import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
} from "../application/ports/idempotency-store.port";
import { IDEMPOTENCY_RETENTION } from "../idempotency.tokens";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // every hour

@Injectable()
export class IdempotencyCleanupService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(IdempotencyCleanupService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    @Inject(IDEMPOTENCY_RETENTION)
    private readonly retention: { ttlMs: number },
  ) {}

  onApplicationBootstrap() {
    void this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanup(): Promise<void> {
    try {
      const count = await this.store.deleteOlderThan(this.retention.ttlMs);

      if (count > 0) {
        this.logger.log(`Cleaned up ${count} expired idempotency records`);
      }
    } catch (error) {
      this.logger.error(
        "Failed to clean up expired idempotency records",
        error,
      );
    }
  }
}
