## ADDED Requirements

### Requirement: An event carries its owner

Every `OutboxEvent` produced by a wallet operation SHALL record the user it belongs to as `ownerId`.

#### Scenario: A deposit records its owner
- **WHEN** user A deposits
- **THEN** the resulting `OutboxEvent` SHALL have `ownerId` equal to A's id

### Requirement: An event is delivered only to its owner's endpoints

Fan-out SHALL create deliveries only for active endpoints whose `userId` equals the event's `ownerId`.

#### Scenario: Other users' endpoints receive nothing
- **GIVEN** user A and user B each have an active endpoint
- **WHEN** A deposits and the relay runs
- **THEN** exactly one delivery SHALL exist, for A's endpoint
- **AND** B's endpoint SHALL have none

#### Scenario: A user with no endpoints
- **GIVEN** user A has no endpoints and user B has one
- **WHEN** A deposits and the relay runs
- **THEN** no delivery SHALL be created
- **AND** the event SHALL be marked processed

#### Scenario: Several endpoints of the same owner
- **GIVEN** user A has two active endpoints
- **WHEN** A deposits and the relay runs
- **THEN** two deliveries SHALL exist, one per endpoint

### Requirement: Missing ownership fails closed

An event without an `ownerId`, or an endpoint without a `userId`, MUST NOT produce any delivery.

#### Scenario: Event without an owner
- **GIVEN** an `OutboxEvent` with no `ownerId` and an active endpoint owned by A
- **WHEN** the relay runs
- **THEN** no delivery SHALL be created
- **AND** the event SHALL be marked processed

#### Scenario: Endpoint without an owner
- **GIVEN** an active endpoint with no `userId`
- **WHEN** any event is fanned out
- **THEN** that endpoint SHALL receive no delivery

### Requirement: Inactive endpoints stay silent

Fan-out SHALL skip every endpoint whose `active` flag is false, whoever owns it.

#### Scenario: Deactivated endpoint
- **GIVEN** an endpoint owned by A with `active` false
- **WHEN** A deposits and the relay runs
- **THEN** no delivery SHALL be created for it
