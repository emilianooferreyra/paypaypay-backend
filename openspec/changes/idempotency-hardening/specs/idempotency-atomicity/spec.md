## ADDED Requirements

### Requirement: The key is claimed before the work, by the database

The server SHALL claim a key by inserting an `IN_PROGRESS` record under a unique `(userId, key)` before the handler runs. The unique index MUST be the only arbiter between concurrent requests.

#### Scenario: Two claims at once
- **WHEN** two requests insert the same `(userId, key)` simultaneously
- **THEN** exactly one insert SHALL succeed
- **AND** the other SHALL observe the existing record

#### Scenario: The claim stores what is needed to compare later
- **WHEN** a key is claimed
- **THEN** the record SHALL hold the user, the key, the request fingerprint, a fresh lock token and a lease expiry

### Requirement: The record is completed inside the money transaction

For a successful money operation, the record's status, code and response SHALL be written in the same database transaction as the balance change.

#### Scenario: Commit
- **WHEN** a deposit commits
- **THEN** the balance change, the transaction record, the outbox event and the `COMPLETED` idempotency record SHALL all be visible together

#### Scenario: Rollback
- **GIVEN** the operation fails after writing the balance
- **WHEN** the transaction rolls back
- **THEN** the idempotency record SHALL NOT be `COMPLETED`

#### Scenario: Crash after commit
- **GIVEN** the process stops right after the commit
- **WHEN** the client retries with the same key
- **THEN** the stored response SHALL be replayed
- **AND** the money SHALL NOT move again

### Requirement: A stale holder cannot commit

Completion MUST succeed only for the current lock token while the record is `IN_PROGRESS`. If it does not, the operation SHALL fail and its money movement SHALL roll back.

#### Scenario: Takeover then a late finish
- **GIVEN** request A claimed key K and then stalled past its lease
- **AND** request B took over the key and completed
- **WHEN** request A tries to complete
- **THEN** A's completion SHALL be refused
- **AND** A's balance change SHALL be rolled back
- **AND** the balance SHALL reflect exactly one execution

#### Scenario: Takeover only after expiry
- **GIVEN** a record `IN_PROGRESS` whose lease has not expired
- **WHEN** another request with the same key arrives
- **THEN** it SHALL NOT take over

#### Scenario: Takeover after expiry
- **GIVEN** a record `IN_PROGRESS` whose lease expired without completing
- **WHEN** a request with the same key and fingerprint arrives
- **THEN** it SHALL take over with a new lock token
- **AND** execute exactly once

### Requirement: The lease outlives the longest money transaction

At startup the application SHALL refuse a lease shorter than three times the sum of `DB_TRANSACTION_MAX_WAIT_MS` and `DB_TRANSACTION_TIMEOUT_MS`. Lease expiry SHALL be judged with the database clock.

#### Scenario: A lease that is too short
- **GIVEN** `IDEMPOTENCY_LEASE_MS` is lower than that bound
- **WHEN** the application starts
- **THEN** it SHALL fail with a message naming both values

### Requirement: Idempotency data is read and written on the primary

The store MUST NOT read idempotency records through a replica.

#### Scenario: Single connection
- **WHEN** the store is constructed
- **THEN** it SHALL use the same primary connection as the money flows
