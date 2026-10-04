## ADDED Requirements

### Requirement: One definition of the HTTP pipeline

`configureApp(app)` SHALL be the only place that registers helmet, the cookie parser, the `api` global prefix, URI versioning with default version `1`, CORS from `envs.ALLOWED_ORIGINS` with credentials, the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`), `GlobalExceptionFilter` and `LoggingInterceptor`. Both `main.ts` and the e2e bootstrap MUST call it.

#### Scenario: Production registers the full pipeline
- **WHEN** `configureApp` runs on an application
- **THEN** it SHALL register each of the pieces above exactly once

#### Scenario: The e2e app runs the same pipeline
- **WHEN** the e2e bootstrap builds the application
- **THEN** it SHALL do so through `configureApp`
- **AND** it SHALL NOT register its own copy of any of those pieces

#### Scenario: CORS is not open in tests
- **GIVEN** `ALLOWED_ORIGINS` is `http://localhost:3000`
- **WHEN** the e2e app receives a preflight request from `http://evil.test`
- **THEN** the response SHALL NOT allow that origin

### Requirement: Shutdown hooks are opt-in

`configureApp` SHALL register process shutdown hooks only when asked.

#### Scenario: Production enables them
- **WHEN** `main.ts` calls `configureApp` with shutdown hooks enabled
- **THEN** `enableShutdownHooks` SHALL be called

#### Scenario: Tests do not leak signal handlers
- **WHEN** the e2e bootstrap calls `configureApp` without that option
- **THEN** `enableShutdownHooks` SHALL NOT be called
