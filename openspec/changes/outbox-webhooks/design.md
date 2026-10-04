## Context

Wallet operations use `withOptimisticRetry(prisma, async (tx) => ...)`: a Prisma interactive transaction at READ COMMITTED, with a `version` column as compare-and-swap and bounded retries on serialization failure, deadlock and P2002. That part is well designed and stays. What is missing is a way for the application layer to say "run this atomically and enqueue an event" without importing Prisma.

Corrections to earlier notes: webhooks were described as "fire-and-forget after commit". In the code they are **awaited inline** in the request path (see proposal, point 2). The consequences are the same or worse.

## Decisions

### D1. One change, two pull requests

| Option | Pros | Cons |
|---|---|---|
| **A. One change, PR 1 = unit-of-work refactor, PR 2 = outbox (chosen)** | Refactor lands under green tests before behavior changes; each PR is reviewable; the outbox is built on the final seam | The real bug is fixed one PR later |
| B. Outbox first passing `tx` around, refactor later | Bug fixed sooner | Builds the outbox on the pattern we want to remove; refactor churn on money code afterwards |
| C. One big PR | One review | Mixes a money-path refactor with a behavior change; hard to bisect |

"Make the change easy, then make the easy change." PR 1 must change no observable behavior, and the existing specs are its safety net.

### D2. The transaction boundary is a port (Unit of Work)

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. `UnitOfWork.run(ctx => ...)` (chosen)** | The application layer receives a context exposing repositories bound to the transaction | Explicit, testable with in-memory fakes, application code has no Prisma | More interfaces |
| B. Implicit context via `AsyncLocalStorage` | Repositories find the active transaction on their own | Smaller signatures | Hidden control flow; failures are hard to debug |
| C. Pass Prisma's `tx` into use cases | What the code does today | Least code | The application layer knows Prisma; hexagonal boundary is fictional |

```ts
interface UnitOfWork {
  run<T>(work: (ctx: WalletTx) => Promise<T>): Promise<T>;
}
interface WalletTx {
  wallets: WalletRepository;
  transactions: TransactionRepository;
  outbox: OutboxPort; // added in PR 2
}
```

`PrismaUnitOfWork` calls `withOptimisticRetry`, so isolation level, timeouts and retry classification stay exactly as they are. The retry wrapper is now an adapter detail. Because the whole callback is re-run on retry, `work` must be free of side effects other than through `ctx`.

Repositories speak the domain's `Money` (from `shared/kernel`), not `Prisma.Decimal`. The mapping lives in the adapter. Scope is limited to `deposit`, `send` and `withdraw`; `exchange` keeps calling `withOptimisticRetry` directly until a later change.

### D3. Outbox stores facts; deliveries store per-endpoint state

`OutboxEvent`: `id` (uuid, becomes the public event id), `type`, `aggregateType`, `aggregateId`, `payload` (Json), `occurredAt`, `processedAt`. Partial index on `processedAt IS NULL`.

`WebhookDelivery` gains `eventId`, `lockedUntil`, `lastError`, and a unique index (`eventId`, `endpointId`). That unique index makes fan-out idempotent: if the relay crashes after creating some deliveries, re-running it cannot create duplicates.

| Option | Pros | Cons |
|---|---|---|
| **A. Fan-out in the relay (chosen)** | Outbox row is independent of the endpoint list; delivery state machine is per endpoint | Two steps in the relay |
| B. Fan-out at enqueue time | One table | Business transaction must read endpoints; an endpoint added later never sees the event; write amplification on the hot path |

Known semantic: an endpoint registered after the commit but before the relay processes the event may receive it. Accepted and documented.

### D4. Claim with a lease, do the HTTP call outside the transaction

Holding a row lock while waiting for a merchant's server would pin a database connection to network latency. Instead:

```sql
UPDATE "WebhookDelivery" SET "lockedUntil" = now() + $lease
WHERE id IN (
  SELECT id FROM "WebhookDelivery"
  WHERE status IN ('pending','failed') AND "eventId" IS NOT NULL
    AND "nextRetryAt" <= now() AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
  ORDER BY "nextRetryAt" LIMIT $batch
  FOR UPDATE SKIP LOCKED)
RETURNING *;
```

Claim is one short statement; delivery happens after it commits; the result is written with a second short update. If a worker dies mid-delivery, the lease expires and another worker picks the row up. Consequence: **delivery is at-least-once**, and a crash after the merchant responded but before we recorded it means a duplicate. That is why the event id exists.

### D5. Delivery policy

