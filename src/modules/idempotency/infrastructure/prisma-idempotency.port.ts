import { Prisma } from "../../../generated/prisma/client.js";
import {
  IdempotencyContext,
  IdempotencyPort,
} from "../application/ports/idempotency-store.port";

/**
 * Completes the record through the money transaction's own client, so the
 * stored response commits or rolls back together with the balance.
 */
export class PrismaIdempotencyPort implements IdempotencyPort {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async complete(
    { recordId, lockToken }: IdempotencyContext,
    statusCode: number,
    body: unknown,
  ): Promise<boolean> {
    const updated = await this.tx.$executeRaw`
      UPDATE "IdempotencyRecord"
      SET "status" = 'COMPLETED'::"IdempotencyStatusEnum",
          "statusCode" = ${statusCode},
          "response" = ${JSON.stringify(body)}::jsonb,
          "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "id" = ${recordId}
        AND "lockToken" = ${lockToken}
        AND "status" = 'IN_PROGRESS'::"IdempotencyStatusEnum"
    `;

    return updated === 1;
  }
}
