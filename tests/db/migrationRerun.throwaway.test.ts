import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import pg from "pg";

import {
  describeWithThrowawayPostgres,
  freshDatabase,
  migrationNames,
  prismaMigrate,
  repositoryRoot,
  type ThrowawayDatabase,
} from "./throwawayPostgres";

/** The migrations 0.1.4 shipped; they are pinned byte for byte elsewhere. */
const RELEASED = ["20260224171205_init", "20260224172227_add_pubsub"];
const added = migrationNames.filter((name) => !RELEASED.includes(name));
const recoveryQuery = readFileSync(
  join(repositoryRoot, "deploy", "README.md"),
  "utf8",
).match(/SELECT migration_name FROM public\._prisma_migrations[^;]+;/)![0];

/** A migration's statements, comments dropped, split at each `;` line end. */
const statements = (name: string) =>
  readFileSync(
    join(repositoryRoot, "prisma", "migrations", name, "migration.sql"),
    "utf8",
  )
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

/** Data a deployed database holds before the migration: an old-style row. */
const seed = async (client: pg.Client, row: { id: string; key: string }) => {
  await client.query(
    `INSERT INTO "Peer" (id, "updatedAt", "lastPing", "publicKey") VALUES ($1, now(), 0, $2)`,
    [row.id, row.key],
  );
};

/** The schema and the identity rows, for comparing two databases. */
const fingerprint = async (client: pg.Client) => ({
  columns: (
    await client.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
       ORDER BY table_name, column_name`,
    )
  ).rows,
  indexes: (
    await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
       ORDER BY indexname`,
    )
  ).rows,
  peers: (
    await client.query(
      `SELECT id, "publicKey" FROM "Peer" ORDER BY "publicKey"`,
    )
  ).rows,
});

const databases: ThrowawayDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

describeWithThrowawayPostgres("re-running a migration after a failure", () => {
  test("each new migration runs again cleanly after a failure at every statement boundary", async () => {
    expect(added).toEqual([
      "20261126120000_pending_signal_created_at_index",
      "20261127000000_rekey_peers_to_derived_ids",
      "20261127000100_routing_claim_owner",
      "20261127180000_index_identity_authentication",
    ]);
    for (const migration of added) {
      const before = migrationNames.slice(0, migrationNames.indexOf(migration));
      const parts = statements(migration);
      const row = { id: randomUUID(), key: randomBytes(32).toString("hex") };

      // What a clean deploy from the same starting point produces.
      const reference = await freshDatabase(before);
      databases.push(reference);
      await seed(reference.client, row);
      const clean = await prismaMigrate(reference.url, migrationNames);
      expect(clean.exitCode, clean.output).toBe(0);
      const expected = await fingerprint(reference.client);

      // A failure after the first `committed` statements: those took effect,
      // Prisma recorded the migration as started and never finished.
      for (let committed = 0; committed <= parts.length; committed++) {
        const label = `${migration} after ${String(committed)} of ${String(parts.length)} statement(s)`;
        const database = await freshDatabase(before);
        databases.push(database);
        await seed(database.client, row);
        for (const statement of parts.slice(0, committed))
          await database.client.query(statement);
        await database.client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count, logs)
           VALUES ($1, 'interrupted', $2, now(), 0, 'simulated failure')`,
          [randomUUID(), migration],
        );

        // Identify the failed name as an operator would, even when later
        // migrations have yet to run.
        const unresolved = await database.client.query<{
          migration_name: string;
        }>(recoveryQuery);
        expect(unresolved.rows, label).toEqual([{ migration_name: migration }]);
        const resolve = await prismaMigrate(database.url, migrationNames, [
          "migrate",
          "resolve",
          "--rolled-back",
          unresolved.rows[0]!.migration_name,
        ]);
        expect(resolve.exitCode, `${label}: ${resolve.output}`).toBe(0);
        const redeploy = await prismaMigrate(database.url, migrationNames);
        expect(redeploy.exitCode, `${label}: ${redeploy.output}`).toBe(0);
        expect(
          (await database.client.query(recoveryQuery)).rows,
          label,
        ).toEqual([]);
        expect(await fingerprint(database.client), label).toEqual(expected);
      }
    }
  }, 300_000);
});
