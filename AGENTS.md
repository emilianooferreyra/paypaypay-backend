# AGENTS.md

PayPayPay backend: a multi-currency (ARS, USD, USDT, BRL) fintech API. NestJS 11, TypeScript, Prisma 7, PostgreSQL, Redis. Requests go to `/api/v1/*`; Swagger is at `/api/docs`.

This file holds what cannot be derived from reading the code. If something here contradicts the code, the code is right: fix this file.

## Commands

```bash
docker compose up -d          # Postgres + Redis (development overlay is the default)
pnpm install
npx prisma generate           # after any schema change; client lands in src/generated/prisma (never edit)
npx prisma migrate dev        # apply/create migrations
npx prisma db seed            # demo data
pnpm start:dev

pnpm typecheck                # tsc --noEmit
pnpm test                     # unit, colocated *.spec.ts
pnpm test:e2e                 # needs Postgres and Redis; specs live in e2e/
pnpm lint:ci
```

CI (`.github/workflows/ci.yml`) runs typecheck, unit and e2e. The production image is published to GHCR only from `main`, and only after those pass.

## Workflow

- **Every change goes through OpenSpec.** `openspec new change <name>`, then proposal, specs, design and tasks under `openspec/changes/<name>/`. No implementation before the plan is reviewed and approved. When done, archive the change so `openspec/specs/` stays current.
- **Strict TDD.** Write the failing test first and watch it fail, then the minimum code to pass, then clean up.
- **Verify in two tiers.**
  - *While iterating (after every step):* `pnpm typecheck` and the affected unit specs. Add `pnpm test:e2e` when the change touches the database, transactions or HTTP behavior. Jest does not type-check here, so tests passing does not replace `pnpm typecheck`.
  - *Always, before opening every PR (once the feature is finished):* `pnpm typecheck`, the full unit suite, `pnpm test:e2e`, then `pnpm build` and `docker build`. All of it must pass; CI then repeats typecheck, unit and e2e. Do not run the build commands after every intermediate change.
- **One PR per change**, branched from `main` (`feat/`, `fix/`, `chore/`, `docs/`). Conventional commits. Keep unrelated cleanups out of the PR and list them as follow-ups instead.

## Rules

- **No `any`**, including specs and mocks (`as any` and `<any>` too). Enforcement is by convention only: ESLint `no-explicit-any` is off and `noImplicitAny` is false, so the tooling will not catch it. Existing usages are being removed gradually, mostly in specs.
- **Money is never a JS `number`.** Use `Money` from `src/shared/kernel/money.ts` in domain and application code: a `bigint` in fixed point (10^-8) with no decimal library (see ADR 0002). Do not add `decimal.js`; ESLint forbids importing it in `wallet/domain` and `wallet/application`. Prisma `Decimal` belongs to persistence: convert only at the adapter boundary (`toLedgerString`, `Money.restore`), and use it in tests only as an independent oracle.
- **Money-moving use cases run inside `UnitOfWork.run`** (`src/modules/wallet/application/ports/unit-of-work.port.ts`). Its Prisma adapter applies `withOptimisticRetry`: READ COMMITTED with a `version` column as compare-and-swap, so `work` may run more than once and must have no side effects except through `tx`. Do not change the isolation level without an ADR.
- **Never call an external service inside a database transaction.**
- **Configuration goes through `src/config/envs.ts`** (Zod). Add every new variable there and to `.env.template`. Never commit `.env`.
- **Applied migrations are immutable.** Create a new one.
- **Tests:** colocated `*.spec.ts`, English test names. Reuse `src/common/testing` (`mockPrisma`, factories, `createTestingModule`).

## Architecture direction

The codebase is a modular monolith in layers (controller, service, Prisma) by default. That is a deliberate choice, not an accident.

Hexagonal architecture (`domain/`, `application/` with ports, `infrastructure/` with adapters) is being introduced incrementally, starting with `wallet` and `webhook` (see `openspec/changes/outbox-webhooks`). In a hexagonal module, `domain/` and `application/` must not import Prisma or `src/generated/prisma`. Other modules keep their current layout until a planned change migrates them; do not reorganize folders outside such a change.

Webhook events go through a transactional outbox (ADR 0001): a use case enqueues the event with `tx.outbox.enqueue` in the same transaction as the balance change, and a relay delivers it afterwards. Never send a webhook directly from a use case.

## Docker and CI facts

- Compose is a shared base plus one overlay per environment. Production is selected explicitly with `-f docker-compose.yml -f docker-compose.prod.yml`. Never put dev-only ports or volumes in the base file: Compose merges lists, so they would leak into production.
- Two health endpoints on purpose: `/api/v1/health/live` (process only, used by the image `HEALTHCHECK`) and `/api/v1/health/ready` (database and Redis). The container healthcheck must not depend on Postgres or Redis.
- The production image runs `prisma migrate deploy` in `docker-entrypoint.sh` before serving traffic.
