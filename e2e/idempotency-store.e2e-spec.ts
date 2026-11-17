import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { PrismaIdempotencyStore } from "../src/modules/idempotency/infrastructure/prisma-idempotency.store";
import { PrismaIdempotencyPort } from "../src/modules/idempotency/infrastructure/prisma-idempotency.port";
import {
  ClaimInput,
  IdempotencyContext,
} from "../src/modules/idempotency/application/ports/idempotency-store.port";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

const input = (overrides: Partial<ClaimInput> = {}): ClaimInput => ({
  userId: "idem-user",
  key: "key-1",
  route: "/wallet/deposit",
  requestHash: "hash-1",
  leaseMs: 60_000,
  ...overrides,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PrismaIdempotencyStore (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let store: PrismaIdempotencyStore;

  const complete = (ctx: IdempotencyContext, code = 201, body: unknown = {}) =>
    prisma.$transaction((tx) =>
      new PrismaIdempotencyPort(tx).complete(ctx, code, body),
    );

  const claimed = async (overrides: Partial<ClaimInput> = {}) => {
    const result = await store.claim(input(overrides));
    if (!result.claimed) throw new Error("expected to win the claim");

    return result.context;
  };

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    store = new PrismaIdempotencyStore(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  describe("claim", () => {
    it("stores user, key, hash, token and a lease from the database clock", async () => {
      const ctx = await claimed();

      const row = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: ctx.recordId },
      });
      expect(row).toMatchObject({
        userId: "idem-user",
        key: "key-1",
        route: "/wallet/deposit",
        requestHash: "hash-1",
        status: "IN_PROGRESS",
        lockToken: ctx.lockToken,
      });
      const [{ ahead }] = await prisma.$queryRaw<{ ahead: number }[]>`
        SELECT EXTRACT(EPOCH FROM ("lockedUntil" - (now() AT TIME ZONE 'UTC')))::float AS ahead
        FROM "IdempotencyRecord" WHERE id = ${ctx.recordId}`;
      expect(ahead).toBeGreaterThan(55);
      expect(ahead).toBeLessThanOrEqual(60);
    });

    it("lets exactly one of two simultaneous claims win", async () => {
      const results = await Promise.all([
        store.claim(input()),
        store.claim(input()),
      ]);

      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      const loser = results.find((r) => !r.claimed)!;
      expect(loser.claimed).toBe(false);
      if (!loser.claimed) {
        expect(loser.existing).toMatchObject({
          status: "IN_PROGRESS",
          requestHash: "hash-1",
          statusCode: null,
          leaseExpired: false,
        });
        expect(loser.existing.retryAfterSeconds).toBeGreaterThan(0);
      }
      expect(await prisma.idempotencyRecord.count()).toBe(1);
    });

    it("scopes keys per user", async () => {
      await claimed({ userId: "idem-user" });

      const other = await store.claim(input({ userId: "other-user" }));

      expect(other.claimed).toBe(true);
    });
  });

  describe("complete", () => {
    it("stores status, code and body for the current token", async () => {
      const ctx = await claimed();

      expect(await complete(ctx, 201, { id: "tx-1" })).toBe(true);

      const row = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: ctx.recordId },
      });
      expect(row).toMatchObject({
        status: "COMPLETED",
        statusCode: 201,
        response: { id: "tx-1" },
      });
    });

    it("refuses a stale token", async () => {
      const ctx = await claimed();

      expect(
        await complete({ recordId: ctx.recordId, lockToken: "stale" }),
      ).toBe(false);
      const row = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: ctx.recordId },
      });
      expect(row.status).toBe("IN_PROGRESS");
    });

    it("does not complete twice", async () => {
      const ctx = await claimed();
      await complete(ctx);

      expect(await complete(ctx)).toBe(false);
    });
  });

  describe("takeOver", () => {
    it("is refused while the lease is alive", async () => {
      const ctx = await claimed();

      expect(await store.takeOver(ctx.recordId, 60_000)).toBeNull();
    });

    it("issues a new token after expiry and fences the old holder out", async () => {
      const old = await claimed({ leaseMs: 1 });
      await sleep(20);

      const fresh = await store.takeOver(old.recordId, 60_000);

      expect(fresh).not.toBeNull();
      expect(fresh!.lockToken).not.toBe(old.lockToken);
      expect(await complete(old)).toBe(false);
      expect(await complete(fresh!)).toBe(true);
    });

    it("lets exactly one of two simultaneous takeovers win", async () => {
      const old = await claimed({ leaseMs: 1 });
      await sleep(20);

      const results = await Promise.all([
        store.takeOver(old.recordId, 60_000),
        store.takeOver(old.recordId, 60_000),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("is refused for a finished record", async () => {
      const ctx = await claimed({ leaseMs: 1 });
      await complete(ctx);
      await sleep(20);

      expect(await store.takeOver(ctx.recordId, 60_000)).toBeNull();
    });
  });

  describe("unlock, discard and fail", () => {
    it("unlock makes the key takeable at once", async () => {
      const ctx = await claimed();

      expect(await store.unlock(ctx)).toBe(true);

      const again = await store.claim(input());
      expect(again.claimed).toBe(false);
      if (!again.claimed) expect(again.existing.leaseExpired).toBe(true);
      expect(await store.takeOver(ctx.recordId, 60_000)).not.toBeNull();
    });

    it("discard deletes the claim so the key can be reused", async () => {
      const ctx = await claimed();

      expect(await store.discard(ctx)).toBe(true);

      const again = await store.claim(input({ requestHash: "hash-2" }));
      expect(again.claimed).toBe(true);
    });

    it("fail stores the response for replay", async () => {
      const ctx = await claimed();

      expect(
        await store.fail(ctx, 422, { message: "Insufficient balance" }),
      ).toBe(true);

      const again = await store.claim(input());
      expect(again.claimed).toBe(false);
      if (!again.claimed) {
        expect(again.existing).toMatchObject({
          status: "FAILED",
          statusCode: 422,
          response: { message: "Insufficient balance" },
        });
      }
    });

    it("all three are conditional on the token", async () => {
      const ctx = await claimed();
      const stale = { recordId: ctx.recordId, lockToken: "stale" };

      expect(await store.unlock(stale)).toBe(false);
      expect(await store.discard(stale)).toBe(false);
      expect(await store.fail(stale, 422, {})).toBe(false);
      expect(await prisma.idempotencyRecord.count()).toBe(1);
    });
  });

  describe("deleteOlderThan", () => {
    it("deletes only records past the retention", async () => {
      await claimed({ key: "old" });
      await claimed({ key: "recent" });
      await prisma.$executeRaw`
        UPDATE "IdempotencyRecord"
        SET "createdAt" = (now() AT TIME ZONE 'UTC') - interval '100 hours'
        WHERE "key" = 'old'`;

      const deleted = await store.deleteOlderThan(72 * 60 * 60 * 1000);

      expect(deleted).toBe(1);
      const left = await prisma.idempotencyRecord.findMany();
      expect(left.map((r) => r.key)).toEqual(["recent"]);
    });
  });
});
