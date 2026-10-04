## Decisions

### D1. Keep `e2e/`, fix the tooling

| Option | Pros | Cons |
|---|---|---|
| **A. Keep `e2e/`, add it to scripts and `.dockerignore` (chosen)** | Small, nothing moves, no path churn in CI | Differs from the `test/` folder the NestJS docs use in their examples |
| B. Rename to `test/` | Matches the docs and every existing glob | Touches `test:e2e`, CI, `global-setup`, imports, and history |

The docs use `test/` in examples but do not require it. Naming and a separate Jest config (the parts that matter) already match.

### D2. Lint `.js` files without type information

The error means typed linting (`projectService`) found a file that is not in `tsconfig.json`; `.js` files are not included unless `allowJs` or `checkJs` is on.

| Option | Pros | Cons |
|---|---|---|
| **A. `tseslint.configs.disableTypeChecked` for `**/*.js` (chosen)** | The documented fix for files that do not need type information; no tsconfig change | JS files get syntax rules, not type-aware ones |
| B. `allowDefaultProject: ['e2e/*.js', ...]` | Keeps typed rules | Meant for a handful of files; slower; needs maintenance as files are added |
| C. `allowJs` in `tsconfig.json` | Typed rules on JS | Makes `tsc` check the JS files too, which is where `// @ts-nocheck` would be needed; grows the typecheck surface |
| D. Convert the four files to TypeScript | Cleanest long term | Jest `globalSetup` and `setupFiles` in TS need extra transform setup; out of proportion for four small files |

`// @ts-nocheck` is removed: it affects `tsc`, which never sees these files.

### D3. One `configureApp`

`src/bootstrap/configure-app.ts` exports `configureApp(app, options?)` applying helmet, cookie parser, global prefix, URI versioning, CORS from `envs.ALLOWED_ORIGINS`, the global `ValidationPipe`, `GlobalExceptionFilter` and `LoggingInterceptor`. `main.ts` keeps what only a running server needs (`enableShutdownHooks`, Swagger, `listen`); an option lets production enable shutdown hooks without registering process signal handlers for every e2e app.

The test module compiles `AppModule`, calls `configureApp`, then `init()`. This follows the docs' pattern and removes the duplicated block, so the two can no longer drift.

### D4. Build the e2e schema from migrations, keep the safety guard

`prisma db push` syncs the schema directly and skips migration history. `prisma migrate reset --force --skip-seed --skip-generate` drops the database, applies every migration, and therefore fails if migrations and schema disagree.

Two safety rules, both deliberate:

- `global-setup.js` refuses to run unless the database name in `DATABASE_URL` ends in `_test`, so a wrong env var can never reset a development or production database.
- The reset stays a Prisma command on purpose. Prisma blocks destructive commands launched by an AI agent until the user consents. Replacing it with a hand-written `DROP SCHEMA` would make the suite pass without that check, which defeats the guard. Each agent-launched run keeps needing explicit consent.

### D5. Tests for the new code

`configureApp` gets a unit test with a typed stub of the application, asserting the pipeline it registers. The database guard gets a test for the name check (pure function). Tooling changes are verified by running the tools (see tasks).

## Risks

| Risk | Mitigation |
|---|---|
| Existing e2e specs depended on CORS `*` or no interceptor | Run the suite after the bootstrap change and fix only real failures; list them in the PR |
| `migrate reset` fails because migrations and schema already disagree | That is the point. If it fails, the fix is a new migration, reported separately |
| `migrate reset` is slower than `db push` | Accepted; measured in the PR |
| `_test` guard blocks a legitimate custom database name | Name the variable to override explicitly only if ever needed; not added now |

## Follow-ups

Split HTTP e2e from DB integration specs; `e2e/support/` for helpers when the suite grows; turn on `no-explicit-any` as an error for production code.
