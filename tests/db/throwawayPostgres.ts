/**
 * Harness for the tests that need a real PostgreSQL; not a test file.
 *
 * Those tests run only when P2PARTY_TEST_POSTGRES_URL names a throwaway
 * server, and are skipped otherwise. DATABASE_URL is never used, so a
 * developer's database cannot be touched by accident. The URL must point at
 * a loopback address on a port above 5000 other than 5432, as the owner's
 * rule for local servers requires; anything else is refused. Each test file
 * gets its own database, `p2party_test_<random>`, created on that server and
 * dropped afterwards. See "Testing" in the README.
 */
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "bun:test";

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client/client";

export const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const migrationsDir = join(repositoryRoot, "prisma", "migrations");

/** The throwaway server's URL, after the safety checks; undefined to skip. */
export const throwawayServerUrl = (() => {
  const raw = process.env.P2PARTY_TEST_POSTGRES_URL;
  if (!raw) return undefined;
  const url = new URL(raw);
  const port = Number(url.port);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("P2PARTY_TEST_POSTGRES_URL must name a loopback address");
  if (!Number.isInteger(port) || port <= 5000 || port === 5432)
    throw new Error(
      "P2PARTY_TEST_POSTGRES_URL must name a port above 5000 other than 5432",
    );
  return url;
})();

/** describe() when a throwaway server is named, describe.skip() otherwise. */
export const describeWithThrowawayPostgres = throwawayServerUrl
  ? describe
  : describe.skip;

/** Every migration directory, in the order Prisma applies them. */
export const migrationNames = readdirSync(migrationsDir, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

export const REKEY_MIGRATION = "20261127000000_rekey_peers_to_derived_ids";

const databaseUrl = (name: string) => {
  const url = new URL(throwawayServerUrl!);
  url.pathname = `/${name}`;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
};

/**
 * The Prisma CLI, as deploy.yml runs it, against `url`, with a migrations
 * directory holding only `migrations`. No .env file is read, and the CLI's
 * version check is off: the run makes no request beyond the throwaway server.
 */
export const prismaMigrate = async (
  url: string,
  migrations: readonly string[],
  args: readonly string[] = ["migrate", "deploy"],
): Promise<{ exitCode: number; output: string }> => {
  const work = mkdtempSync(join(tmpdir(), "p2party-migrate-"));
  try {
    mkdirSync(join(work, "prisma", "migrations"), { recursive: true });
    cpSync(
      join(repositoryRoot, "prisma", "schema.prisma"),
      join(work, "prisma", "schema.prisma"),
    );
    cpSync(
      join(migrationsDir, "migration_lock.toml"),
      join(work, "prisma", "migrations", "migration_lock.toml"),
    );
    for (const name of migrations)
      cpSync(
        join(migrationsDir, name),
        join(work, "prisma", "migrations", name),
        { recursive: true },
      );
    writeFileSync(
      join(work, "prisma.config.ts"),
      'export default { schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" }, datasource: { url: process.env.DATABASE_URL } };\n',
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(repositoryRoot, "node_modules", "prisma", "build", "index.js"),
        ...args,
      ],
      {
        cwd: work,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: url,
          CHECKPOINT_DISABLE: "1",
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: `${stdout}${stderr}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

export interface ThrowawayDatabase {
  name: string;
  url: string;
  /** A plain connection to this database. */
  client: pg.Client;
  /** A Prisma client for this database, as the server builds it. */
  prisma: PrismaClient;
  drop(): Promise<void>;
}

/**
 * A new database on the throwaway server, with `migrations` applied through
 * the Prisma CLI (all of them by default).
 */
export const freshDatabase = async (
  migrations: readonly string[] = migrationNames,
): Promise<ThrowawayDatabase> => {
  const name = `p2party_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: databaseUrl("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = databaseUrl(name);
  if (migrations.length > 0) {
    const { exitCode, output } = await prismaMigrate(url, migrations);
    if (exitCode !== 0) throw new Error(`migrate deploy failed:\n${output}`);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  return {
    name,
    url,
    client,
    prisma,
    drop: async () => {
      await prisma.$disconnect();
      await client.end();
      const dropper = new pg.Client({
        connectionString: databaseUrl("postgres"),
      });
      await dropper.connect();
      await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await dropper.end();
    },
  };
};
