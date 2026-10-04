import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { DeliverDueWebhooks } from "../application/deliver-due-webhooks";
import { RELAY_CONFIG } from "../application/ports/relay-config";
import type { RelayConfig } from "../application/ports/relay-config";
import { RelayOutboxEvents } from "../application/relay-outbox-events";

interface FanOutStep {
  execute(batchSize: number): Promise<number>;
}

interface DeliveryStep {
  execute(): Promise<number>;
}

export interface CycleResult {
  readonly relayed: number;
  readonly delivered: number;
}

/**
 * Polls the outbox. A recursive timeout, not an interval, so a slow cycle can
 * never overlap the next one. Several instances can run side by side: the
 * claims use SKIP LOCKED and leases, so they take disjoint work.
 *
 * It lives in the API process for now. Nothing here depends on that: the same
 * class can be started from its own entrypoint to scale delivery separately.
 */
@Injectable()
export class OutboxRelayRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    @Inject(RelayOutboxEvents) private readonly relay: FanOutStep,
    @Inject(DeliverDueWebhooks) private readonly deliver: DeliveryStep,
    @Inject(RELAY_CONFIG) private readonly config: RelayConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;

    this.running = true;
    this.schedule(0);
  }

  /** Stops claiming new work and waits for the batch that is in flight. */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  /** One cycle on demand: fan out, then deliver. Used by tests and tooling. */
  async runOnce(): Promise<CycleResult> {
    const relayed = await this.relay.execute(this.config.batchSize);
    const delivered = await this.deliver.execute();

    return { relayed, delivered };
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let nextDelay = this.config.pollIntervalMs;

    try {
      const { relayed, delivered } = await this.runOnce();
      // Work found: come back right away so a backlog drains without waiting
      // a full interval between batches.
      if (relayed + delivered > 0) nextDelay = 0;
    } catch (error) {
      this.logger.error(
        `Relay cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (this.running) this.schedule(nextDelay);
  }
}
