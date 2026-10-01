## Context

Sources read for this design, fintech-native first (levels as in the project's source hierarchy):

- **Stripe, idempotent requests** (practice): the first result is saved, errors included; reusing a key with different parameters is an error; keys may be pruned after at least 24 hours; nothing is saved when validation fails or when the request conflicts with one still running; every `POST` accepts a key.
- **Brandur, "Implementing Stripe-like Idempotency Keys in Postgres"** (practice, by a former Stripe engineer): unique `(user_id, idempotency_key)`, a `locked_at` lock, stored request parameters to catch mismatched retries, 409 for a request in flight, recovery points around foreign mutations, retryable versus permanent errors, a reaper at about 72 hours.
- **Adyen, API idempotency** (practice): header `idempotency-key`, at most 64 characters, valid 7 to 14 days; a concurrent duplicate gets a transient error (422 or 409, code 704); a repeat returns the first response; random UUIDs are recommended so that two credentials of the same account cannot read each other's responses, which is the cross-user leak of today's guard.
- **Square, idempotency** (practice): the same key and parameters return the first successful response; the same key with changed parameters is an error.
- **Monzo, API** (practice): money endpoints take a `dedupe_id`, "a unique string used to de-duplicate deposits", that must stay static between retries.
- **Mercado Pago, payments API** (practice): `X-Idempotency-Key` with a unique UUID per attempt.
- **IETF `Idempotency-Key` draft, version 07** (expired draft, never an RFC): same key and payload returns the earlier result; a changed payload SHOULD get 422; a concurrent request SHOULD get a conflict error; UUIDs are recommended.
- **Supplementary, from outside fintech:** Airbnb's payments platform published a detailed account of putting the idempotency record in the same database transaction as the business writes and of leases longer than call timeouts. It is a marketplace, not a fintech, so no decision here rests on it alone: each of those two points is also supported by Brandur's atomic phases and by the Stripe documentation above.

## Decisions

### D1. Claim first, with the unique index as the arbiter

| Option | Pros | Cons |
|---|---|---|
| **A. `INSERT` an `IN_PROGRESS` row before the handler; the unique `(userId, key)` picks the winner (chosen)** | No read-then-write window; the database, not application code, decides who runs | One extra short statement before the work |
| B. Read the key, run, write after (today) | Simple | The race in the proposal; the duplicate runs |
| C. Redis `SET NX` lock | Fast | A second source of truth, not atomic with the money transaction (the idempotency state belongs in the primary database, next to the data it protects) |

### D2. The record is completed in the same transaction as the money

The claim is a separate short transaction; the money transaction is the existing unit of work. Completion (`COMPLETED`, status code, response body) happens **inside that unit of work**, through a new `idempotency` member of `WalletTx`. This is Brandur's "atomic phase": the money and the proof that it moved commit together or not at all. A crash after commit finds `COMPLETED`; a crash before commit finds nothing done and an expired lease.

### D3. A fencing token makes takeover safe

A lease alone is not safe: a holder that stalls past its lease could still commit after another request took over, and the money would move twice. So each claim stores a fresh `lockToken`, and completion is:

```sql
UPDATE "IdempotencyRecord"
SET status = 'COMPLETED', ...
WHERE id = $id AND "lockToken" = $token AND status = 'IN_PROGRESS'
```

Zero rows means the caller no longer holds the key. The use case throws, the unit of work rolls back, and the stale holder's money movement disappears with it. The same reasoning applies to the webhook relay, which uses a lease but delivers at-least-once by design; here exactly-once on the money is the requirement.

### D4. The lease must outlive the longest money transaction

`withOptimisticRetry` allows 3 attempts, each bounded by `DB_TRANSACTION_MAX_WAIT_MS` plus `DB_TRANSACTION_TIMEOUT_MS` (5 s and 10 s today). The lease default is 60 s and a startup check refuses a lease shorter than `3 x (maxWait + timeout)`. Brandur's lock follows the same principle: it can only be acquired when the key is unlocked or its lock has expired, so the lock has to outlast the work it protects. Lease expiry is judged with the database clock so several instances agree.

### D5. What a duplicate gets

| Existing record | Same fingerprint | Different fingerprint |
|---|---|---|
| `COMPLETED` or `FAILED` | Replay the stored status and body, with `Idempotent-Replayed: true` | 422 |
| `IN_PROGRESS`, lease live | 409 with `Retry-After` | 422 |
| `IN_PROGRESS`, lease expired | Take over (new token) and run | 422 |
| none | Claim and run | n/a |

The fingerprint is a SHA-256 of canonical JSON of the method, the route template and the body (keys sorted, so field order does not matter). Including the route means the same key sent to another endpoint is a mismatch, not a replay.

### D6. Which failures are stored

| Outcome | Stored? | Why |
|---|---|---|
| Success | Yes, `COMPLETED`, in the money transaction | The replay |
| 400, 404, 422 | Yes, `FAILED` with the response | Deterministic for this request; Stripe also replays errors |
| 409 (optimistic lock exhausted), 5xx, unexpected error | No: the lease is released | Transient; the client must be able to retry the same key |

A 422 such as "Insufficient balance" is replayed under the same key even if the balance changes later. That is the documented behavior of Stripe and the expectation for every client: a new attempt uses a new key.

### D7. The header is required, with no opt-out

A missing key is precisely the double-charge case, so money endpoints require it (400). Validation: 1 to 255 characters from `[A-Za-z0-9._:-]`, which admits UUIDs and keeps the key safe to log and to use as an index value. Stripe allows 255; Adyen allows 64. 255 is chosen so that a client using a composite key, such as `payment-1234-refund`, is not rejected.

### D8. Hexagonal shape

```
modules/idempotency/
  domain/          # key rules, fingerprint, decide(existingRecord, fingerprint, now)
  application/     # ports (IdempotencyStore) + use cases: Claim, Release, Fail
  infrastructure/  # Prisma store, Nest interceptor, @Idempotent decorator, @IdempotencyContext param
```

The interceptor does the claim and the decision before the handler and the release or failure recording after it; it never completes a successful request (D2). The wallet side gets an `IdempotencyPort.complete(context, status, body)` in `WalletTx`, implemented by the same Prisma adapter with the fenced `UPDATE`.

### D9. Retention

Default 72 hours (Brandur's argument: a bug deployed on a Friday should still be fixable before keys vanish), configurable through `IDEMPOTENCY_TTL_HOURS`. The industry range is wide: Stripe only promises "at least 24 hours", Adyen keeps keys 7 to 14 days. One constant replaces the two copies in the guard and the cleanup service.

## Risks

| Risk | Mitigation |
|---|---|
| A takeover duplicates money | Fencing token plus a test where the stale holder's completion fails and its balance change rolls back |
| Lease shorter than a slow money transaction | Startup validation of `lease >= 3 x (maxWait + timeout)` |
| Canonical JSON differs between a client and a retry (number formats, nested key order) | Keys sorted recursively; amounts are strings in the money DTOs, so no float formatting is involved |
| Clients that do not send a key start getting 400 | Intended; documented in the client note (task 7.3) |
| Legacy rows (written before the upgrade) have no hash | Treated as a replay of the stored response, as before; the reaper clears them within the retention window |
| Large request bodies in the hash | Money DTOs are tiny; the hash is computed once per request |
| Replica reads | The store reads and writes only through the primary connection, so replica lag can never hide a record and let a retry run twice |

## Follow-ups

`investment` buy and sell onto the same mechanism (with `investment-on-money`); a unique idempotency column on `Transaction` as a defense in depth; a short guide for clients on key generation and retry; metrics for replays, conflicts and takeovers.
