import rekeyStatement from "../../prisma/migrations/20261127000000_rekey_peers_to_derived_ids/migration.sql" with { type: "text" };

import type { ProcessPrismaClient } from "../prismaClient";

/**
 * The newest migration this build ships: the database schema it was built
 * for. tests/schemaCheck.test.ts fails when a migration directory is added
 * without updating it.
 */
export const NEWEST_MIGRATION = "20261127000100_routing_claim_owner";

/** One row of Prisma's `_prisma_migrations` history. */
export interface MigrationRecord {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

const RECOVERY = 'see deploy/README.md, "A failed or interrupted migration"';

/**
 * Why this build must not start on a database with this migration history,
 * as the one line an operator reads; undefined when the database is at
 * exactly this build's schema. `history` is undefined when the database has
 * no migration history table at all.
 */
export const schemaRefusal = (
  history: readonly MigrationRecord[] | undefined,
  newest: string = NEWEST_MIGRATION,
): string | undefined => {
  const refuse = (found: string, run: string) =>
    `p2party: refusing to start: ${found}; ${run}`;
  if (history === undefined || history.length === 0)
    return refuse(
      "the database has no migration history (an empty database)",
      `run \`prisma migrate deploy\` to reach ${newest}, then start again`,
    );
  const unfinished = history.find(
    ({ finished_at, rolled_back_at }) =>
      finished_at === null && rolled_back_at === null,
  );
  if (unfinished)
    return refuse(
      `migration ${unfinished.migration_name} failed or did not finish`,
      `run \`prisma migrate resolve --rolled-back ${unfinished.migration_name}\`, then \`prisma migrate deploy\` (${RECOVERY})`,
    );
  const applied = history
    .filter(({ finished_at, rolled_back_at }) => finished_at && !rolled_back_at)
    .map(({ migration_name }) => migration_name)
    .sort();
  const latest = applied.at(-1) ?? "none";
  if (applied.some((name) => name > newest))
    return refuse(
      `the database is at ${latest}, newer than this build's ${newest}`,
      `deploy the build that ships ${latest}; rolling the binary back is not supported`,
    );
  if (!applied.includes(newest))
    return refuse(
      `the database is at ${latest}, older than this build's ${newest}`,
      "run `prisma migrate deploy`, then start again",
    );
  return undefined;
};

/** Reads the migration history and returns schemaRefusal's verdict. */
export const readSchemaRefusal = async (
  prisma: Pick<ProcessPrismaClient, "$queryRaw">,
): Promise<string | undefined> => {
  const [table] = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`;
  if (!table?.present) return schemaRefusal(undefined);
  return schemaRefusal(
    await prisma.$queryRaw<MigrationRecord[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"`,
  );
};

/**
 * Re-run the one-time re-key statement, which is idempotent: on a database
 * where every identity already has its derived id it changes nothing.
 *
 * No supported writer creates an identity row with another id after that
 * migration: 0.1.4 creates only derived ids, and the deploy stops every worker
 * before migrating. A row with another id would leave its identity able to
 * authenticate but not to join a room (rooms are joined by the derived id), so
 * the statement runs again before the listener opens rather than trusting
 * that. Returns how many rows it re-keyed.
 */
export const rekeyStoredIdentities = async (
  prisma: Pick<ProcessPrismaClient, "$executeRawUnsafe">,
): Promise<number> => prisma.$executeRawUnsafe(rekeyStatement);
