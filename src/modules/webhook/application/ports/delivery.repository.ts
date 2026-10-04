import { DeliveryDecision } from "../../domain/delivery-policy";

export interface NewDelivery {
  readonly eventId: string;
  readonly endpointId: string;
  /** Event type, kept on the row for humans reading the table. */
  readonly event: string;
  /** The exact body that will be signed and sent, on every attempt. */
  readonly payload: string;
  readonly dueAt: Date;
}

export interface DeliveryRepository {
  /**
   * One row per (event, endpoint). Creating a row that already exists is a
   * no-op, which makes fan-out safe to run twice.
   */
  createIfAbsent(deliveries: readonly NewDelivery[]): Promise<void>;
}

export interface DueDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly url: string;
  readonly secret: string;
  readonly payload: string;
  /** Attempts already made before this one. */
  readonly attempts: number;
}

/** Work that runs outside any fan-out transaction. */
export interface DeliveryQueue {
  /**
   * Claims up to `limit` due deliveries for `leaseMs`. A claimed delivery is
   * invisible to other workers until the lease expires, so a worker that dies
   * mid-delivery does not strand it. Must not hold a database transaction open
   * after it returns.
   */
  claimDue(limit: number, leaseMs: number): Promise<DueDelivery[]>;

  /** Updates the same row; a retry never inserts a new one. */
  record(deliveryId: string, decision: DeliveryDecision): Promise<void>;
}
