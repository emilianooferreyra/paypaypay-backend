## ADDED Requirements

### Requirement: Lint and format scripts cover the e2e folder

The `lint`, `lint:ci` and `format` scripts SHALL include `e2e/**/*.ts`, and `.dockerignore` SHALL exclude `e2e/`.

#### Scenario: An e2e lint violation is reported by lint:ci
- **GIVEN** an unused import is added to an e2e spec
- **WHEN** `pnpm lint:ci` runs
- **THEN** it SHALL report that file

#### Scenario: The image build context excludes e2e
- **WHEN** the Docker build context is assembled
- **THEN** `e2e/` SHALL NOT be part of it

### Requirement: JavaScript files are linted without type information

`.js` files in the project SHALL be linted with `tseslint.configs.disableTypeChecked` and MUST NOT produce a "was not found by the project service" error.

#### Scenario: Setup scripts lint cleanly
- **WHEN** ESLint runs on `e2e/global-setup.js`, `e2e/setup.js`, `e2e/setup-env.js` and `jest.env.setup.js`
- **THEN** it SHALL report no parsing error

#### Scenario: No ineffective type directive remains
- **WHEN** the `.js` setup files are read
- **THEN** none SHALL contain `// @ts-nocheck`
