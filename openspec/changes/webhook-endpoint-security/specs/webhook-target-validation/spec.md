## ADDED Requirements

### Requirement: Only safe URLs can be registered

Registration SHALL accept a URL only if its scheme is `https`, it carries no username or password, its host is not `localhost`, `*.localhost`, `*.local` or `*.internal`, and it is not an IP literal in a blocked range.

#### Scenario: Plain HTTP is refused
- **WHEN** a user registers `http://merchant.example/hook`
- **THEN** the response SHALL be 400

#### Scenario: Credentials in the URL are refused
- **WHEN** a user registers `https://user:pass@merchant.example/hook`
- **THEN** the response SHALL be 400

#### Scenario: Internal names are refused
- **WHEN** a user registers `https://localhost/hook` or `https://db.internal/hook`
- **THEN** each response SHALL be 400

#### Scenario: A public HTTPS URL is accepted
- **WHEN** a user registers `https://merchant.example/hook`, resolving to a public address
- **THEN** the response SHALL be 201

### Requirement: Non-public addresses are blocked

The system SHALL treat an address as non-public if it is loopback, private, link-local (including `169.254.169.254`), carrier-grade NAT, unspecified, multicast, reserved or IPv6 unique-local, including the IPv4-mapped IPv6 form of any of them.

#### Scenario: Blocked IPv4 addresses
- **WHEN** each of `127.0.0.1`, `10.0.0.1`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0` and `224.0.0.1` is checked
- **THEN** every one SHALL be reported non-public

#### Scenario: Blocked IPv6 addresses
- **WHEN** each of `::1`, `::`, `fe80::1`, `fc00::1`, `fd12:3456::1` and `::ffff:10.0.0.1` is checked
- **THEN** every one SHALL be reported non-public

#### Scenario: Boundaries of a range
- **WHEN** `172.15.255.255`, `172.32.0.0`, `100.63.255.255` and `100.128.0.0` are checked
- **THEN** every one SHALL be reported public

#### Scenario: Public addresses pass
- **WHEN** `93.184.216.34` and `2606:2800:220:1:248:1893:25c8:1946` are checked
- **THEN** both SHALL be reported public

### Requirement: Names are resolved and checked at registration

A hostname SHALL be resolved at registration, and every address it resolves to MUST be public.

#### Scenario: A name that resolves to a private address
- **GIVEN** `rebind.example` resolves to `10.0.0.5`
- **WHEN** a user registers `https://rebind.example/hook`
- **THEN** the response SHALL be 400

#### Scenario: One private answer among public ones
- **GIVEN** a name resolves to `93.184.216.34` and `192.168.0.9`
- **WHEN** a user registers it
- **THEN** the response SHALL be 400

### Requirement: The target is checked again when it is called

At delivery time the sender SHALL resolve the host, reject the attempt if any address is non-public, and connect to an address it has just checked.

#### Scenario: A name that changed after registration
- **GIVEN** an endpoint registered while its name resolved to a public address
- **AND** the name now resolves to `127.0.0.1`
- **WHEN** a delivery is attempted
- **THEN** no connection SHALL be opened
- **AND** the outcome SHALL be a failure naming the blocked address

#### Scenario: Redirects are still not followed
- **WHEN** an endpoint answers 302
- **THEN** the sender SHALL NOT request the `Location`

### Requirement: Local targets are a development switch, off by default

With `WEBHOOK_ALLOW_LOCAL_TARGETS` unset or `false`, `http` and non-public targets MUST be refused. When it is `true` they SHALL be allowed and the application SHALL log a warning once at startup.

#### Scenario: Default refuses loopback
- **GIVEN** the switch is unset
- **WHEN** a delivery targets `http://127.0.0.1:4000/hook`
- **THEN** the attempt SHALL be refused

#### Scenario: The switch allows a local receiver
- **GIVEN** the switch is `true`
- **WHEN** a delivery targets `http://127.0.0.1:4000/hook`
- **THEN** the attempt SHALL be made
