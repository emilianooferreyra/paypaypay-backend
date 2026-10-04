# PayFlow

Financial simulation platform built with NestJS. Multi-currency wallets, virtual cards, simulated investments, and full authentication.

## Stack

- **NestJS** + TypeScript — framework core
- **PostgreSQL** + **Prisma ORM** — data layer
- **Redis** + **Keyv** — token caching, OTP expiry, rate limiting
- **Passport.js** + JWT — authentication with access/refresh token rotation
- **Docker** — local development environment

## Quick Start

```bash
# Start services
docker compose up -d

# Install dependencies
pnpm install

# Run migrations
pnpm prisma:migrate:dev

# Seed database
pnpm prisma:seed

# Start development server
pnpm start:dev
```

### Docker environments

Compose is split into a shared base and one overlay per environment, so the two
cannot drift apart:

```bash
# Development — docker-compose.override.yml is picked up automatically
docker compose up

# Production
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The bare command is the development one on purpose: the easiest thing to type
should never be the one that starts a production configuration.

The production image runs `prisma migrate deploy` before it accepts traffic, and
refuses to boot when `RECAPTCHA_SECRET_KEY` is unset — the guard treats a missing
key in production as a misconfiguration rather than something to degrade past.

Then visit `http://localhost:3000/api/docs` for Swagger.

## Architecture

### Module Structure

```
src/modules/
├── auth/          # Authentication, 2FA, sessions, password recovery
├── users/         # User CRUD and profile
├── wallet/        # Multi-currency wallet (optimistic locking, idempotency)
├── transaction/   # Immutable transaction records
├── investment/    # Simulated asset portfolio
├── card/          # Virtual card management
├── webhook/       # Webhook dispatch with retry + HMAC verification
├── session/       # Session lifecycle (create, rotate, revoke)
├── tokens/        # Token generation and OTP validation
├── hash/          # Password hashing (Argon2 / bcrypt)
├── emails/        # Transactional email integration
└── prisma/        # Database service provider
```

### Key Decisions

| Decision | Rationale |
|---|---|
| **Optimistic locking** on wallet balance | Prevents race conditions without pessimistic locks, version column tracks concurrency |
| **Idempotency guard** (`IdempotentKey`) | Replay-safe financial operations — same key returns cached result |
| **Refresh token rotation** | Each refresh invalidates the previous token, preventing token reuse if compromised |
| **E2E with mock Prisma** | Override `PrismaService` with `mockPrisma` — full NestJS module graph runs but the database is a mock, enabling fast deterministic tests |
| **2FA rate limiting** | In-memory sliding window (5 attempts / 15 min) per user |
| **Session-based auth** | Access tokens reference DB sessions — revoke a session and access is cut immediately, no JWT expiry wait |

### Testing

Two layers:

**Unit tests** (`*.spec.ts`) — co-located with source files. Services tested with `Test.createTestingModule` overrides.

**E2E tests** (`e2e/*.e2e-spec.ts`) — full NestJS application with real middleware, guards, pipes, and filters. Database is replaced with `mockPrisma`:

```ts
const moduleFixture = await Test.createTestingModule({
  imports: [AppModule],
})
  .overrideProvider(PrismaService)
  .useValue(mockPrisma)
  .compile();
```

No database needed — each test sets up Prisma mock return values in `beforeEach`. Auth guards rely on mocked session lookups.

### Service Layer

`auth.service.ts` was refactored into focused services:

| Service | Responsibility |
|---|---|
| `AuthService` | register, login, refresh, googleLogin, logout |
| `SessionTokenService` | JWT generation, session creation, cookie management |
| `TwoFactorService` | 2FA generate/enable/disable/verify, backup codes, rate limiting |
| `PasswordRecoveryService` | forgot-password, verify-otp, reset-password |

## Commands

```bash
# Unit tests
pnpm test

# E2E tests
pnpm test:e2e

# Prisma
pnpm prisma:generate    # Generate client after schema change
pnpm prisma:migrate:dev # Apply migrations
pnpm prisma:seed        # Seed demo data
pnpm prisma:studio      # Database GUI

# Webhook demo
pnpm webhook:demo       # Runs local webhook receiver + deposit flow
```

## Environment

Copy `.env.template` to `.env`. Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_ACCESS_SECRET` | Access token signing key |
| `JWT_REFRESH_SECRET` | Refresh token signing key |
| `FRONTEND_URL` | CORS origin (default: `http://localhost:3001`) |

Optional, for tuning the money flow:

| Variable | Default | Description |
|---|---|---|
| `DB_TRANSACTION_MAX_WAIT_MS` | `5000` | How long a money transaction waits for a pooled connection |
| `DB_TRANSACTION_TIMEOUT_MS` | `10000` | How long it may hold that connection before rolling back |
| `REFRESH_GRACE_PERIOD_MS` | `2000` | Window where a superseded refresh token is still accepted |
| `EXCHANGE_RATE_MAX_AGE_MS` | `300000` | Age past which a quote is rejected as stale |

Webhook delivery. Events are written to an outbox inside the same transaction as
the wallet change and delivered by a relay that polls the database; see
[ADR 0001](docs/adr/0001-transactional-outbox.md).

| Variable | Default | Description |
|---|---|---|
| `OUTBOX_RELAY_ENABLED` | `true` | Whether this process runs the relay. `false` for an instance that only serves requests (tests set it) |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Pause between cycles when there is nothing to do |
| `OUTBOX_BATCH_SIZE` | `20` | Events fanned out, and deliveries claimed, per cycle |
| `OUTBOX_LEASE_MS` | `60000` | How long a claimed delivery is reserved. Must be at least twice `WEBHOOK_TIMEOUT_MS` or the app refuses to start |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt limit on an endpoint's response |
| `WEBHOOK_MAX_ATTEMPTS` | `3` | Total attempts before a delivery is marked `dead` |

The schema in `src/config/envs.ts` validates on import and throws, so a missing
required variable fails the process at boot rather than at first use. Tests get
safe defaults from `jest.env.setup.js` and need no `.env`.

## Deployment

- **Backend**: Railway (Dockerfile)
- **Frontend**: Vercel (Next.js with API rewrites to Railway)
- **Database**: Railway PostgreSQL
- **Cache**: Railway Redis (Upstash)
