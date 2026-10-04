import { randomUUID } from "node:crypto";
import { DeliveryDecision } from "../domain/delivery-policy";
import { Clock } from "../application/ports/clock.port";
import {
  DeliveryQueue,
  DeliveryRepository,
  DueDelivery,
  NewDelivery,
} from "../application/ports/delivery.repository";
import { EndpointRepository } from "../application/ports/endpoint.repository";
import {
  OutboxEventRecord,
  OutboxEventRepository,
} from "../application/ports/outbox-event.repository";
import {
  RelayTx,
  RelayUnitOfWork,
} from "../application/ports/relay-unit-of-work.port";
import {
  WebhookRequest,
  WebhookSender,
} from "../application/ports/webhook-sender.port";
import { DeliveryOutcome } from "../domain/delivery-policy";

export class MutableClock implements Clock {
  constructor(public current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface StoredEvent extends OutboxEventRecord {
  processedAt: Date | null;
}

export interface StoredEndpoint {
  id: string;
  url: string;
  secret: string;
  active: boolean;
}

export interface StoredDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  event: string;
  payload: string;
  status: "pending" | "failed" | "delivered" | "dead";
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextRetryAt: Date;
  lockedUntil: Date | null;
}

/**
 * In-memory stand-in for the webhook persistence ports. A `run` commits all or
 * nothing, fan-out is idempotent per (event, endpoint), and a claimed delivery
 * stays invisible until its lease expires. Concurrency between real workers
 * (SKIP LOCKED) is proven by the integration test against Postgres.
 */
export class InMemoryWebhookStore implements RelayUnitOfWork, DeliveryQueue {
  events: StoredEvent[] = [];
  endpoints: StoredEndpoint[] = [];
  deliveries: StoredDelivery[] = [];
  private failNextInsert: Error | null = null;

  constructor(private readonly clock: Clock) {}

  addEvent(input: {
    type: string;
    payload?: Record<string, unknown>;
    occurredAt?: Date;
  }): StoredEvent {
    const event: StoredEvent = {
      id: randomUUID(),
      type: input.type,
      payload: input.payload ?? { walletId: "w1" },
      occurredAt: input.occurredAt ?? new Date("2026-09-30T11:59:00.000Z"),
      processedAt: null,
    };
    this.events.push(event);
    return event;
  }

  addEndpoint(input?: Partial<StoredEndpoint>): StoredEndpoint {
    const endpoint: StoredEndpoint = {
      id: randomUUID(),
      url: "https://merchant.example/hooks",
      secret: "s3cret",
      active: true,
      ...input,
    };
    this.endpoints.push(endpoint);
    return endpoint;
  }

  addDelivery(
    input: Partial<StoredDelivery> &
      Pick<StoredDelivery, "eventId" | "endpointId">,
  ): StoredDelivery {
    const delivery: StoredDelivery = {
      id: randomUUID(),
      event: "deposit.confirmed",
      payload: '{"id":"x"}',
      status: "pending",
      attempts: 0,
      responseStatus: null,
      lastError: null,
      nextRetryAt: this.clock.now(),
      lockedUntil: null,
      ...input,
    };
    this.deliveries.push(delivery);
    return delivery;
  }

  injectDeliveryInsertFailure(error: Error): void {
    this.failNextInsert = error;
  }

  async run<T>(work: (tx: RelayTx) => Promise<T>): Promise<T> {
    const events = this.events.map((e) => ({ ...e }));
    const deliveries = this.deliveries.map((d) => ({ ...d }));

    try {
      return await work({
        events: this.eventRepository(),
        endpoints: this.endpointRepository(),
        deliveries: this.deliveryRepository(),
      });
    } catch (error) {
      this.events = events;
      this.deliveries = deliveries;
      throw error;
    }
  }

  private eventRepository(): OutboxEventRepository {
    return {
      claimUnprocessed: (limit) =>
        Promise.resolve(
          this.events.filter((e) => e.processedAt === null).slice(0, limit),
        ),
      markProcessed: (ids, at) => {
        for (const event of this.events) {
          if (ids.includes(event.id)) event.processedAt = at;
        }
        return Promise.resolve();
      },
    };
  }

  private endpointRepository(): EndpointRepository {
    return {
      findActive: () =>
        Promise.resolve(
          this.endpoints.filter((e) => e.active).map((e) => ({ id: e.id })),
        ),
    };
  }

  private deliveryRepository(): DeliveryRepository {
    return {
      createIfAbsent: (rows: readonly NewDelivery[]) => {
        if (this.failNextInsert) {
          const error = this.failNextInsert;
          this.failNextInsert = null;
          return Promise.reject(error);
        }

        for (const row of rows) {
          const exists = this.deliveries.some(
            (d) => d.eventId === row.eventId && d.endpointId === row.endpointId,
          );
          if (exists) continue;

          this.addDelivery({
            eventId: row.eventId,
            endpointId: row.endpointId,
            event: row.event,
            payload: row.payload,
            nextRetryAt: row.dueAt,
          });
        }
        return Promise.resolve();
      },
    };
  }

  claimDue(limit: number, leaseMs: number): Promise<DueDelivery[]> {
    const now = this.clock.now();
    const claimable = this.deliveries
      .filter(
        (d) =>
          (d.status === "pending" || d.status === "failed") &&
          d.nextRetryAt.getTime() <= now.getTime() &&
          (d.lockedUntil === null || d.lockedUntil.getTime() < now.getTime()) &&
          this.endpoints.find((e) => e.id === d.endpointId)?.active === true,
      )
      .sort((a, b) => a.nextRetryAt.getTime() - b.nextRetryAt.getTime())
      .slice(0, limit);

    return Promise.resolve(
      claimable.map((d) => {
        d.lockedUntil = new Date(now.getTime() + leaseMs);
        const endpoint = this.endpoints.find((e) => e.id === d.endpointId);
        return {
          id: d.id,
          eventId: d.eventId,
          url: endpoint?.url ?? "",
          secret: endpoint?.secret ?? "",
          payload: d.payload,
          attempts: d.attempts,
        };
      }),
    );
  }

  record(deliveryId: string, decision: DeliveryDecision): Promise<void> {
    const delivery = this.deliveries.find((d) => d.id === deliveryId);
    if (!delivery) return Promise.resolve();

    delivery.attempts = decision.attempts;
    delivery.status = decision.status;
    delivery.responseStatus = decision.responseStatus ?? null;
    delivery.lastError =
      decision.status === "delivered" ? null : decision.lastError;
    delivery.lockedUntil = null;
    if (decision.status === "failed")
      delivery.nextRetryAt = decision.nextRetryAt;
    return Promise.resolve();
  }
}

/** Replays scripted outcomes and remembers every request it received. */
export class ScriptedSender implements WebhookSender {
  readonly requests: WebhookRequest[] = [];
  private readonly script: Array<DeliveryOutcome | Error> = [];
  private gate: Promise<void> | null = null;

  willRespond(...outcomes: Array<DeliveryOutcome | Error>): this {
    this.script.push(...outcomes);
    return this;
  }

  /** Every send waits for `release()`, to observe concurrency. */
  holdUntilReleased(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    return release;
  }

  async send(request: WebhookRequest): Promise<DeliveryOutcome> {
    this.requests.push(request);
    if (this.gate) await this.gate;

    const next = this.script.shift() ?? { kind: "response", status: 200 };
    if (next instanceof Error) throw next;
    return next;
  }
}
