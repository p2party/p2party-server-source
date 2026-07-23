# Contributing

Contributions and adversarial review are welcome.

1. Open an issue before a large protocol or persistence change.
2. Keep protocol-v3 inputs bounded and bind all actions to the authenticated
   WebSocket identity.
3. Add focused tests for success, malformed input, replay, and cross-room or
   cross-identity attempts.
4. Run `bun run check` and `bun run format:check`.
5. Do not commit `.env` files, databases, TURN secrets, generated binaries, or
   production logs.

Use conventional, focused commits. By contributing, you agree that your work
is distributed under the repository's AGPL-3.0-only license.
