import { ExecutionContext, createParamDecorator } from "@nestjs/common";
import type { IdempotencyContext } from "../application/ports/idempotency-store.port";

/**
 * Hands the controller the proof of ownership of the claimed key, to pass down
 * to the use case that completes the record inside its transaction. Named
 * `Idempotency` so it does not clash with the `IdempotencyContext` type.
 */
export const Idempotency = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IdempotencyContext => {
    const request = context
      .switchToHttp()
      .getRequest<{ idempotency?: IdempotencyContext }>();
    if (!request.idempotency) {
      throw new Error("@Idempotency() needs the @Idempotent() interceptor");
    }

    return request.idempotency;
  },
);
