import { buildIdempotencyConfig } from "./idempotency-config";

const env = {
  IDEMPOTENCY_LEASE_MS: 60_000,
  IDEMPOTENCY_TTL_HOURS: 72,
  DB_TRANSACTION_MAX_WAIT_MS: 5000,
  DB_TRANSACTION_TIMEOUT_MS: 10_000,
};

describe("buildIdempotencyConfig", () => {
  it("maps the environment", () => {
    expect(buildIdempotencyConfig(env)).toEqual({
      leaseMs: 60_000,
      ttlMs: 72 * 60 * 60 * 1000,
    });
  });

  it("accepts a lease of exactly three times the longest money transaction", () => {
    expect(() =>
      buildIdempotencyConfig({ ...env, IDEMPOTENCY_LEASE_MS: 45_000 }),
    ).not.toThrow();
  });

  it("refuses a lease that could expire while a money transaction is still running", () => {
    expect(() =>
      buildIdempotencyConfig({ ...env, IDEMPOTENCY_LEASE_MS: 44_999 }),
    ).toThrow(/IDEMPOTENCY_LEASE_MS.*DB_TRANSACTION/s);
  });

  it("follows the transaction limits it is given", () => {
    expect(() =>
      buildIdempotencyConfig({
        ...env,
        DB_TRANSACTION_TIMEOUT_MS: 30_000,
      }),
    ).toThrow();
  });

  it.each([
    ["IDEMPOTENCY_LEASE_MS", 0],
    ["IDEMPOTENCY_TTL_HOURS", 0],
    ["IDEMPOTENCY_TTL_HOURS", 1.5],
  ])("refuses %s = %s", (key, value) => {
    expect(() => buildIdempotencyConfig({ ...env, [key]: value })).toThrow();
  });
});
