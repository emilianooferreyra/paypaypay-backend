import {
  InMemoryWebhookStore,
  MutableClock,
} from "../testing/in-memory-webhook-store";
import { RelayOutboxEvents } from "./relay-outbox-events";

describe("RelayOutboxEvents", () => {
  let clock: MutableClock;
  let store: InMemoryWebhookStore;
  let relay: RelayOutboxEvents;

  beforeEach(() => {
    clock = new MutableClock(new Date("2026-09-30T12:00:00.000Z"));
    store = new InMemoryWebhookStore(clock);
    relay = new RelayOutboxEvents(store, clock);
  });

  it("creates one pending delivery per active endpoint and marks the event processed", async () => {
    const event = store.addEvent({ type: "deposit.confirmed" });
    const a = store.addEndpoint();
    const b = store.addEndpoint();

    const processed = await relay.execute(10);

    expect(processed).toBe(1);
    expect(store.deliveries).toHaveLength(2);
    expect(store.deliveries.map((d) => d.endpointId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(store.deliveries.every((d) => d.status === "pending")).toBe(true);
    expect(store.deliveries.every((d) => d.attempts === 0)).toBe(true);
    expect(store.events.find((e) => e.id === event.id)?.processedAt).toEqual(
      clock.now(),
    );
  });

  it("makes each delivery due right away", async () => {
    store.addEvent({ type: "deposit.confirmed" });
    store.addEndpoint();

    await relay.execute(10);

    expect(store.deliveries[0].nextRetryAt).toEqual(clock.now());
  });

  it("marks the event processed even when there is no endpoint to notify", async () => {
    const event = store.addEvent({ type: "deposit.confirmed" });

    await relay.execute(10);

    expect(store.deliveries).toHaveLength(0);
    expect(store.events.find((e) => e.id === event.id)?.processedAt).not.toBe(
      null,
    );
  });

  it("ignores inactive endpoints", async () => {
    store.addEvent({ type: "deposit.confirmed" });
    store.addEndpoint({ active: false });

    await relay.execute(10);

    expect(store.deliveries).toHaveLength(0);
  });

  it("builds one body with the event id, type, data and the time it happened", async () => {
    const event = store.addEvent({
      type: "withdraw.completed",
      payload: { walletId: "w1", amount: "400" },
      occurredAt: new Date("2026-09-30T11:30:00.000Z"),
    });
    store.addEndpoint();
    store.addEndpoint();

    await relay.execute(10);

    const bodies = new Set(store.deliveries.map((d) => d.payload));
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0])).toEqual({
      id: event.id,
      event: "withdraw.completed",
      data: { walletId: "w1", amount: "400" },
      timestamp: "2026-09-30T11:30:00.000Z",
    });
  });

  it("does not duplicate a delivery that already exists", async () => {
    const event = store.addEvent({ type: "deposit.confirmed" });
    const a = store.addEndpoint();
    const b = store.addEndpoint();
    store.addDelivery({ eventId: event.id, endpointId: a.id });

    await relay.execute(10);

    expect(store.deliveries).toHaveLength(2);
    expect(store.deliveries.filter((d) => d.endpointId === a.id)).toHaveLength(
      1,
    );
    expect(store.deliveries.filter((d) => d.endpointId === b.id)).toHaveLength(
      1,
    );
  });

  it("does nothing the second time", async () => {
    store.addEvent({ type: "deposit.confirmed" });
    store.addEndpoint();

    await relay.execute(10);
    const again = await relay.execute(10);

    expect(again).toBe(0);
    expect(store.deliveries).toHaveLength(1);
  });

  it("respects the batch size and finishes the rest on the next run", async () => {
    store.addEndpoint();
    store.addEvent({ type: "deposit.confirmed" });
    store.addEvent({ type: "deposit.confirmed" });
    store.addEvent({ type: "deposit.confirmed" });

    expect(await relay.execute(2)).toBe(2);
    expect(store.deliveries).toHaveLength(2);

    expect(await relay.execute(2)).toBe(1);
    expect(store.deliveries).toHaveLength(3);
  });

  it("leaves the event unprocessed when creating a delivery fails", async () => {
    const event = store.addEvent({ type: "deposit.confirmed" });
    store.addEndpoint();
    store.injectDeliveryInsertFailure(new Error("insert failed"));

    await expect(relay.execute(10)).rejects.toThrow("insert failed");

    expect(store.deliveries).toHaveLength(0);
    expect(store.events.find((e) => e.id === event.id)?.processedAt).toBe(null);
  });
});
