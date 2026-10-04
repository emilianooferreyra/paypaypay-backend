import { Injectable } from "@nestjs/common";
import { Prisma } from "../../../../generated/prisma/client.js";
import { envs } from "../../../../config";
import { PrismaService } from "../../../prisma/prisma.service";
import type {
  RelayTx,
  RelayUnitOfWork,
} from "../../application/ports/relay-unit-of-work.port";
import type {
  DeliveryRepository,
  NewDelivery,
} from "../../application/ports/delivery.repository";
import type {
  ActiveEndpoint,
  EndpointRepository,
} from "../../application/ports/endpoint.repository";
import type {
  OutboxEventRecord,
  OutboxEventRepository,
} from "../../application/ports/outbox-event.repository";

interface EventRow {
  id: string;
  type: string;
  payload: Prisma.JsonValue;
  occurredAt: Date;
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : { value };
}

class PrismaOutboxEventRepository implements OutboxEventRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async claimUnprocessed(limit: number): Promise<OutboxEventRecord[]> {
    // Row locks for the length of this transaction. SKIP LOCKED makes another
    // relay running at the same time take different rows instead of waiting.
    const rows = await this.tx.$queryRaw<EventRow[]>`
      SELECT id, type, payload, "occurredAt"
      FROM "OutboxEvent"
      WHERE "processedAt" IS NULL
      ORDER BY seq
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: asRecord(row.payload),
      occurredAt: row.occurredAt,
    }));
  }

  async markProcessed(ids: readonly string[], at: Date): Promise<void> {
    await this.tx.outboxEvent.updateMany({
      where: { id: { in: [...ids] } },
      data: { processedAt: at },
    });
  }
}

class PrismaEndpointRepository implements EndpointRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  findActive(): Promise<readonly ActiveEndpoint[]> {
    return this.tx.webhookEndpoint.findMany({
      where: { active: true },
      select: { id: true },
    });
  }
}

class PrismaDeliveryRepository implements DeliveryRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async createIfAbsent(deliveries: readonly NewDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;

    // The unique (eventId, endpointId) turns a repeated fan-out into a no-op.
    await this.tx.webhookDelivery.createMany({
      data: deliveries.map((delivery) => ({
        eventId: delivery.eventId,
        endpointId: delivery.endpointId,
        event: delivery.event,
        payload: delivery.payload,
        status: "pending",
        attempts: 0,
        nextRetryAt: delivery.dueAt,
      })),
      skipDuplicates: true,
    });
  }
}

@Injectable()
export class PrismaRelayUnitOfWork implements RelayUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: RelayTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (tx) =>
        work({
          events: new PrismaOutboxEventRepository(tx),
          endpoints: new PrismaEndpointRepository(tx),
          deliveries: new PrismaDeliveryRepository(tx),
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: envs.DB_TRANSACTION_MAX_WAIT_MS,
        timeout: envs.DB_TRANSACTION_TIMEOUT_MS,
      },
    );
  }
}
