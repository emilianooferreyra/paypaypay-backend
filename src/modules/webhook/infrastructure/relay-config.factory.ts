import { DEFAULT_RETRY_POLICY, RetryPolicy } from "../domain/delivery-policy";
import { RelayConfig } from "../application/ports/relay-config";

/** The slice of the validated environment the relay reads. */
export interface RelayEnv {
  OUTBOX_RELAY_ENABLED: boolean;
  OUTBOX_POLL_INTERVAL_MS: number;
  OUTBOX_BATCH_SIZE: number;
  OUTBOX_LEASE_MS: number;
  WEBHOOK_TIMEOUT_MS: number;
  WEBHOOK_MAX_ATTEMPTS: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/**
 * Builds the relay configuration and refuses combinations that would break
 * delivery. The lease must outlive every call in a batch: batch members run
 * concurrently and are each cut off by the timeout, so twice the timeout is
 * the smallest lease with room for claiming and recording. A shorter one would
 * let a second worker take a delivery that is still being sent.
 */
export function buildRelayConfig(env: RelayEnv): RelayConfig {
  const timeoutMs = positiveInteger(
    "WEBHOOK_TIMEOUT_MS",
    env.WEBHOOK_TIMEOUT_MS,
  );
  const leaseMs = positiveInteger("OUTBOX_LEASE_MS", env.OUTBOX_LEASE_MS);

  if (leaseMs < timeoutMs * 2) {
    throw new Error(
      `OUTBOX_LEASE_MS (${leaseMs}) must be at least twice WEBHOOK_TIMEOUT_MS (${timeoutMs}): the lease has to outlive the slowest call in a batch`,
    );
  }

  const retry: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: positiveInteger(
      "WEBHOOK_MAX_ATTEMPTS",
      env.WEBHOOK_MAX_ATTEMPTS,
    ),
  };

  return {
    enabled: env.OUTBOX_RELAY_ENABLED,
    pollIntervalMs: positiveInteger(
      "OUTBOX_POLL_INTERVAL_MS",
      env.OUTBOX_POLL_INTERVAL_MS,
    ),
    batchSize: positiveInteger("OUTBOX_BATCH_SIZE", env.OUTBOX_BATCH_SIZE),
    leaseMs,
    timeoutMs,
    retry,
  };
}
