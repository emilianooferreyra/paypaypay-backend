export interface ExistingRecord {
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  requestHash: string | null;
  statusCode: number | null;
  response: unknown;
  /** Computed by the database clock. */
  leaseExpired: boolean;
  retryAfterSeconds: number;
}

export type Decision =
  | { action: "claim" }
  | { action: "takeover" }
  | { action: "mismatch" }
  | { action: "conflict"; retryAfterSeconds: number }
  | { action: "replay"; statusCode: number; body: unknown; failed: boolean };

export function decide(
  existing: ExistingRecord | null,
  requestFingerprint: string,
): Decision {
  if (existing === null) return { action: "claim" };

  if (
    existing.requestHash !== null &&
    existing.requestHash !== requestFingerprint
  ) {
    return { action: "mismatch" };
  }

  if (existing.statusCode !== null) {
    return {
      action: "replay",
      statusCode: existing.statusCode,
      body: existing.response,
      failed: existing.status === "FAILED",
    };
  }

  if (existing.leaseExpired) return { action: "takeover" };

  return {
    action: "conflict",
    retryAfterSeconds: Math.max(1, existing.retryAfterSeconds),
  };
}
