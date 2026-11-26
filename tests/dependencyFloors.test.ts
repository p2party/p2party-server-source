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
 * lifts it, to the newest patch of the line that first holds the fix. Its row
 * then names that dependent and the range it declares; once the range reaches
 * the floor, the override is no longer needed and the tests fail until it is
 * deleted. Offline: reads package.json and bun.lock only.
 */
interface SecurityFloor {
  floor: string;
  advisories: string[];
  /**
   * Only for an overridden package: the dependent whose declared range keeps
   * it below the floor, and that range as bun.lock records it.
   */
  overriddenFor?: { dependent: string; declares: string };
}

const SECURITY_FLOORS: Record<string, SecurityFloor> = {
  effect: {
    floor: "3.22.1",
    advisories: ["GHSA-38f7-945m-qr2g", "GHSA-7589-6fvf-x4pw"],
    overriddenFor: { dependent: "@prisma/config", declares: "3.20.0" },
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

type DependencyMap = Record<string, string>;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
) as { overrides?: DependencyMap } & Partial<
  Record<(typeof DEPENDENCY_FIELDS)[number], DependencyMap>
>;

const lock = Bun.JSONC.parse(
  readFileSync(join(repositoryRoot, "bun.lock"), "utf8"),
) as {
  overrides?: DependencyMap;
  workspaces: Record<
    string,
    Partial<Record<(typeof DEPENDENCY_FIELDS)[number], DependencyMap>>
  >;
  packages: Record<
    string,
    [string, string?, { dependencies?: DependencyMap }?, ...unknown[]]
  >;
};

const nameAndVersion = (spec: string) => {
  const at = spec.lastIndexOf("@");
  return [spec.slice(0, at), spec.slice(at + 1)] as const;
};

/** Every package copy in bun.lock, as [name, version]. */
const resolved = Object.values(lock.packages).map(([spec]) =>
  nameAndVersion(spec),
);

/**
 * Whether some version the range accepts is at or above the floor: the floor
 * itself, or a version the range names (padded to x.y.z) that the range
 * accepts. Exact pins and ^, ~, >=, < and || ranges are all decided by these.
 */
const reaches = (range: string, floor: string): boolean =>
  Bun.semver.satisfies(floor, range) ||
  [...range.matchAll(/\d+(?:\.\d+){0,2}/g)]
    .map(([v]) => [...v.split("."), "0", "0"].slice(0, 3).join("."))
    .some(
      (v) => Bun.semver.satisfies(v, range) && Bun.semver.order(v, floor) >= 0,
    );

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

test("the lockfile's overrides and dependency ranges equal package.json's", () => {
  // bun run check does not install, so only CI's frozen install would notice
  // a package.json edited without regenerating bun.lock.
  expect(lock.overrides ?? {}).toEqual(manifest.overrides ?? {});
  const workspace = lock.workspaces[""]!;
  for (const field of DEPENDENCY_FIELDS)
    expect(workspace[field] ?? {}, field).toEqual(manifest[field] ?? {});
});

test("every override is needed: its dependent's range does not reach the floor", () => {
  for (const name of Object.keys(manifest.overrides ?? {})) {
    const record = SECURITY_FLOORS[name]?.overriddenFor;
    expect(
      record,
      `${name}: no dependent recorded for its override`,
    ).toBeDefined();
    const declared = Object.values(lock.packages)
      .filter(([spec]) => nameAndVersion(spec)[0] === record!.dependent)
      .map(([, , meta]) => meta?.dependencies?.[name]);
    // The record is what the lockfile holds now, for every copy of the dependent.
    expect(
      declared.length,
      `${name}: ${record!.dependent} is not in bun.lock`,
    ).toBeGreaterThan(0);
    expect(declared, `${name}: ${record!.dependent}'s range changed`).toEqual(
      declared.map(() => record!.declares),
    );
    // A range that reaches the floor resolves above it without help: delete
    // the override.
    expect(
      reaches(record!.declares, SECURITY_FLOORS[name]!.floor),
      `${name}: ${record!.dependent} declares ${record!.declares}, which reaches ${SECURITY_FLOORS[name]!.floor}`,
    ).toBe(false);
  }
});
