import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The deployment ships a single compiled binary built with `bun build
 * --compile`. Two properties have to hold for that binary to start at all, and
 * both failed in production: every instance crash-looped 7000+ times with
 *
 *   Cannot find module '@prisma/client' from '/$bunfs/root/p2party_linux_x64'
 *
 * These are source-level assertions because reproducing the failure needs a
 * cross-compiled binary on a Linux host.
 */

const srcRoot = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(srcRoot, "prismaClient.ts"), "utf8");
/** Comments explain why the old approach was wrong, and name it. Assert on code. */
const client = clientSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const schema = readFileSync(
  join(dirname(srcRoot), "prisma", "schema.prisma"),
  "utf8",
);

describe("compiled-binary bundling", () => {
  test("the Prisma client is imported statically, never via require", () => {
    // bun build resolves what it can see. A runtime require() of a bare
    // specifier is invisible to it, so the client is left out of the binary.
    expect(client).not.toContain("createRequire");
    expect(client).not.toMatch(/require\(\s*["']@prisma\/client["']\s*\)/);
    expect(client).toContain('from "./generated/prisma/client/client"');
  });

  test("the schema generates into the source tree", () => {
    // prisma-client (ESM into src/) rather than prisma-client-js (node_modules).
    expect(schema).toMatch(/provider\s*=\s*"prisma-client"/);
    expect(schema).toMatch(
      /output\s*=\s*"\.\.\/src\/generated\/prisma\/client"/,
    );
  });

  test("queries use the pg driver adapter, not the native engine", () => {
    expect(client).toContain("PrismaPg");
    expect(client).toContain("adapter");
  });

  test("generation emits no platform-specific engine", () => {
    // The stronger assertion, and the one that actually failed in production:
    // the native engine is a .node built for the *build host*, so a macOS
    // machine embedded libquery_engine-darwin-arm64 into a linux-x64 binary and
    // the server died with "could not locate the Query Engine for runtime
    // debian-openssl-3.0.x". Checking the generator flag was a proxy; this
    // checks the outcome, and holds regardless of how Prisma spells the option.
    const generated = join(dirname(srcRoot), "src", "generated");
    if (!existsSync(generated)) return; // db:generate runs before check
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.node$|engine/i.test(entry.name)) offenders.push(entry.name);
      }
    };
    walk(generated);
    expect(offenders).toEqual([]);
  });

  test("build and check regenerate the client first", () => {
    // src/generated is gitignored, so a fresh clone has nothing to import.
    const pkg = JSON.parse(
      readFileSync(join(dirname(srcRoot), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const script of ["check", "build:linux"])
      expect(pkg.scripts[script]).toContain("db:generate");
  });
});
