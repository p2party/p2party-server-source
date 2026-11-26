/**
 * Runs before any test file is imported (bunfig.toml, `[test] preload`).
 *
 * Bun loads `.env` for `bun test` as for `bun run`, and src/prismaClient.ts
 * configures the shared client from DATABASE_URL when it is first imported. A
 * test that reached that client by mistake would query the developer's
 * database. DATABASE_URL is replaced here, whatever `.env` or the shell set,
 * with an address nothing listens on, so no test can open a connection to a
 * real database through the shared client. Tests that need PostgreSQL build
 * their own client from P2PARTY_TEST_POSTGRES_URL (tests/db/throwawayPostgres.ts).
 */
export const TEST_DATABASE_URL =
  "postgresql://bun-test:bun-test@127.0.0.1:1/no-database?sslmode=disable";

process.env.DATABASE_URL = TEST_DATABASE_URL;
