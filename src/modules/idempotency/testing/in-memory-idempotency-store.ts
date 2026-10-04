import { randomUUID } from "node:crypto";
import { ExistingRecord } from "../domain/decide";
import {
  ClaimInput,
  ClaimResult,
  IdempotencyContext,
  IdempotencyPort,
  IdempotencyStore,
} from "../application/ports/idempotency-store.port";

export interface StoredRecord {
  id: string;
  userId: string;
  key: string;
  requestHash: string;
  status: ExistingRecord["status"];
  lockToken: string;
  leaseUntil: number;
  statusCode: number | null;
  response: unknown;
  createdAt: number;
}

/**
 * Fake of the store with the same fencing rules as the Prisma one and a clock
 * the test controls, so lease expiry needs no sleeping.
 */
export class InMemoryIdempotencyStore
  implements IdempotencyStore, IdempotencyPort
{
  readonly records = new Map<string, StoredRecord>();
  private clock = 1_000_000;

  advance(ms: number): void {
    this.clock += ms;
  }

  private find(userId: string, key: string): StoredRecord | undefined {
    return [...this.records.values()].find(
      (r) => r.userId === userId && r.key === key,
    );
  }

  private held({ recordId, lockToken }: IdempotencyContext) {
    const record = this.records.get(recordId);

    return record?.lockToken === lockToken && record.status === "IN_PROGRESS"
      ? record
      : undefined;
  }

  claim(input: ClaimInput): Promise<ClaimResult> {
    const existing = this.find(input.userId, input.key);
    if (existing) {
      return Promise.resolve({
        claimed: false,
        recordId: existing.id,
        existing: {
          status: existing.status,
          requestHash: existing.requestHash,
          statusCode: existing.statusCode,
          response: existing.response,
          leaseExpired: existing.leaseUntil <= this.clock,
          retryAfterSeconds: Math.ceil(
            (existing.leaseUntil - this.clock) / 1000,
          ),
        },
      });
    }

    const record: StoredRecord = {
      id: randomUUID(),
      userId: input.userId,
      key: input.key,
      requestHash: input.requestHash,
      status: "IN_PROGRESS",
      lockToken: randomUUID(),
      leaseUntil: this.clock + input.leaseMs,
      statusCode: null,
      response: null,
      createdAt: this.clock,
    };
    this.records.set(record.id, record);

    return Promise.resolve({
      claimed: true,
      context: { recordId: record.id, lockToken: record.lockToken },
    });
  }

  takeOver(
    recordId: string,
    leaseMs: number,
  ): Promise<IdempotencyContext | null> {
    const record = this.records.get(recordId);
    if (
      !record ||
      record.status !== "IN_PROGRESS" ||
      record.leaseUntil > this.clock
    ) {
      return Promise.resolve(null);
    }
    record.lockToken = randomUUID();
    record.leaseUntil = this.clock + leaseMs;

    return Promise.resolve({ recordId, lockToken: record.lockToken });
  }

  unlock(context: IdempotencyContext): Promise<boolean> {
    const record = this.held(context);
    if (record) record.leaseUntil = this.clock - 1000;

    return Promise.resolve(record !== undefined);
  }

  discard(context: IdempotencyContext): Promise<boolean> {
    const record = this.held(context);
    if (record) this.records.delete(record.id);

    return Promise.resolve(record !== undefined);
  }

  fail(
    context: IdempotencyContext,
    statusCode: number,
    body: unknown,
  ): Promise<boolean> {
    const record = this.held(context);
    if (record) {
      record.status = "FAILED";
      record.statusCode = statusCode;
      record.response = body;
    }

    return Promise.resolve(record !== undefined);
  }

  complete(
    context: IdempotencyContext,
    statusCode: number,
    body: unknown,
  ): Promise<boolean> {
    const record = this.held(context);
    if (record) {
      record.status = "COMPLETED";
      record.statusCode = statusCode;
      record.response = body;
    }

    return Promise.resolve(record !== undefined);
  }

  deleteOlderThan(ttlMs: number): Promise<number> {
    let deleted = 0;
    for (const record of [...this.records.values()]) {
      if (record.createdAt < this.clock - ttlMs) {
        this.records.delete(record.id);
        deleted++;
      }
    }

    return Promise.resolve(deleted);
  }
}
