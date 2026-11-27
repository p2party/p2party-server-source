# Contributing

Contributions and adversarial review are welcome.

## Development setup

Follow the fresh-clone instructions in [README.md](README.md). Use only a local,
disposable PostgreSQL database. Never point tests, Prisma migrations, or development
commands at production data or a shared database service.

The signaling server and website repositories are private. Maintainers start server changes from `master` and open pull requests in this repository. Testnet participants can read the public SDK guide, download the client and genesis, and request a unit through the SDK issue tracker. [Testnet guide](https://github.com/p2party/p2party-js/blob/master/docs/testnet-1.md) · [Request a test unit](https://github.com/p2party/p2party-js/issues/new)

Before opening a pull request, run:

```bash
bun install --frozen-lockfile
bun run db:generate
bun run db:migrate
bun run check
bun run format:check
```

The unit suite uses database doubles and schema-contract checks. CI also applies
the migrations to a fresh disposable PostgreSQL instance.

## Change guidelines

1. Open an issue before a large protocol or persistence change.
2. Keep protocol-v5 inputs bounded and bind all actions to the authenticated
   WebSocket identity.
3. Add focused tests for success, malformed input, replay, and cross-room or
   cross-identity attempts.
4. Commit both `prisma/schema.prisma` and a migration for schema changes, then
   verify that the full migration chain bootstraps a fresh PostgreSQL database.
5. Do not commit `.env` files, databases, TURN secrets, generated binaries, or
   production logs.

## Pull requests

- Keep changes focused and explain the security boundary they affect.
- Include the exact verification commands and results.
- Call out protocol or persistence compatibility changes explicitly.
- Use conventional commit messages.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not
in an issue or pull request.

By contributing, you agree that your work is distributed under the
repository's Apache-2.0 license.
