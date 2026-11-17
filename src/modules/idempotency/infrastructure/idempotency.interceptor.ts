import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Observable, from, mergeMap, of, throwError } from "rxjs";
import { catchError } from "rxjs/operators";
import {
  IDEMPOTENCY_STORE,
  IdempotencyContext,
} from "../application/ports/idempotency-store.port";
import type { IdempotencyStore } from "../application/ports/idempotency-store.port";
import { classifyFailure } from "../domain/classify-failure";
import { decide } from "../domain/decide";
import { validateKey } from "../domain/idempotency-key";
import { fingerprint } from "../domain/request-fingerprint";

export const IDEMPOTENCY_CONFIG = Symbol("IDEMPOTENCY_CONFIG");

export interface IdempotencyInterceptorConfig {
  leaseMs: number;
}

interface IdempotentRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  route?: { path: string };
  url?: string;
  body: unknown;
  user: { userId: string };
  idempotency?: IdempotencyContext;
}

interface IdempotentResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

const KEY_ERRORS = {
  missing: "The Idempotency-Key header is required",
  empty: "The Idempotency-Key header must not be empty",
  multiple: "The Idempotency-Key header must be sent once",
  too_long: "The Idempotency-Key header must be at most 255 characters",
  invalid_characters:
    "The Idempotency-Key header may only contain letters, digits and . _ : -",
} as const;

/**
 * Claims the key before the handler runs and decides what a repeated request
 * gets. It never completes a successful request: that happens inside the money
 * transaction, so the stored response commits with the balance (see
 * `IdempotencyPort.complete`). It only records how a failed request ended.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    @Inject(IDEMPOTENCY_CONFIG)
    private readonly config: IdempotencyInterceptorConfig,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const response = http.getResponse<IdempotentResponse>();

    const validation = validateKey(request.headers["idempotency-key"]);
    if (!validation.ok) {
      throw new BadRequestException(KEY_ERRORS[validation.reason]);
    }
    response.setHeader("Idempotency-Key", validation.key);

    const route = request.route?.path ?? request.url ?? "";
    const requestHash = fingerprint({
      method: request.method,
      route,
      body: request.body,
    });

    const claim = await this.store.claim({
      userId: request.user.userId,
      key: validation.key,
      route,
      requestHash,
      leaseMs: this.config.leaseMs,
    });

    let held: IdempotencyContext;
    if (claim.claimed) {
      held = claim.context;
    } else {
      const decision = decide(claim.existing, requestHash);
      switch (decision.action) {
        case "replay":
          this.event("idempotency.replay", claim.recordId);
          response.status(decision.statusCode);
          response.setHeader("Idempotent-Replayed", "true");
          if (decision.failed) {
            throw new HttpException(
              decision.body as string | Record<string, unknown>,
              decision.statusCode,
            );
          }

          return of(decision.body);
        case "mismatch":
          this.event("idempotency.mismatch", claim.recordId);
          throw new UnprocessableEntityException(
            "This Idempotency-Key was already used with a different request",
          );
        case "takeover": {
          const taken = await this.store.takeOver(
            claim.recordId,
            this.config.leaseMs,
          );
          if (!taken) {
            this.event("idempotency.conflict", claim.recordId);
            throw this.conflict(response, 1);
          }
          this.event("idempotency.takeover", claim.recordId);
          held = taken;
          break;
        }
        case "conflict":
          this.event("idempotency.conflict", claim.recordId);
          throw this.conflict(response, decision.retryAfterSeconds);
        case "claim":
          throw new Error("A claim cannot be refused");
      }
    }

    request.idempotency = held;

    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          from(this.release(held, error)).pipe(
            mergeMap(() => throwError(() => error)),
          ),
        ),
      );
  }

  private conflict(response: IdempotentResponse, retryAfterSeconds: number) {
    response.setHeader("Retry-After", String(retryAfterSeconds));

    return new ConflictException(
      "A request with this Idempotency-Key is still being processed",
    );
  }

  /** Leaves the key in the state the failure calls for; never masks the error. */
  private async release(held: IdempotencyContext, error: unknown) {
    const status =
      error instanceof HttpException ? error.getStatus() : undefined;

    try {
      switch (classifyFailure(status)) {
        case "fail":
          await this.store.fail(
            held,
            status as number,
            (error as HttpException).getResponse(),
          );
          break;
        case "discard":
          await this.store.discard(held);
          this.event("idempotency.discard", held.recordId);
          break;
        case "unlock":
          await this.store.unlock(held);
          break;
      }
    } catch (releaseError) {
      // The lease expires on its own, so a failed release only delays a retry.
      this.logger.error(
        JSON.stringify({
          event: "idempotency.release_failed",
          recordId: held.recordId,
        }),
        releaseError instanceof Error ? releaseError.stack : undefined,
      );
    }
  }

  /** One structured event per decision: the record id, never the body. */
  private event(event: string, recordId: string) {
    this.logger.log(JSON.stringify({ event, recordId }));
  }
}
