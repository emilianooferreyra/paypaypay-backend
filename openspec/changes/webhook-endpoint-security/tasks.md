Strict TDD: a failing test first, then the minimum code, then cleanup. This change builds on the outbox PR (`feat/outbox-relay`); start it from `main` once that PR is merged. Every e2e run needs the maintainer's consent for the `authdb_test` reset.

## 1. Address policy (pure, no I/O)

- [ ] 1.1 RED: table-driven spec for `isPublicAddress` covering every scenario of `webhook-target-validation`: blocked IPv4 and IPv6, IPv4-mapped forms, boundaries of each range (`172.15.255.255`, `172.32.0.0`, `100.63.255.255`, `100.128.0.0`), and public addresses
- [ ] 1.2 GREEN: `domain/address-policy.ts`
- [ ] 1.3 RED→GREEN: `assertDeliverableUrl(url, { allowLocal })` — https only, no credentials, no internal names, IP literals checked; with `allowLocal` it permits `http` and private targets

## 2. Checked DNS resolution

- [ ] 2.1 RED: spec for `resolvePublicAddress(host, resolver)` with a fake resolver — all public → the address to use; any private among several → rejected; none → rejected
- [ ] 2.2 GREEN: `infrastructure/safe-lookup.ts` (the `lookup` function handed to `http`/`https`), built on `dns.promises.lookup` with `all: true`
- [ ] 2.3 Move `HttpWebhookSender` from `fetch` to `node:http`/`node:https` with that `lookup`; keep the timeout, the no-redirect rule, the headers and the body byte-for-byte. The existing sender spec must pass unchanged in meaning
- [ ] 2.4 RED→GREEN: sender specs — a name that resolves to `127.0.0.1` opens no connection and yields a failure naming the address; with the dev switch on, a local receiver works

## 3. Schema

- [ ] 3.1 Migration: nullable `userId` on `WebhookEndpoint` (FK to `User`, `ON DELETE CASCADE`, index) and nullable `ownerId` on `OutboxEvent` (index); hand-review the SQL; apply every migration to a scratch database and confirm `migrate diff` reports no difference
- [ ] 3.2 Regenerate the client; typecheck

## 4. Scoping (TDD)

- [ ] 4.1 RED: `RelayOutboxEvents` spec — events fan out only to the owner's active endpoints; null owner and unowned endpoints get nothing; a user with no endpoints still marks the event processed
- [ ] 4.2 GREEN: change the `EndpointRepository` port to `findActiveOwnedBy(ownerId)`; update the in-memory store and the Prisma adapter; carry `ownerId` on `OutboxEventRecord`
- [ ] 4.3 RED→GREEN: the wallet `OutboxPort` adapter writes `ownerId` from the event data; the three wallet services pass the user id (specs on the in-memory unit of work assert it)
- [ ] 4.4 Integration spec against Postgres: two users, each with an endpoint; A's deposit reaches only A's endpoint; a null-owner event reaches nobody

## 5. Endpoint administration (TDD)

- [ ] 5.1 Define the `EndpointStore` port and an in-memory fake
- [ ] 5.2 RED: `WebhookEndpointService` spec — create stamps the owner and returns the secret once; list returns only the owner's; delete and deliveries answer 404 for someone else's and for a missing id alike; the sixth endpoint is refused; a blocked URL is refused with 400; a name that resolves privately is refused
- [ ] 5.3 GREEN: the service and the Prisma `EndpointStore`; secret from `randomBytes(32).toString("hex")`
- [ ] 5.4 Add `JwtAuthGuard` to the controller and make it thin; replace the DTO validation with the URL policy
- [ ] 5.5 e2e: 401 for every route without a session; user B cannot see, delete or read user A's endpoint; the secret appears on creation and never again; the sixth endpoint returns 409

## 6. Configuration and docs

- [ ] 6.1 `WEBHOOK_ALLOW_LOCAL_TARGETS` in the Zod schema (default `false`); warn once at startup when on; `jest.env.setup.js` sets it `true` for tests that use a local receiver
- [ ] 6.2 Update the delivery and relay e2e specs to register endpoints with an owner and to run with the switch on; keep one spec that runs with it off
- [ ] 6.3 `scripts/webhook-demo.ts`: document the switch; it already sends a JWT
- [ ] 6.4 ADR `docs/adr/0004-webhook-endpoint-security.md`; update ADR 0001's follow-up section to point to it; README lists the variable and says to leave it off in production

## 7. Verification

- [ ] 7.1 `pnpm typecheck`, `pnpm lint:ci` (no new errors in files this PR touches), `pnpm test`, `pnpm test:e2e` (with consent), `pnpm build`, `docker build --target prod`
- [ ] 7.2 Walk every scenario of the three specs and record how it was verified
- [ ] 7.3 Open the PR with the verification table and the list of what was deliberately not done
