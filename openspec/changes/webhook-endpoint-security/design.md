## Context

`WebhookController` talks to Prisma directly and has no guard. `WebhookEndpoint` has no owner. The relay (from the outbox PR) asks the endpoint repository for *all* active endpoints and sends every event to each. `HttpWebhookSender` calls `fetch` on whatever URL is stored, with `redirect: "manual"` already set.

This change closes the three holes in the proposal without changing how delivery itself works.

## Decisions

### D1. Who owns an endpoint: the authenticated user

| Option | Pros | Cons |
|---|---|---|
| **A. Owner is the authenticated user; an endpoint receives only that user's events (chosen)** | Smallest model that is correct; uses the auth that exists; nothing leaks across users | Not the merchant/partner model a payments gateway has |
| B. API keys and merchant accounts | What a gateway like Nave exposes | Needs a new entity, key issuing, rotation; too large for a security fix |
| C. Admin-only global endpoints | Keeps today's "everything to everyone" semantics | Keeps the leak; needs roles that do not exist |

B is a reasonable next step and does not conflict with A: an "owner" can later be a merchant.

### D2. Fail closed

An event with no `ownerId`, or an endpoint with no `userId`, matches nothing. Endpoints created before this change have no owner and go silent. That is deliberate: assigning them to someone would be guessing, and "silent" is recoverable (the owner registers again) while "delivered to the wrong person" is not.

### D3. 404 instead of 403 for someone else's endpoint

A 403 confirms the id exists. Answering 404 for "not yours" and "does not exist" alike gives an attacker no way to enumerate ids.

### D4. `ownerId` on `OutboxEvent` as a column

| Option | Pros | Cons |
|---|---|---|
| **A. Explicit nullable `ownerId` column (chosen)** | Part of the contract, indexable, null means "deliver to nobody" | One more column and a migration |
| B. Read `payload->>'userId'` in SQL | No schema change | The security rule would hide inside a JSON shape that a future event could omit |

### D5. Validate the target twice, and connect to the address that was checked

| Option | Pros | Cons |
|---|---|---|
| A. Validate at registration only | Simple | A name can resolve to a public address today and a private one at delivery time (DNS rebinding), so the check proves nothing later |
| **B. At registration, and again at delivery with a connect-time check (chosen)** | Closes rebinding: the address that was checked is the address that is used | Needs `http`/`https` with a custom `lookup` instead of `fetch` |
| C. Egress proxy or firewall rule | The real answer in production | Infrastructure, not code in this repo; complementary, not a substitute |

`fetch` gives no hook between name resolution and connection, so the sender moves to `node:http` / `node:https` with a `lookup` function that resolves, rejects any non-public address, and returns the address to connect to. Redirects stay unfollowed (already the policy). The pure part, `isPublicAddress` and `assertDeliverableUrl`, lives in `domain/` with no I/O and is tested exhaustively; the `lookup` adapter is thin.

Blocked: loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`, which includes the metadata address), carrier-grade NAT (`100.64/10`), unspecified (`0.0.0.0/8`, `::`), multicast and reserved ranges, unique-local IPv6 (`fc00::/7`), and IPv4-mapped IPv6 forms of all of those (`::ffff:10.0.0.1`). Names `localhost`, `*.localhost`, `*.local` and `*.internal` are rejected without resolving.

### D6. One development switch

`WEBHOOK_ALLOW_LOCAL_TARGETS` (default `false`) allows `http` and private addresses. Tests and the demo need a receiver on `127.0.0.1`. One flag is easier to reason about, and to audit in a deployment, than two. The e2e tests that assert blocking run with it off, through the pure functions and a sender built with the flag off.

### D7. Hexagonal shape

The controller becomes thin and calls `WebhookEndpointService` (application), which depends on an `EndpointStore` port (create, list by owner, delete by owner, count by owner, list deliveries by owner) implemented with Prisma in `infrastructure/persistence/`. The URL policy is domain code. The relay's `EndpointRepository` port changes from `findActive()` to `findActiveOwnedBy(ownerId)`; a `null` owner returns nothing.

### D8. Secret generation

`randomBytes(32).toString("hex")` replaces `randomUUID()`: 256 bits instead of 122, and no version or variant bits that make a UUID look structured. Existing secrets keep working.

## Risks

| Risk | Mitigation |
|---|---|
| Existing endpoints go silent | Intended and documented; the owner re-registers. The migration does not guess owners |
| Switching `fetch` to `http`/`https` changes timeout and body handling | The sender spec already covers headers, redirect, timeout and failure against a real server; it runs unchanged and must stay green |
| IPv6 and mapped-address edge cases in the blocklist | Table-driven tests with both allowed and blocked addresses, including mapped forms and boundary addresses of each range |
| Name resolves to several addresses, some private | All addresses must be public; one private answer rejects the target |
| The dev switch left on in production | Default off; the ADR and README say so; it is logged once at startup when on |
| A legitimate partner behind a private DNS name | Not supported by design; an egress-controlled deployment can revisit |

## Follow-ups

Encrypt secrets at rest; API keys for machine clients; audit log entries for create and delete; signature with timestamp; egress firewall; per-endpoint event filtering.
