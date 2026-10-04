## ADDED Requirements

### Requirement: Events are persisted in the same transaction as the business change

A successful deposit, send or withdraw SHALL insert exactly one `OutboxEvent` in the same database transaction that changes the wallet and creates the transaction record.

#### Scenario: Successful operation produces one event
- **WHEN** a deposit of `100.00 ARS` succeeds
- **THEN** exactly one `OutboxEvent` of type `deposit.confirmed` SHALL exist for it
- **AND** its `aggregateId` SHALL equal the created transaction id
- **AND** its `processedAt` SHALL be null

#### Scenario: Rolled-back operation produces no event
- **GIVEN** the operation fails after the event was enqueued but before commit
- **WHEN** the transaction rolls back
- **THEN** no `OutboxEvent` SHALL exist for that operation
- **AND** the wallet balance SHALL be unchanged

#### Scenario: Failed operation produces no event
- **WHEN** a send fails with `Insufficient balance`
- **THEN** no `OutboxEvent` SHALL be created

#### Scenario: A retried transaction enqueues once
- **GIVEN** the first attempt of the unit of work fails with an optimistic-lock conflict
- **WHEN** the second attempt succeeds
- **THEN** exactly one `OutboxEvent` SHALL exist

### Requirement: Event identity and shape

Each `OutboxEvent` SHALL have a uuid `id` that is the public event id, a `type`, an `aggregateType`, an `aggregateId`, a JSON `payload` snapshot and an `occurredAt` timestamp set at enqueue time.

#### Scenario: Payload is a snapshot
- **GIVEN** an event was enqueued for a transaction
- **WHEN** the wallet is modified afterwards
- **THEN** the event payload SHALL be unchanged

### Requirement: The request path performs no webhook I/O

Wallet endpoints MUST NOT call any webhook endpoint or read `WebhookEndpoint` while serving a request.

#### Scenario: Slow receiver does not slow the API
- **GIVEN** an active endpoint that takes 30 seconds to respond
- **WHEN** a deposit request is made
- **THEN** the response time SHALL NOT depend on that endpoint
