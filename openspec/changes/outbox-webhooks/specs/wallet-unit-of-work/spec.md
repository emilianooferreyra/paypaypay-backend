## ADDED Requirements

### Requirement: Use cases run inside a unit of work port

`DepositService`, `SendService` and `WithdrawService` SHALL perform all reads and writes of wallet state through a `UnitOfWork` port and MUST NOT depend on `PrismaService` or on Prisma types.

#### Scenario: Business write commits atomically
- **GIVEN** a deposit whose transaction record insert fails
- **WHEN** the use case runs
- **THEN** the wallet balance SHALL be unchanged
- **AND** no transaction record SHALL exist

#### Scenario: Optimistic-lock conflict is retried
- **GIVEN** the compare-and-swap on the wallet version fails on the first attempt
- **WHEN** the unit of work runs
- **THEN** the whole callback SHALL be re-run, up to 3 attempts in total
- **AND** the final balance SHALL reflect the operation exactly once

#### Scenario: Retry classification is preserved
- **WHEN** a serialization failure (`40001`), deadlock (`40P01`) or unique violation (`P2002`) occurs inside the unit of work
- **THEN** it SHALL be retried
- **AND** any other error SHALL propagate on the first occurrence

### Requirement: Behavior of the wallet endpoints is unchanged

The refactor to the unit of work MUST NOT change HTTP status codes, response bodies or error messages of the deposit, send and withdraw endpoints.

#### Scenario: Insufficient balance
- **GIVEN** a wallet with balance lower than the amount
- **WHEN** a send or withdraw is requested
- **THEN** the response SHALL be 422 with message `Insufficient balance`
- **AND** no balance change SHALL be persisted

#### Scenario: Existing suites still pass
- **WHEN** the deposit, send, withdraw and wallet e2e suites run
- **THEN** they SHALL pass with no change to their expected HTTP outcomes

### Requirement: Inner layers do not import infrastructure

Files under `wallet/domain` and `wallet/application` MUST NOT import `PrismaService`, `generated/prisma` or `@prisma/*`.

#### Scenario: Lint fails on a forbidden import
- **GIVEN** a file in `wallet/application` that imports from `generated/prisma`
- **WHEN** ESLint runs
- **THEN** it SHALL report an error for that import
