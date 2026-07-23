# Security policy

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability.

Email `security@deliberative.io` with:

- the affected commit or deployed endpoint;
- reproduction steps or a proof of concept;
- the expected security impact; and
- whether you want attribution.

Encrypt sensitive reports before sending when possible. Maintainers will
acknowledge receipt, coordinate validation and remediation, and agree on a
disclosure timeline with the reporter.

## Supported version

Protocol v3 on the default branch is the only supported signaling protocol.
Older protocol versions are rejected rather than negotiated.

## Cryptographic scope

The server authenticates signaling sockets and authorizes same-room signaling.
The message protocol and cryptographic implementation live in `p2party-js`.
Neither repository has completed an independent third-party security audit;
avoid claims to the contrary.
