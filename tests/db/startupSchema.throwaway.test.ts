import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import pg from "pg";

import {
  startupDatabaseCheck,
  BUILD_MIGRATIONS,
} from "../../src/db/schemaCheck";
import { provisionalPeerId } from "../../src/utils/peerIdentity";
import {
  describeWithThrowawayPostgres,
  freshDatabase,
  migrationNames,
  prismaMigrate,
  repositoryRoot,
  type ThrowawayDatabase,
} from "./throwawayPostgres";

/** A free port from the operating system's ephemeral range (above 5000). */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

/**
 * Start the real server on `databaseUrl` and wait until it either exits or
 * answers /health. No .env is read. Returns what it did.
 */
const start = async (databaseUrl: string) => {
  const port = freePort();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "run",
      join(repositoryRoot, "src", "index.ts"),
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        SIGNALING_HOST: `127.0.0.1:${port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let exitCode: number | undefined;
  void child.exited.then((code) => {
    exitCode = code;
  });
  let listening = false;
  for (let attempt = 0; attempt < 200 && exitCode === undefined; attempt++) {
    listening = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (listening) break;
    await Bun.sleep(50);
  }
  if (listening) child.kill();
  await child.exited;
  const stderr = await new Response(child.stderr).text();
  return { exitCode: listening ? undefined : exitCode, listening, stderr };
};

const NEWEST_MIGRATION = BUILD_MIGRATIONS.at(-1)!;

const refusalLine = (stderr: string) =>
  stderr.split("\n").find((line) => line.startsWith("p2party: refusing"));

let database: ThrowawayDatabase | undefined;
afterEach(async () => {
  await database?.drop();
  database = undefined;
});

describeWithThrowawayPostgres("the schema the server starts on", () => {
  test("losing the startup re-key session reports an unknown outcome", async () => {
    database = await freshDatabase();
    await database.client.query("BEGIN");
    await database.client.query('LOCK TABLE "Peer" IN ACCESS EXCLUSIVE MODE');
    try {
      const checking = startupDatabaseCheck(database.url, {
        check: 2000,
        rekey: 6000,
      });
      let terminated = false;
      for (let i = 0; i < 100; i++) {
        await database.client.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await database.client.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='p2party-startup-check' AND wait_event_type='Lock'",
        );
        if (rows[0]) {
          await database.client.query("SELECT pg_terminate_backend($1)", [
            rows[0].pid,
          ]);
          terminated = true;
          break;
        }
        await Bun.sleep(25);
      }
      expect((await checking).refusal).toContain("result may be unknown");
      expect(terminated).toBe(true);
    } finally {
      await database.client.query("ROLLBACK");
    }
  }, 15_000);

  test("the live Prisma pool cancels slow SQL and can serve the next query", async () => {
    database = await freshDatabase([]);
    const probe = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `import { prisma } from "./src/prismaClient";
        try { await prisma.$queryRawUnsafe("SELECT 1 FROM pg_sleep(25)"); process.exit(2); }
        catch { const [row] = await prisma.$queryRawUnsafe("SELECT 1 AS alive"); process.exit(row.alive === 1 ? 0 : 3); }`,
      ],
      {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH, DATABASE_URL: database.url },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const kill = setTimeout(() => probe.kill(), 18_000);
    try {
      expect(await probe.exited).toBe(0);
    } finally {
      clearTimeout(kill);
    }
  }, 25_000);

  test("the server refuses to start on a schema older than its own", async () => {
    database = await freshDatabase([]);
    const empty = await start(database.url);
    expect(empty.listening).toBe(false);
    expect(empty.exitCode).toBe(1);
    expect(refusalLine(empty.stderr)).toContain(
      "the database has no migration history (an empty database)",
    );
    await database.drop();

    database = await freshDatabase(migrationNames.slice(0, -1));
    const older = await start(database.url);
    expect(older.listening).toBe(false);
    expect(older.exitCode).toBe(1);
    expect(refusalLine(older.stderr)).toContain(
      `older than this build's ${NEWEST_MIGRATION}; run \`prisma migrate deploy\``,
    );
  }, 60_000);

  test("the server refuses to start after a failed migration", async () => {
    database = await freshDatabase(migrationNames.slice(0, -1));
    // The newest migration waits for a table lock and its session ends: an
    // interrupted deploy, recorded by Prisma as failed.
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE "Peer" IN ROW SHARE MODE`);
    const migrating = prismaMigrate(database.url, migrationNames);
    let waiting: number | undefined;
    for (let attempt = 0; attempt < 600 && waiting === undefined; attempt++) {
      const { rows } = await database.client.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      waiting = rows[0]?.pid;
      if (waiting === undefined) await Bun.sleep(50);
    }
    await database.client.query("SELECT pg_terminate_backend($1)", [waiting]);
    expect((await migrating).exitCode).not.toBe(0);
    await holder.query("ROLLBACK");
    await holder.end();

    const failed = await start(database.url);
    expect(failed.listening).toBe(false);
    expect(failed.exitCode).toBe(1);
    expect(refusalLine(failed.stderr)).toBe(
      `p2party: refusing to start: migration ${NEWEST_MIGRATION} failed or did not finish; run \`prisma migrate resolve --rolled-back ${NEWEST_MIGRATION}\`, then \`prisma migrate deploy\` (see deploy/README.md, "A failed or interrupted migration")`,
    );
  }, 60_000);

  test("the server refuses to start on a schema newer than its own", async () => {
    database = await freshDatabase();
    await database.client.query(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, 'newer', now(), '29991231000000_from_a_newer_build', now(), 1)`,
    );
    const newer = await start(database.url);
    expect(newer.listening).toBe(false);
    expect(newer.exitCode).toBe(1);
    expect(refusalLine(newer.stderr)).toContain(
      `the database is at 29991231000000_from_a_newer_build, newer than this build's ${NEWEST_MIGRATION}`,
    );
  }, 60_000);

  test("the server refuses to start when an intermediate migration is missing", async () => {
    database = await freshDatabase();
    const intermediate = migrationNames[2]!;
    await database.client.query(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = $1`,
      [intermediate],
    );
    const missing = await start(database.url);
    expect(missing.listening).toBe(false);
    expect(missing.exitCode).toBe(1);
    expect(refusalLine(missing.stderr)).toContain(
      `the database lacks migration ${intermediate}, which this build ships`,
    );
  }, 60_000);

  test("the server refuses to start on an unknown migration that sorts before its newest", async () => {
    database = await freshDatabase();
    await database.client.query(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, 'other', now(), '20261127000050_from_another_build', now(), 1)`,
    );
    const unknown = await start(database.url);
    expect(unknown.listening).toBe(false);
    expect(unknown.exitCode).toBe(1);
    expect(refusalLine(unknown.stderr)).toBe(
      "p2party: refusing to start: the database has migration 20261127000050_from_another_build, which this build does not ship; deploy the build that applied it",
    );
  }, 60_000);

  test("a start on the expected schema opens the listener", async () => {
    database = await freshDatabase();
    // A row an unsupported writer (a server before 0.1.4) left with a random
    // id after the migration: the start re-keys it before the listener opens.
    const key = "ab".repeat(32);
    await database.client.query(
      `INSERT INTO "Peer" (id, "updatedAt", "lastPing", "publicKey")
       VALUES ('0b5e0f2a-7d0c-4c55-9a3e-1f0d2c3b4a59', now(), 0, $1)`,
      [key],
    );
    const expected = await start(database.url);
    expect(expected.listening).toBe(true);
    expect(refusalLine(expected.stderr)).toBeUndefined();
    const { rows } = await database.client.query<{ id: string }>(
      `SELECT id FROM "Peer" WHERE "publicKey" = $1`,
      [key],
    );
    expect(rows).toEqual([{ id: provisionalPeerId(key) }]);
  }, 60_000);
});
