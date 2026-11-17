import { Module } from "@nestjs/common";
import { envs } from "../../config/envs";
import { PrismaModule } from "../prisma/prisma.module";
import { IDEMPOTENCY_STORE } from "./application/ports/idempotency-store.port";
import { buildIdempotencyConfig } from "./domain/idempotency-config";
import { IDEMPOTENCY_RETENTION } from "./idempotency.tokens";
import { IdempotencyCleanupService } from "./infrastructure/idempotency-cleanup.service";
import {
  IDEMPOTENCY_CONFIG,
  IdempotencyInterceptor,
} from "./infrastructure/idempotency.interceptor";
import { PrismaIdempotencyStore } from "./infrastructure/prisma-idempotency.store";

// Validated once at startup: a lease shorter than a money transaction could let
// a takeover run while the first holder is still writing.
const config = buildIdempotencyConfig(envs);

@Module({
  imports: [PrismaModule],
  providers: [
    { provide: IDEMPOTENCY_STORE, useClass: PrismaIdempotencyStore },
    { provide: IDEMPOTENCY_CONFIG, useValue: { leaseMs: config.leaseMs } },
    { provide: IDEMPOTENCY_RETENTION, useValue: { ttlMs: config.ttlMs } },
    IdempotencyInterceptor,
    IdempotencyCleanupService,
  ],
  exports: [IDEMPOTENCY_STORE, IDEMPOTENCY_CONFIG, IdempotencyInterceptor],
})
export class IdempotencyModule {}
