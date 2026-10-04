import { Inject, Injectable } from "@nestjs/common";
import { decide, DeliveryOutcome } from "../domain/delivery-policy";
import { CLOCK, RANDOM } from "./ports/clock.port";
import type { Clock, Random } from "./ports/clock.port";
import { DELIVERY_QUEUE } from "./ports/delivery-queue.token";
import type { DeliveryQueue, DueDelivery } from "./ports/delivery.repository";
import { RELAY_CONFIG } from "./ports/relay-config";
import type { RelayConfig } from "./ports/relay-config";
import { WEBHOOK_SENDER } from "./ports/webhook-sender.port";
import type { WebhookSender } from "./ports/webhook-sender.port";

/**
 * Claims due deliveries, calls the endpoints, records what happened.
 *
 * Claiming is one short statement that leaves a lease on the rows; the HTTP
 * calls run afterwards with no database transaction open. A worker that dies
 * in the middle simply lets its lease expire and another one picks the rows
 * up, which makes delivery at-least-once: the event id lets receivers
 * deduplicate.
 */
@Injectable()
export class DeliverDueWebhooks {
  constructor(
    @Inject(DELIVERY_QUEUE) private readonly queue: DeliveryQueue,
    @Inject(WEBHOOK_SENDER) private readonly sender: WebhookSender,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM) private readonly random: Random,
    @Inject(RELAY_CONFIG) private readonly config: RelayConfig,
  ) {}

  /** Resolves with how many deliveries were handled. */
  async execute(): Promise<number> {
    const due = await this.queue.claimDue(
      this.config.batchSize,
      this.config.leaseMs,
    );

    // Concurrent on purpose: attempts are bounded by the request timeout, so
    // the whole batch finishes well inside the lease. Sequential calls could
    // outlive it and let another worker deliver the same rows twice.
    const results = await Promise.allSettled(
      due.map((delivery) => this.deliverOne(delivery)),
    );

    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;

    return due.length;
  }

  private async deliverOne(delivery: DueDelivery): Promise<void> {
    const outcome = await this.attempt(delivery);
    const decision = decide(
      delivery.attempts,
      outcome,
      this.clock.now(),
      this.random,
      this.config.retry,
    );

    await this.queue.record(delivery.id, decision);
  }

  private async attempt(delivery: DueDelivery): Promise<DeliveryOutcome> {
    try {
      return await this.sender.send({
        url: delivery.url,
        secret: delivery.secret,
        eventId: delivery.eventId,
        body: delivery.payload,
      });
    } catch (error) {
      return {
        kind: "failure",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
