## Why

The e2e suite passes, but it does not test what production runs. A review against the NestJS and typescript-eslint documentation found four concrete problems:

1. **Tooling does not cover `e2e/`.** `lint`, `lint:ci` and `format` glob `test/`, and `.dockerignore` excludes `test/`. No script lints or formats the e2e files.
2. **The e2e bootstrap duplicates `main.ts` and has drifted.** `main.ts` applies `LoggingInterceptor`, CORS from `envs.ALLOWED_ORIGINS` and shutdown hooks. `e2e/setup-app.ts` applies none of them (CORS is `*`). The e2e app is not the production pipeline.
3. **The schema comes from `prisma db push --force-reset`, not from the migrations.** The suite proves `schema.prisma` works, not that the migrations do, and the repo already had a migration-drift fix.
4. **The editor reports `Parsing error: ... was not found by the project service`** on the four `.js` files (`e2e/global-setup.js`, `e2e/setup.js`, `e2e/setup-env.js`, `jest.env.setup.js`). Adding `// @ts-nocheck` to one file does not help: that directive silences `tsc`, and `tsc` already ignores `.js` files. The error comes from ESLint's typed linting, and it never shows in `lint:ci` because that script only globs `.ts`.

## What Changes

- Keep the folder name `e2e/`. Add it to `lint`, `lint:ci`, `format` and `.dockerignore`.
- Disable type-checked linting for `.js` files (`tseslint.configs.disableTypeChecked`), as the typescript-eslint docs recommend. Remove the ineffective `// @ts-nocheck`.
- Extract `configureApp(app)` into `src/bootstrap/` and use it from both `main.ts` and `e2e/setup-app.ts`.
- Build the e2e schema from the real migrations (`prisma migrate reset`) and refuse to run unless the target database name ends in `_test`.
- **BREAKING**: none for the API. E2E specs that relied on CORS `*` or on the absence of the logging interceptor may change; they are reviewed in the tasks.

## Capabilities

### New Capabilities
- `e2e-tooling`: which files lint and format cover, and how `.js` files are linted.
- `app-bootstrap`: a single definition of the HTTP pipeline shared by production and tests.
- `e2e-database-setup`: how the e2e database is built and protected.

### Modified Capabilities
- *(none)*

## Impact

- **Files**: `package.json` scripts, `.dockerignore`, `eslint.config.mjs`, `src/main.ts`, new `src/bootstrap/configure-app.ts`, `e2e/setup-app.ts`, `e2e/global-setup.js`.
- **Database**: the e2e suite now applies migrations to `authdb_test`. It still resets that database on every run, so **each run still needs the maintainer's explicit consent** when launched by an AI agent (Prisma enforces it); this change does not bypass that guard.
- **CI**: the e2e job benefits from migration coverage. It does not need extra steps.
- **Out of scope**: moving `e2e/` to `test/`, splitting HTTP e2e from database integration specs into different folders, `e2e/support/` for helpers (revisit when the suite grows).
