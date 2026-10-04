import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import type { DeliveryDecision } from "../../domain/delivery-policy";
import type {
  DeliveryQueue,
  DueDelivery,
} from "../../application/ports/delivery.repository";

interface ClaimedRow {
  id: string;
  eventId: string;
  url: string;
  secret: string;
  payload: string;
  attempts: number;
}

@Injectable()
export class PrismaDeliveryQueue implements DeliveryQueue {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One statement: pick due rows, lock them only long enough to stamp a lease,
   * return them. No transaction stays open while the endpoint is called.
   *
   * Time comes from the database (`now()` in UTC, the way Prisma stores
   * timestamps), so several app instances agree on what "due" and "expired"
   * mean whatever their own clocks say.
   */
  async claimDue(limit: number, leaseMs: number): Promise<DueDelivery[]> {
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "WebhookDelivery" AS d
      SET "lockedUntil" =
        (now() AT TIME ZONE 'UTC') + (${leaseMs}::double precision * interval '1 millisecond')
      FROM (
        SELECT delivery.id
        FROM "WebhookDelivery" AS delivery
        JOIN "WebhookEndpoint" AS endpoint ON endpoint.id = delivery."endpointId"
        JOIN "OutboxEvent" AS event ON event.id = delivery."eventId"
        WHERE delivery.status IN ('pending', 'failed')
          AND endpoint.active = true
          AND delivery."nextRetryAt" <= (now() AT TIME ZONE 'UTC')
          AND (
            delivery."lockedUntil" IS NULL
            OR delivery."lockedUntil" < (now() AT TIME ZONE 'UTC')
          )
        ORDER BY delivery."nextRetryAt", event.seq
        LIMIT ${limit}
        FOR UPDATE OF delivery SKIP LOCKED
      ) AS due, "WebhookEndpoint" AS target
      WHERE d.id = due.id
        AND target.id = d."endpointId"
      RETURNING d.id, d."eventId", target.url, target.secret, d.payload, d.attempts
    `;

    // RETURNING does not promise the subquery's order, and nothing relies on
    // it: the ORDER BY decides which rows are taken when there are more than
    // `limit`, and the batch is delivered concurrently anyway.
    return rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      url: row.url,
      secret: row.secret,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  async record(deliveryId: string, decision: DeliveryDecision): Promise<void> {
    await this.prisma.webhookDelivery.updateMany({
      // A worker whose lease expired may finish after another one already
      // settled the delivery; a final state is never overwritten.
      where: { id: deliveryId, status: { in: ["pending", "failed"] } },
      data: {
        status: decision.status,
        attempts: decision.attempts,
        responseStatus: decision.responseStatus ?? null,
        lastError: decision.status === "delivered" ? null : decision.lastError,
        lockedUntil: null,
        ...(decision.status === "failed"
          ? { nextRetryAt: decision.nextRetryAt }
          : {}),
      },
    });
  }
}
