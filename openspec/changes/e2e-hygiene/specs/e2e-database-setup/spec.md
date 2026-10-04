## ADDED Requirements

### Requirement: The e2e schema is built from the migrations

The e2e global setup SHALL create the schema by applying the migration history (`prisma migrate reset`), not by syncing `schema.prisma` directly.

#### Scenario: Migration drift fails the suite
- **GIVEN** `schema.prisma` has a column that no migration creates
- **WHEN** the e2e suite starts
- **THEN** the setup or the first query that needs the column SHALL fail

#### Scenario: Migrations and schema agree
- **GIVEN** every schema change has a migration
- **WHEN** the e2e suite starts
- **THEN** the setup SHALL complete and the suite SHALL run

### Requirement: The setup only touches a test database

The global setup MUST refuse to run when the database name in `DATABASE_URL` does not end in `_test`.

#### Scenario: Development database is protected
- **GIVEN** `DATABASE_URL` points at `authdb`
- **WHEN** the global setup runs
- **THEN** it SHALL throw before issuing any reset
- **AND** the message SHALL name the database and the `_test` requirement

#### Scenario: Test database is accepted
- **GIVEN** `DATABASE_URL` points at `authdb_test`
- **WHEN** the global setup runs
- **THEN** it SHALL proceed to reset that database

### Requirement: The destructive reset stays behind the Prisma guard

The reset MUST be executed through a Prisma command, so the agent consent check Prisma applies keeps working.

#### Scenario: Agent-launched run needs consent
- **GIVEN** the suite is launched by an AI agent without the consent variable
- **WHEN** the reset command runs
- **THEN** Prisma SHALL refuse and the suite SHALL fail with its message
