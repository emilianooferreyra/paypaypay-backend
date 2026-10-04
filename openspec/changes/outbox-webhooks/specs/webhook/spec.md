## MODIFIED Requirements

### Requirement: WebhookService dispatch with endpoints

The system SHALL deliver events to all active webhook endpoints asynchronously through the outbox relay, signing each payload with HMAC-SHA256. Delivery MUST NOT happen inside the request that produced the event.

#### Scenario: Dispatch to multiple endpoints
- **WHEN** the relay processes an event with two active endpoints
- **THEN** one `webhookDelivery` record SHALL be created per endpoint
- **AND** each endpoint SHALL receive a signed POST request via `fetch` when its delivery is claimed

#### Scenario: Skip dispatch when no endpoints
- **WHEN** the relay processes an event and no active endpoints exist
- **THEN** no HTTP requests SHALL be made
- **AND** no delivery records SHALL be created

#### Scenario: HMAC-SHA256 signature header
- **WHEN** delivering to an endpoint with secret "test-secret"
- **THEN** the request SHALL include header `X-Webhook-Signature` with HMAC-SHA256 of the exact body sent
- **AND** the request SHALL include header `X-Webhook-Id` with the event id

### Requirement: WebhookService retry on failure

The system SHALL retry failed deliveries with persisted exponential backoff, distinguishing retryable from permanent failures.

#### Scenario: Mark delivery as failed on exception
- **WHEN** `fetch` throws, times out, or returns 5xx, 408 or 429
- **THEN** the delivery record SHALL have status `failed`
- **AND** `nextRetryAt` SHALL be set to a future timestamp

#### Scenario: Mark delivery as delivered on success
- **WHEN** `fetch` returns 2xx
- **THEN** the delivery record SHALL have status `delivered`
- **AND** `responseStatus` SHALL be set

#### Scenario: Permanent client error is not retried
- **WHEN** `fetch` returns another non-2xx status such as 400 or 404
- **THEN** the delivery record SHALL have status `dead`

### Requirement: WebhookService delivery record creation

The system SHALL keep one delivery record per (event, endpoint) and update it across attempts, recording status, attempts, response status, last error and timestamps.

#### Scenario: Create delivery record
- **WHEN** the relay fans out an event
- **THEN** a `webhookDelivery` SHALL be created with `eventId`, `endpointId`, `event`, `payload` and status `pending`

#### Scenario: Attempts update the same record
- **WHEN** a delivery is attempted more than once
- **THEN** the same record SHALL be updated and its `attempts` incremented
