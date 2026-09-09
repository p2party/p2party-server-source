# Security policy

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability.

Email `security@p2party.com` with:

- the affected commit or deployed endpoint;
- reproduction steps or a proof of concept;
- the expected security impact; and
- whether you want attribution.

Use synthetic keys, room identifiers, and databases in reproductions. Do not
attach a live identity secret, TURN secret, `.env` file, or user database. Ask
`security@p2party.com` for the current encryption key before sending sensitive
artifacts.

Maintainers will acknowledge receipt, coordinate validation and remediation,
and agree on a disclosure timeline with the reporter. Please allow time for a
fix to reach supported deployments before publishing details.

## Supported version

Release 0.1.4 on the default branch supports protocol v4 only.
Older protocol versions are rejected rather than negotiated.

## Cryptographic scope

The server authenticates signaling sockets and authorizes same-room signaling.
The message protocol and cryptographic implementation live in `p2party-js`.
Neither repository has completed an independent third-party security audit;
avoid claims to the contrary.

The signaling operator can observe identity public keys, peer IDs, room
membership, IP/network metadata, and TURN use. The current server does not
provide blind rendezvous or hide room membership from its operator. Reports
that cross the signaling and message-cryptography boundary may still be sent to
`security@p2party.com`; include the affected repository and commit.

## Operational limits

Connection, authentication, message and room admission are bounded; new peer
records are written only after proof of key possession. These limits reduce
resource abuse but do not prove that identities represent distinct people.
Proof of work and passkeys are not part of the production signaling protocol.

Use one signaling worker for supported session and membership fencing. Every
encrypted PostgreSQL connection verifies its certificate. The supplied
deployment provisions and distributes a database CA over authenticated SSH.
Use `sslmode=disable` only for a disposable local database.
