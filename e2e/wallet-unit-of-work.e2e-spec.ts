import { ConflictException, INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { Prisma } from "../src/generated/prisma/client.js";
import { Money } from "../src/shared/kernel/money";
import { PrismaUnitOfWork } from "../src/modules/wallet/infrastructure/persistence/prisma-unit-of-work";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

const USER_ID = "uow-user-id";

describe("PrismaUnitOfWork (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let uow: PrismaUnitOfWork;

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    uow = new PrismaUnitOfWork(prisma);
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
        email: "uow@test.com",
        password: "hashed",
        name: "Unit of Work",
        status: "ACTIVE",
        authProvider: "LOCAL",
      },
    });
  });

  const balanceOf = async (currency: "ARS" | "USD") =>
    (
      await prisma.wallet.findUniqueOrThrow({
        where: { userId_currency: { userId: USER_ID, currency } },
      })
    ).balance;

  it("commits the wallet change and the transaction record together", async () => {
    const result = await uow.run(async ({ wallets, transactions }) => {
      const wallet = await wallets.findOrCreateEmpty(USER_ID, "ARS");
      const applied = await wallets.credit(
        wallet.id,
        wallet.version,
        Money.of("500", "ARS"),
      );
      const record = await transactions.create({
        walletId: wallet.id,
        type: "DEPOSIT",
        status: "COMPLETED",
        amount: Money.of("500", "ARS"),
        description: "Depósito ARS",
      });
      return { applied, record };
    });

    expect(result.applied).toBe(true);
    expect(result.record.type).toBe("DEPOSIT");
    expect(result.record.amount).toBe("500");
    expect((await balanceOf("ARS")).toString()).toBe("500");
    expect(await prisma.transaction.count()).toBe(1);
  });

  it("rolls everything back when the work fails after writing", async () => {
    await expect(
      uow.run(async ({ wallets, transactions }) => {
        const wallet = await wallets.findOrCreateEmpty(USER_ID, "ARS");
        await wallets.credit(wallet.id, wallet.version, Money.of("500", "ARS"));
        await transactions.create({
          walletId: wallet.id,
          type: "DEPOSIT",
          status: "COMPLETED",
          amount: Money.of("500", "ARS"),
          description: "will be rolled back",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await prisma.wallet.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);
  });

  it("retries the whole callback when the wallet version moved, and applies the change once", async () => {
    await prisma.wallet.create({
      data: { userId: USER_ID, currency: "ARS", balance: 1000, version: 1 },
    });
    let attempts = 0;

    await uow.run(async ({ wallets }) => {
      attempts += 1;
      const wallet = await wallets.findByUserAndCurrency(USER_ID, "ARS");
      if (wallet === null) throw new Error("wallet should exist");

      if (attempts === 1) {
        // Another writer gets in between our read and our write.
        await prisma.wallet.update({
          where: { id: wallet.id },
          data: { version: { increment: 1 } },
        });
      }

      const applied = await wallets.credit(
        wallet.id,
        wallet.version,
        Money.of("500", "ARS"),
      );
      if (!applied) throw new ConflictException("Optimistic lock conflict");
    });

    expect(attempts).toBe(2);
    expect((await balanceOf("ARS")).toString()).toBe("1500");
  });

  it("stops after 3 attempts when the conflict never clears", async () => {
    await prisma.wallet.create({
      data: { userId: USER_ID, currency: "ARS", balance: 1000, version: 1 },
    });
    let attempts = 0;

    await expect(
      uow.run(async ({ wallets }) => {
        attempts += 1;
        const wallet = await wallets.findByUserAndCurrency(USER_ID, "ARS");
        if (wallet === null) throw new Error("wallet should exist");
        await prisma.wallet.update({
          where: { id: wallet.id },
          data: { version: { increment: 1 } },
        });
        const applied = await wallets.credit(
          wallet.id,
          wallet.version,
          Money.of("500", "ARS"),
        );
        if (!applied) throw new ConflictException("Optimistic lock conflict");
      }),
    ).rejects.toThrow(ConflictException);

    expect(attempts).toBe(3);
    expect((await balanceOf("ARS")).toString()).toBe("1000");
  });

  it("does not retry an error that is not a conflict", async () => {
    let attempts = 0;

    await expect(
      uow.run(async () => {
        attempts += 1;
        throw new Error("not retryable");
      }),
    ).rejects.toThrow("not retryable");

    expect(attempts).toBe(1);
  });

  it("refuses a debit whose version is stale and writes nothing", async () => {
    const wallet = await prisma.wallet.create({
      data: { userId: USER_ID, currency: "ARS", balance: 1000, version: 5 },
    });

    const applied = await uow.run(({ wallets }) =>
      wallets.debit(wallet.id, 4, Money.of("100", "ARS")),
    );

    expect(applied).toBe(false);
    expect((await balanceOf("ARS")).toString()).toBe("1000");
  });

  it("recovers when two concurrent first deposits race on the unique constraint", async () => {
    const deposit = () =>
      uow.run(async ({ wallets }) => {
        const wallet = await wallets.findOrCreateEmpty(USER_ID, "ARS");
        const applied = await wallets.credit(
          wallet.id,
          wallet.version,
          Money.of("100", "ARS"),
        );
        if (!applied) throw new ConflictException("Optimistic lock conflict");
      });

    await Promise.all([deposit(), deposit()]);

    expect(await prisma.wallet.count()).toBe(1);
    expect((await balanceOf("ARS")).toString()).toBe("200");
  });

  it("loads a balance with legacy precision instead of failing", async () => {
    await prisma.wallet.create({
      data: {
        userId: USER_ID,
        currency: "USD",
        balance: new Prisma.Decimal("1.0005"),
        version: 1,
      },
    });

    const wallet = await uow.run(({ wallets }) =>
      wallets.findByUserAndCurrency(USER_ID, "USD"),
    );

    expect(wallet).not.toBeNull();
    expect(wallet?.balance.isLessThan(Money.of("1.01", "USD"))).toBe(true);
    expect(wallet?.balance.isGreaterThanOrEqual(Money.of("1.00", "USD"))).toBe(
      true,
    );
  });
});
