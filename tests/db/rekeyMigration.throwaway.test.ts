import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import pg from "pg";

import { provisionalPeerId } from "../../src/utils/peerIdentity";
import {
  describeWithThrowawayPostgres,
  freshDatabase,
  migrationNames,
  prismaMigrate,
  REKEY_MIGRATION,
  repositoryRoot,
  type ThrowawayDatabase,
} from "./throwawayPostgres";

/** The migrations a 0.1.4 database already has. */
const before = migrationNames.filter((name) => name < REKEY_MIGRATION);
const rekeySql = readFileSync(
  join(
    repositoryRoot,
    "prisma",
    "migrations",
    REKEY_MIGRATION,
    "migration.sql",
  ),
  "utf8",
);

const ROOM_A = "00000000-0000-4000-8000-0000000000a1";
const ROOM_B = "00000000-0000-4000-8000-0000000000a2";
const DEAD_SERVER = "9b2f6c1e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const randomUuid = () => {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

interface Seeded {
  /** Rows a server before 0.1.4 stored with random ids. */
  old: { id: string; key: string }[];
  /** A row a 0.1.4 server stored with the derived id. */
  derived: { id: string; key: string };
  /** A row whose key the upgrade handler would never admit. */
  nonCanonical: { id: string; key: string };
}

/** A 0.1.4 database: old random-id identities, memberships, queued rows. */
const seed = async (client: pg.Client, oldRows = 3): Promise<Seeded> => {
  const old = Array.from({ length: oldRows }, () => ({
    id: randomUuid(),
    key: randomBytes(32).toString("hex"),
  }));
  const derivedKey = randomBytes(32).toString("hex");
  const derived = { id: provisionalPeerId(derivedKey), key: derivedKey };
  const nonCanonical = {
    id: randomUuid(),
    key: randomBytes(32).toString("hex").toUpperCase(),
  };
  const insert = (row: { id: string; key: string }, serverId: string | null) =>
    client.query(
      `INSERT INTO "Peer" (id, "updatedAt", "lastPing", "publicKey", "serverId") VALUES ($1, now(), 0, $2, $3)`,
      [row.id, row.key, serverId],
    );
  await insert(old[0]!, DEAD_SERVER);
  for (const row of old.slice(1)) await insert(row, null);
  await insert(derived, null);
  await insert(nonCanonical, null);
  for (const [id, identifier] of [
    [ROOM_A, "room-a"],
    [ROOM_B, "room-b"],
  ])
    await client.query(
      `INSERT INTO "Room" (id, "updatedAt", identifier) VALUES ($1, now(), $2)`,
      [id, identifier],
    );
  for (const [peer, room] of [
    [old[0]!.id, ROOM_A],
    [old[0]!.id, ROOM_B],
    [derived.id, ROOM_A],
    [nonCanonical.id, ROOM_B],
  ])
    await client.query(`INSERT INTO "_PeerRooms" ("A", "B") VALUES ($1, $2)`, [
      peer,
      room,
    ]);
  await client.query(
    `INSERT INTO "Challenge" (id, "updatedAt", nonce, "peerId") VALUES ($1, now(), $2, $3)`,
    [randomUuid(), "n".repeat(64), old[0]!.id],
  );
  await client.query(
    `INSERT INTO "PendingSignal" (id, "targetServerId", "targetPeerId", payload) VALUES ($1, $2, $3, 'SDP')`,
    [randomUuid(), DEAD_SERVER, old[0]!.id],
  );
  return { old, derived, nonCanonical };
};

const snapshot = async (client: pg.Client) => ({
  peers: (
    await client.query<{ id: string; publicKey: string; serverId: string }>(
      `SELECT id, "publicKey", "serverId" FROM "Peer" ORDER BY "publicKey"`,
    )
  ).rows,
  memberships: (
    await client.query(`SELECT "A", "B" FROM "_PeerRooms" ORDER BY "A", "B"`)
  ).rows,
  challenges: (await client.query(`SELECT "peerId" FROM "Challenge"`)).rows,
  signals: (await client.query(`SELECT "targetPeerId" FROM "PendingSignal"`))
    .rows,
});

let database: ThrowawayDatabase | undefined;
afterEach(async () => {
  await database?.drop();
  database = undefined;
});

