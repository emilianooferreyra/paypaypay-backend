# ADR 0001: Deliver webhooks through a transactional outbox

- **Status:** accepted
- **Date:** 2026-09-30
- **Change:** `openspec/changes/outbox-webhooks` (PR 1: unit-of-work seam, PR 2: outbox and relay)

## Context

After a deposit, send or withdrawal committed, the service called
`webhookService.dispatch(...)` and awaited it inside the HTTP request. Reading
that code showed six problems, none of them hypothetical:

1. **Dual write.** The balance change and the webhook were two separate steps.
   If the process died between them, the money moved and the event was lost,
   with no record that it ever existed.
2. **Delivery inside the request.** Endpoints were called one after another
   with no timeout. A slow merchant slowed, or hung, the customer's deposit.
3. **Retries lived in memory.** A `setTimeout` held the schedule, so any restart
   or deploy dropped every pending retry. A `nextRetryAt` column was written
   and never read.
4. **Every retry inserted a new row,** and the statement that stamped the retry
   time matched rows by content instead of by id.
5. **A 4xx was retried like a 5xx.**
6. **No event id,** so a receiver had no way to deduplicate.

## Decision

Write the event in the **same database transaction** as the change that caused
it, and let a separate relay deliver it.

```
request ──▶ UnitOfWork.run ─┬─ wallet update
                            ├─ transaction record          one commit
                            └─ OutboxEvent (per-wallet lock)

relay ──▶ fan-out:  OutboxEvent ──▶ one WebhookDelivery per active endpoint   (one transaction)
      ──▶ deliver:  claim (lease, SKIP LOCKED) ─▶ HTTP call ─▶ record result  (no transaction open during the call)
```

- **Outbox stores facts; deliveries store per-endpoint state.** `OutboxEvent`
  holds what happened. `WebhookDelivery` holds status, attempts, lease and next
  retry for one endpoint, with a unique `(eventId, endpointId)` so fan-out can
  run twice without creating duplicates.
- **Leases, not long locks.** Claiming is a single statement using
  `FOR UPDATE SKIP LOCKED` that stamps `lockedUntil` and returns. The HTTP call
  happens afterwards, with no transaction open. A worker that dies simply lets
  its lease expire and another takes the row.
- **All state is in the database.** Retry scheduling, attempts and the
  terminal `dead` state survive a restart. There is no in-memory timer.
- **Policy is pure code.** `classify` (2xx delivered; network error, timeout,
  5xx, 408, 429 retryable; other statuses permanent, redirects included),
  backoff of 1, 5 and 15 minutes with ±20% jitter, and `decide`. All unit
  tested without a database.
- **Hexagonal where it pays.** The wallet use cases depend on a `UnitOfWork`
  port; the relay depends on repository, queue, sender and clock ports. Prisma
  and `fetch` are adapters. The same ports make a move to SQS a matter of
  replacing the sender.

## Alternatives considered

| Option | Why not |
|---|---|
| Pass Prisma's `tx` into every use case | The application layer would know Prisma; the boundary would be fiction |
| `AsyncLocalStorage` for the active transaction | Hidden control flow that is hard to debug when it fails |
| BullMQ on the existing Redis | A second source of truth next to Postgres, and no atomic link to the business transaction |
| `@nestjs/outbox` (official) | Published at `0.0.1`; a pre-stable dependency on the money path. Its Prisma store uses the same lease and `SKIP LOCKED` mechanism, which confirms the design |
| `@nestjs/schedule` | A new dependency for a one-second loop |
| `LISTEN/NOTIFY` | More moving parts; polling stays as the fallback anyway |
| Fan out at enqueue time | Puts endpoint reads and write amplification on the money path, and an endpoint added later would never see the event |

From `@nestjs/outbox` we did adopt **commit-order per key**: enqueue takes a
per-wallet advisory lock, so two writers for the same wallet serialize and
`seq` follows commit order for that wallet. Writers of different wallets never
wait for each other.

## Consequences

**Guarantees**
- An event exists if and only if its business change committed.
- Delivery is **at-least-once.** A crash after the receiver answered but before
  the result was recorded causes a duplicate. Receivers deduplicate by the
  event id, sent in the body (`id`) and in `X-Webhook-Id`.
- Enqueue order is commit order **per wallet**.

**Not guaranteed**
- **Delivery order.** Events of a wallet are enqueued in commit order, but a
  batch is delivered concurrently and retries reorder further. Receivers should
  order by `timestamp`, not arrival. A strictly ordered, per-endpoint pipeline
  is possible but would make one slow endpoint block its own queue.

**Behavior changes**
- Delivery is asynchronous: a webhook no longer leaves before the API answers.
  With the default one-second poll it typically arrives within a second.
- A redirect from an endpoint is treated as a permanent failure and never
  followed, so an endpoint cannot bounce the server to a host nobody registered.

**Costs**
- The relay shares the API process and its connection pool. Claims are short
  and batches small; it can move to its own entrypoint without code changes.
- The `lease ≥ 2 × timeout` rule is enforced at startup. A shorter lease would
  let a second worker deliver a row still being sent.

## Deliberately not built

Replay endpoint for `dead` deliveries; a signature that covers a timestamp
(changing what is signed would break every receiver, so it needs a versioned
header); a separate relay process; metrics for outbox lag and dead count; the
consumer-side inbox of the official package; moving `exchange` and `investment`
onto the unit of work.

## Follow-up that cannot wait

**Endpoint registration is unauthenticated and global.** `WebhookController`
has no guard, and the relay sends every user's events to every active
endpoint. Anyone who can reach the API can register a URL and receive other
users' deposit and withdrawal events, and can point the server at internal
addresses (SSRF). This predates the outbox and is not changed by it, but it
must be fixed before real data flows: authenticate the endpoints, scope them
to an owner, deliver only the owner's events, and validate target URLs.
