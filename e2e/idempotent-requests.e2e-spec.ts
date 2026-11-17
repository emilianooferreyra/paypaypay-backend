import { randomUUID } from "node:crypto";
import { ConflictException, INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { fingerprint } from "../src/modules/idempotency/domain/request-fingerprint";
import { PrismaIdempotencyStore } from "../src/modules/idempotency/infrastructure/prisma-idempotency.store";
import { DepositService } from "../src/modules/wallet/application/deposit.service";
import { PrismaUnitOfWork } from "../src/modules/wallet/infrastructure/persistence/prisma-unit-of-work";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

const BASE = "/api/v1/wallet";
const ALICE = "idem-alice";
const BOB = "idem-bob";

describe("Idempotent money requests (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let store: PrismaIdempotencyStore;
  let target: Parameters<typeof request>[0];
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    jwtService = moduleFixture.get(JwtService);
    store = new PrismaIdempotencyStore(prisma);
    // Concurrent requests need a server that is really listening: supertest
    // opens an ephemeral listener per request on an idle one, and they collide.
    await app.listen(0);
    target = await app.getUrl();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);

    for (const id of [ALICE, BOB]) {
      await prisma.user.create({
        data: {
          id,
          email: `${id}@test.com`,
          password: "hashed",
          name: id,
          status: "ACTIVE",
          authProvider: "LOCAL",
        },
      });
      await prisma.session.create({
        data: {
          id: `${id}-session`,
          userId: id,
          refreshToken: "hashed-refresh-token",
          isActive: true,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      await prisma.kycVerification.create({
        data: { userId: id, status: "APPROVED" },
      });
      await prisma.wallet.create({
        data: { userId: id, currency: "ARS", balance: 1000, version: 1 },
      });
      tokens[id] = jwtService.sign({ sub: id, sessionId: `${id}-session` });
    }
  });

  const post = (
    path: string,
    body: Record<string, string>,
    key: string | undefined,
    user = ALICE,
  ) => {
    const req = request(target)
      .post(`${BASE}/${path}`)
      .set("Cookie", `access_token=${tokens[user]}`);
    if (key !== undefined) req.set("Idempotency-Key", key);

    return req.send(body);
  };

  const deposit500 = { amount: "500", currency: "ARS" };

  const balanceOf = async (userId = ALICE) =>
    (
      await prisma.wallet.findUniqueOrThrow({
        where: { userId_currency: { userId, currency: "ARS" } },
      })
    ).balance.toString();

  const transactionCount = () => prisma.transaction.count();

  describe("the key header", () => {
    it("is required: 400 and no money moves", async () => {
      await post("deposit", deposit500, undefined).expect(400);

      expect(await balanceOf()).toBe("1000");
      expect(await transactionCount()).toBe(0);
    });

    it.each(["", "a b", "a".repeat(256)])("refuses the key %j", async (key) => {
      await post("deposit", deposit500, key).expect(400);

      expect(await transactionCount()).toBe(0);
    });
  });

  describe("a retry after success", () => {
    it("replays the first response and moves the money once", async () => {
      const key = randomUUID();

      const first = await post("deposit", deposit500, key).expect(201);
      const second = await post("deposit", deposit500, key).expect(201);

      expect(second.body).toEqual(first.body);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(first.headers["idempotent-replayed"]).toBeUndefined();
      expect(second.headers["idempotency-key"]).toBe(key);
      expect(await balanceOf()).toBe("1500");
      expect(await transactionCount()).toBe(1);
    });

    it.each(["withdraw"])("%s as well", async (path) => {
      const key = randomUUID();

      await post(path, { amount: "300", currency: "ARS" }, key).expect(201);
      await post(path, { amount: "300", currency: "ARS" }, key).expect(201);

      expect(await balanceOf()).toBe("700");
      expect(await transactionCount()).toBe(1);
    });

    it("applies to exchange too", async () => {
      await prisma.wallet.create({
        data: { userId: ALICE, currency: "USD", balance: 0, version: 1 },
      });
      await prisma.exchangeRate.create({
        data: {
          fromCurrency: "ARS",
          toCurrency: "USD",
          rate: "0.001",
          date: new Date(),
        },
      });
      const key = randomUUID();
      const body = { fromCurrency: "ARS", toCurrency: "USD", amount: "500" };

      const first = await post("exchange", body, key).expect(201);
      const second = await post("exchange", body, key).expect(201);

      expect(second.body).toEqual(first.body);
      expect(await balanceOf()).toBe("500");
      expect(await transactionCount()).toBe(1);
    });
  });

  describe("a deterministic failure", () => {
    it("is stored and replayed, even if the balance changes afterwards", async () => {
      const key = randomUUID();
      const withdrawal = { amount: "9999", currency: "ARS" };

      const first = await post("withdraw", withdrawal, key).expect(422);
      await post(
        "deposit",
        { amount: "100000", currency: "ARS" },
        randomUUID(),
      ).expect(201);
      const second = await post("withdraw", withdrawal, key).expect(422);

      // The exception filter stamps every response with the current time, so the
      // stored answer is compared without that envelope field.
      const { timestamp: _first, ...firstBody } = first.body;
      const { timestamp: _second, ...secondBody } = second.body;
      expect(secondBody).toEqual(firstBody);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(await transactionCount()).toBe(1);
    });
  });

  describe("input that was invalid", () => {
    it("leaves the key reusable for the corrected request", async () => {
      const key = randomUUID();

      await post("deposit", { amount: "-100", currency: "ARS" }, key).expect(
        400,
      );
      await post("deposit", deposit500, key).expect(201);

      expect(await balanceOf()).toBe("1500");
    });
  });

  describe("a changed request under the same key", () => {
    it("is refused with 422 and moves nothing", async () => {
      const key = randomUUID();
      await post("deposit", deposit500, key).expect(201);

      await post("deposit", { amount: "900", currency: "ARS" }, key).expect(
        422,
      );

      expect(await balanceOf()).toBe("1500");
      expect(await transactionCount()).toBe(1);
    });

    it("is refused when the same body goes to another endpoint", async () => {
      const key = randomUUID();
      await post("deposit", deposit500, key).expect(201);

      await post("withdraw", deposit500, key).expect(422);

      expect(await balanceOf()).toBe("1500");
    });
  });

  describe("two users with the same key", () => {
    it("execute independently and never see each other's response", async () => {
      const key = randomUUID();

      const alice = await post("deposit", deposit500, key, ALICE).expect(201);
      const bob = await post(
        "deposit",
        { amount: "200", currency: "ARS" },
        key,
        BOB,
      ).expect(201);

      expect(bob.body.id).not.toBe(alice.body.id);
      expect(bob.headers["idempotent-replayed"]).toBeUndefined();
      expect(await balanceOf(ALICE)).toBe("1500");
      expect(await balanceOf(BOB)).toBe("1200");
    });
  });

  describe("20 simultaneous identical requests", () => {
    it("create exactly one transaction; every other answer is a 409 or a replay", async () => {
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => post("deposit", deposit500, key)),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      const executed = responses.filter(
        (r) => r.status === 201 && !r.headers["idempotent-replayed"],
      );
      expect(executed).toHaveLength(1);
      for (const conflict of responses.filter((r) => r.status === 409)) {
        expect(Number(conflict.headers["retry-after"])).toBeGreaterThanOrEqual(
          1,
        );
      }
      expect(await transactionCount()).toBe(1);
      expect(await balanceOf()).toBe("1500");
    });
  });

  describe("a holder that crashed", () => {
    it("lets the retry execute once the lease expired", async () => {
      const key = randomUUID();
      const claim = await store.claim({
        userId: ALICE,
        key,
        route: `${BASE}/deposit`,
        requestHash: fingerprint({
          method: "POST",
          route: `${BASE}/deposit`,
          body: deposit500,
        }),
        leaseMs: 60_000,
      });
      expect(claim.claimed).toBe(true);

      // Before the lease ends the retry is told to wait.
      await post("deposit", deposit500, key).expect(409);
      expect(await transactionCount()).toBe(0);

      await prisma.$executeRaw`
        UPDATE "IdempotencyRecord"
        SET "lockedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second'`;

      await post("deposit", deposit500, key).expect(201);
      await post("deposit", deposit500, key).expect(201);

      expect(await transactionCount()).toBe(1);
      expect(await balanceOf()).toBe("1500");
    });
  });

  describe("a holder that lost its lease", () => {
    it("cannot apply its money: the balance change rolls back with the refused completion", async () => {
      const uow = new PrismaUnitOfWork(prisma);
      const deposit = new DepositService(uow);
      const claim = await store.claim({
        userId: ALICE,
        key: randomUUID(),
        route: `${BASE}/deposit`,
        requestHash: "hash",
        leaseMs: 1,
      });
      if (!claim.claimed) throw new Error("expected a claim");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const fresh = await store.takeOver(claim.context.recordId, 60_000);
      expect(fresh).not.toBeNull();

      await expect(
        deposit.execute({
          userId: ALICE,
          currency: "ARS",
          amount: "500",
          idempotency: claim.context,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(await balanceOf()).toBe("1000");
      expect(await transactionCount()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);

      await deposit.execute({
        userId: ALICE,
        currency: "ARS",
        amount: "500",
        idempotency: fresh!,
      });
      expect(await balanceOf()).toBe("1500");
      expect(await transactionCount()).toBe(1);
    });
  });
});
