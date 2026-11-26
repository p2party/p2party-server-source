import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

/**
 * Security floors for packages this repository installs only through the
 * Prisma CLI: on developer machines, in CI, and as the deploy's migration
 * tooling on the signaling host. None of them is in the compiled server
 * binary. Each floor is the first release that fixes every listed advisory
 * for the major line the lockfile resolves (GitHub advisory database, read
 * 2026-11-26).
 *
 * When a dependent pins a version below a floor, `overrides` in package.json
 * lifts it, to the newest patch of the line that first holds the fix, and
 * that override must have a row here. Offline: reads package.json and
 * bun.lock only.
 */
const SECURITY_FLOORS: Record<string, { floor: string; advisories: string[] }> =
  {
    // @prisma/config 7.10.1 pins 3.20.0, below the fix: overridden.
    effect: {
      floor: "3.22.1",
      advisories: ["GHSA-38f7-945m-qr2g", "GHSA-7589-6fvf-x4pw"],
    },
    defu: { floor: "6.1.5", advisories: ["GHSA-737v-mqg7-c878"] },
    "deepmerge-ts": { floor: "8.0.0", advisories: ["GHSA-ggr8-5vv4-36mx"] },
    valibot: {
      floor: "1.4.2",
      advisories: ["GHSA-vqpr-j7v3-hqw9", "GHSA-5qjj-4xww-7phc"],
    },
    "find-my-way": { floor: "9.7.0", advisories: ["GHSA-c96f-x56v-gq3h"] },
    "fast-uri": {
      floor: "3.1.9",
      advisories: [
        "GHSA-hrr3-gc8f-f4qj",
        "GHSA-w74x-v6f9-j3xg",
        "GHSA-xhq7-xmqj-769h",
        "GHSA-wjr9-j795-jxcr",
        "GHSA-333x-w4r6-6crp",
      ],
    },
    mysql2: {
      floor: "3.23.1",
      advisories: ["GHSA-3f6p-5ww8-9rcr", "GHSA-rgwj-5xj2-c3m3"],
    },
  };

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
) as { overrides?: Record<string, string> };

/** Every package copy in bun.lock, as [name, version]. */
const resolved = (() => {
  const lock = Bun.JSONC.parse(
    readFileSync(join(repositoryRoot, "bun.lock"), "utf8"),
  ) as { packages: Record<string, [string, ...unknown[]]> };
  return Object.values(lock.packages).map(([spec]) => {
    const at = spec.lastIndexOf("@");
    return [spec.slice(0, at), spec.slice(at + 1)] as const;
  });
})();

test("the lockfile resolves every security floor", () => {
  const below = resolved
    .filter(
      ([name, version]) =>
        name in SECURITY_FLOORS &&
        !Bun.semver.satisfies(version, `>=${SECURITY_FLOORS[name]!.floor}`),
    )
    .map(
      ([name, version]) =>
        `${name}@${version} < ${SECURITY_FLOORS[name]!.floor} (${SECURITY_FLOORS[name]!.advisories.join(", ")})`,
    );
  expect(below).toEqual([]);

  // An override of a package the lockfile does not hold protects nothing.
  const names = new Set(resolved.map(([name]) => name));
  expect(
    Object.keys(manifest.overrides ?? {}).filter((name) => !names.has(name)),
  ).toEqual([]);
});

test("every override has a recorded reason", () => {
  expect(
    Object.keys(manifest.overrides ?? {}).filter(
      (name) => !(name in SECURITY_FLOORS),
    ),
  ).toEqual([]);
});
