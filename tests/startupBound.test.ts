import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * A start against a database that refuses, or that accepts and never
 * answers, must exit non-zero with one line inside the 10 s the deploy's
 * failure messages state, never hang. Neither case needs a database: a
 * loopback port nothing listens on, and a loopback listener that accepts and
 * stays silent.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOUND_MS = 10_000;

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

const start = async (
  databasePort: number,
  signalingHost: string | null = "test.localhost",
) => {
  const began = performance.now();
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
        DATABASE_URL: `postgresql://nobody:nothing@127.0.0.1:${String(databasePort)}/none?sslmode=disable`,
        PORT: String(freePort()),
        ...(signalingHost === null ? {} : { SIGNALING_HOST: signalingHost }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Far past the bound, so a hang fails the assertions below, not the runner.
  const killer = setTimeout(() => child.kill(), 3 * BOUND_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(killer);
  return {
    exitCode,
    elapsed: performance.now() - began,
    lines: `${stdout}${stderr}`.split("\n").filter((line) => line.trim()),
  };
};

describe("the startup bound", () => {
  test.each([null, "wss://example.org/ws"])(
    "an absent or malformed SIGNALING_HOST refuses startup before database access",
    async (host) => {
      const result = await start(freePort(), host);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join("\n")).toContain(
        "SIGNALING_HOST must contain the public WebSocket URL.host",
      );
      expect(result.lines.join("\n")).not.toContain("ECONNREFUSED");
    },
  );
  test("a start against a database that accepts and never answers exits within the bound", async () => {
    let accepted = 0;
    const silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          accepted++;
        },
        data() {},
      },
    });
    try {
      const result = await start(silent.port);
      expect(accepted).toBeGreaterThan(0);
      expect(result.exitCode).toBe(1);
      expect(result.lines).toEqual([
        "p2party: refusing to start: the database did not answer within 8 s while the migration history was read; check DATABASE_URL and that PostgreSQL is reachable from this host, then start again",
      ]);
      expect(result.elapsed).toBeLessThan(BOUND_MS);
    } finally {
      silent.stop(true);
    }
  }, 40_000);

  test("a start against a database that refuses connections exits within the bound", async () => {
    const result = await start(freePort());
    expect(result.exitCode).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(
      /^p2party: refusing to start: the database could not be reached to read the migration history \(\w+ ECONNREFUSED\); check DATABASE_URL and that PostgreSQL is reachable from this host, then start again$/,
    );
    expect(result.elapsed).toBeLessThan(BOUND_MS);
  }, 40_000);
});
