import { buildRelayConfig } from "./relay-config.factory";

const base = {
  OUTBOX_RELAY_ENABLED: true,
  OUTBOX_POLL_INTERVAL_MS: 1000,
  OUTBOX_BATCH_SIZE: 20,
  OUTBOX_LEASE_MS: 60_000,
  WEBHOOK_TIMEOUT_MS: 5000,
  WEBHOOK_MAX_ATTEMPTS: 3,
};

describe("buildRelayConfig", () => {
  it("maps the environment into the relay configuration", () => {
    const config = buildRelayConfig(base);

    expect(config).toMatchObject({
      enabled: true,
      pollIntervalMs: 1000,
      batchSize: 20,
      leaseMs: 60_000,
      timeoutMs: 5000,
    });
    expect(config.retry.maxAttempts).toBe(3);
    expect(config.retry.delaysMs).toEqual([60_000, 300_000, 900_000]);
  });

  it("refuses a lease that is not clearly longer than the request timeout", () => {
    expect(() =>
      buildRelayConfig({
        ...base,
        OUTBOX_LEASE_MS: 8000,
        WEBHOOK_TIMEOUT_MS: 5000,
      }),
    ).toThrow(/lease/i);
  });

  it("accepts a lease that is exactly twice the timeout", () => {
    expect(() =>
      buildRelayConfig({
        ...base,
        OUTBOX_LEASE_MS: 10_000,
        WEBHOOK_TIMEOUT_MS: 5000,
      }),
    ).not.toThrow();
  });

  it.each([
    ["OUTBOX_BATCH_SIZE", 0],
    ["OUTBOX_POLL_INTERVAL_MS", 0],
    ["WEBHOOK_TIMEOUT_MS", 0],
    ["WEBHOOK_MAX_ATTEMPTS", 0],
    ["OUTBOX_BATCH_SIZE", 1.5],
  ])("refuses %s = %s", (key, value) => {
    expect(() => buildRelayConfig({ ...base, [key]: value })).toThrow();
  });
});
