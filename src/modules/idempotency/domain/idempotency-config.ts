export interface IdempotencyEnv {
  IDEMPOTENCY_LEASE_MS: number;
  IDEMPOTENCY_TTL_HOURS: number;
  DB_TRANSACTION_MAX_WAIT_MS: number;
  DB_TRANSACTION_TIMEOUT_MS: number;
}

export interface IdempotencyConfig {
  leaseMs: number;
  ttlMs: number;
}

const LEASE_SAFETY_FACTOR = 3;

export function buildIdempotencyConfig(env: IdempotencyEnv): IdempotencyConfig {
  if (!(env.IDEMPOTENCY_LEASE_MS > 0)) {
    throw new Error("IDEMPOTENCY_LEASE_MS must be positive");
  }
  if (
    !Number.isInteger(env.IDEMPOTENCY_TTL_HOURS) ||
    env.IDEMPOTENCY_TTL_HOURS < 1
  ) {
    throw new Error("IDEMPOTENCY_TTL_HOURS must be a positive integer");
  }

  const minLease =
    LEASE_SAFETY_FACTOR *
    (env.DB_TRANSACTION_MAX_WAIT_MS + env.DB_TRANSACTION_TIMEOUT_MS);
  if (env.IDEMPOTENCY_LEASE_MS < minLease) {
    throw new Error(
      `IDEMPOTENCY_LEASE_MS (${env.IDEMPOTENCY_LEASE_MS}) must be at least ${LEASE_SAFETY_FACTOR}x the DB_TRANSACTION max wait + timeout (${minLease})`,
    );
  }

  return {
    leaseMs: env.IDEMPOTENCY_LEASE_MS,
    ttlMs: env.IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
  };
}
