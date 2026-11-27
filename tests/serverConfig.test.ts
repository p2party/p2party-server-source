import { expect, test } from "bun:test";
import { join } from "node:path";

const valid = {
  DATABASE_URL: "postgresql://u:config-secret@127.0.0.1:1/app?sslmode=disable",
  COTURN_SECRET: "a".repeat(32),
  SIGNALING_HOST: "relay.example:8443",
  PORT: "3001",
};

const check = (env: Record<string, string>) =>
  Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../src/index.ts"),
      "--check-config",
    ],
    {
      env,
      timeout: 5_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

test("checks the worker environment without a reachable database", () => {
  const result = check(valid);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("p2party: configuration valid");
});

test("rejects invalid staged settings without disclosing credentials", () => {
  for (const [name, value] of [
    ["SIGNALING_HOST", "bad/path"],
    ["COTURN_SECRET", "short"],
    ["DATABASE_URL", "bad config-secret"],
    ["DATABASE_URL", "https://u:config-secret@relay.example/db"],
    [
      "DATABASE_URL",
      "postgresql://u:config-secret@127.0.0.1:1/app?sslrootcert=/missing/p2party-test-ca",
    ],
    ["PORT", "3001oops"],
    ["MAX_CONNECTIONS", "unknown"],
  ] as const) {
    const result = check({ ...valid, [name]: value });
    expect(result.exitCode, name).toBe(1);
    expect(result.stderr.toString(), name).not.toContain("config-secret");
  }
});
