# ADR 0003: Idempotent money requests: claim first, fence the holder, complete with the money

- **Status:** implemented by the `idempotency-hardening` change
- **Date:** 2026-10-04
- **Code:** `src/modules/idempotency/`, `WalletTx.idempotency` in `src/modules/wallet/application/ports/unit-of-work.port.ts`, migration `20261004120000_idempotency_per_user_key`
- **Plan and scenarios:** `openspec/changes/idempotency-hardening/` (design D1 to D10 hold the full reasoning and the source list)

## Context

A client that times out cannot tell whether a deposit happened. It retries, and without protection the money moves twice. The previous guard read the key, ran the handler, and stored the response afterwards. That left four defects:

1. **A race.** Two simultaneous requests with the same key both found nothing and both ran.
2. **A cross-user leak.** The key was unique on its own, so one user's key could replay another user's response.
3. **No request check.** The same key with a different amount returned the first response as if nothing had changed.
4. **Not atomic with the money.** The response was stored after the transaction committed. A crash in between left money moved and no record.

## Decision

- **Claim first.** Before the handler runs, `INSERT ... ON CONFLICT DO NOTHING` an `IN_PROGRESS` row. The unique index on `(userId, key)` decides who runs; there is no read-then-write window. Keys are scoped to the user.
- **Fingerprint.** A SHA-256 of the method, the route and the body with keys sorted. A reused key with another fingerprint is a 422 and nothing runs.
- **Lease and fencing token.** The claim holds a lease measured with the database clock and a random `lockToken`. A request that finds an expired lease takes over with a new token. Every state change is a single `UPDATE ... WHERE id = $id AND "lockToken" = $token AND status = 'IN_PROGRESS'`, so a holder that stalled past its lease matches no row.
- **Completion inside the money transaction.** The record is completed as the last step of the unit of work (`tx.idempotency.complete`). If the token no longer matches, the use case throws, the transaction rolls back, and the stale holder's money movement disappears. A crash before commit leaves no money moved and an expiring lease; a crash after commit leaves a `COMPLETED` record.
- **Failures.** Only answers that are deterministic for the request are stored:

  | Outcome | Action |
  |---|---|
  | Success | `COMPLETED`, inside the money transaction |
  | 404, 422 | `FAILED` with the response; replayed |
  | 400 | Claim deleted; the client may fix the payload and reuse the key |
  | 409, 5xx, unexpected error | Lease released; the same request may retry |

- **A duplicate while the first runs** gets 409 with `Retry-After`. A finished one is replayed with `Idempotent-Replayed: true`. Every answer echoes `Idempotency-Key`.
- **The header is required** on `deposit`, `withdraw`, `exchange` and `send`: 1 to 255 characters from `A-Z a-z 0-9 . _ : -`.
- **Retention** is 72 hours (`IDEMPOTENCY_TTL_HOURS`). The lease is 60 seconds (`IDEMPOTENCY_LEASE_MS`) and the application refuses to start if it is shorter than `3 x (DB_TRANSACTION_MAX_WAIT_MS + DB_TRANSACTION_TIMEOUT_MS)`.

## Options not taken

| Option | Why not |
|---|---|
| Read the key, run, write after (the old guard) | It is the race and the non-atomic write described above |
| A Redis `SET NX` lock | A second source of truth that cannot commit with the money; the state belongs in the primary database next to the data it protects |
| A lease without a fencing token | A stalled holder could still commit after a takeover and move the money twice |
| Storing every failure | Stripe documents that nothing is saved when validation fails; keeping a 400 would turn the corrected request into a mismatch |

## Consequences

- Clients must send a key; a request without one is a 400. This is intentional: a missing key is exactly the double-charge case.
- A 422 such as `Insufficient balance` is replayed under the same key even if the balance changes later. A new attempt needs a new key. This is the documented behavior of Stripe.
- The use cases take the idempotency context as an optional field (`idempotency?`) so that callers that are not HTTP requests keep working. The HTTP controller always passes it, and the end-to-end suite checks that every money endpoint completes its record. A future endpoint that forgets to pass it would run once but leave its key `IN_PROGRESS` until the lease expires, and a retry after that would execute again. Reviewers of new money endpoints must check for it.
- The interceptor emits one structured log event per decision (`idempotency.replay`, `conflict`, `mismatch`, `takeover`, `discard`), with the record id and never the body. Counters and dashboards are a follow-up.
- Investment buy and sell are not covered yet; they move onto the same mechanism with `investment-on-money`.

## Sources

Read for the design on 2026-10-03; see `design.md` for the exact claims taken from each. Fintech-native first: Stripe (idempotent requests), Brandur ("Implementing Stripe-like Idempotency Keys in Postgres"), Adyen (API idempotency), Square (idempotency), Monzo (`dedupe_id`), Mercado Pago (`X-Idempotency-Key`), and the IETF `Idempotency-Key` header draft (expired draft, never an RFC). Airbnb's payments write-up is supplementary only; no decision rests on it alone.
