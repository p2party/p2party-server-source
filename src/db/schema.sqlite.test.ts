import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "../prismaClient";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("checked-in SQLite bootstrap schema", () => {
  test("round-trips millisecond lastPing values through Prisma as BigInt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p2party-schema-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "schema.db");
    const sqlite = new Database(databasePath, { create: true });
    sqlite.exec(
      readFileSync(new URL("./schema.sqlite.sql", import.meta.url), "utf8"),
    );

    const lastPingColumn = sqlite
      .query("PRAGMA table_info(peer)")
      .all()
      .find((column) => (column as { name: string }).name === "lastPing") as
      { type: string } | undefined;
    sqlite.close();
    expect(lastPingColumn?.type).toBe("BIGINT");

    const prisma = new PrismaClient({
      datasourceUrl: `file:${databasePath}`,
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
    } finally {
      await prisma.$disconnect();
    }
  });
});
