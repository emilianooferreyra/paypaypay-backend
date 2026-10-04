import { ConflictException, INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { DepositService } from "../src/modules/wallet/application/deposit.service";
import { WithdrawService } from "../src/modules/wallet/application/withdraw.service";
import { Money } from "../src/shared/kernel/money";
import { WalletEvent } from "../src/modules/wallet/domain/wallet-events";
import { PrismaUnitOfWork } from "../src/modules/wallet/infrastructure/persistence/prisma-unit-of-work";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

const USER_ID = "outbox-user-id";

const eventFor = (
  walletId: string,
  type: WalletEvent["type"],
): WalletEvent => ({
  type,
  walletId,
  data: {
    walletId,
    userId: USER_ID,
    amount: "10",
    currency: "ARS",
    transactionId: `tx-${type}`,
  },
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Transactional outbox (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let uow: PrismaUnitOfWork;
  let deposit: DepositService;
  let withdraw: WithdrawService;

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    uow = new PrismaUnitOfWork(prisma);
    deposit = new DepositService(uow);
    withdraw = new WithdrawService(uow);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    await prisma.user.create({
      data: {
        id: USER_ID,
        email: "outbox@test.com",
        password: "hashed",
        name: "Outbox",
        status: "ACTIVE",
        authProvider: "LOCAL",
      },
    });
  });

  describe("atomicity with the business change", () => {
    it("writes exactly one event when a deposit succeeds", async () => {
      const tx = await deposit.execute({
        userId: USER_ID,
        currency: "ARS",
        amount: "500",
      });

      const events = await prisma.outboxEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "deposit.confirmed",
        aggregateType: "wallet",
        aggregateId: tx.walletId,
        processedAt: null,
        payload: {
          walletId: tx.walletId,
          userId: USER_ID,
          amount: "500",
          currency: "ARS",
          transactionId: tx.id,
        },
      });
      expect(events[0].occurredAt).toBeInstanceOf(Date);
    });

    it("writes no event when the operation fails", async () => {
      await prisma.wallet.create({
        data: { userId: USER_ID, currency: "ARS", balance: 100, version: 1 },
      });

      await expect(
        withdraw.execute({ userId: USER_ID, currency: "ARS", amount: "500" }),
      ).rejects.toThrow("Insufficient balance");

      expect(await prisma.outboxEvent.count()).toBe(0);
    });

    it("rolls the event back with the wallet and the record when the work fails after enqueue", async () => {
      await expect(
        uow.run(async ({ wallets, outbox }) => {
          const wallet = await wallets.findOrCreateEmpty(USER_ID, "ARS");
          await outbox.enqueue(eventFor(wallet.id, "deposit.confirmed"));
          throw new Error("boom after enqueue");
        }),
      ).rejects.toThrow("boom after enqueue");

      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(await prisma.wallet.count()).toBe(0);
    });

    it("writes one event, not two, when the transaction is retried", async () => {
      await prisma.wallet.create({
        data: { userId: USER_ID, currency: "ARS", balance: 0, version: 1 },
      });
      let attempts = 0;

      await uow.run(async ({ wallets, outbox }) => {
        attempts += 1;
        const wallet = await wallets.findOrCreateEmpty(USER_ID, "ARS");
        if (attempts === 1) {
          await prisma.wallet.update({
            where: { id: wallet.id },
            data: { version: { increment: 1 } },
          });
        }
        await outbox.enqueue(eventFor(wallet.id, "deposit.confirmed"));
        const applied = await wallets.credit(
          wallet.id,
          wallet.version,
          Money.of("10", "ARS"),
        );
        if (!applied) throw new ConflictException("Optimistic lock conflict");
      });

      expect(attempts).toBe(2);
      expect(await prisma.outboxEvent.count()).toBe(1);
    });

    it("keeps the payload as a snapshot when the wallet changes afterwards", async () => {
      const tx = await deposit.execute({
        userId: USER_ID,
        currency: "ARS",
        amount: "500",
      });
      await deposit.execute({
        userId: USER_ID,
        currency: "ARS",
        amount: "700",
      });

      const first = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: tx.walletId },
        orderBy: { seq: "asc" },
      });
      expect(first.payload).toMatchObject({ amount: "500" });
    });
  });

  describe("commit order per wallet", () => {
    const makeWallet = (currency: "ARS" | "USD") =>
      prisma.wallet.create({
        data: { userId: USER_ID, currency, balance: 0, version: 1 },
      });

    it("makes a second writer for the same wallet wait until the first commits", async () => {
      const wallet = await makeWallet("ARS");
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      let firstHasEnqueued: () => void = () => undefined;
      const enqueued = new Promise<void>(
        (resolve) => (firstHasEnqueued = resolve),
      );
      let secondDone = false;

      const first = uow.run(async ({ outbox }) => {
        await outbox.enqueue(eventFor(wallet.id, "deposit.confirmed"));
        firstHasEnqueued();
        await gate;
      });

      await enqueued;
      const second = uow
        .run(({ outbox }) =>
          outbox.enqueue(eventFor(wallet.id, "withdraw.completed")),
        )
        .then(() => {
          secondDone = true;
        });

      await tick(400);
      expect(secondDone).toBe(false);

      openGate();
      await Promise.all([first, second]);

      const ordered = await prisma.outboxEvent.findMany({
        orderBy: { seq: "asc" },
      });
      expect(ordered.map((e) => e.type)).toEqual([
        "deposit.confirmed",
        "withdraw.completed",
      ]);
    });

    it("does not make writers of different wallets wait for each other", async () => {
      const a = await makeWallet("ARS");
      const b = await makeWallet("USD");
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      let firstHasEnqueued: () => void = () => undefined;
      const enqueued = new Promise<void>(
        (resolve) => (firstHasEnqueued = resolve),
      );

      const first = uow.run(async ({ outbox }) => {
        await outbox.enqueue(eventFor(a.id, "deposit.confirmed"));
        firstHasEnqueued();
        await gate;
      });

      await enqueued;
      await uow.run(({ outbox }) =>
        outbox.enqueue(eventFor(b.id, "deposit.confirmed")),
      );

      expect(await prisma.outboxEvent.count()).toBe(1);

      openGate();
      await first;
      expect(await prisma.outboxEvent.count()).toBe(2);
    });
  });
});
