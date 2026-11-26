import {
  cpSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Under `bun test`, the shared Prisma client must not be configured from the
 * DATABASE_URL a `.env` names. The proof never reads this repository's `.env`:
 * it runs `bun test` in a scratch copy holding a sentinel `.env` whose
 * DATABASE_URL points at a socket this test listens on, makes the shared
 * client query, and counts connections to the sentinel.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const probeTest = `
import { test } from "bun:test";
import { prisma } from "./src/prismaClient";
test("the shared client queries", async () => {
  const configured = process.env.DATABASE_URL ?? "";
  await prisma.peer.count().catch(() => undefined);
  console.log("PROBE " + JSON.stringify({ sentinel: configured.includes("sentinel") }));
});
`;

/** Runs the probe in a scratch copy; with or without this repository's bunfig. */
const runInScratchCopy = async (withBunfig: boolean) => {
  let connections = 0;
  const sentinel = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        connections++;
        socket.end();
      },
      data() {},
    },
  });
  const scratch = mkdtempSync(join(tmpdir(), "p2party-test-isolation-"));
  try {
    for (const entry of ["src", "node_modules"])
      symlinkSync(join(repositoryRoot, entry), join(scratch, entry));
    cpSync(join(repositoryRoot, "package.json"), join(scratch, "package.json"));
    cpSync(
      join(repositoryRoot, "tsconfig.json"),
      join(scratch, "tsconfig.json"),
    );
    if (withBunfig) {
      cpSync(join(repositoryRoot, "bunfig.toml"), join(scratch, "bunfig.toml"));
      cpSync(
        join(repositoryRoot, "tests", "preload.ts"),
        join(scratch, "tests", "preload.ts"),
        { recursive: true },
      );
    }
    writeFileSync(
      join(scratch, ".env"),
      `DATABASE_URL=postgresql://sentinel:sentinel@127.0.0.1:${String(sentinel.port)}/sentinel?sslmode=disable\n`,
    );
    writeFileSync(join(scratch, "probe.test.ts"), probeTest);
    const child = Bun.spawn([process.execPath, "test", "./probe.test.ts"], {
      cwd: scratch,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const report = /PROBE (\{.*\})/.exec(`${stdout}${stderr}`)?.[1];
    expect(exitCode, `${stdout}${stderr}`).toBe(0);
    return {
      ...(JSON.parse(report ?? "{}") as { sentinel: boolean }),
      connections,
    };
  } finally {
    sentinel.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
};

describe("test isolation from .env", () => {
  test("bun test never configures the shared client from .env's database", async () => {
    // Control: without the preload, the sentinel .env configures the client
    // and the query reaches the sentinel. The preload is what stops it.
    const unguarded = await runInScratchCopy(false);
    expect(unguarded.sentinel).toBe(true);
    expect(unguarded.connections).toBeGreaterThan(0);

    const guarded = await runInScratchCopy(true);
    expect(guarded).toEqual({ sentinel: false, connections: 0 });
  }, 60_000);
});
