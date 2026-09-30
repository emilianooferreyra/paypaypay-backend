## ADDED Requirements

### Requirement: Endpoint routes require authentication

Every route of `WebhookController` SHALL require a valid session and MUST answer 401 to an anonymous caller.

#### Scenario: Anonymous create
- **WHEN** an unauthenticated client calls `POST /webhooks/endpoints`
- **THEN** the response SHALL be 401
- **AND** no endpoint SHALL be created

#### Scenario: Anonymous list, delete and deliveries
- **WHEN** an unauthenticated client calls `GET /webhooks/endpoints`, `DELETE /webhooks/endpoints/:id` or `GET /webhooks/endpoints/:id/deliveries`
- **THEN** each response SHALL be 401

### Requirement: An endpoint belongs to the user who created it

Creating an endpoint SHALL record the caller as its owner. List, delete and read-deliveries MUST act only on the caller's own endpoints.

#### Scenario: Listing shows only my endpoints
- **GIVEN** user A has two endpoints and user B has one
- **WHEN** user A lists endpoints
- **THEN** only A's two endpoints SHALL be returned

#### Scenario: Someone else's endpoint looks like it does not exist
- **GIVEN** an endpoint owned by user A
- **WHEN** user B deletes it or reads its deliveries
- **THEN** the response SHALL be 404, identical to a nonexistent id
- **AND** the endpoint SHALL be unchanged

#### Scenario: Deleting my endpoint
- **WHEN** the owner deletes an endpoint
- **THEN** the response SHALL be 204
- **AND** its deliveries SHALL be removed with it

### Requirement: The secret is shown once

The response to creation SHALL include the secret. No other route MUST return it.

#### Scenario: Creation returns the secret
- **WHEN** a user creates an endpoint
- **THEN** the response SHALL contain `id`, `url` and `secret`

#### Scenario: Listing hides the secret
- **WHEN** a user lists endpoints
- **THEN** no item SHALL contain `secret`

#### Scenario: The secret is unpredictable
- **WHEN** two endpoints are created
- **THEN** their secrets SHALL differ
- **AND** each SHALL be 64 hexadecimal characters

### Requirement: A user may hold a limited number of endpoints

A user SHALL NOT have more than 5 endpoints.

#### Scenario: The sixth endpoint is refused
- **GIVEN** a user with 5 endpoints
- **WHEN** the user creates another
- **THEN** the response SHALL be 409
- **AND** no endpoint SHALL be created

#### Scenario: The limit is per user
- **GIVEN** user A has 5 endpoints
- **WHEN** user B creates one
- **THEN** the response SHALL be 201