describeWithThrowawayPostgres("one-time re-key of stored identities", () => {
  test("the migration derives exactly provisionalPeerId", async () => {
    database = await freshDatabase([]);
    const keys = Array.from({ length: 500 }, () =>
      randomBytes(32).toString("hex"),
    );
    const { rows } = await database.client.query<{ k: string; id: string }>(
      `SELECT k, encode(set_byte(set_byte(d, 6, (get_byte(d, 6) & 15) | 64), 8,
              (get_byte(d, 8) & 63) | 128), 'hex')::uuid::text AS id
       FROM (SELECT k, substring(sha256(convert_to('p2party/signaling/peer-id/v1', 'UTF8')
              || decode('00', 'hex') || decode(k, 'hex')) FROM 1 FOR 16) AS d
             FROM unnest($1::text[]) AS k) AS s`,
      [keys],
    );
    // The expression above is the migration's, verbatim.
    expect(rekeySql).toContain(
      "convert_to('p2party/signaling/peer-id/v1', 'UTF8')",
    );
    expect(rekeySql).toContain('(get_byte("digest", 6) & 15) | 64');
    expect(rekeySql).toContain('(get_byte("digest", 8) & 63) | 128');
    expect(rows.map(({ k, id }) => id === provisionalPeerId(k))).toEqual(
      keys.map(() => true),
    );
  });

  test("startup re-keys every old identity before accepting connections", async () => {
    database = await freshDatabase(before);
    const { old, derived, nonCanonical } = await seed(database.client);

    // The deploy's own step: `prisma migrate deploy` with every migration.
    const deploy = await prismaMigrate(database.url, migrationNames);
    expect(deploy.exitCode, deploy.output).toBe(0);

    const after = await snapshot(database.client);
    // Every remaining row has the id derived from its key.
    expect(after.peers.map(({ id, publicKey }) => [id, publicKey])).toEqual(
      [...old, derived]
        .map(({ key }) => [provisionalPeerId(key), key])
        .sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
    );
    const newId = provisionalPeerId(old[0]!.key);
    // Memberships, challenges and queued rows followed in the same statement;
    // the routing claim is a column of the row and moved with it.
    expect(after.memberships).toEqual(
      [
        { A: newId, B: ROOM_A },
        { A: newId, B: ROOM_B },
        { A: derived.id, B: ROOM_A },
      ].sort((a, b) => (a.A + a.B < b.A + b.B ? -1 : 1)),
    );
    expect(after.challenges).toEqual([{ peerId: newId }]);
    expect(after.signals).toEqual([{ targetPeerId: newId }]);
    expect(after.peers.find(({ id }) => id === newId)?.serverId).toBe(
      DEAD_SERVER,
    );
    // The key no client can present is gone, with its membership.
    expect(after.peers.some(({ id }) => id === nonCanonical.id)).toBe(false);

    // "Before accepting connections": deploy.yml applies the migrations
    // before it restarts the signaling services.
    const playbook = readFileSync(
      join(repositoryRoot, "deploy", "ansible", "playbooks", "deploy.yml"),
      "utf8",
    );
    const migrate = playbook.indexOf("- name: Apply Postgres migrations");
    const restart = playbook.indexOf("- name: Restart signaling services");
    expect(migrate).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(migrate);
  }, 60_000);

  test("a migration left half-applied by a failure runs again cleanly", async () => {
    // Prisma runs a migration's statements without a transaction, so a
    // failure after the claim-owner migration's first statement leaves that
    // column in place. The documented recovery (resolve --rolled-back, then
    // deploy) must still complete.
    const ownerMigration = migrationNames.find((name) =>
      name.endsWith("_routing_claim_owner"),
    )!;
    database = await freshDatabase(
      migrationNames.filter((name) => name < ownerMigration),
    );
    await database.client.query(
      `ALTER TABLE "Peer" ADD COLUMN "socketGeneration" VARCHAR(36)`,
    );
    await database.client.query(
      `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, 'interrupted', $1, now(), 0)`,
      [ownerMigration],
    );
    const resolve = await prismaMigrate(database.url, migrationNames, [
      "migrate",
      "resolve",
      "--rolled-back",
      ownerMigration,
    ]);
    expect(resolve.exitCode, resolve.output).toBe(0);
    const redeploy = await prismaMigrate(database.url, migrationNames);
    expect(redeploy.exitCode, redeploy.output).toBe(0);
    const { rows } = await database.client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE (table_name, column_name) IN (('Peer', 'socketGeneration'), ('PendingSignal', 'kind'))
       ORDER BY column_name`,
    );
    expect(rows.map(({ column_name }) => column_name)).toEqual([
      "kind",
      "socketGeneration",
    ]);
  }, 60_000);

  test("the re-key is idempotent and resumes after an interruption", async () => {
    database = await freshDatabase(before);
    const { old } = await seed(database.client, 5);
    const seeded = await snapshot(database.client);

    // Hold a lock on one old row, so the migration's statement waits on it,
    // and end the migration's session there: a lost connection or a killed
    // process mid-statement.
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM "Peer" WHERE id = $1 FOR UPDATE`, [
      old[3]!.id,
    ]);
    const interrupted = prismaMigrate(database.url, migrationNames);
    let waiting: number | undefined;
    for (let attempt = 0; attempt < 600 && waiting === undefined; attempt++) {
      const { rows } = await database.client.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      waiting = rows[0]?.pid;
      if (waiting === undefined) await Bun.sleep(50);
    }
    expect(waiting).toBeDefined();
    await database.client.query("SELECT pg_terminate_backend($1)", [waiting]);
    const result = await interrupted;
    expect(result.exitCode).not.toBe(0);
    await holder.query("ROLLBACK");
    await holder.end();

    // All or nothing: not one row was re-keyed, the row that was not locked
    // included.
    expect(await snapshot(database.client)).toEqual(seeded);

    // Resuming: Prisma records the interrupted migration as failed, so the
    // operator marks it rolled back (true: nothing was applied) and deploys
    // again, which runs the whole statement.
    const refused = await prismaMigrate(database.url, migrationNames);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.output).toContain(REKEY_MIGRATION);
    const resolve = await prismaMigrate(database.url, migrationNames, [
      "migrate",
      "resolve",
      "--rolled-back",
      REKEY_MIGRATION,
    ]);
    expect(resolve.exitCode, resolve.output).toBe(0);
    const resumed = await prismaMigrate(database.url, migrationNames);
    expect(resumed.exitCode, resumed.output).toBe(0);
    const rekeyed = await snapshot(database.client);
    for (const { id, publicKey } of rekeyed.peers)
      expect(id).toBe(provisionalPeerId(publicKey));

    // Idempotent: the statement run again changes nothing.
    const again = await database.client.query(rekeySql);
    const counts = (Array.isArray(again) ? again : [again]).map(
      (part) => part.rowCount,
    );
    expect(counts).toEqual([0]);
    expect(await snapshot(database.client)).toEqual(rekeyed);
  }, 120_000);
});
