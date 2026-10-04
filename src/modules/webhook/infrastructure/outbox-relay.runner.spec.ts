import { DEFAULT_RETRY_POLICY } from "../domain/delivery-policy";
import { RelayConfig } from "../application/ports/relay-config";
import { OutboxRelayRunner } from "./outbox-relay.runner";

const config = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
  enabled: true,
  pollIntervalMs: 1000,
  batchSize: 20,
  leaseMs: 60_000,
  timeoutMs: 5000,
  retry: DEFAULT_RETRY_POLICY,
  ...overrides,
});

describe("OutboxRelayRunner", () => {
  let relay: { execute: jest.Mock<Promise<number>, [number]> };
  let deliver: { execute: jest.Mock<Promise<number>, []> };

  const makeRunner = (overrides: Partial<RelayConfig> = {}) =>
    new OutboxRelayRunner(relay, deliver, config(overrides));

  beforeEach(() => {
    jest.useFakeTimers();
    relay = { execute: jest.fn().mockResolvedValue(0) };
    deliver = { execute: jest.fn().mockResolvedValue(0) };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("schedules nothing when it is disabled", async () => {
    const runner = makeRunner({ enabled: false });

    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(jest.getTimerCount()).toBe(0);
    expect(relay.execute).not.toHaveBeenCalled();
    expect(deliver.execute).not.toHaveBeenCalled();
  });

  it("fans out and then delivers on every cycle, with the configured batch size", async () => {
    const runner = makeRunner({ batchSize: 7 });

    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(relay.execute).toHaveBeenCalledWith(7);
    expect(deliver.execute).toHaveBeenCalledTimes(1);
    await runner.onModuleDestroy();
  });

  it("waits the poll interval when there was nothing to do", async () => {
    const runner = makeRunner({ pollIntervalMs: 1000 });

    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(relay.execute).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(999);
    expect(relay.execute).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(relay.execute).toHaveBeenCalledTimes(2);
    await runner.onModuleDestroy();
  });

  it("runs the next cycle straight away while there is work, to drain a backlog", async () => {
    relay.execute.mockResolvedValueOnce(5).mockResolvedValue(0);
    const runner = makeRunner({ pollIntervalMs: 60_000 });

    runner.onModuleInit();
    // 10 ms is nowhere near the 60 s interval: a second call can only be the
    // immediate follow-up.
    await jest.advanceTimersByTimeAsync(10);

    expect(relay.execute).toHaveBeenCalledTimes(2);
    await runner.onModuleDestroy();
  });

  it("keeps going after a cycle fails, after waiting the poll interval", async () => {
    relay.execute
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(0);
    const runner = makeRunner({ pollIntervalMs: 1000 });

    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(relay.execute).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(relay.execute).toHaveBeenCalledTimes(2);
    await runner.onModuleDestroy();
  });

  it("never overlaps two cycles, even when one takes longer than the interval", async () => {
    let finish: () => void = () => undefined;
    relay.execute.mockImplementationOnce(
      () => new Promise<number>((resolve) => (finish = () => resolve(0))),
    );
    const runner = makeRunner({ pollIntervalMs: 100 });

    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5000);

    expect(relay.execute).toHaveBeenCalledTimes(1);

    finish();
    await jest.advanceTimersByTimeAsync(100);
    expect(relay.execute).toHaveBeenCalledTimes(2);
    await runner.onModuleDestroy();
  });

  it("waits for the batch in flight on shutdown and starts no other", async () => {
    let finish: () => void = () => undefined;
    deliver.execute.mockImplementationOnce(
      () => new Promise<number>((resolve) => (finish = () => resolve(1))),
    );
    const runner = makeRunner({ pollIntervalMs: 100 });

    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    let destroyed = false;
    const destroying = runner.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(destroyed).toBe(false);

    finish();
    await destroying;
    expect(destroyed).toBe(true);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(relay.execute).toHaveBeenCalledTimes(1);
  });

  it("runOnce performs one cycle on demand and reports the counts", async () => {
    relay.execute.mockResolvedValue(2);
    deliver.execute.mockResolvedValue(3);
    const runner = makeRunner({ enabled: false });

    await expect(runner.runOnce()).resolves.toEqual({
      relayed: 2,
      delivered: 3,
    });
  });
});
