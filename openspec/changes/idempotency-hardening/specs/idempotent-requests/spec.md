## ADDED Requirements

### Requirement: Money endpoints require a valid idempotency key

`POST /wallet/deposit`, `/withdraw`, `/exchange` and `/send` SHALL require an `Idempotency-Key` header of 1 to 255 characters from the set `A-Z a-z 0-9 . _ : -`, and MUST answer 400 otherwise.

#### Scenario: Missing key
- **WHEN** a client calls a money endpoint without `Idempotency-Key`
- **THEN** the response SHALL be 400
- **AND** no money SHALL move

#### Scenario: Malformed key
- **WHEN** a client sends an empty key, a key of 256 characters, or a key containing a space or a newline
- **THEN** each response SHALL be 400

#### Scenario: A UUID is accepted
- **WHEN** a client sends a valid UUID as the key
- **THEN** the request SHALL proceed

### Requirement: A repeated request is answered from the stored result

When a key is reused with the same fingerprint after the first request finished, the server SHALL return the stored status code and body without executing the operation again, and SHALL mark the response with `Idempotent-Replayed: true`.

#### Scenario: Retry after success
- **GIVEN** a deposit of 500 ARS with key K succeeded
- **WHEN** the same request is sent again with key K
- **THEN** the response SHALL equal the first one
- **AND** the balance SHALL have increased once
- **AND** exactly one transaction SHALL exist

#### Scenario: Retry after a deterministic error
- **GIVEN** a withdrawal with key K failed with 422 `Insufficient balance`
- **WHEN** the same request is sent again with key K
- **THEN** the response SHALL again be 422 with the same body
- **AND** no operation SHALL be attempted

### Requirement: A changed request under the same key is refused

If a key is reused with a different fingerprint, where the fingerprint covers the method, the route and the body, the server MUST answer 422 and MUST NOT execute anything.

#### Scenario: Different amount
- **GIVEN** a deposit of 500 with key K succeeded
- **WHEN** a deposit of 900 is sent with key K
- **THEN** the response SHALL be 422
- **AND** the balance SHALL be unchanged by the second request

#### Scenario: Same body on another endpoint
- **GIVEN** a deposit with key K
- **WHEN** a withdrawal with the same body and key K is sent
- **THEN** the response SHALL be 422

#### Scenario: Field order does not matter
- **GIVEN** a request whose JSON fields are in one order
- **WHEN** the same request is retried with the fields in another order
- **THEN** it SHALL be treated as the same request

### Requirement: A duplicate while the first is running gets 409

While a request with a given key is still executing, a second request with the same key and fingerprint SHALL be answered with 409 and a `Retry-After` header, and MUST NOT execute the operation.

#### Scenario: Concurrent duplicate
- **GIVEN** a request with key K is still executing
- **WHEN** a second request with the same key and fingerprint arrives
- **THEN** the response SHALL be 409
- **AND** it SHALL carry a `Retry-After` header
- **AND** the operation SHALL NOT run a second time

#### Scenario: Many simultaneous requests
- **WHEN** 20 identical requests with the same key are sent at the same time
- **THEN** exactly one transaction SHALL be created
- **AND** every other response SHALL be a 409 or a replay of the stored result

### Requirement: Keys are scoped to the user

A key SHALL be unique per user. One user's key MUST NOT match, replay or conflict with another user's request.

#### Scenario: Two users, same key
- **GIVEN** user A completed a deposit with key K
- **WHEN** user B sends a different deposit with key K
- **THEN** B's request SHALL execute normally
- **AND** B SHALL NOT receive A's response

### Requirement: Transient failures leave the key reusable

A 409 from an exhausted optimistic lock, any 5xx, and any unexpected error SHALL release the key so the client can retry it.

#### Scenario: Unexpected error
- **GIVEN** a request with key K failed with an unexpected error before committing
- **WHEN** the same request is retried with key K
- **THEN** it SHALL execute

### Requirement: Records expire

A record SHALL be removed once older than `IDEMPOTENCY_TTL_HOURS` (default 72), and a key whose record was removed SHALL be treated as new.

#### Scenario: Cleanup
- **GIVEN** records older and newer than the retention window
- **WHEN** the cleanup runs
- **THEN** only the older ones SHALL be deleted
