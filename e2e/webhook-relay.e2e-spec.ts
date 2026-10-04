import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { RelayOutboxEvents } from "../src/modules/webhook/application/relay-outbox-events";
import { PrismaDeliveryQueue } from "../src/modules/webhook/infrastructure/persistence/prisma-delivery.queue";
import { PrismaRelayUnitOfWork } from "../src/modules/webhook/infrastructure/persistence/prisma-relay-unit-of-work";
import { SystemClock } from "../src/modules/webhook/infrastructure/system-clock";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

describe("Webhook relay persistence (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let relay: RelayOutboxEvents;
  let queue: PrismaDeliveryQueue;

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    relay = new RelayOutboxEvents(
      new PrismaRelayUnitOfWork(prisma),
      new SystemClock(),
    );
    queue = new PrismaDeliveryQueue(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  const past = (ms: number) => new Date(Date.now() - ms);
  const future = (ms: number) => new Date(Date.now() + ms);

  const makeEndpoint = (overrides: { active?: boolean; url?: string } = {}) =>
    prisma.webhookEndpoint.create({
      data: {
        url: overrides.url ?? "https://merchant.example/hooks",
        secret: "s3cret",
        active: overrides.active ?? true,
      },
    });

  const makeEvent = (type = "deposit.confirmed") =>
    prisma.outboxEvent.create({
      data: {
        type,
        aggregateType: "wallet",
        aggregateId: "w1",
        payload: { walletId: "w1", amount: "10" },
      },
    });

  const makeDelivery = (
    eventId: string | null,
    endpointId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    prisma.webhookDelivery.create({
      data: {
        endpointId,
        eventId,
        event: "deposit.confirmed",
        payload: '{"id":"x"}',
        status: "pending",
        nextRetryAt: past(1000),
        ...overrides,
      },
    });

  describe("fan-out", () => {
    it("creates one pending delivery per active endpoint and marks the event processed", async () => {
      const a = await makeEndpoint();
      const b = await makeEndpoint();
      await makeEndpoint({ active: false });
      const event = await makeEvent();

      const processed = await relay.execute(10);

      expect(processed).toBe(1);
      const deliveries = await prisma.webhookDelivery.findMany({
        where: { eventId: event.id },
      });
      expect(deliveries.map((d) => d.endpointId).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect(deliveries.every((d) => d.status === "pending")).toBe(true);
      expect(deliveries[0].nextRetryAt).not.toBeNull();
      expect(
        (
          await prisma.outboxEvent.findUniqueOrThrow({
            where: { id: event.id },
          })
        ).processedAt,
      ).not.toBeNull();
    });

    it("stores the body with the event id and the time it happened", async () => {
      await makeEndpoint();
      const event = await makeEvent("withdraw.completed");

      await relay.execute(10);

      const delivery = await prisma.webhookDelivery.findFirstOrThrow();
      expect(JSON.parse(delivery.payload)).toEqual({
        id: event.id,
        event: "withdraw.completed",
        data: { walletId: "w1", amount: "10" },
        timestamp: event.occurredAt.toISOString(),
      });
    });

    it("does not duplicate a delivery that already exists for the event and endpoint", async () => {
      const a = await makeEndpoint();
      await makeEndpoint();
      const event = await makeEvent();
      await makeDelivery(event.id, a.id);

      await relay.execute(10);

      expect(await prisma.webhookDelivery.count()).toBe(2);
    });

    it("gives two concurrent relays disjoint batches", async () => {
      await makeEndpoint();
      for (let i = 0; i < 10; i += 1) await makeEvent();

      const [first, second] = await Promise.all([
        relay.execute(5),
        relay.execute(5),
      ]);

      expect(first + second).toBe(10);
      expect(await prisma.webhookDelivery.count()).toBe(10);
      const perEvent = await prisma.webhookDelivery.groupBy({
        by: ["eventId"],
        _count: true,
      });
      expect(perEvent.every((g) => g._count === 1)).toBe(true);
    });

    it("takes events in sequence order", async () => {
      await makeEndpoint();
      const first = await makeEvent("deposit.confirmed");
      await makeEvent("withdraw.completed");

      await relay.execute(1);

      expect(
        (
          await prisma.outboxEvent.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).processedAt,
      ).not.toBeNull();
      expect(
        await prisma.outboxEvent.count({ where: { processedAt: null } }),
      ).toBe(1);
    });
  });

  describe("claiming due deliveries", () => {
    it("returns the url, secret and stored body, and leaves a lease in the future", async () => {
      const endpoint = await makeEndpoint({ url: "https://m.example/a" });
      const event = await makeEvent();
      const delivery = await makeDelivery(event.id, endpoint.id, {
        payload: '{"id":"abc"}',
      });

      const [claimed] = await queue.claimDue(10, 60_000);

      expect(claimed).toEqual({
        id: delivery.id,
        eventId: event.id,
        url: "https://m.example/a",
        secret: "s3cret",
        payload: '{"id":"abc"}',
        attempts: 0,
      });
      const row = await prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(row.lockedUntil?.getTime()).toBeGreaterThan(Date.now() + 30_000);
    });

    it("does not hand the same delivery to a second worker while the lease is live", async () => {
      const endpoint = await makeEndpoint();
      await makeDelivery((await makeEvent()).id, endpoint.id);

      expect(await queue.claimDue(10, 60_000)).toHaveLength(1);
      expect(await queue.claimDue(10, 60_000)).toHaveLength(0);
    });

    it("hands it out again once the lease has expired", async () => {
      const endpoint = await makeEndpoint();
      await makeDelivery((await makeEvent()).id, endpoint.id, {
        lockedUntil: past(1000),
      });

      expect(await queue.claimDue(10, 60_000)).toHaveLength(1);
    });

    it("skips what is not due, not pending, inactive, or from before the outbox", async () => {
      const endpoint = await makeEndpoint();
      const inactive = await makeEndpoint({ active: false });
      const event = await makeEvent();
      await makeDelivery(event.id, endpoint.id, {
        nextRetryAt: future(60_000),
      });
      await makeDelivery((await makeEvent()).id, endpoint.id, {
        status: "delivered",
      });
      await makeDelivery((await makeEvent()).id, endpoint.id, {
        status: "dead",
      });
      await makeDelivery((await makeEvent()).id, inactive.id);
      await makeDelivery(null, endpoint.id, { status: "failed" });

      expect(await queue.claimDue(10, 60_000)).toHaveLength(0);
    });

    it("claims failed deliveries whose retry time has come", async () => {
      const endpoint = await makeEndpoint();
      await makeDelivery((await makeEvent()).id, endpoint.id, {
        status: "failed",
        attempts: 1,
        nextRetryAt: past(1000),
      });

      const [claimed] = await queue.claimDue(10, 60_000);

      expect(claimed.attempts).toBe(1);
    });

    it("takes the deliveries of older events first when it cannot take them all", async () => {
      const endpoint = await makeEndpoint();
      const older = await makeEvent("deposit.confirmed");
      const newer = await makeEvent("withdraw.completed");
      const same = new Date(Date.now() - 5000);
      await makeDelivery(newer.id, endpoint.id, { nextRetryAt: same });
      await makeDelivery(older.id, endpoint.id, { nextRetryAt: same });

      const first = await queue.claimDue(1, 60_000);
      const second = await queue.claimDue(1, 60_000);

      expect(first.map((c) => c.eventId)).toEqual([older.id]);
      expect(second.map((c) => c.eventId)).toEqual([newer.id]);
    });

    it("never hands the same delivery to two concurrent workers", async () => {
      const endpoint = await makeEndpoint();
      for (let i = 0; i < 10; i += 1) {
        await makeDelivery((await makeEvent()).id, endpoint.id);
      }

      const [a, b] = await Promise.all([
        queue.claimDue(5, 60_000),
        queue.claimDue(5, 60_000),
      ]);

      const ids = [...a, ...b].map((d) => d.id);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
    });

    it("skips rows another process has locked instead of waiting for them", async () => {
      const endpoint = await makeEndpoint();
      const locked = await makeDelivery((await makeEvent()).id, endpoint.id, {
        nextRetryAt: past(5000),
      });
      const free = await makeDelivery((await makeEvent()).id, endpoint.id, {
        nextRetryAt: past(1000),
      });

      let claimedWhileLocked: string[] = [];
      let elapsed = 0;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "WebhookDelivery" WHERE id = ${locked.id} FOR UPDATE`;

        const started = Date.now();
        claimedWhileLocked = (await queue.claimDue(10, 60_000)).map(
          (d) => d.id,
        );
        elapsed = Date.now() - started;
      });

      expect(claimedWhileLocked).toEqual([free.id]);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("recording the result", () => {
    const claimOne = async () => {
      const endpoint = await makeEndpoint();
      const delivery = await makeDelivery((await makeEvent()).id, endpoint.id);
      await queue.claimDue(10, 60_000);
      return delivery;
    };

    it("records a delivery on the same row and clears the lease", async () => {
      const delivery = await claimOne();

      await queue.record(delivery.id, {
        status: "delivered",
        attempts: 1,
        responseStatus: 200,
      });

      expect(await prisma.webhookDelivery.count()).toBe(1);
      expect(
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        }),
      ).toMatchObject({
        status: "delivered",
        attempts: 1,
        responseStatus: 200,
        lastError: null,
        lockedUntil: null,
      });
    });

    it("records a retryable failure with the next time to try", async () => {
      const delivery = await claimOne();
      const nextRetryAt = future(60_000);

      await queue.record(delivery.id, {
        status: "failed",
        attempts: 1,
        responseStatus: 503,
        lastError: "HTTP 503",
        nextRetryAt,
      });

      expect(
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        }),
      ).toMatchObject({
        status: "failed",
        attempts: 1,
        responseStatus: 503,
        lastError: "HTTP 503",
        nextRetryAt,
        lockedUntil: null,
      });
    });

    it("records a dead delivery and keeps the row", async () => {
      const delivery = await claimOne();

      await queue.record(delivery.id, {
        status: "dead",
        attempts: 3,
        lastError: "ECONNREFUSED",
      });

      expect(
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        }),
      ).toMatchObject({
        status: "dead",
        attempts: 3,
        lastError: "ECONNREFUSED",
      });
    });

    it("does not overwrite a delivery that already reached a final state", async () => {
      const delivery = await claimOne();
      await queue.record(delivery.id, {
        status: "delivered",
        attempts: 1,
        responseStatus: 200,
      });

      await queue.record(delivery.id, {
        status: "dead",
        attempts: 2,
        lastError: "late result from a worker whose lease expired",
      });

      expect(
        (
          await prisma.webhookDelivery.findUniqueOrThrow({
            where: { id: delivery.id },
          })
        ).status,
      ).toBe("delivered");
    });
  });
});
