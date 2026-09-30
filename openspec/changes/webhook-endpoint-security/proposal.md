## Why

Reading `WebhookController`, `CreateEndpointDto` and the relay shows a hole that is exploitable today and predates the outbox:

1. **No authentication.** The controller has no guard, and the only global guards are the throttler and CSRF (CSRF protects cookies, not anonymous callers). Anyone who can reach the API can create, list and delete endpoints and read delivery logs.
2. **Events go to everyone.** An endpoint has no owner, and fan-out sends every event to every active endpoint. A stranger who registers a URL receives **every user's deposit, withdrawal and transfer events**: wallet ids, user ids, amounts, currencies.
3. **The server will call any address.** `@IsUrl({ require_tld: false })` accepts `http://localhost`, private ranges and `http://169.254.169.254/`, the cloud metadata address. Together with (1) this is server-side request forgery: an anonymous caller makes the server send POSTs to its internal network.

The outbox made (2) sharper: delivery is now reliable, so the leak is reliable too.

## What Changes

- **Authenticate** every route of `WebhookController` with `JwtAuthGuard`.
- **Ownership.** `WebhookEndpoint` gets a `userId`. Create, list, delete and read-deliveries work only on the caller's own endpoints; someone else's endpoint answers 404, not 403, so its existence is not revealed. A user may have at most 5 endpoints.
- **Scoping.** `OutboxEvent` gets an `ownerId`; fan-out delivers an event only to active endpoints owned by that user. An endpoint or event with no owner receives and emits nothing (fail closed). Endpoints created before this change are unowned and therefore silent.
- **Target validation**, twice:
  - at registration: HTTPS only, no credentials in the URL, no `localhost`, no private, loopback, link-local, carrier-grade NAT, multicast or unique-local address, including IP literals and names that resolve to them;
  - at delivery: the name is resolved again and every resulting address is checked before connecting, and the connection uses the address that was checked, so a DNS answer that changes between checks cannot redirect the request.
- **Secret** is 32 random bytes, shown once on creation and never returned again (the list already omits it).
- A single development switch, `WEBHOOK_ALLOW_LOCAL_TARGETS` (default `false`), permits `http` and private targets for local work and tests. Production must leave it off.
- **BREAKING**: endpoint routes now require authentication and only see the caller's endpoints; unauthenticated callers get 401. Existing unowned endpoints stop receiving events. `scripts/webhook-demo.ts` already sends a JWT and needs the dev switch on the server.

## Capabilities

### New Capabilities
- `webhook-endpoint-ownership`: authentication, per-user ownership, limits, secret handling.
- `webhook-target-validation`: which URLs may be registered and called.
- `webhook-event-scoping`: an event reaches only its owner's endpoints.

### Modified Capabilities
- *(none in `openspec/specs/`; the delivery behavior it touches belongs to the unarchived `outbox-webhooks` change)*

## Impact

- **Code**: `webhook.controller.ts`, new application service and ports for endpoint administration, `RelayOutboxEvents`, the endpoint repository and the outbox adapter, `HttpWebhookSender`, wallet outbox adapter (sets `ownerId`), `envs.ts`.
- **Database**: additive migration: nullable `userId` on `WebhookEndpoint` (FK to `User`, cascade) and nullable `ownerId` on `OutboxEvent`, with indexes.
- **Depends on** the outbox PR (`feat/outbox-relay`): it changes the relay and the sender that PR introduces.
- **Out of scope** (follow-ups): encrypting secrets at rest (the HMAC needs the raw secret, so it must be reversible: AES-GCM with a key from the environment), API keys for machine clients, an audit log entry per create and delete, a signature that covers a timestamp, and an egress proxy or firewall rule, which is the real production answer to SSRF; the in-app check is defense in depth.
