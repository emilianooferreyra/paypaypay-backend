import { Logger } from "@nestjs/common";
import { InMemoryIdempotencyStore } from "../testing/in-memory-idempotency-store";
import { IdempotencyCleanupService } from "./idempotency-cleanup.service";

const HOUR_MS = 60 * 60 * 1000;
const TTL_MS = 72 * HOUR_MS;

describe("IdempotencyCleanupService", () => {
  let store: InMemoryIdempotencyStore;
  let service: IdempotencyCleanupService;

  const claim = (key: string) =>
    store.claim({
      userId: "user-1",
      key,
      route: "/wallet/deposit",
      requestHash: "hash",
      leaseMs: 60_000,
    });

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    service = new IdempotencyCleanupService(store, { ttlMs: TTL_MS });
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it("deletes only the records older than the configured retention", async () => {
    await claim("old");
    store.advance(73 * HOUR_MS);
    await claim("recent");

    await service.cleanup();

    expect([...store.records.values()].map((r) => r.key)).toEqual(["recent"]);
  });

  it("uses the configured retention, not a fixed one", async () => {
    service = new IdempotencyCleanupService(store, { ttlMs: 2 * HOUR_MS });
    await claim("old");
    store.advance(3 * HOUR_MS);

    await service.cleanup();

    expect(store.records.size).toBe(0);
  });

  it("does nothing when nothing expired", async () => {
    await claim("fresh");

    await service.cleanup();

    expect(store.records.size).toBe(1);
  });

  it("survives a database error", async () => {
    jest.spyOn(store, "deleteOlderThan").mockRejectedValue(new Error("down"));

    await expect(service.cleanup()).resolves.toBeUndefined();
  });

  it("runs on bootstrap and then every hour, and stops on shutdown", () => {
    jest.useFakeTimers();
    const cleanup = jest.spyOn(service, "cleanup").mockResolvedValue();

    service.onApplicationBootstrap();
    expect(cleanup).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(HOUR_MS);
    expect(cleanup).toHaveBeenCalledTimes(2);

    service.onApplicationShutdown();
    jest.advanceTimersByTime(3 * HOUR_MS);
    expect(cleanup).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
