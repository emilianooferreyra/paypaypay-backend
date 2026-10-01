Strict TDD: a failing test first, then the minimum code, then cleanup. This branch starts from `feat/outbox-relay` because both change the wallet use cases; if that PR is merged first, rebase is not needed (the repo merges with merge commits). Every e2e run needs the maintainer's consent for the `authdb_test` reset.

## 1. Pure rules (domain, no I/O)

- [ ] 1.1 RED→GREEN `validateKey`: accepts UUIDs and the allowed set up to 255 characters; rejects empty, 256 characters, spaces, newlines, non-ASCII
- [ ] 1.2 RED→GREEN `fingerprint`: stable for the same method, route and body; field order and nesting order do not change it; a different amount, method or route does
- [ ] 1.3 RED→GREEN `decide(existing, fingerprint, now)`: the full table of design D5 (none, replay, 409, takeover, 422), including legacy rows without a hash
- [ ] 1.4 RED→GREEN `classifyFailure(status)`: 400, 404 and 422 are stored; 409, 5xx and non-HTTP errors are released
- [ ] 1.5 RED→GREEN `buildIdempotencyConfig`: refuses a lease shorter than `3 x (maxWait + timeout)`; `IDEMPOTENCY_KEY_REQUIRED` and `IDEMPOTENCY_TTL_HOURS` parsing

## 2. Schema

- [ ] 2.1 Migration on `IdempotencyRecord`: drop the unique on `key`, add `@@unique([userId, key])`, add `requestHash`, `lockToken`, `lockedUntil`; hand-review the SQL; apply every migration to a scratch database and confirm `migrate diff` reports no difference
- [ ] 2.2 Regenerate the client; typecheck

## 3. Store (integration, against Postgres)

- [ ] 3.1 RED: spec for `claim` — exactly one of two simultaneous claims wins; the loser sees the existing record; the claim stores user, key, hash, token and a lease from the database clock
- [ ] 3.2 RED: spec for `complete` — succeeds only for the current token while `IN_PROGRESS`; refuses a stale token; stores status, code and body
- [ ] 3.3 RED: spec for `takeOver` — only after the lease expired; issues a new token; the old token can no longer complete
- [ ] 3.4 RED: spec for `release` and `fail` — conditional on the token; release makes the key claimable at once; fail stores the response
- [ ] 3.5 GREEN: the Prisma store with fenced `UPDATE` statements; time from `now()` in UTC

## 4. Interceptor (TDD with a fake store, then HTTP)

- [ ] 4.1 RED→GREEN `IdempotencyInterceptor` against an in-memory store: missing key, bad key, new claim, replay with the header, 409 with `Retry-After`, 422, takeover, failure classification, `required=false` pass-through
- [ ] 4.2 `@Idempotent()` becomes the new interceptor; `@IdempotencyContext()` parameter decorator exposes `{ recordId, lockToken }` to the controller
- [ ] 4.3 Remove `IdempotencyGuard`, its spec and the duplicated TTL constant; `IdempotencyCleanupService` reads the configured retention

## 5. Atomic completion in the wallet flows (TDD)

- [ ] 5.1 Add `idempotency: IdempotencyPort` to `WalletTx`; the in-memory unit of work implements it with the same fencing rule and the same rollback
- [ ] 5.2 RED: for each of deposit, withdraw, send and exchange, a spec that the record is completed together with the balance, and that nothing is completed when the work rolls back
- [ ] 5.3 GREEN: the controller passes the context down through `WalletService` into the use cases, which call `complete` inside the unit of work with `201` and the result
- [ ] 5.4 Move `exchange` onto the unit of work only as far as completion requires; the rounding fix stays in `exchange-on-money`
- [ ] 5.5 RED→GREEN: a late completion by a stale holder throws and rolls the balance back

## 6. End to end

- [ ] 6.1 e2e: retry after success replays and the balance changes once
- [ ] 6.2 e2e: 20 simultaneous identical requests create exactly one transaction; the rest are 409 or replays
- [ ] 6.3 e2e: same key with a different amount is 422; another user with the same key executes independently
- [ ] 6.4 e2e: claim, simulate a crash with no completion, expire the lease, retry — executes once
- [ ] 6.5 e2e: stale holder scenario against Postgres (two tokens, forced expiry)
- [ ] 6.6 Update every existing e2e that calls a money endpoint to send a key

## 7. Configuration and docs

- [ ] 7.1 `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_LEASE_MS`, `IDEMPOTENCY_TTL_HOURS` in the Zod schema; warn at startup when the key is not required; README lists them
- [ ] 7.2 ADR `docs/adr/0003-idempotency.md` (0002 is the Money ADR): problem, options, fencing, what is and is not stored, sources
- [ ] 7.3 A short client note: how to generate a key, reuse it only for retries of the same request, and what 409 and 422 mean

## 8. Verification

- [ ] 8.1 `pnpm typecheck`, `pnpm lint:ci` (no new errors in files this PR touches), `pnpm test`, `pnpm test:e2e` (with consent), `pnpm build`, `docker build --target prod`
- [ ] 8.2 Walk every scenario of both specs and record how it was verified
- [ ] 8.3 Open the PR with the verification table and the list of what was deliberately not done
