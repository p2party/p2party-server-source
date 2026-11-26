import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * These run without a database on purpose.
 *
 * The failure this suite exists to prevent already happened once: the schema
 * declared one provider while the deployment was configured for another, and
 * nothing noticed until a query failed in production. A migration set and a
 * schema that disagree are a deploy-time outage, so they are checked here
 * rather than discovered on the box.
 */

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const prismaDir = join(repositoryRoot, "prisma");
const migrationsDir = join(prismaDir, "migrations");

const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
const lock = readFileSync(join(migrationsDir, "migration_lock.toml"), "utf8");

const migrationSql = readdirSync(migrationsDir)
  .filter((entry) => !entry.endsWith(".toml"))
  .sort()
  .map((entry) =>
    readFileSync(join(migrationsDir, entry, "migration.sql"), "utf8"),
  )
  .join("\n");

describe("prisma migrations", () => {
  test("the schema provider and the migration lock agree", () => {
    const schemaProvider =
      /datasource\s+db\s*\{[^}]*provider\s*=\s*"([^"]+)"/.exec(schema)?.[1];
    const lockProvider = /provider\s*=\s*"([^"]+)"/.exec(lock)?.[1];

    expect(schemaProvider).toBe("postgresql");
    // Prisma refuses to replay a migration set recorded under another provider,
    // so a mismatch here is a hard deploy failure, not a warning.
    expect(lockProvider).toBe(schemaProvider);
  });

  test("every model in the schema has a table in the migrations", () => {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(
      (m) => m[1],
    );
    expect(models).toContain("Peer");
    expect(models).toContain("Room");
    expect(models).toContain("Challenge");
    expect(models).toContain("PendingSignal");

    for (const model of models)
      expect(migrationSql).toContain(`CREATE TABLE "${model}"`);
  });

  test("the multi-instance routing columns exist", () => {
    // Without these, two signaling instances silently cannot reach each
    // other's peers: a signal is written for a peer nobody delivers to.
    expect(schema).toContain("serverId");
    expect(migrationSql).toMatch(/ALTER TABLE "Peer" ADD COLUMN\s+"serverId"/);
    expect(migrationSql).toContain(
      'CREATE INDEX "Peer_serverId_idx" ON "Peer"("serverId")',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "PendingSignal_targetServerId_idx" ON "PendingSignal"("targetServerId")',
    );
  });

  test("deleting a peer cascades to its challenges", () => {
    // nonce and signature are UNIQUE; orphaned challenges would pin those
    // values forever and reject a re-registering peer.
    expect(schema).toContain("onDelete: Cascade");
    expect(migrationSql).toMatch(
      /ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_peerId_fkey"[\s\S]*?ON DELETE CASCADE/,
    );
  });

  test("the uniqueness the auth path depends on is enforced in SQL", () => {
    for (const index of [
      'CREATE UNIQUE INDEX "Peer_publicKey_key" ON "Peer"("publicKey")',
      'CREATE UNIQUE INDEX "Room_identifier_key" ON "Room"("identifier")',
      'CREATE UNIQUE INDEX "Challenge_nonce_key" ON "Challenge"("nonce")',
    ])
      expect(migrationSql).toContain(index);
  });

  test("no SQLite artefacts survive the switch", () => {
    expect(schema).not.toContain("sqlite");
    expect(migrationSql).not.toContain("PRAGMA");
  });
});

describe("released migrations", () => {
  test("the migrations released in 0.1.4 are unchanged, byte for byte", () => {
    // Prisma records each applied migration's SHA-256. A change to one a
    // production database has applied would make that record a lie.
    const sha256 = (name: string) =>
      createHash("sha256")
        .update(
          new Uint8Array(
            readFileSync(join(migrationsDir, name, "migration.sql")),
          ),
        )
        .digest("hex");
    expect(sha256("20260224171205_init")).toBe(
      "60f80b7c878d251b73356b810017a6c5b01db0b4d4c09bc58dee5f25e06d44a4",
    );
    expect(sha256("20260224172227_add_pubsub")).toBe(
      "aff74f1c36c4b6e5afddb8658b4a455d5dd4273f2713e0dd5afffcb99210e792",
    );
  });
});
