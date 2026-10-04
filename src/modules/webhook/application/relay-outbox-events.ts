import { Inject, Injectable } from "@nestjs/common";
import { CLOCK } from "./ports/clock.port";
import type { Clock } from "./ports/clock.port";
import { RELAY_UNIT_OF_WORK } from "./ports/relay-unit-of-work.port";
import type { RelayUnitOfWork } from "./ports/relay-unit-of-work.port";

/**
 * Turns facts (outbox events) into work (one delivery per active endpoint).
 *
 * It all happens in one transaction: either the event is marked processed and
 * every delivery exists, or nothing changed and the next run starts again.
 * Fan-out is idempotent per (event, endpoint), so a crash can never produce a
 * duplicate delivery.
 */
@Injectable()
export class RelayOutboxEvents {
  constructor(
    @Inject(RELAY_UNIT_OF_WORK) private readonly unitOfWork: RelayUnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Resolves with how many events were processed. */
  execute(batchSize: number): Promise<number> {
    return this.unitOfWork.run(async ({ events, endpoints, deliveries }) => {
      const batch = await events.claimUnprocessed(batchSize);
      if (batch.length === 0) return 0;

      const active = await endpoints.findActive();
      const now = this.clock.now();

      const rows = batch.flatMap((event) => {
        // One body per event, the same bytes for every endpoint and every
        // retry. The signature differs per endpoint because the secret does.
        const payload = JSON.stringify({
          id: event.id,
          event: event.type,
          data: event.payload,
          timestamp: event.occurredAt.toISOString(),
        });

        return active.map((endpoint) => ({
          eventId: event.id,
          endpointId: endpoint.id,
          event: event.type,
          payload,
          dueAt: now,
        }));
      });

      await deliveries.createIfAbsent(rows);
      await events.markProcessed(
        batch.map((event) => event.id),
        now,
      );

      return batch.length;
    });
  }
}
