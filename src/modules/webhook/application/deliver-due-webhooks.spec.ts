import {
  InMemoryWebhookStore,
  MutableClock,
  ScriptedSender,
} from "../testing/in-memory-webhook-store";
import { DEFAULT_RETRY_POLICY } from "../domain/delivery-policy";
import { RelayConfig } from "./ports/relay-config";
import { DeliverDueWebhooks } from "./deliver-due-webhooks";

const config: RelayConfig = {
  enabled: true,
  pollIntervalMs: 1000,
  batchSize: 20,
  leaseMs: 60_000,
  timeoutMs: 5000,
  retry: DEFAULT_RETRY_POLICY,
};
const noJitter = () => 0.5;

describe("DeliverDueWebhooks", () => {
  let clock: MutableClock;
  let store: InMemoryWebhookStore;
  let sender: ScriptedSender;
  let deliver: DeliverDueWebhooks;

  const seedDelivery = (overrides = {}) => {
    const event = store.addEvent({ type: "deposit.confirmed" });
    const endpoint = store.addEndpoint();
    return store.addDelivery({
      eventId: event.id,
      endpointId: endpoint.id,
      payload: '{"id":"evt"}',
      ...overrides,
    });
  };

  beforeEach(() => {
    clock = new MutableClock(new Date("2026-09-30T12:00:00.000Z"));
    store = new InMemoryWebhookStore(clock);
    sender = new ScriptedSender();
    deliver = new DeliverDueWebhooks(store, sender, clock, noJitter, config);
  });

  it("sends the stored body, signed with the endpoint secret, tagged with the event id", async () => {
    const event = store.addEvent({ type: "deposit.confirmed" });
    const endpoint = store.addEndpoint({
      url: "https://merchant.example/a",
      secret: "topsecret",
    });
    store.addDelivery({
      eventId: event.id,
      endpointId: endpoint.id,
      payload: '{"id":"evt-1"}',
    });

    await deliver.execute();

    expect(sender.requests).toEqual([
      {
        url: "https://merchant.example/a",
        secret: "topsecret",
        eventId: event.id,
        body: '{"id":"evt-1"}',
      },
    ]);
  });

  it("marks a 2xx as delivered and records the response status", async () => {
    const delivery = seedDelivery();
    sender.willRespond({ kind: "response", status: 200 });

    await deliver.execute();

    expect(store.deliveries[0]).toMatchObject({
      id: delivery.id,
      status: "delivered",
      attempts: 1,
      responseStatus: 200,
      lastError: null,
      lockedUntil: null,
    });
  });

  it("schedules the retry in the database, about a minute ahead, after a 503", async () => {
    seedDelivery();
    sender.willRespond({ kind: "response", status: 503 });

    await deliver.execute();

    expect(store.deliveries[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      responseStatus: 503,
      lastError: "HTTP 503",
      nextRetryAt: new Date("2026-09-30T12:01:00.000Z"),
    });
  });

  it("goes straight to dead on a 400", async () => {
    seedDelivery();
    sender.willRespond({ kind: "response", status: 400 });

    await deliver.execute();

    expect(store.deliveries[0]).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "HTTP 400",
    });
  });

  it("goes dead when the attempts are exhausted, and keeps the row", async () => {
    seedDelivery({ status: "failed", attempts: 2 });
    sender.willRespond({ kind: "response", status: 500 });

    await deliver.execute();

    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({ status: "dead", attempts: 3 });
  });

  it("retries on the same row: the table does not grow", async () => {
    seedDelivery();
    sender.willRespond(
      { kind: "response", status: 503 },
      { kind: "response", status: 200 },
    );

    await deliver.execute();
    clock.advance(61_000);
    await deliver.execute();

    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
  });

  it("does not send a delivery before it is due", async () => {
    seedDelivery({
      status: "failed",
      attempts: 1,
      nextRetryAt: new Date("2026-09-30T12:01:00.000Z"),
    });

    const claimed = await deliver.execute();

    expect(claimed).toBe(0);
    expect(sender.requests).toHaveLength(0);
  });

  it("does not send a delivery another worker holds under a live lease", async () => {
    seedDelivery({ lockedUntil: new Date("2026-09-30T12:00:30.000Z") });

    await deliver.execute();

    expect(sender.requests).toHaveLength(0);
  });

  it("picks up a delivery whose lease expired", async () => {
    seedDelivery({ lockedUntil: new Date("2026-09-30T11:59:00.000Z") });

    await deliver.execute();

    expect(sender.requests).toHaveLength(1);
  });

  it("never resends a delivered or dead delivery", async () => {
    seedDelivery({ status: "delivered", attempts: 1 });
    seedDelivery({ status: "dead", attempts: 3 });

    await deliver.execute();

    expect(sender.requests).toHaveLength(0);
  });

  it("treats an unexpected error from the sender as a retryable failure", async () => {
    seedDelivery();
    sender.willRespond(new Error("socket hang up"));

    await deliver.execute();

    expect(store.deliveries[0]).toMatchObject({
      status: "failed",
      lastError: "socket hang up",
    });
  });

  it("does not let one failing delivery stop the others from being recorded", async () => {
    seedDelivery();
    seedDelivery();
    sender.willRespond(new Error("boom"), { kind: "response", status: 200 });

    await deliver.execute();

    expect(store.deliveries.map((d) => d.status).sort()).toEqual([
      "delivered",
      "failed",
    ]);
  });

  it("calls the endpoints concurrently, so a slow one cannot outlive the lease for the rest", async () => {
    seedDelivery();
    seedDelivery();
    seedDelivery();
    const release = sender.holdUntilReleased();

    const running = deliver.execute();
    await new Promise((resolve) => setImmediate(resolve));

    expect(sender.requests).toHaveLength(3);

    release();
    await running;
  });

  it("returns how many deliveries it handled", async () => {
    seedDelivery();
    seedDelivery();

    expect(await deliver.execute()).toBe(2);
    expect(await deliver.execute()).toBe(0);
  });
});
