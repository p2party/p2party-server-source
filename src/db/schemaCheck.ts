import rekeyStatement from "../../prisma/migrations/20261127000000_rekey_peers_to_derived_ids/migration.sql" with { type: "text" };

import pg from "pg";

import { postgresConnection } from "./ssl";
import { describeError } from "../utils/logError";

/**
 * Every migration this build ships, in order: the database schema it was
 * built for. tests/schemaCheck.test.ts fails unless this is exactly the list
 * of directories in prisma/migrations.
 */
export const BUILD_MIGRATIONS: readonly string[] = [
  "20260224171205_init",
  "20260224172227_add_pubsub",
  "20261126120000_pending_signal_created_at_index",
  "20261127000000_rekey_peers_to_derived_ids",
  "20261127000100_routing_claim_owner",
];

/**
 * How long a start may take to connect and read the migration history. A
 * database that refuses, drops packets or accepts and never answers ends the
 * start inside this bound, under the 10 s the deploy's failure messages state.
 */
export const STARTUP_CHECK_DEADLINE_MS = 8_000;
/**
 * How long the startup re-key may run. It is one statement, cancelled by the
 * server at this bound (statement_timeout) and rolled back whole.
 */
export const STARTUP_REKEY_DEADLINE_MS = 60_000;

/** One row of Prisma's `_prisma_migrations` history. */
export interface MigrationRecord {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

const RECOVERY = 'see deploy/README.md, "A failed or interrupted migration"';

const refuse = (found: string, run: string) =>
  `p2party: refusing to start: ${found}; ${run}`;

/**
 * Why this build must not start on a database with this migration history,
 * as the one line an operator reads; undefined when the database has exactly
 * this build's migrations, all finished. `history` is undefined when the
 * database has no migration history table at all.
 */
export const schemaRefusal = (
  history: readonly MigrationRecord[] | undefined,
  migrations: readonly string[] = BUILD_MIGRATIONS,
): string | undefined => {
  const newest = migrations.at(-1)!;
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
  const applied = new Set(
    history
      .filter(
        ({ finished_at, rolled_back_at }) => finished_at && !rolled_back_at,
      )
      .map(({ migration_name }) => migration_name),
  );
  const latest = [...applied].sort().at(-1) ?? "none";
  const unknown = [...applied]
    .filter((name) => !migrations.includes(name))
    .sort();
  const newer = unknown.filter((name) => name > newest);
  if (newer.length > 0)
    return refuse(
      `the database is at ${latest}, newer than this build's ${newest}`,
      `deploy the build that ships ${latest}; rolling the binary back is not supported`,
    );
  if (unknown.length > 0)
    return refuse(
      `the database has migration ${unknown[0]!}, which this build does not ship`,
      "deploy the build that applied it",
    );
  const missing = migrations.filter((name) => !applied.has(name));
  if (missing.length > 0 && missing.some((name) => name < latest))
    return refuse(
      `the database lacks migration ${missing[0]!}, which this build ships, though it has ${latest}`,
      "run `prisma migrate deploy`, then start again",
    );
  if (missing.length > 0)
    return refuse(
      `the database is at ${latest}, older than this build's ${newest}`,
      "run `prisma migrate deploy`, then start again",
    );
  return undefined;
};

class Deadline extends Error {}

/** `work`, or a Deadline rejection after `ms`. */
const within = <T>(ms: number, work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Deadline()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const seconds = (ms: number) => `${String(ms / 1000)} s`;

export interface StartupCheck {
  /** The one line to print before exiting 1; undefined to go on starting. */
  refusal?: string;
  /** Identity rows the startup re-key gave their derived id. */
  rekeyed?: number;
}

/**
 * The first database work of a start, on its own connection and bounded: the
 * shared Prisma pool waits forever for a connection (pg's default), so a
 * firewall that drops packets, or a server that accepts and never answers,
 * would otherwise hang the start with no output.
 *
 * It reads the migration history within STARTUP_CHECK_DEADLINE_MS and refuses
 * a database that is not at exactly this build's schema. It then re-runs the
 * one-time re-key statement within STARTUP_REKEY_DEADLINE_MS. That statement
 * is idempotent and changes nothing unless an unsupported writer left an
 * identity row with another id, which would let the identity authenticate but
 * not join a room. Each failure is the one line in `refusal`.
 */
export const startupDatabaseCheck = async (
  databaseUrl: string,
  deadlines: { check: number; rekey: number } = {
    check: STARTUP_CHECK_DEADLINE_MS,
    rekey: STARTUP_REKEY_DEADLINE_MS,
  },
): Promise<StartupCheck> => {
  const { connectionString, ssl } = postgresConnection(databaseUrl);
  const client = new pg.Client({
    connectionString,
    ssl,
    // A little past the deadline, so the deadline names the failure.
    connectionTimeoutMillis: deadlines.check + 1_000,
    application_name: "p2party-startup-check",
  });
  // A connection that drops after the verdict must not crash the process
  // before the line is printed.
  client.on("error", () => {});

  let history: MigrationRecord[] | undefined;
  try {
    history = await within(
      deadlines.check,
      (async () => {
        await client.connect();
        const [table] = (
          await client.query<{ present: boolean }>(
            `SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`,
          )
        ).rows;
        if (!table?.present) return undefined;
        return (
          await client.query<MigrationRecord>(
            `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
          )
        ).rows;
      })(),
    );
  } catch (error) {
    return {
      refusal: refuse(
        error instanceof Deadline
          ? `the database did not answer within ${seconds(deadlines.check)} while the migration history was read`
          : `the database could not be reached to read the migration history (${describeError(error)})`,
        "check DATABASE_URL and that PostgreSQL is reachable from this host, then start again",
      ),
    };
  }

  const refusal = schemaRefusal(history);
  if (refusal) return { refusal };

  try {
    const rekeyed = await within(
      deadlines.rekey + 5_000,
      (async () => {
        await client.query(
          `SET statement_timeout = ${String(Math.trunc(deadlines.rekey))}`,
        );
        return (await client.query(rekeyStatement)).rowCount ?? 0;
      })(),
    );
    await within(2_000, client.end()).catch(() => {});
    return { rekeyed };
  } catch (error) {
    return {
      refusal: refuse(
        error instanceof Deadline
          ? `the startup re-key of stored identities got no answer within ${seconds(deadlines.rekey + 5_000)}`
          : `the startup re-key of stored identities failed or ran past ${seconds(deadlines.rekey)} (${describeError(error)}), and changed nothing`,
        `run prisma/migrations/20261127000000_rekey_peers_to_derived_ids/migration.sql once with psql and no time limit, then start again (${RECOVERY})`,
      ),
    };
  }
};
