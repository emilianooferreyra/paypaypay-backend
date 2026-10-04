## ADDED Requirements

### Requirement: Fan-out creates one delivery per active endpoint, idempotently

The relay SHALL turn each unprocessed `OutboxEvent` into one `WebhookDelivery` per active endpoint and mark the event processed in the same transaction.

#### Scenario: Two active endpoints
- **GIVEN** an unprocessed event and two active endpoints
- **WHEN** the relay runs
- **THEN** two deliveries with status `pending` SHALL exist
- **AND** the event `processedAt` SHALL be set

#### Scenario: No active endpoints
- **GIVEN** an unprocessed event and no active endpoints
- **WHEN** the relay runs
- **THEN** no delivery SHALL be created
- **AND** the event SHALL be marked processed

#### Scenario: Re-running fan-out does not duplicate
- **GIVEN** a delivery already exists for (`eventId`, `endpointId`)
- **WHEN** the relay processes the same event again
- **THEN** no second delivery SHALL be created

### Requirement: Deliveries are claimed with a lease

A worker SHALL claim due deliveries with a single statement using `FOR UPDATE SKIP LOCKED` and a `lockedUntil` lease, and MUST NOT hold a database transaction open during the HTTP call.

#### Scenario: Concurrent workers claim disjoint batches
- **GIVEN** 10 due deliveries and two workers claiming at the same time with batch size 5
- **WHEN** both claim
- **THEN** no delivery SHALL be claimed by both

#### Scenario: Expired lease is re-claimed
- **GIVEN** a delivery claimed by a worker that crashed, with `lockedUntil` in the past
- **WHEN** another worker claims
- **THEN** that delivery SHALL be claimable again

#### Scenario: Live lease is respected
- **GIVEN** a delivery with `lockedUntil` in the future
- **WHEN** a worker claims
- **THEN** that delivery SHALL NOT be returned

### Requirement: Delivery request contract

Each attempt SHALL send a POST with the stored signed body, header `X-Webhook-Signature` (HMAC-SHA256 hex of the body, unchanged scheme), and header `X-Webhook-Id` equal to the event id. The body SHALL include the event `id`.

#### Scenario: Retry sends identical bytes
- **GIVEN** a delivery failed once
- **WHEN** it is retried
- **THEN** the body and signature SHALL be byte-identical to the first attempt

#### Scenario: Timeout
- **GIVEN** an endpoint that does not answer within `WEBHOOK_TIMEOUT_MS`
- **WHEN** an attempt is made
- **THEN** the request SHALL be aborted
- **AND** the attempt SHALL count as retryable

### Requirement: Outcome classification and retry policy

The worker SHALL mark 2xx as `delivered`. Network errors, timeouts, 5xx, 408 and 429 SHALL be retryable; any other non-2xx status SHALL be permanent.

#### Scenario: Delivered
- **WHEN** an endpoint answers 200
- **THEN** the delivery status SHALL be `delivered`
- **AND** `responseStatus` SHALL be 200

#### Scenario: Retryable failure schedules the next attempt in the database
- **WHEN** an endpoint answers 503 on the first attempt
- **THEN** status SHALL be `failed`, `attempts` SHALL be 1
- **AND** `nextRetryAt` SHALL be about 1 minute ahead (±20%)
- **AND** no in-memory timer SHALL be involved

#### Scenario: Permanent failure
- **WHEN** an endpoint answers 400
- **THEN** status SHALL be `dead` immediately
- **AND** `lastError` SHALL record the status

#### Scenario: Attempts exhausted
- **GIVEN** `WEBHOOK_MAX_ATTEMPTS` is 3 and the third attempt fails with 500
- **WHEN** the result is recorded
- **THEN** status SHALL be `dead`
- **AND** the row SHALL be kept

#### Scenario: A retry does not insert a new row
- **WHEN** a delivery is retried
- **THEN** the same `WebhookDelivery` row SHALL be updated

### Requirement: State survives restarts

Pending and retry state MUST live only in the database.

#### Scenario: Restart between attempts
- **GIVEN** a delivery failed and is scheduled for a later `nextRetryAt`
- **WHEN** the application restarts and the time passes
- **THEN** the delivery SHALL be attempted without any external action

### Requirement: Graceful shutdown

On shutdown the runner SHALL stop claiming new work and wait for the in-flight batch.

#### Scenario: Shutdown during a batch
- **WHEN** the module is destroyed while a batch is in flight
- **THEN** the runner SHALL finish that batch before resolving
- **AND** it SHALL NOT start another

### Requirement: Runner can be disabled

The runner SHALL NOT start when `OUTBOX_RELAY_ENABLED` is false.

#### Scenario: Disabled in unit tests
- **GIVEN** `OUTBOX_RELAY_ENABLED=false`
- **WHEN** the application boots
- **THEN** no polling timer SHALL be scheduled
