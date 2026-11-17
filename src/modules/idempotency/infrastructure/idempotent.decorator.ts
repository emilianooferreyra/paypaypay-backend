import { UseInterceptors, applyDecorators } from "@nestjs/common";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

/** Requires an `Idempotency-Key` and makes the endpoint safe to retry. */
export function Idempotent() {
  return applyDecorators(UseInterceptors(IdempotencyInterceptor));
}
