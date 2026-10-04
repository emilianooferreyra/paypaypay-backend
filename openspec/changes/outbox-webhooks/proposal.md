## Why

Webhook delivery is not reliable today, and the code shows why (verified in `webhook.service.ts`, `deposit.service.ts`, `send.service.ts`, `withdraw.service.ts`):

1. **Dual write.** The money transaction commits, and only afterwards the service calls `webhookService.dispatch(...)`. If the process dies between the two, the balance changed and the event is gone, with no trace.
2. **Delivery runs inside the request.** `dispatch` is awaited in the HTTP request path and calls each endpoint sequentially with `fetch` and **no timeout**. A slow merchant endpoint slows down (or hangs) a deposit response. The `.catch` only swallows the error.
3. **Retries live in memory.** Retries are a `setTimeout`. A restart or deploy drops them. `nextRetryAt` is written to the database but nothing ever reads it.
4. **Every retry inserts a new `WebhookDelivery` row**, and the `updateMany` that stamps `nextRetryAt` matches by endpoint/event/payload instead of by delivery id.
5. **4xx is retried like 5xx.** A permanent client error gets three attempts.
6. **No event id.** A receiver cannot deduplicate, which makes at-least-once delivery unsafe to consume.

The fix is the transactional outbox: write the event in the **same database transaction** as the business change, and let a separate relay deliver it. This is also where hexagonal architecture earns its keep (the outbox needs a transaction boundary that the application layer can request without knowing about Prisma), so this change introduces it in `wallet` and `webhook` only.

## What Changes

**PR 1 — Unit of Work seam (behavior-preserving refactor)**
- Introduce ports `UnitOfWork`, `WalletRepository`, `TransactionRepository` in `wallet/application`, and a `PrismaUnitOfWork` adapter in `wallet/infrastructure` that wraps the existing `withOptimisticRetry`.
- `DepositService`, `SendService`, `WithdrawService` depend on the ports, not on `PrismaService`. Public behavior, HTTP responses and error codes do not change.
- Add an ESLint restriction so `domain/` and `application/` cannot import Prisma.

**PR 2 — Outbox and relay**
- New `OutboxEvent` table. The three services enqueue `deposit.confirmed`, `withdraw.completed`, `transfer.completed` through `ctx.outbox` inside the unit of work.
- A relay fans each event out into one `WebhookDelivery` per active endpoint, then delivers due deliveries with a lease-based claim (`FOR UPDATE SKIP LOCKED`), a request timeout, persisted exponential backoff, and a terminal `dead` state.
- Remove `WebhookService.dispatch` and the `setTimeout` retry. Request handlers never perform HTTP to webhook endpoints again.
- Payloads and the `X-Webhook-Id` header carry the event id so receivers can deduplicate. The signature scheme is unchanged.
- **BREAKING**: none for receivers (additive `id` field and header). Delivery becomes asynchronous: a webhook is no longer sent before the API response returns.

## Capabilities

### New Capabilities
- `wallet-unit-of-work`: transaction boundary and persistence ports for wallet use cases.
- `transactional-outbox`: events are persisted atomically with the business change.
- `webhook-delivery-worker`: fan-out, leasing, retry policy and delivery semantics.

### Modified Capabilities
- `webhook`: the requirements "WebhookService dispatch with endpoints", "WebhookService retry on failure" and "WebhookService delivery record creation" change, because dispatch is no longer synchronous or in-memory.

## Impact

- **Modules**: `wallet` (services move under `application/`, new `domain/` and `infrastructure/`), `webhook` (same three-layer split), `prisma` (unchanged), `config` (new env vars).
- **Database**: new table `OutboxEvent`; new nullable columns on `WebhookDelivery` (`eventId`, `lockedUntil`, `lastError`) and a unique index on (`eventId`, `endpointId`). Additive migration; existing rows stay valid.
- **Env**: `OUTBOX_RELAY_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`, `OUTBOX_LEASE_MS`.
- **Tests**: `deposit/send/withdraw` specs are rewritten against in-memory fakes of the ports. New integration tests need Postgres (already available in CI).
- **Out of scope** (documented as follow-ups): replay-protected signature (`t=`/`v1=`), replay endpoint for dead deliveries, moving `exchange` and `investment` onto the unit of work, splitting the relay into its own process, `LISTEN/NOTIFY` instead of polling, metrics for outbox lag, the double-entry ledger.
