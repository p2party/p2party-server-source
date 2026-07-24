import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "../prismaClient";

const temporaryDirectories: string[] = [];
const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("checked-in SQLite migrations", () => {
  test("bootstrap a file: database with Prisma types and room relations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p2party-schema-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "schema.db");
    const databaseUrl = `file:${databasePath}`;

    const migration = spawnSync(
      process.execPath,
      ["x", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
      },
    );
    if (migration.status !== 0) {
      throw new Error(
        `Could not apply SQLite migrations:\n${migration.stderr || migration.stdout}`,
      );
    }

    const sqlite = new Database(databasePath, { create: true });
    const columns = (table: "room" | "peer" | "challenge") =>
      new Map(
        sqlite
          .query(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => {
            const typedColumn = column as { name: string; type: string };
            return [typedColumn.name, typedColumn.type];
          }),
      );
    expect(columns("peer").get("lastPing")).toBe("BIGINT");
    for (const table of ["room", "peer", "challenge"] as const) {
      expect(columns(table).get("createdAt")).toBe("DATETIME");
      expect(columns(table).get("updatedAt")).toBe("DATETIME");
    }
    sqlite.close();

    const prisma = new PrismaClient({
      datasourceUrl: databaseUrl,
    });
    const millisecondTimestamp = 1_753_456_789_012n;

    try {
      const peer = await prisma.peer.create({
        data: {
          lastPing: millisecondTimestamp,
          publicKey: "ab".repeat(32),
        },
      });

      expect(peer.lastPing).toBe(millisecondTimestamp);
      expect(peer.createdAt).toBeInstanceOf(Date);
      expect(peer.updatedAt).toBeInstanceOf(Date);

      const room = await prisma.room.create({
        data: {
          identifier: "migration-smoke-room",
          peers: { connect: { id: peer.id } },
        },
        include: { peers: true },
      });
      expect(room.peers.map(({ id }) => id)).toEqual([peer.id]);

      const peerWithRooms = await prisma.peer.findUniqueOrThrow({
        where: { id: peer.id },
        include: { rooms: true },
      });
      expect(peerWithRooms.rooms.map(({ id }) => id)).toEqual([room.id]);
    } finally {
      await prisma.$disconnect();
    }
  });
});
