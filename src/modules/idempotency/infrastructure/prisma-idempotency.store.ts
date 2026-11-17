import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ExistingRecord } from "../domain/decide";
import {
  ClaimInput,
  ClaimResult,
  IdempotencyContext,
  IdempotencyStore,
} from "../application/ports/idempotency-store.port";

interface ExistingRow {
  id: string;
  status: ExistingRecord["status"];
  requestHash: string | null;
  statusCode: number | null;
  response: unknown;
  leaseExpired: boolean;
  retryAfterSeconds: number;
}

const MAX_CLAIM_ATTEMPTS = 3;

/**
 * Every time comparison uses the database clock (`now() AT TIME ZONE 'UTC'`),
 * never the application's, so instances with skewed clocks agree on who owns a
 * lease. Every state change is a single conditional UPDATE keyed by the
 * fencing token: a holder whose lease was taken over simply matches no row.
 */
@Injectable()
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly prisma: PrismaService) {}

  async claim(input: ClaimInput): Promise<ClaimResult> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const lockToken = randomUUID();
      const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "IdempotencyRecord"
          ("id", "userId", "key", "route", "status", "requestHash",
           "lockToken", "lockedUntil", "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${input.userId}, ${input.key}, ${input.route},
           'IN_PROGRESS'::"IdempotencyStatusEnum", ${input.requestHash},
           ${lockToken},
           (now() AT TIME ZONE 'UTC') + make_interval(secs => ${input.leaseMs / 1000}),
           now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
        ON CONFLICT ("userId", "key") DO NOTHING
        RETURNING "id"
      `;
      if (inserted.length === 1) {
        return {
          claimed: true,
          context: { recordId: inserted[0].id, lockToken },
        };
      }

      const rows = await this.prisma.$queryRaw<ExistingRow[]>`
        SELECT "id", "status"::text AS "status", "requestHash", "statusCode",
               "response",
               ("lockedUntil" IS NULL OR "lockedUntil" <= now() AT TIME ZONE 'UTC') AS "leaseExpired",
               COALESCE(CEIL(EXTRACT(EPOCH FROM ("lockedUntil" - (now() AT TIME ZONE 'UTC'))))::int, 0) AS "retryAfterSeconds"
        FROM "IdempotencyRecord"
        WHERE "userId" = ${input.userId} AND "key" = ${input.key}
      `;
      // The winner may have discarded its claim between our INSERT and SELECT.
      if (rows.length === 0) continue;

      const { id, ...existing } = rows[0];

      return { claimed: false, recordId: id, existing };
    }

    throw new Error("Could not settle the idempotency claim");
  }

  async takeOver(
    recordId: string,
    leaseMs: number,
  ): Promise<IdempotencyContext | null> {
    const lockToken = randomUUID();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "IdempotencyRecord"
      SET "lockToken" = ${lockToken},
          "lockedUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}),
          "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "id" = ${recordId}
        AND "status" = 'IN_PROGRESS'::"IdempotencyStatusEnum"
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= now() AT TIME ZONE 'UTC')
      RETURNING "id"
    `;

    return rows.length === 1 ? { recordId, lockToken } : null;
  }

  async unlock({ recordId, lockToken }: IdempotencyContext): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "IdempotencyRecord"
      SET "lockedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second',
          "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "id" = ${recordId}
        AND "lockToken" = ${lockToken}
        AND "status" = 'IN_PROGRESS'::"IdempotencyStatusEnum"
    `;

    return updated === 1;
  }

  async discard({ recordId, lockToken }: IdempotencyContext): Promise<boolean> {
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "IdempotencyRecord"
      WHERE "id" = ${recordId}
        AND "lockToken" = ${lockToken}
        AND "status" = 'IN_PROGRESS'::"IdempotencyStatusEnum"
    `;

    return deleted === 1;
  }

  async fail(
    { recordId, lockToken }: IdempotencyContext,
    statusCode: number,
    body: unknown,
  ): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "IdempotencyRecord"
      SET "status" = 'FAILED'::"IdempotencyStatusEnum",
          "statusCode" = ${statusCode},
          "response" = ${JSON.stringify(body)}::jsonb,
          "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "id" = ${recordId}
        AND "lockToken" = ${lockToken}
        AND "status" = 'IN_PROGRESS'::"IdempotencyStatusEnum"
    `;

    return updated === 1;
  }

  async deleteOlderThan(ttlMs: number): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM "IdempotencyRecord"
      WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${ttlMs / 1000})
    `;
  }
}
