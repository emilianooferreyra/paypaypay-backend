## Why

Retrying a payment must never move money twice. The current `IdempotencyGuard` does not guarantee that, and reading it shows why (verified in `idempotency.guard.ts`, the `IdempotencyRecord` model and the cleanup service):

1. **The key is optional.** Without an `idempotency-key` header the guard calls the handler and does nothing else, so the exact case that matters, a client retrying after a timeout, is unprotected unless the client chose to opt in.
2. **It races.** The guard reads the key, runs the handler, and only then inserts the record inside an `async` callback in `tap(...)` that nobody awaits. Two concurrent requests with the same key both miss the cache and both move the money; the second insert fails on the unique index and the error is swallowed.
3. **The record is not atomic with the money.** It is written after the response exists and in a different transaction. A crash or a failed save leaves money moved and no record of it.
4. **The key is global.** `key` is `@unique` on its own, and the cached response is returned without comparing the user. Another user who sends the same key receives the first user's response.
5. **Nothing compares the request.** The same key with a different amount silently returns the first response.
6. **Concurrent duplicates have no defined answer.** There is no "still running" state, although the schema already carries `IN_PROGRESS`, `COMPLETED` and `FAILED`.
7. **No test exercises concurrency.**

Stripe, Adyen, Square and Monzo (a `dedupe_id` on its money endpoints), together with Brandur's reference implementation written by a former Stripe engineer and the expired IETF draft, agree on the remedy: claim the key before doing the work, compare the request, answer a conflict to a duplicate in flight and an error to a changed payload, and finish the record in the same transaction as the money.

## What Changes

- **Claim first.** Before the handler runs, the interceptor inserts an `IN_PROGRESS` record under a unique `(userId, key)` with a request fingerprint and a lease. The unique index decides the winner; no read-then-write.
- **Decide on a duplicate.** Same key and fingerprint: replay the stored response if finished, answer 409 with `Retry-After` if still running, take over if the lease expired. Same key, different fingerprint (body, method or route): 422.
- **Finish inside the money transaction.** The wallet use cases mark the record `COMPLETED` and store the response in the same unit of work as the balance change. A fencing token makes a stale holder's late completion fail, which rolls its money movement back.
- **Deterministic failures are replayed, transient ones are released.** A 400, 404 or 422 is stored and replayed. A 409 conflict, a 5xx or an unexpected error releases the lease so the client can retry with the same key.
- **The header is required** on `deposit`, `withdraw`, `exchange` and `send`: a missing, empty, over-long or malformed key gets 400. There is no opt-out: a money endpoint that can be called without a key is the double-charge case.
- **Per-user scope**, a configurable retention (default 72 hours), and a startup check that the lease outlives the longest possible money transaction.
- **BREAKING for API clients**: money `POST` endpoints answer 400 without `Idempotency-Key`.
- The `IdempotencyRecord` table changes: `key @unique` becomes `@@unique([userId, key])`; new columns `requestHash`, `lockToken`, `lockedUntil`.

## Capabilities

### New Capabilities
- `idempotent-requests`: the contract a client sees (key rules, replay, 409, 422, error handling, scope).
- `idempotency-atomicity`: claim, lease, fencing and completion inside the money transaction.

### Modified Capabilities
- *(none; no spec in `openspec/specs/` covers idempotency)*

## Impact

- **Code**: new `modules/idempotency/` (domain, application, infrastructure), replacing `common/guards/idempotency.guard.ts`, `common/decorators/idempotent.decorator.ts` and `idempotency-cleanup.service.ts`; wallet controller, `WalletService`, the four use cases and the `WalletTx` port; `envs.ts`.
- **Database**: one additive-ish migration on `IdempotencyRecord` (index swap, three new columns).
- **Depends on** the outbox PR (`feat/outbox-relay`): both change the wallet use cases. This branch starts from it.
- **Not in scope**: `investment` buy and sell (they have no idempotency today and are fixed together with `investment-on-money`), a unique key on `Transaction` as a second safety net, and consumer-side deduplication (already covered by the event id).
