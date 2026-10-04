import { createServer, IncomingMessage, Server } from "node:http";
import { AddressInfo } from "node:net";
import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { verifySignature } from "../src/modules/webhook/domain/webhook-signature";
import { DeliverDueWebhooks } from "../src/modules/webhook/application/deliver-due-webhooks";
import { RelayOutboxEvents } from "../src/modules/webhook/application/relay-outbox-events";
import { HttpWebhookSender } from "../src/modules/webhook/infrastructure/http-webhook.sender";
import { OutboxRelayRunner } from "../src/modules/webhook/infrastructure/outbox-relay.runner";
import { PrismaDeliveryQueue } from "../src/modules/webhook/infrastructure/persistence/prisma-delivery.queue";
import { PrismaRelayUnitOfWork } from "../src/modules/webhook/infrastructure/persistence/prisma-relay-unit-of-work";
import { buildRelayConfig } from "../src/modules/webhook/infrastructure/relay-config.factory";
import { SystemClock } from "../src/modules/webhook/infrastructure/system-clock";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

const USER_ID = "delivery-user-id";
const SECRET = "e2e-secret";

interface Received {
  headers: IncomingMessage["headers"];
  body: string;
}

describe("Webhook delivery (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let runner: OutboxRelayRunner;
  let accessToken: string;
  let receiver: Server;
  let receiverUrl: string;
  let received: Received[];
  let statuses: number[];
  let hang: boolean;

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    runner = moduleFixture.get(OutboxRelayRunner);
    const jwt = moduleFixture.get(JwtService);

    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (hang) return;
        res.writeHead(statuses.shift() ?? 200);
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, "127.0.0.1", resolve),
    );
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

    accessToken = jwt.sign({ sub: USER_ID, sessionId: "delivery-session-id" });
  });

  afterAll(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    received = [];
    statuses = [];
    hang = false;
    await cleanDatabase(prisma);

    await prisma.user.create({
      data: {
        id: USER_ID,
        email: "delivery@test.com",
        password: "hashed",
        name: "Delivery",
        status: "ACTIVE",
        authProvider: "LOCAL",
      },
    });
    await prisma.session.create({
      data: {
        id: "delivery-session-id",
        userId: USER_ID,
        refreshToken: "hashed-refresh-token",
        isActive: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.kycVerification.create({
      data: { userId: USER_ID, status: "APPROVED" },
    });
    await prisma.webhookEndpoint.create({
      data: { url: receiverUrl, secret: SECRET },
    });
  });

  const deposit = (amount = "500") =>
    request(app.getHttpServer())
      .post("/api/v1/wallet/deposit")
      .set("Cookie", `access_token=${accessToken}`)
      .send({ amount, currency: "ARS" })
      .expect(201);

  it("does not call the endpoint while serving the deposit", async () => {
    await deposit();

    expect(received).toHaveLength(0);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("delivers the event once the relay runs, signed and tagged with the event id", async () => {
    const res = await deposit("500");

    await runner.runOnce();

    expect(received).toHaveLength(1);
    const event = await prisma.outboxEvent.findFirstOrThrow();
    const { headers, body } = received[0];

    expect(headers["x-webhook-id"]).toBe(event.id);
    expect(
      verifySignature(SECRET, body, String(headers["x-webhook-signature"])),
    ).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      id: event.id,
      event: "deposit.confirmed",
      data: {
        userId: USER_ID,
        amount: "500",
        currency: "ARS",
        transactionId: res.body.id,
      },
    });

    const delivery = await prisma.webhookDelivery.findFirstOrThrow();
    expect(delivery).toMatchObject({
      status: "delivered",
      attempts: 1,
      responseStatus: 200,
      eventId: event.id,
    });
  });

  it("does not slow the deposit down when the endpoint never answers", async () => {
    hang = true;

    const started = Date.now();
    await deposit();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(received).toHaveLength(0);
  });

  it("keeps a failed delivery in the database and retries it after a restart", async () => {
    statuses = [503, 200];
    await deposit();

    await runner.runOnce();

    const failed = await prisma.webhookDelivery.findFirstOrThrow();
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 1,
      responseStatus: 503,
      lastError: "HTTP 503",
    });
    // About a minute ahead (60 s, spread by up to 20%).
    const wait = (failed.nextRetryAt?.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(40_000);
    expect(wait).toBeLessThan(75_000);

    // A "restart": a brand new set of objects that share nothing with the
    // first one except the database. Then let the retry time arrive.
    const config = buildRelayConfig({
      OUTBOX_RELAY_ENABLED: false,
      OUTBOX_POLL_INTERVAL_MS: 1000,
      OUTBOX_BATCH_SIZE: 20,
      OUTBOX_LEASE_MS: 60_000,
      WEBHOOK_TIMEOUT_MS: 5000,
      WEBHOOK_MAX_ATTEMPTS: 3,
    });
    const clock = new SystemClock();
    const fresh = new OutboxRelayRunner(
      new RelayOutboxEvents(new PrismaRelayUnitOfWork(prisma), clock),
      new DeliverDueWebhooks(
        new PrismaDeliveryQueue(prisma),
        new HttpWebhookSender(config),
        clock,
        Math.random,
        config,
      ),
      config,
    );
    await prisma.webhookDelivery.update({
      where: { id: failed.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    });

    await fresh.runOnce();

    expect(received).toHaveLength(2);
    expect(received[0].body).toBe(received[1].body);
    expect(await prisma.webhookDelivery.count()).toBe(1);
    expect(
      await prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: failed.id },
      }),
    ).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("gives up at once on a permanent client error and never retries it", async () => {
    statuses = [400];
    await deposit();

    await runner.runOnce();
    await runner.runOnce();

    expect(received).toHaveLength(1);
    expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "HTTP 400",
    });
  });

  it("delivers on its own once the runner is started, and stops cleanly", async () => {
    const config = buildRelayConfig({
      OUTBOX_RELAY_ENABLED: true,
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_BATCH_SIZE: 20,
      OUTBOX_LEASE_MS: 60_000,
      WEBHOOK_TIMEOUT_MS: 5000,
      WEBHOOK_MAX_ATTEMPTS: 3,
    });
    const clock = new SystemClock();
    const live = new OutboxRelayRunner(
      new RelayOutboxEvents(new PrismaRelayUnitOfWork(prisma), clock),
      new DeliverDueWebhooks(
        new PrismaDeliveryQueue(prisma),
        new HttpWebhookSender(config),
        clock,
        Math.random,
        config,
      ),
      config,
    );

    live.onModuleInit();
    try {
      await deposit();

      const deadline = Date.now() + 5000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(received).toHaveLength(1);
    } finally {
      await live.onModuleDestroy();
    }

    // Stopped: nothing new is picked up afterwards.
    await deposit("10");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toHaveLength(1);
  });

  it("sends nothing to an inactive endpoint", async () => {
    await prisma.webhookEndpoint.updateMany({ data: { active: false } });
    await deposit();

    await runner.runOnce();

    expect(received).toHaveLength(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("delivers nothing twice when the relay runs again", async () => {
    await deposit();

    await runner.runOnce();
    await runner.runOnce();

    expect(received).toHaveLength(1);
  });
});
