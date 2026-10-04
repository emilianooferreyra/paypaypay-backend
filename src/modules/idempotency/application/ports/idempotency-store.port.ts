import type { ExistingRecord } from "../../domain/decide";

/** Proof of ownership of a claimed key: the fencing token. */
export interface IdempotencyContext {
  readonly recordId: string;
  readonly lockToken: string;
}

export interface ClaimInput {
  userId: string;
  key: string;
  route: string;
  requestHash: string;
  leaseMs: number;
}

export type ClaimResult =
  | { claimed: true; context: IdempotencyContext }
  | { claimed: false; recordId: string; existing: ExistingRecord };

/** Operations that run outside the money transaction. */
export interface IdempotencyStore {
  /** Atomically claims the key for this user; exactly one concurrent caller wins. */
  claim(input: ClaimInput): Promise<ClaimResult>;
  /** Takes an `IN_PROGRESS` record over once its lease expired; null otherwise. */
  takeOver(
    recordId: string,
    leaseMs: number,
  ): Promise<IdempotencyContext | null>;
  /** Releases the lease so the key can be taken over at once. */
  unlock(context: IdempotencyContext): Promise<boolean>;
  /** Deletes the claim so the key can be reused with a corrected request. */
  discard(context: IdempotencyContext): Promise<boolean>;
  /** Stores a deterministic failure so it replays. */
  fail(
    context: IdempotencyContext,
    statusCode: number,
    body: unknown,
  ): Promise<boolean>;
  /** Deletes records older than the retention; returns how many. */
  deleteOlderThan(ttlMs: number): Promise<number>;
}

/** Runs inside the money transaction, so completion commits with the balance. */
export interface IdempotencyPort {
  /** False when the token is stale (the lease was taken over). */
  complete(
    context: IdempotencyContext,
    statusCode: number,
    body: unknown,
  ): Promise<boolean>;
}

export const IDEMPOTENCY_STORE = Symbol("IDEMPOTENCY_STORE");