- Timeout: `AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)`, default 5000.
- Retryable: network error, timeout, 5xx, 408, 429. Everything else non-2xx is permanent and goes straight to `dead`.
- Backoff: 1 min, 5 min, 15 min (the current delays), with ±20% jitter so endpoints that recover together are not hit in lockstep. `WEBHOOK_MAX_ATTEMPTS` defaults to 3, as today. After the last attempt the delivery is `dead`, visible in the table, not deleted.
- The signed body is stored in `payload` exactly as sent, so retries sign byte-identical content.

### D6. Signature scheme is unchanged in this change

Adding `X-Webhook-Id` and an `id` field is additive. Changing what is signed (timestamp + body, Stripe-style `t=,v1=`) would break `scripts/webhook-demo.ts` and every receiver. Replay protection is a real gap; it goes to a follow-up that ships with a documented versioned header.

### D7. Runner: a plain polling loop

| Option | Pros | Cons |
|---|---|---|
| **A. `setTimeout` loop in `OnModuleInit`, stopped in `OnModuleDestroy` (chosen)** | No new dependency; safe with several instances thanks to `SKIP LOCKED`; shutdown hooks already enabled | Poll latency up to the interval; runs in the API process |
| B. `@nestjs/schedule` | Familiar | New dependency for a one-second loop |
| C. BullMQ on the existing Redis | Rich retries and dashboards | Second source of truth next to Postgres; loses the atomic link to the business transaction |
| D. `LISTEN/NOTIFY` | Near-zero latency | More moving parts; keep polling as fallback anyway |

The loop uses a recursive timeout (not `setInterval`) so a slow batch never overlaps itself, and on shutdown waits for the in-flight batch. `OUTBOX_RELAY_ENABLED=false` disables it in unit tests.

### D8. Layout for the two hexagonal modules

```
modules/wallet/
  domain/          # rules and value objects, no Nest, no Prisma
  application/     # use cases (DepositService, SendService, WithdrawService) + ports/
  infrastructure/  # controller, PrismaUnitOfWork, repositories
modules/webhook/
  domain/          # WebhookEvent, retry policy (pure functions)
  application/     # RelayOutboxEvents, DeliverDueWebhooks + ports/
  infrastructure/  # controller, Prisma repositories, HttpWebhookSender, runner
```

Class and file names of the use cases stay (`DepositService` etc.) so the diff is a move plus a dependency change, not a rename storm. Other modules keep their current layout; the two styles coexist by design, and the ADR says so.

## Risks

| Risk | Mitigation |
|---|---|
| PR 1 touches the money path | No behavior change is allowed; existing specs and `wallet.e2e-spec` must pass unchanged in meaning; new integration test proves rollback and retry through the adapter |
| Raw SQL claim depends on Postgres semantics | Integration test with two concurrent claimers proves disjoint batches; lease-expiry test proves re-claim |
| Duplicate deliveries | Documented contract: at-least-once; event id in body and `X-Webhook-Id` |
| Relay in the API process competes for the pool | Small batch, short statements, HTTP outside transactions; can move to its own entrypoint later without code changes |
| Legacy `WebhookDelivery` rows without `eventId` | The claim query requires `eventId IS NOT NULL`, so old failed rows are ignored rather than replayed |
| Migration | Additive only (new table, nullable columns, new index); no rewrite of existing data |
| No local `docker build` (project rule) | Not needed for this change; verification is unit, integration and e2e against Postgres |

## Follow-ups

Replay-protected signature v2; endpoint to replay `dead` deliveries; `exchange` and `investment` onto the unit of work; separate relay process; outbox-lag and dead-count metrics; the double-entry ledger, which will enqueue its events through the same port.

## Prior art: `@nestjs/outbox` (reviewed 2026-09-30)

The NestJS docs (reliability/outbox) describe an official package with a Prisma store. On npm it is version `0.0.1` (the only one), published days before this review, with peers `@nestjs/common` and `@nestjs/core` `^11 || ^12`. We keep our own implementation: a pre-stable dependency on the money path is a risk, and owning the design is the point of this work.

Its store independently uses the same core mechanism as D4 (lease plus `FOR UPDATE SKIP LOCKED`), which is a useful confirmation. Two ideas are worth adopting in PR 2:

1. **Commit-order per key.** On enqueue it takes `pg_advisory_xact_lock` on a hash of the message key, so rows become visible in the order transactions commit. For us the key is the wallet id: a receiver must not see `withdraw.completed` before the `deposit.confirmed` it depended on. Cost: concurrent enqueues for the same wallet serialize briefly (the optimistic lock already makes same-wallet writes contend). Added as a test-first task.
2. **Dead letters stay visible and replayable.** Our `dead` delivery status is the equivalent; a replay endpoint remains a follow-up.

Not adopted: the consumer-side inbox (merchants deduplicate by the event id we send) and the package itself.
