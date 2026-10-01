## Context

Sources read for this design (levels as in the project's source hierarchy):

- **Brandur, "Implementing Stripe-like Idempotency Keys in Postgres"** (practice): unique `(user_id, idempotency_key)`, a `locked_at` lock, stored request parameters to catch mismatched retries, 409 for a request in flight, recovery points around foreign mutations, retryable versus permanent errors, a reaper at about 72 hours.
- **Airbnb, "Avoiding double payments in a distributed payments system"** (practice): idempotency rows written in the same database transaction as the business writes, no network calls inside database phases and no database work during network calls, a lease with an expiry longer than the RPC timeout, responses stored only for deterministic end states, idempotency data read from the primary, never a replica.
- **Stripe, idempotent requests** (practice): the first result is saved, errors included; reusing a key with different parameters is an error; keys may be pruned after at least 24 hours; nothing is saved when validation fails or when the request conflicts with one still running.
- **IETF `Idempotency-Key` draft, version 07** (expired draft, never an RFC): same key and same payload returns the earlier result; a changed payload SHOULD get 422; a concurrent request SHOULD get a conflict error; UUIDs are recommended.

## Decisions

### D1. Claim first, with the unique index as the arbiter

| Option | Pros | Cons |
|---|---|---|
| **A. `INSERT` an `IN_PROGRESS` row before the handler; the unique `(userId, key)` picks the winner (chosen)** | No read-then-write window; the database, not application code, decides who runs | One extra short statement before the work |
| B. Read the key, run, write after (today) | Simple | The race in the proposal; the duplicate runs |
| C. Redis `SET NX` lock | Fast | A second source of truth, not atomic with the money transaction (Airbnb stored this in the primary database for the same reason) |

### D2. The record is completed in the same transaction as the money

The claim is a separate short transaction; the money transaction is the existing unit of work. Completion (`COMPLETED`, status code, response body) happens **inside that unit of work**, through a new `idempotency` member of `WalletTx`. This is Airbnb's rule and Brandur's "atomic phase": the money and the proof that it moved commit together or not at all. A crash after commit finds `COMPLETED`; a crash before commit finds nothing done and an expired lease.

### D3. A fencing token makes takeover safe

A lease alone is not safe: a holder that stalls past its lease could still commit after another request took over, and the money would move twice. So each claim stores a fresh `lockToken`, and completion is:

```sql
UPDATE "IdempotencyRecord"
SET status = 'COMPLETED', ...
WHERE id = $id AND "lockToken" = $token AND status = 'IN_PROGRESS'
```

Zero rows means the caller no longer holds the key. The use case throws, the unit of work rolls back, and the stale holder's money movement disappears with it. The same reasoning applies to the webhook relay, which uses a lease but delivers at-least-once by design; here exactly-once on the money is the requirement.

### D4. The lease must outlive the longest money transaction

`withOptimisticRetry` allows 3 attempts, each bounded by `DB_TRANSACTION_MAX_WAIT_MS` plus `DB_TRANSACTION_TIMEOUT_MS` (5 s and 10 s today). The lease default is 60 s and a startup check refuses a lease shorter than `3 x (maxWait + timeout)`. Airbnb's rule of thumb is the same: lease longer than the call timeout. Lease expiry is judged with the database clock so several instances agree.

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

### D7. The header is required, with a transition switch

A missing key is precisely the double-charge case, so money endpoints require it (400). Validation: 1 to 255 characters from `[A-Za-z0-9._:-]`, which admits UUIDs and keeps the key safe to log and to use as an index value. `IDEMPOTENCY_KEY_REQUIRED=false` restores the old pass-through so the backend can ship before the frontend sends a key. Flag off is a risk the owner accepts knowingly; it logs a warning at startup.

### D8. Hexagonal shape

```
modules/idempotency/
  domain/          # key rules, fingerprint, decide(existingRecord, fingerprint, now)
  application/     # ports (IdempotencyStore) + use cases: Claim, Release, Fail
  infrastructure/  # Prisma store, Nest interceptor, @Idempotent decorator, @IdempotencyContext param
```

The interceptor does the claim and the decision before the handler and the release or failure recording after it; it never completes a successful request (D2). The wallet side gets an `IdempotencyPort.complete(context, status, body)` in `WalletTx`, implemented by the same Prisma adapter with the fenced `UPDATE`.

### D9. Retention

Default 72 hours (Brandur's argument: a bug deployed on a Friday should still be fixable before keys vanish), configurable through `IDEMPOTENCY_TTL_HOURS`. Stripe only promises "at least 24 hours". One constant replaces the two copies in the guard and the cleanup service.

## Risks

| Risk | Mitigation |
|---|---|
| The frontend breaks on the four money calls | `IDEMPOTENCY_KEY_REQUIRED` switch; listed in the PR; the frontend change is a separate, small follow-up |
| A takeover duplicates money | Fencing token plus a test where the stale holder's completion fails and its balance change rolls back |
| Lease shorter than a slow money transaction | Startup validation of `lease >= 3 x (maxWait + timeout)` |
| Canonical JSON differs between a client and a retry (number formats, nested key order) | Keys sorted recursively; amounts are strings in the money DTOs, so no float formatting is involved |
| Legacy rows (written before the upgrade) have no hash | Treated as a replay of the stored response, as before; the reaper clears them within the retention window |
| Large request bodies in the hash | Money DTOs are tiny; the hash is computed once per request |
| Replica reads | The store reads and writes only through the primary connection, as Airbnb did |

## Follow-ups

`investment` buy and sell onto the same mechanism (with `investment-on-money`); a unique idempotency column on `Transaction` as a defense in depth; a short guide for clients on key generation and retry; metrics for replays, conflicts and takeovers.
