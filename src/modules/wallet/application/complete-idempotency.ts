import { ConflictException } from "@nestjs/common";
import type {
  IdempotencyContext,
  IdempotencyPort,
} from "../../idempotency/application/ports/idempotency-store.port";

/**
 * Stores the response of a money operation as the last step of its transaction,
 * so it commits with the balance or not at all. If the lease was taken over
 * while this request ran, the token no longer matches: throwing rolls the money
 * back, leaving the new holder as the only one that can apply it.
 *
 * Without a context (a caller that is not an HTTP request) there is nothing to
 * complete.
 */
export async function completeIdempotency<T>(
  idempotency: IdempotencyPort,
  context: IdempotencyContext | undefined,
  result: T,
): Promise<T> {
  if (!context) return result;

  const completed = await idempotency.complete(
    context,
    201,
    JSON.parse(JSON.stringify(result)),
  );
  if (!completed) {
    throw new ConflictException(
      "The idempotency key is held by another request",
    );
  }

  return result;
}
