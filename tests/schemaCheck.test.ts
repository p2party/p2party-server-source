import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  NEWEST_MIGRATION,
  schemaRefusal,
  type MigrationRecord,
} from "../src/db/schemaCheck";

const migrations = readdirSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations"),
  { withFileTypes: true },
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const finished = (migration_name: string): MigrationRecord => ({
  migration_name,
  finished_at: new Date(0),
  rolled_back_at: null,
});

describe("the schema a build starts on", () => {
  test("the newest migration constant names the newest migration directory", () => {
    // A migration added without updating NEWEST_MIGRATION would let this
    // build start on a database that lacks it.
    expect(NEWEST_MIGRATION).toBe(migrations.at(-1)!);
  });

  test("exactly this build's schema is accepted", () => {
    expect(schemaRefusal(migrations.map(finished))).toBeUndefined();
    // A migration rolled back by an operator and then applied again.
    expect(
      schemaRefusal([
        ...migrations.slice(0, -1).map(finished),
        { ...finished(NEWEST_MIGRATION), rolled_back_at: new Date(0) },
        finished(NEWEST_MIGRATION),
      ]),
    ).toBeUndefined();
  });

  test("each other state is refused with what was found and what to run", () => {
    expect(schemaRefusal(undefined)).toBe(
      `p2party: refusing to start: the database has no migration history (an empty database); run \`prisma migrate deploy\` to reach ${NEWEST_MIGRATION}, then start again`,
    );
    expect(schemaRefusal([])).toBe(schemaRefusal(undefined));
    expect(schemaRefusal(migrations.slice(0, -1).map(finished))).toBe(
      `p2party: refusing to start: the database is at ${migrations.at(-2)!}, older than this build's ${NEWEST_MIGRATION}; run \`prisma migrate deploy\`, then start again`,
    );
    expect(
      schemaRefusal([
        ...migrations.slice(0, -1).map(finished),
        { ...finished(NEWEST_MIGRATION), finished_at: null },
      ]),
    ).toBe(
      `p2party: refusing to start: migration ${NEWEST_MIGRATION} failed or did not finish; run \`prisma migrate resolve --rolled-back ${NEWEST_MIGRATION}\`, then \`prisma migrate deploy\` (see deploy/README.md, "A failed or interrupted migration")`,
    );
    expect(
      schemaRefusal([
        ...migrations.map(finished),
        finished("29991231000000_from_a_newer_build"),
      ]),
    ).toBe(
      `p2party: refusing to start: the database is at 29991231000000_from_a_newer_build, newer than this build's ${NEWEST_MIGRATION}; deploy the build that ships 29991231000000_from_a_newer_build; rolling the binary back is not supported`,
    );
  });
});
