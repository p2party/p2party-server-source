import { describe, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The release rehearsal (deploy/rehearsal/README.md) drives a local VM with the
// production playbooks. These tests pin what keeps it local: the VM sees no
// host directory and exposes two ports only, the inventory names nothing but
// that VM, and run.sh refuses any other inventory before it does anything.
// No test here starts a VM: run.sh is given a limactl that records any call.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rehearsal = join(repoRoot, "deploy", "rehearsal");
const runSh = join(rehearsal, "run.sh");

interface PortForward {
  guestIP?: string;
  guestIPMustBeZero?: boolean;
  guestPort?: number;
  guestPortRange?: [number, number];
  guestSocket?: string;
  hostIP?: string;
  hostPort?: number;
  hostPortRange?: [number, number];
  hostSocket?: string;
  proto?: string;
  ignore?: boolean;
  reverse?: boolean;
}

interface LimaTemplate {
  base?: unknown;
  vmType?: string;
  arch?: string;
  images?: { location?: string; arch?: string; digest?: string }[];
  mounts?: unknown[];
  additionalDisks?: unknown;
  blockDevices?: unknown;
  networks?: unknown[];
  portForwards?: PortForward[];
  ssh?: {
    localPort?: number;
    loadDotSSHPubKeys?: boolean;
    forwardAgent?: boolean;
    overVsock?: boolean;
  };
  networkOpts?: { hostLoopback?: boolean };
  plain?: boolean;
  cpus?: number;
  memory?: string;
  disk?: string;
}

const template = () =>
  Bun.YAML.parse(
    readFileSync(join(rehearsal, "lima.yaml"), "utf8"),
  ) as LimaTemplate;

interface InventoryGroup {
  hosts?: Record<string, Record<string, unknown> | null>;
  children?: Record<string, InventoryGroup | null>;
  vars?: Record<string, unknown>;
}

/** Every host of a YAML inventory with the variables it sets itself. */
function inventoryHosts(text: string) {
  const hosts = new Map<string, Record<string, unknown>>();
  const groupVars: Record<string, unknown>[] = [];
  const visit = (group: InventoryGroup | null | undefined) => {
    if (!group) return;
    if (group.vars) groupVars.push(group.vars);
    for (const [name, vars] of Object.entries(group.hosts ?? {})) {
      hosts.set(name, { ...(hosts.get(name) ?? {}), ...(vars ?? {}) });
    }
    for (const child of Object.values(group.children ?? {})) visit(child);
  };
  const parsed = Bun.YAML.parse(text) as Record<string, InventoryGroup>;
  for (const group of Object.values(parsed)) visit(group);
  return { hosts, groupVars };
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  limactlCalls: string;
  workDirCreated: boolean;
}

/** Each run.sh call here takes well under a second; a blocked one is killed. */
const RUN_TIMEOUT_MS = 10_000;
/** Above the run.sh timeouts of the test that makes the most calls (four). */
const RUN_TEST_TIMEOUT_MS = 60_000;

/**
 * Whether some process holds the FIFO open for reading. A non-blocking open
 * for writing succeeds only then; closing it again hands that reader an end of
 * file, so a blocked reader exits instead of outliving the test.
 */
function fifoHasReader(path: string): boolean {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a run.sh with a limactl that only records its arguments, a work
 * directory that run.sh must not create before its checks pass, and a PATH
 * with this test's bun first. The timeout ends a run.sh that blocks, which a
 * read of the FIFO used below would do.
 */
function runRehearsal(
  script: string,
  args: string[],
  sandbox: string,
  cwd = sandbox,
): RunResult {
  const stub = join(sandbox, "limactl-stub");
  const calls = join(sandbox, "limactl-calls");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${calls}'\nexit 1\n`, {
    mode: 0o755,
  });
  const workDir = join(sandbox, "work");
  const result = Bun.spawnSync({
    cmd: ["bash", script, ...args],
    cwd,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: sandbox,
      LIMACTL: stub,
      REHEARSAL_WORK_DIR: workDir,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_TIMEOUT_MS,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    limactlCalls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    workDirCreated: existsSync(workDir),
  };
}

/** A copy of deploy/rehearsal/ whose inventory.yml is `inventory`. */
function rehearsalCopy(sandbox: string, inventory: string) {
  const copy = join(sandbox, "deploy", "rehearsal");
  mkdirSync(copy, { recursive: true });
  for (const file of [
    "run.sh",
    "inventory-check.ts",
    "lima.yaml",
    "vars.yml",
    "ansible.cfg",
  ]) {
    cpSync(join(rehearsal, file), join(copy, file));
  }
  writeFileSync(join(copy, "inventory.yml"), inventory);
  return copy;
}

const trackedInventory = () =>
  readFileSync(join(rehearsal, "inventory.yml"), "utf8");

function withSandbox(run: (sandbox: string) => void) {
  const sandbox = mkdtempSync(join(tmpdir(), "p2party-rehearsal-test-"));
  try {
    run(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function expectRefusedBeforeAnything(result: RunResult, reason: RegExp) {
  expect(result.stderr).toMatch(reason);
  expect(result.exitCode).toBe(2);
  expect(result.limactlCalls).toBe("");
  expect(result.workDirCreated).toBe(false);
}

describe("release rehearsal contract", () => {
  test("the rehearsal template forwards no guest port except the two named ones, both above 5000", () => {
    const lima = template();
    const forwards = lima.portForwards ?? [];

    // Exactly one guest port is forwarded: the public signaling port (Caddy).
    const forwarded = forwards.filter((rule) => rule.ignore !== true);
    expect(forwarded).toHaveLength(1);
    const [signaling] = forwarded;
    expect(signaling?.guestPort).toBe(443);
    expect(signaling?.guestPortRange).toBeUndefined();
    expect(signaling?.hostIP).toBe("127.0.0.1");
    expect(signaling?.hostPort).toBeGreaterThan(5000);
    expect(signaling?.guestSocket).toBeUndefined();
    expect(signaling?.hostSocket).toBeUndefined();
    expect(signaling?.reverse).toBeUndefined();

    // Everything else is ignored, TCP and UDP, on every guest address. The
    // ignore rule is last, so it cannot shadow the forward above, and Lima's
    // own fallback rule (appended after it) is never reached.
    const last = forwards.at(-1);
    expect(forwards).toHaveLength(2);
    expect(last).toEqual({
      guestIP: "0.0.0.0",
      guestPortRange: [1, 65535],
      proto: "any",
      ignore: true,
    });
    expect(forwards.some((rule) => rule.guestIPMustBeZero === true)).toBe(
      false,
    );

    // The second named port: the instance's SSH, on the host's loopback.
    expect(lima.ssh?.localPort).toBeGreaterThan(5000);
    expect(lima.ssh?.localPort).not.toBe(signaling?.hostPort);
    expect(lima.ssh?.overVsock).toBe(false);

    // User-mode networking only, and no route to the host's loopback services.
    expect(lima.networks ?? []).toEqual([]);
    expect(lima.networkOpts?.hostLoopback).toBe(false);
    expect(lima.plain).toBeUndefined();
  });

  test("the rehearsal template mounts nothing from the host", () => {
    const lima = template();
    expect(Array.isArray(lima.mounts)).toBe(true);
    expect(lima.mounts).toEqual([]);
    // A base template would merge its own mounts (Lima's ubuntu template
    // mounts the home directory).
    expect(lima.base).toBeUndefined();
    expect(lima.additionalDisks).toBeUndefined();
    expect(lima.blockDevices).toBeUndefined();
    expect(lima.ssh?.loadDotSSHPubKeys).toBe(false);
    expect(lima.ssh?.forwardAgent).toBe(false);
    expect(lima.vmType).toBe("vz");
    expect(lima.cpus).toBe(2);
    expect(lima.memory).toBe("2GiB");
    expect(lima.disk).toBe("12GiB");
  });

  test(
    "the rehearsal inventory names only 127.0.0.1",
    () => {
      const { hosts, groupVars } = inventoryHosts(trackedInventory());
      expect([...hosts.keys()].sort()).toEqual([
        "p2party-coturn",
        "p2party-postgres",
        "p2party-signaling",
      ]);
      for (const vars of hosts.values()) {
        expect(vars.ansible_host).toBe("127.0.0.1");
        expect(vars.ansible_port).toBe(template().ssh?.localPort);
        expect(vars.ansible_connection).toBeUndefined();
        expect(vars.ansible_ssh_common_args).toBeUndefined();
        expect(vars.ansible_ssh_extra_args).toBeUndefined();
      }
      for (const vars of groupVars) {
        expect(vars.ansible_host).toBeUndefined();
        expect(vars.ansible_connection).toBeUndefined();
        expect(vars.ansible_ssh_common_args).toBeUndefined();
      }
      // run.sh accepts it.
      withSandbox((sandbox) => {
        const copy = rehearsalCopy(sandbox, trackedInventory());
        const result = runRehearsal(
          join(copy, "run.sh"),
          ["--inventory", join(copy, "inventory.yml"), "check"],
          sandbox,
        );
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(
          "p2party-postgres, p2party-signaling, p2party-coturn -> 127.0.0.1:56022",
        );
        expect(result.exitCode).toBe(0);
        expect(result.limactlCalls).toBe("");
      });
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses an inventory with any other host",
    () => {
      const cases: [string, string, RegExp][] = [
        [
          "a host on the private network",
          trackedInventory().replace(
            /(p2party-signaling:\n\s+ansible_host:) 127\.0\.0\.1/,
            "$1 10.231.0.4",
          ),
          /host p2party-signaling is 10\.231\.0\.4, not 127\.0\.0\.1/,
        ],
        [
          "a host named only by its name",
          `${trackedInventory()}\nextra:\n  hosts:\n    signaling.example.org:\n`,
          /host signaling\.example\.org is signaling\.example\.org, not 127\.0\.0\.1/,
        ],
        [
          "a group variable that redirects every connection",
          trackedInventory().replace(
            "ansible_python_interpreter: /usr/bin/python3",
            "ansible_python_interpreter: /usr/bin/python3\n    ansible_ssh_common_args: -o ProxyJump=jump.example.org",
          ),
          /group all sets ansible_ssh_common_args/,
        ],
        [
          "a host on the right address with another port",
          trackedInventory().replace(
            /(p2party-postgres:\n\s+ansible_host: 127\.0\.0\.1\n\s+ansible_port:) 56022/,
            "$1 22",
          ),
          /host p2party-postgres uses port 22, not the instance's SSH port 56022/,
        ],
        [
          "a local connection",
          trackedInventory().replace(
            "role: turn",
            "role: turn\n          ansible_connection: local",
          ),
          /host p2party-coturn sets ansible_connection/,
        ],
      ];
      for (const [label, inventory, reason] of cases) {
        withSandbox((sandbox) => {
          expect(inventory).not.toBe(trackedInventory());
          const copy = rehearsalCopy(sandbox, inventory);
          const result = runRehearsal(
            join(copy, "run.sh"),
            ["--inventory", join(copy, "inventory.yml"), "upgrade"],
            sandbox,
          );
          try {
            expectRefusedBeforeAnything(result, reason);
          } catch (error) {
            throw new Error(`${label}: ${String(error)}`);
          }
        });
      }
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses the production inventory path",
    () => {
      withSandbox((sandbox) => {
        // A FIFO with no writer: opening it for reading blocks, so a run.sh that
        // looked inside before refusing would time out here.
        const inventoryDir = join(sandbox, "deploy", "ansible", "inventory");
        mkdirSync(inventoryDir, { recursive: true });
        const production = join(inventoryDir, "production.yml");
        const mkfifo = Bun.spawnSync({ cmd: ["mkfifo", production] });
        expect(mkfifo.exitCode).toBe(0);

        for (const path of [
          production,
          "deploy/ansible/inventory/production.yml",
        ]) {
          const result = runRehearsal(
            runSh,
            ["--inventory", path, "upgrade"],
            sandbox,
          );
          expect(fifoHasReader(production)).toBe(false);
          expectRefusedBeforeAnything(
            result,
            /refusing to start: .*production inventory/,
          );
        }

        // The rehearsal inventory under the production name is refused too, and
        // so is any file other than the tracked rehearsal inventory.
        const renamed = join(sandbox, "production.yml");
        symlinkSync(join(rehearsal, "inventory.yml"), renamed);
        expectRefusedBeforeAnything(
          runRehearsal(runSh, ["--inventory", renamed, "upgrade"], sandbox),
          /refusing to start: .*production inventory/,
        );
        const other = join(sandbox, "other.yml");
        writeFileSync(other, trackedInventory());
        expectRefusedBeforeAnything(
          runRehearsal(runSh, ["--inventory", other, "upgrade"], sandbox),
          /refusing to start: .* is not the tracked rehearsal inventory/,
        );
      });
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test("the image is pinned by digest", () => {
    const lima = template();
    const images = lima.images ?? [];
    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image?.arch).toBe(lima.arch);
    expect(lima.arch).toBe("aarch64");
    // A dated release directory, never the moving `release/` alias.
    expect(image?.location).toMatch(
      /^https:\/\/cloud-images\.ubuntu\.com\/releases\/noble\/release-\d{8}\/ubuntu-24\.04-server-cloudimg-arm64\.img$/,
    );
    expect(image?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
