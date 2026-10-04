Strict TDD where there is code to test. Branch from `main`, after the wallet-unit-of-work PR is merged, so the e2e baseline is not moving. Every e2e run needs the maintainer's explicit consent for the `authdb_test` reset.

## 1. JavaScript linting

- [ ] 1.1 Reproduce: `npx eslint` on the four `.js` files shows the "project service" error (record it)
- [ ] 1.2 Add a `**/*.js` block with `tseslint.configs.disableTypeChecked` to `eslint.config.mjs`; remove `// @ts-nocheck` from `e2e/global-setup.js`
- [ ] 1.3 Re-run ESLint on the four files: no parsing error; `pnpm typecheck` unchanged

## 2. Tooling coverage

- [ ] 2.1 RED: add an unused import to an e2e spec; `pnpm lint:ci` does not report it
- [ ] 2.2 GREEN: add `e2e/**/*.ts` to `lint`, `lint:ci` and `format`; add `e2e/` to `.dockerignore`; the violation is now reported; remove it
- [ ] 2.3 Fix whatever `lint:ci` newly reports in `e2e/` (formatting only; list anything else separately)

## 3. One bootstrap (TDD)

- [ ] 3.1 RED: `src/bootstrap/configure-app.spec.ts` with a typed stub of the application asserting each registration once, and shutdown hooks only when requested
- [ ] 3.2 GREEN: `src/bootstrap/configure-app.ts`; `main.ts` calls it with shutdown hooks enabled and keeps Swagger and `listen`
- [ ] 3.3 `e2e/setup-app.ts` builds the app through `configureApp` and deletes its duplicated block
- [ ] 3.4 Add an e2e check that a preflight from a disallowed origin is not allowed
- [ ] 3.5 Run the e2e suite; fix only failures caused by real behavior differences and list them in the PR

## 4. Database setup

- [ ] 4.1 RED: unit test for a pure `assertTestDatabase(url)` — accepts `..._test`, rejects `authdb`, message names both
- [ ] 4.2 GREEN: implement it; call it first in `e2e/global-setup.js`
- [ ] 4.3 Replace `prisma db push --force-reset` with `prisma migrate reset --force --skip-seed --skip-generate`
- [ ] 4.4 Run the suite with consent: it passes; then confirm it fails if a schema column has no migration (temporary, reverted)

## 5. Verification

- [ ] 5.1 `pnpm typecheck`, `pnpm lint:ci`, `pnpm test`, `pnpm test:e2e` (with consent)
- [ ] 5.2 Update `AGENTS.md`: e2e is linted, bootstrap lives in `configureApp`, e2e builds from migrations
- [ ] 5.3 Walk every scenario of the three specs and record how it was verified
- [ ] 5.4 Open the PR with the verification table
