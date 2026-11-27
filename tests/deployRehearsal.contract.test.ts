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
import {
  checkAnsibleCfg,
  checkExtraVarName,
  checkExtraVars,
  checkInventory,
  checkResolvedHost,
} from "../deploy/rehearsal/inventory-check";
import { replacements, sanitize } from "../deploy/rehearsal/sanitize";

// The release rehearsal (deploy/rehearsal/README.md) drives a local VM with the
// production playbooks. These tests pin what keeps it local: the VM sees no
// host directory and its forwarding rules let no guest port reach the host
// but the two named ones; nothing handed to Ansible can send a connection
// anywhere but that VM; the watch behind the rules fails closed; and run.sh
// refuses before it does anything. No test here starts a VM: run.sh is given
// a limactl that records any call.

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
  minimumLimaVersion?: string;
  base?: unknown;
  vmType?: string;
  arch?: string;
  images?: { location?: string; arch?: string; digest?: string }[];
  mounts?: unknown[];
  additionalDisks?: unknown;
  blockDevices?: unknown;
  copyToHost?: unknown;
  env?: unknown;
  networks?: unknown[];
  portForwards?: PortForward[];
  propagateProxyEnv?: boolean;
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

const templateText = () => readFileSync(join(rehearsal, "lima.yaml"), "utf8");
const template = () => Bun.YAML.parse(templateText()) as LimaTemplate;

const connectionVariables = (
  JSON.parse(
    readFileSync(join(rehearsal, "ansible-connection-variables.json"), "utf8"),
  ) as { ansible_core: string; all: string[] }
).all;

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
/** Above the run.sh timeouts of the tests that make the most calls. */
const RUN_TEST_TIMEOUT_MS = 90_000;

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
 * A limactl that records its arguments: `--version` prints STUB_VERSION,
 * `create`, `start`, `stop` and `delete` keep an instance state file, `list`
 * reports it, and `start` sleeps for STUB_START_SECONDS.
 */
function writeLimactlStub(sandbox: string) {
  const stub = join(sandbox, "limactl-stub");
  const calls = join(sandbox, "limactl-calls");
  const state = join(sandbox, "limactl-state");
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$@" >> '${calls}'
case "$1" in
  --version) echo "limactl version \${STUB_VERSION:-2.3.0}" ;;
  create) touch '${state}' ;;
  start) touch '${sandbox}/start-called'; "\${STUB_SLEEP_BIN:-/bin/sleep}" "\${STUB_START_SECONDS:-0}" ;;
  list)
    [ -f '${state}' ] || exit 0
    case "$*" in *Status*) echo Running ;; *) echo p2party-rehearsal ;; esac ;;
  stop) ;;
  delete) rm -f '${state}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return { stub, calls };
}

/**
 * Runs a run.sh with the limactl stub, a work directory that run.sh must not
 * create before its checks pass, and a PATH with this test's bun first. The
 * timeout ends a run.sh that blocks, which a read of the FIFO used below
 * would do.
 */
function runRehearsal(
  script: string,
  args: string[],
  sandbox: string,
  options: { cwd?: string; env?: Record<string, string> } = {},
): RunResult {
  const { stub, calls } = writeLimactlStub(sandbox);
  const workDir = join(sandbox, "work");
  const result = Bun.spawnSync({
    cmd: ["bash", script, ...args],
    cwd: options.cwd ?? sandbox,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: sandbox,
      LIMACTL: stub,
      LIMA_HOME: join(sandbox, "lima"),
      REHEARSAL_WORK_DIR: workDir,
      ...options.env,
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

/** Every file of deploy/rehearsal/ but the result files. */
function harnessFiles(): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--", ".", ":(exclude)results/**"],
    {
      cwd: rehearsal,
      stdout: "pipe",
    },
  );
  if (result.exitCode !== 0)
    throw new Error("Could not enumerate tracked rehearsal files");
  return result.stdout.toString().split("\0").filter(Boolean);
}

/** A copy of deploy/rehearsal/, edited by `edit`; returns its directory. */
function rehearsalCopy(
  sandbox: string,
  edit: (copy: string) => void = () => {},
  root = sandbox,
) {
  const copy = join(root, "deploy", "rehearsal");
  for (const file of harnessFiles()) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(rehearsal, file), join(copy, file));
  }
  edit(copy);
  return copy;
}

/**
 * A git repository holding a copy of deploy/rehearsal/ committed at HEAD,
 * then edited by `edit` in its work tree.
 */
function rehearsalRepository(
  sandbox: string,
  edit: (copy: string) => void = () => {},
) {
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });
  const copy = rehearsalCopy(sandbox, () => {}, repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync({
      cmd: [
        "git",
        "-c",
        "user.name=rehearsal-test",
        "-c",
        "user.email=rehearsal-test@example.invalid",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      cwd: repo,
      env: { PATH: "/usr/bin:/bin", HOME: sandbox },
    });
    expect(result.exitCode).toBe(0);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "rehearsal fixture");
  edit(copy);
  return { repo, copy, runSh: join(copy, "run.sh") };
}

const trackedInventory = () =>
  readFileSync(join(rehearsal, "inventory.yml"), "utf8");
const trackedVars = () => readFileSync(join(rehearsal, "vars.yml"), "utf8");
const trackedCfg = () => readFileSync(join(rehearsal, "ansible.cfg"), "utf8");

function withSandbox<T>(run: (sandbox: string) => T): T {
  const sandbox = mkdtempSync(join(tmpdir(), "p2party-rehearsal-test-"));
  try {
    return run(sandbox);
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

/** Runs run.sh check on a copy of deploy/rehearsal/ changed by `edit`. */
function checkCopy(
  edit: (copy: string) => void,
  env: Record<string, string> = {},
) {
  return withSandbox((sandbox) => {
    const copy = rehearsalCopy(sandbox, edit);
    return runRehearsal(
      join(copy, "run.sh"),
      ["--inventory", join(copy, "inventory.yml"), "upgrade"],
      sandbox,
      { env },
    );
  });
}

const replaceIn = (
  copy: string,
  file: string,
  from: RegExp | string,
  to: string,
) => {
  const path = join(copy, file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(from, to);
  expect(after).not.toBe(before);
  writeFileSync(path, after);
};

// ---------------------------------------------------------------------------
// The forwarding rules, as Lima 2.3 matches them. Lima documents that a rule
// with guestIP 127.0.0.1 (the default) also matches binds on 0.0.0.0, :: and
// ::1; a rule with guestIP 0.0.0.0 matches binds on 0.0.0.0 and ::, and may
// match every address (Lima's template says so; 2.3.0 did not do it for the
// guest's loopback). A rule "possibly" matches when either reading allows it.
// After the template's rules, Lima appends its own: guest 127.0.0.1, any
// protocol, every port, to the same port on the host's 127.0.0.1.
// ---------------------------------------------------------------------------
interface Bind {
  ip: string;
  port: number;
  proto: "tcp" | "udp";
}

const LIMA_FALLBACK: PortForward = {
  guestIP: "127.0.0.1",
  proto: "any",
  guestPortRange: [1, 65535],
  hostIP: "127.0.0.1",
  hostPortRange: [1, 65535],
};

const unspecifiedIp = (ip: string) => ip === "0.0.0.0" || ip === "::";

function portsAndProto(rule: PortForward, bind: Bind) {
  const [low, high] = rule.guestPortRange ?? [
    rule.guestPort ?? 1,
    rule.guestPort ?? 65535,
  ];
  const proto = rule.proto ?? "tcp";
  return (
    bind.port >= low &&
    bind.port <= high &&
    (proto === "any" || proto === bind.proto)
  );
}

function certainlyMatches(rule: PortForward, bind: Bind) {
  if (rule.guestSocket !== undefined || !portsAndProto(rule, bind))
    return false;
  const guestIP = rule.guestIP ?? "127.0.0.1";
  if (guestIP === bind.ip) return true;
  if (guestIP === "127.0.0.1" && ["0.0.0.0", "::", "::1"].includes(bind.ip)) {
    return true;
  }
  return unspecifiedIp(guestIP) && unspecifiedIp(bind.ip);
}

function possiblyMatches(rule: PortForward, bind: Bind) {
  if (rule.guestSocket !== undefined || !portsAndProto(rule, bind))
    return false;
  return (
    certainlyMatches(rule, bind) || unspecifiedIp(rule.guestIP ?? "127.0.0.1")
  );
}

/** Every host address and port the bind could be forwarded to. */
function forwardsOf(rules: PortForward[], bind: Bind) {
  const outcomes: string[] = [];
  for (const rule of [...rules, LIMA_FALLBACK]) {
    if (!possiblyMatches(rule, bind)) continue;
    if (rule.ignore === true) {
      if (certainlyMatches(rule, bind)) return outcomes;
      continue;
    }
    const [guestLow] = rule.guestPortRange ?? [rule.guestPort ?? bind.port];
    const hostPort =
      rule.hostPort ??
      (rule.hostPortRange
        ? rule.hostPortRange[0] + bind.port - guestLow!
        : bind.port);
    outcomes.push(`${rule.hostIP ?? "127.0.0.1"}:${String(hostPort)}`);
    if (certainlyMatches(rule, bind)) return outcomes;
  }
  return outcomes;
}

/** The bind forms the host agent's logs showed, and the ports around 5000. */
const BIND_ADDRESSES = [
  "127.0.0.1",
  "::1",
  "::",
  "0.0.0.0",
  "10.231.0.2",
  "10.231.0.4",
  "192.168.5.15",
  "127.0.0.53",
];
const BIND_PORTS = [
  1, 22, 53, 68, 80, 443, 2019, 3001, 3478, 4999, 5000, 5353, 5432, 56022,
  56443, 65535,
];

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

    // Everything else is ignored, TCP and UDP, both on the guest's loopback
    // and on its other addresses: Lima's own fallback rule, appended after
    // these, forwards a port bound on the guest's 127.0.0.1 to the same port
    // on the host's, and a 0.0.0.0 rule does not cover the guest's loopback.
    // The ignore rules come after the forward, so they cannot shadow it.
    expect(forwards).toHaveLength(3);
    expect(forwards.indexOf(signaling!)).toBe(0);
    for (const guestIP of ["127.0.0.1", "0.0.0.0"]) {
      expect(forwards.slice(1)).toContainEqual({
        guestIP,
        guestPortRange: [1, 65535],
        proto: "any",
        ignore: true,
      });
    }
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

  test("no bind form the host agent reported can be forwarded anywhere but 127.0.0.1 at 5000 or above, and only guest 443 is forwarded", () => {
    const rules = template().portForwards ?? [];
    const signalingPort = rules.find((rule) => rule.ignore !== true)?.hostPort;
    for (const proto of ["tcp", "udp"] as const) {
      for (const ip of BIND_ADDRESSES) {
        for (const port of BIND_PORTS) {
          const outcomes = forwardsOf(rules, { ip, port, proto });
          const label = `${proto} ${ip}:${String(port)} -> ${JSON.stringify(outcomes)}`;
          for (const outcome of outcomes) {
            const [hostIP, hostPort] = [
              outcome.slice(0, outcome.lastIndexOf(":")),
              Number(outcome.slice(outcome.lastIndexOf(":") + 1)),
            ];
            expect(`${label}: ${hostIP}`).toBe(`${label}: 127.0.0.1`);
            expect(hostPort >= 5000 ? label : `${label} below 5000`).toBe(
              label,
            );
          }
          const expected =
            proto === "tcp" &&
            port === 443 &&
            ["127.0.0.1", "::1", "::", "0.0.0.0"].includes(ip)
              ? [`127.0.0.1:${String(signalingPort)}`]
              : [];
          expect(label).toBe(
            `${proto} ${ip}:${String(port)} -> ${JSON.stringify(expected)}`,
          );
        }
      }
    }
    // The rules are Lima 2.3.0's reading; run.sh refuses other releases.
    expect(template().minimumLimaVersion).toBe("2.3.0");
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
    expect(lima.disk).toBe("8GiB");
  });

  test("the template passes the guest none of the host's environment and copies nothing back (M5, M6)", () => {
    const lima = template();
    expect(lima.propagateProxyEnv).toBe(false);
    expect(lima.env).toBeUndefined();
    expect(lima.copyToHost).toBeUndefined();
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
        const copy = rehearsalCopy(sandbox);
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
      const cases: [string, (copy: string) => void, RegExp][] = [
        [
          "a host on the private network",
          (copy) =>
            replaceIn(
              copy,
              "inventory.yml",
              /(p2party-signaling:\n\s+ansible_host:) 127\.0\.0\.1/,
              "$1 10.231.0.4",
            ),
          /host p2party-signaling is 10\.231\.0\.4, not 127\.0\.0\.1/,
        ],
        [
          "a host named only by its name",
          (copy) =>
            writeFileSync(
              join(copy, "inventory.yml"),
              `${trackedInventory()}\nextra:\n  hosts:\n    signaling.example.org:\n`,
            ),
          /host signaling\.example\.org is signaling\.example\.org, not 127\.0\.0\.1/,
        ],
        [
          "a group variable that redirects every connection",
          (copy) =>
            replaceIn(
              copy,
              "inventory.yml",
              "ansible_python_interpreter: /usr/bin/python3",
              "ansible_python_interpreter: /usr/bin/python3\n    ansible_ssh_common_args: -o ProxyJump=jump.example.org",
            ),
          /group all sets ansible_ssh_common_args/,
        ],
        [
          "a host on the right address with another port",
          (copy) =>
            replaceIn(
              copy,
              "inventory.yml",
              /(p2party-postgres:\n\s+ansible_host: 127\.0\.0\.1\n\s+ansible_port:) 56022/,
              "$1 22",
            ),
          /host p2party-postgres uses port 22, not the instance's SSH port 56022/,
        ],
        [
          "a local connection",
          (copy) =>
            replaceIn(
              copy,
              "inventory.yml",
              "role: turn",
              "role: turn\n          ansible_connection: local",
            ),
          /host p2party-coturn sets ansible_connection/,
        ],
      ];
      for (const [label, edit, reason] of cases) {
        try {
          expectRefusedBeforeAnything(checkCopy(edit), reason);
        } catch (error) {
          throw new Error(`${label}: ${String(error)}`);
        }
      }
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses ansible_ssh_host beside the allowed address (M1)",
    () => {
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          replaceIn(
            copy,
            "inventory.yml",
            /(p2party-signaling:\n\s+ansible_host: 127\.0\.0\.1\n)/,
            "$1          ansible_ssh_host: 10.231.0.4\n",
          ),
        ),
        /host p2party-signaling sets ansible_ssh_host/,
      );
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses ansible_ssh_port beside the allowed port (M2)",
    () => {
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          replaceIn(
            copy,
            "inventory.yml",
            /(p2party-postgres:\n\s+ansible_host: 127\.0\.0\.1\n\s+ansible_port: 56022\n)/,
            "$1          ansible_ssh_port: 22\n",
          ),
        ),
        /host p2party-postgres sets ansible_ssh_port/,
      );
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses a connection variable in vars.yml, which is passed as -e (M16)",
    () => {
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          writeFileSync(
            join(copy, "vars.yml"),
            `${trackedVars()}\nansible_host: 10.231.0.4\n`,
          ),
        ),
        /vars\.yml sets ansible_host/,
      );
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          replaceIn(
            copy,
            "vars.yml",
            "signaling: signaling.rehearsal.localhost",
            "signaling: signaling.p2party.com",
          ),
        ),
        /vars\.yml: domains\.signaling is "signaling\.p2party\.com", not a \*\.localhost name/,
      );
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses an ansible.cfg whose ssh_args could redirect the connection",
    () => {
      for (const [option, reason] of [
        ["-o HostName=10.231.0.4", /ssh_args passes -o HostName=10\.231\.0\.4/],
        ["-o Port=22", /ssh_args passes -o Port=22/],
        ["-o ProxyCommand=nc", /ssh_args passes -o ProxyCommand=nc/],
      ] as const) {
        expectRefusedBeforeAnything(
          checkCopy((copy) =>
            replaceIn(
              copy,
              "ansible.cfg",
              "ssh_args = -F /dev/null",
              `ssh_args = -F /dev/null ${option}`,
            ),
          ),
          reason,
        );
      }
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          replaceIn(
            copy,
            "ansible.cfg",
            "ssh_args = -F /dev/null ",
            "ssh_args = ",
          ),
        ),
        /ssh_args does not pass -F \/dev\/null/,
      );
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          replaceIn(
            copy,
            "ansible.cfg",
            "[ssh_connection]\n",
            "[ssh_connection]\nssh_executable = /usr/local/bin/ssh\n",
          ),
        ),
        /ansible\.cfg sets ssh_executable in \[ssh_connection\]/,
      );
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          replaceIn(
            copy,
            "ansible.cfg",
            "[defaults]\n",
            "[defaults]\nremote_port = 22\n",
          ),
        ),
        /ansible\.cfg sets remote_port in \[defaults\]/,
      );
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses an ANSIBLE_ or LIMA_ variable in its environment",
    () => {
      for (const variable of [
        "ANSIBLE_SSH_ARGS",
        "ANSIBLE_SSH_COMMON_ARGS",
        "ANSIBLE_INVENTORY",
        "LIMA_SSH_PORT_FORWARDER",
      ]) {
        expectRefusedBeforeAnything(
          checkCopy(() => {}, { [variable]: "-o ProxyJump=jump.example.org" }),
          new RegExp(`the environment sets ${variable}`),
        );
      }
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "a ProxyJump is refused in the inventory, in vars.yml, in ansible.cfg and by the SSH guard",
    () => {
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          replaceIn(
            copy,
            "inventory.yml",
            "role: signaling",
            "role: signaling\n          ansible_ssh_extra_args: -J jump.example.org",
          ),
        ),
        /host p2party-signaling sets ansible_ssh_extra_args/,
      );
      expect(
        checkExtraVars(
          `${trackedVars()}\nansible_ssh_common_args: -o ProxyJump=jump.example.org\n`,
          connectionVariables,
        ),
      ).toContain(
        "vars.yml sets ansible_ssh_common_args; extra vars outrank every inventory value",
      );
      expect(
        checkAnsibleCfg(
          trackedCfg().replace(
            "ssh_args = -F /dev/null",
            "ssh_args = -F /dev/null -o ProxyJump=jump.example.org",
          ),
        ),
      ).toContain(
        "ssh_args passes -o ProxyJump=jump.example.org, which is not on its allowlist",
      );
      withSandbox((sandbox) => {
        const guard = guardIn(sandbox);
        for (const args of [
          ["-o", "ProxyJump=jump.example.org", ...guardOk.slice(0)],
          ["-J", "jump.example.org", ...guardOk],
        ]) {
          const result = guard.run("ssh", args);
          expect(result.stderr).toMatch(
            /ssh-guard: refusing ssh: (-o ProxyJump|-J is not)/,
          );
          expect(result.exitCode).toBe(255);
          expect(guard.realCalls()).toBe("");
        }
      });
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test("every connection variable of ansible-core 2.22 is refused outside the rehearsal's own values (M13)", () => {
    expect(connectionVariables.length).toBeGreaterThanOrEqual(100);
    expect(connectionVariables).toContain("ansible_ssh_host");
    expect(connectionVariables).toContain("ansible_ssh_port");
    const allowedHost: Record<string, unknown> = {
      ansible_host: "127.0.0.1",
      ansible_port: 56022,
      ansible_user: "p2party",
    };
    const allowedGroup: Record<string, unknown> = {
      ansible_become: true,
      ansible_become_method: "sudo",
    };
    // One host and one group, built as JSON (which is YAML) so that an
    // allowed variable is changed rather than given twice.
    const inventoryWith = (
      hostVars: Record<string, unknown>,
      groupVars: Record<string, unknown>,
    ) =>
      JSON.stringify({
        all: {
          hosts: { "p2party-signaling": { ...allowedHost, ...hostVars } },
          vars: {
            ansible_python_interpreter: "/usr/bin/python3",
            ...allowedGroup,
            ...groupVars,
          },
        },
      });
    expect(
      checkInventory(inventoryWith({}, {}), 56022, connectionVariables)
        .problems,
    ).toEqual([]);
    for (const name of connectionVariables) {
      const host = checkInventory(
        inventoryWith({ [name]: "changed.example.org" }, {}),
        56022,
        connectionVariables,
      );
      expect(`${name}: ${host.problems.join(" | ")}`).toMatch(
        new RegExp(`host p2party-signaling sets ${name}`),
      );
      const group = checkInventory(
        inventoryWith({}, { [name]: "changed" }),
        56022,
        connectionVariables,
      );
      expect(`${name}: ${group.problems.join(" | ")}`).toMatch(
        new RegExp(`group all sets ${name}`),
      );
      expect(
        checkExtraVars(
          `${trackedVars()}\n${name}: anything\n`,
          connectionVariables,
        ),
      ).toContain(
        `vars.yml sets ${name}; extra vars outrank every inventory value`,
      );
      expect(checkExtraVarName(name, connectionVariables)).not.toEqual([]);
    }
    // And any other ansible_* name, which ansible-core may read later.
    expect(
      checkInventory(
        trackedInventory().replace(
          "role: turn",
          "role: turn\n          ansible_some_future_variable: x",
        ),
        56022,
        connectionVariables,
      ).problems,
    ).toContain(
      "host p2party-coturn sets ansible_some_future_variable, which only the rehearsal's own values may set",
    );
    expect(checkExtraVarName("skip_build", connectionVariables)).toEqual([]);
    expect(checkExtraVarName("delegate_to", connectionVariables)).not.toEqual(
      [],
    );
  });

  test("what ansible-inventory resolved for a host must be 127.0.0.1 on the instance's port", () => {
    const resolved = (extra: Record<string, unknown>) =>
      JSON.stringify({
        ansible_host: "127.0.0.1",
        ansible_port: 56022,
        ansible_user: "p2party",
        ansible_become: true,
        ansible_become_method: "sudo",
        ansible_python_interpreter: "/usr/bin/python3",
        role: "signaling",
        ...extra,
      });
    expect(
      checkResolvedHost(
        "p2party-signaling",
        resolved({}),
        56022,
        connectionVariables,
      ),
    ).toEqual([]);
    expect(
      checkResolvedHost(
        "p2party-signaling",
        resolved({ ansible_ssh_host: "10.231.0.4" }),
        56022,
        connectionVariables,
      ),
    ).toContain(
      "ansible-inventory: host p2party-signaling sets ansible_ssh_host, which only the rehearsal's own values may set",
    );
    expect(
      checkResolvedHost(
        "p2party-signaling",
        resolved({ ansible_host: "10.231.0.4" }),
        56022,
        connectionVariables,
      ).join(" "),
    ).toMatch(/resolves p2party-signaling to 10\.231\.0\.4:56022/);
    expect(
      checkResolvedHost(
        "p2party-signaling",
        resolved({ ansible_port: 22 }),
        56022,
        connectionVariables,
      ).join(" "),
    ).toMatch(/resolves p2party-signaling to 127\.0\.0\.1:22/);
    expect(
      checkResolvedHost(
        "p2party-signaling",
        "not json",
        56022,
        connectionVariables,
      ),
    ).toEqual(["ansible-inventory printed no JSON for p2party-signaling"]);
  });

  test(
    "run.sh refuses an empty inventory (M14)",
    () => {
      expectRefusedBeforeAnything(
        checkCopy((copy) =>
          writeFileSync(join(copy, "inventory.yml"), "all:\n  children:\n"),
        ),
        /the inventory names no host/,
      );
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses a symbolic link as the inventory (M9)",
    () => {
      expectRefusedBeforeAnything(
        checkCopy((copy) => {
          const real = join(copy, "..", "elsewhere.yml");
          writeFileSync(real, trackedInventory());
          rmSync(join(copy, "inventory.yml"));
          symlinkSync(real, join(copy, "inventory.yml"));
        }),
        /inventory\.yml is a symbolic link/,
      );
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses inputs and guards that differ from the repository's HEAD (M8)",
    () => {
      for (const [file, from, to] of [
        ["inventory.yml", "role: turn", "role: TURN"],
        ["vars.yml", "main: rehearsal.localhost", "main: other.localhost"],
        ["ansible.cfg", "forks = 10", "forks = 9"],
        ["lima.yaml", "cpus: 2", "cpus: 3"],
        [
          "ssh-guard.sh",
          'refuse "no -F /dev/null',
          'true || refuse "no -F /dev/null',
        ],
        ["watch.sh", 'sleep "$period"', "sleep 99"],
      ] as const) {
        withSandbox((sandbox) => {
          const {
            repo,
            copy,
            runSh: script,
          } = rehearsalRepository(sandbox, (copy) =>
            replaceIn(copy, file, from, to),
          );
          expectRefusedBeforeAnything(
            runRehearsal(
              script,
              ["--inventory", join(copy, "inventory.yml"), "check"],
              sandbox,
              {
                env: { REHEARSAL_REPO: repo },
              },
            ),
            new RegExp(
              `${file.replace(".", "\\.")} differs from deploy/rehearsal/${file.replace(".", "\\.")} at .*HEAD`,
            ),
          );
        });
      }
      // Unchanged, it is accepted.
      withSandbox((sandbox) => {
        const { repo, copy, runSh: script } = rehearsalRepository(sandbox);
        const result = runRehearsal(
          script,
          ["--inventory", join(copy, "inventory.yml"), "check"],
          sandbox,
          {
            env: { REHEARSAL_REPO: repo },
          },
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      });
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

  test(
    "the SSH guard runs ssh, scp and sftp only to 127.0.0.1 on the instance's port",
    () => {
      withSandbox((sandbox) => {
        const guard = guardIn(sandbox);
        // What Ansible's ssh plugin passes, as ansible-core 2.22 builds it.
        expect(guard.run("ssh", guardOk).exitCode).toBe(0);
        expect(
          guard.run("sftp", [
            "-b",
            "-",
            "-C",
            ...guardOk.slice(0, -2),
            "[127.0.0.1]",
          ]).exitCode,
        ).toBe(0);
        expect(
          guard.run("scp", [
            ...guardOk.slice(0, -2),
            "/tmp/a",
            "[127.0.0.1]:/tmp/b",
          ]).exitCode,
        ).toBe(0);
        expect(guard.realCalls().split("\n").filter(Boolean)).toHaveLength(3);
        guard.clearCalls();
        const refused: [string, string[], RegExp][] = [
          [
            "ssh",
            [...guardOk.slice(0, -2), "10.231.0.4", "true"],
            /destination 10\.231\.0\.4, not 127\.0\.0\.1/,
          ],
          [
            "ssh",
            guardOk.map((arg) => (arg === "Port=56022" ? "Port=22" : arg)),
            /port 22, not the instance's 56022/,
          ],
          [
            "ssh",
            ["-o", "Port=22", ...guardOk],
            /port 22, not the instance's 56022/,
          ],
          [
            "ssh",
            ["-p", "22", ...guardOk],
            /port 22, not the instance's 56022/,
          ],
          [
            "ssh",
            guardOk.filter(
              (arg, i, all) =>
                arg !== "Port=56022" && all[i + 1] !== "Port=56022",
            ),
            /no port given/,
          ],
          [
            "ssh",
            ["-o", "HostName=10.231.0.4", ...guardOk],
            /-o HostName=10\.231\.0\.4 is not on the guard's allowlist/,
          ],
          [
            "ssh",
            ["-o", "ProxyCommand=nc %h %p", ...guardOk],
            /-o ProxyCommand=nc %h %p is not on the guard's allowlist/,
          ],
          [
            "ssh",
            ["-L", "2019:127.0.0.1:2019", ...guardOk],
            /-L is not on the guard's allowlist/,
          ],
          [
            "ssh",
            guardOk.map((arg) =>
              arg === "/dev/null" ? "/tmp/ssh_config" : arg,
            ),
            /no -F \/dev\/null/,
          ],
          [
            "ssh",
            [...guardOk.slice(0, -2), "root@127.0.0.1", "true"],
            /user root, not p2party/,
          ],
          [
            "ssh",
            [...guardOk.slice(0, -2), "ssh://127.0.0.1:22", "true"],
            /a URI destination/,
          ],
          [
            "sftp",
            ["-b", "-", ...guardOk.slice(0, -2), "[10.231.0.4]"],
            /destination \[10\.231\.0\.4\], not 127\.0\.0\.1/,
          ],
          [
            "scp",
            [...guardOk.slice(0, -2), "/tmp/a", "10.231.0.4:/tmp/b"],
            /destination 10\.231\.0\.4, not 127\.0\.0\.1/,
          ],
          [
            "scp",
            [
              "-S",
              "/bin/sh",
              ...guardOk.slice(0, -2),
              "/tmp/a",
              "127.0.0.1:/tmp/b",
            ],
            /-S is not on the guard's allowlist/,
          ],
        ];
        for (const [tool, args, reason] of refused) {
          const result = guard.run(tool, args);
          expect(`${tool} ${args.join(" ")}: ${result.stderr}`).toMatch(reason);
          expect(result.exitCode).toBe(255);
        }
        expect(guard.realCalls()).toBe("");
      });
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "play-env.sh passes Ansible no variable the harness did not set (M12)",
    () => {
      withSandbox((sandbox) => {
        const result = Bun.spawnSync({
          cmd: [
            "bash",
            join(rehearsal, "play-env.sh"),
            "--work",
            "/w",
            "--tools",
            "/t",
            "--cfg",
            "/c.cfg",
            "--control",
            "/cp",
            "--guard-bin",
            "/g",
            "--ssh-port",
            "56022",
            "--bun-dir",
            "/b",
            "--",
            "/usr/bin/env",
          ],
          env: {
            PATH: "/usr/bin:/bin",
            HOME: sandbox,
            ANSIBLE_SSH_ARGS: "-o ProxyJump=jump.example.org",
            ANSIBLE_INVENTORY: "/etc/hosts",
            SSH_AUTH_SOCK: "/tmp/agent",
            UNRELATED: "1",
          },
        });
        expect(result.exitCode).toBe(0);
        const env = Object.fromEntries(
          result.stdout
            .toString()
            .trim()
            .split("\n")
            .map((line) => [
              line.slice(0, line.indexOf("=")),
              line.slice(line.indexOf("=") + 1),
            ]),
        );
        expect(Object.keys(env).sort()).toEqual(
          [
            "ANSIBLE_COLLECTIONS_PATH",
            "ANSIBLE_CONFIG",
            "ANSIBLE_FORCE_COLOR",
            "ANSIBLE_HOME",
            "ANSIBLE_LOCAL_TEMP",
            "ANSIBLE_NOCOLOR",
            "ANSIBLE_PRIVATE_KEY_FILE",
            "ANSIBLE_SSH_COMMON_ARGS",
            "ANSIBLE_SSH_CONTROL_PATH_DIR",
            "BUN_INSTALL_CACHE_DIR",
            "CHECKPOINT_DISABLE",
            "HOME",
            "LANG",
            "LC_ALL",
            "PATH",
            "PRISMA_HIDE_UPDATE_MESSAGE",
            "REHEARSAL_GUARD_LOG",
            "REHEARSAL_GUARD_PORT",
            "REHEARSAL_GUARD_REAL_DIR",
            "TMPDIR",
            "USER",
          ].sort(),
        );
        expect(env.PATH?.split(":")[0]).toBe("/g");
        expect(env.ANSIBLE_CONFIG).toBe("/c.cfg");
        expect(env.ANSIBLE_SSH_COMMON_ARGS).toBe(
          "-o UserKnownHostsFile=/w/secrets/known_hosts -o StrictHostKeyChecking=accept-new",
        );
        expect(env.REHEARSAL_GUARD_PORT).toBe("56022");
        expect(env.REHEARSAL_GUARD_REAL_DIR).toBe("/usr/bin");
      });
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses a Lima outside the 2.3 line",
    () => {
      for (const [version, refused] of [
        ["2.4.0", true],
        ["2.2.9", true],
        ["3.0.0", true],
        ["2.3.0", false],
      ] as const) {
        withSandbox((sandbox) => {
          const { repo, copy, runSh: script } = rehearsalRepository(sandbox);
          const result = runRehearsal(
            script,
            ["--inventory", join(copy, "inventory.yml"), "vm-check"],
            sandbox,
            {
              env: { REHEARSAL_REPO: repo, STUB_VERSION: version },
            },
          );
          if (refused) {
            expect(result.stderr).toMatch(
              new RegExp(
                `limactl is version ${version.replaceAll(".", "\\.")}; the rehearsal's port rules were verified on Lima 2\\.3\\.0 only`,
              ),
            );
            expect(result.exitCode).toBe(2);
          } else {
            expect(result.stderr).not.toMatch(/limactl is version/);
          }
          expect(result.limactlCalls.split("\n").filter(Boolean)).toEqual([
            "--version",
          ]);
        });
      }
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh refuses Lima's override files on every path, the snapshot restore's included (M11)",
    () => {
      for (const file of ["default.yaml", "override.yaml", "base.yaml"]) {
        for (const mode of ["vm-check", "upgrade", "scenario-3"]) {
          withSandbox((sandbox) => {
            const { repo, copy, runSh: script } = rehearsalRepository(sandbox);
            mkdirSync(join(sandbox, "lima", "_config"), { recursive: true });
            writeFileSync(
              join(sandbox, "lima", "_config", file),
              'mounts: [{location: "~"}]\n',
            );
            const result = runRehearsal(
              script,
              ["--inventory", join(copy, "inventory.yml"), mode],
              sandbox,
              {
                env: { REHEARSAL_REPO: repo },
              },
            );
            expect(result.stderr).toMatch(
              new RegExp(
                `_config/${file.replace(".", "\\.")} exists and would change the instance`,
              ),
            );
            expect(result.exitCode).toBe(2);
            expect(result.limactlCalls).not.toMatch(/create|start/);
          });
        }
      }
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test(
    "run.sh works only in a work directory it made, never the root, a home directory or the repository",
    () => {
      withSandbox((sandbox) => {
        const { repo, copy, runSh: script } = rehearsalRepository(sandbox);
        const run = (work: string, mode = "clean") =>
          runRehearsal(
            script,
            ["--inventory", join(copy, "inventory.yml"), mode],
            sandbox,
            {
              env: { REHEARSAL_REPO: repo, REHEARSAL_WORK_DIR: work },
            },
          );
        const foreign = join(sandbox, "foreign");
        mkdirSync(foreign);
        writeFileSync(join(foreign, "keep-me"), "not the harness's\n");
        for (const [work, reason] of [
          ["/", /is the root, a top-level directory or the home directory/],
          [sandbox, /is the root, a top-level directory or the home directory/],
          [foreign, /exists, is not empty and was not made by run\.sh/],
          ["relative/work", /is not an absolute path/],
          [join(repo, "work"), /inside the repository/],
          [
            join(sandbox, "absent"),
            /does not exist; there is nothing to clean/,
          ],
        ] as const) {
          const result = run(work);
          expect(`${work}: ${result.stderr}`).toMatch(reason);
          expect(result.exitCode).toBe(2);
        }
        expect(readFileSync(join(foreign, "keep-me"), "utf8")).toBe(
          "not the harness's\n",
        );
        expect(existsSync(join(repo, "work"))).toBe(false);
      });
    },
    RUN_TEST_TIMEOUT_MS,
  );

  test("the watch deletes the instance when limactl listens below 5000 or off 127.0.0.1, TCP or UDP", () => {
    for (const [line, kind] of [
      ["limactl 9 u 1u IPv4 0x1 0t0 UDP 127.0.0.1:53", "UDP 127.0.0.1:53"],
      [
        "limactl 9 u 1u IPv4 0x1 0t0 TCP 127.0.0.1:2019 (LISTEN)",
        "TCP 127.0.0.1:2019",
      ],
      ["limactl 9 u 1u IPv4 0x1 0t0 TCP *:56443 (LISTEN)", "TCP *:56443"],
      ["limactl 9 u 1u IPv6 0x1 0t0 UDP [::1]:5353", "UDP [::1]:5353"],
    ] as const) {
      const outcome = runWatch({
        tcp: line.includes("TCP") ? line : "",
        udp: line.includes("UDP") ? line : "",
      });
      expect(outcome.tripped).toMatch(
        new RegExp(
          `limactl is listening where it must not: ${kind.replace(/[.*[\]]/g, "\\$&")}`,
        ),
      );
      expect(outcome.limactlCalls).toEqual([
        "stop --force p2party-rehearsal",
        "delete --force p2party-rehearsal",
      ]);
      expect(outcome.exitCode).toBe(3);
    }
    // Lima's own sockets on 127.0.0.1 at 5000 and above, and a connected UDP
    // socket, are fine: a heartbeat, no trip (the stub's sleep ends the loop).
    const fine = runWatch({
      tcp: "limactl 9 u 1u IPv4 0x1 0t0 TCP 127.0.0.1:56022 (LISTEN)",
      udp: "limactl 9 u 1u IPv4 0x1 0t0 UDP 127.0.0.1:55688\nlimactl 9 u 2u IPv4 0x1 0t0 UDP 192.168.1.2:60000->1.1.1.1:53",
    });
    expect(fine.tripped).toBe("");
    expect(fine.heartbeat).toMatch(/^[0-9]+$/);
    expect(fine.limactlCalls).toEqual([]);
  });

  test("the watch fails closed: a probe that errors or prints nothing deletes the instance", () => {
    for (const [lsof, df, reason] of [
      ["exit 1", "normal", /a probe failed \(lsof printed nothing readable\)/],
      [
        "echo garbage; exit 0",
        "normal",
        /a probe failed \(lsof printed nothing readable\)/,
      ],
      ["normal", "exit 1", /a probe failed \(df printed nothing readable\)/],
      ["normal", "low", /only 3 GiB free \(the floor is 8 GiB\)/],
    ] as const) {
      const outcome = runWatch({
        tcp: "",
        udp: "",
        lsofScript: lsof,
        dfScript: df,
      });
      expect(outcome.tripped).toMatch(reason);
      expect(outcome.limactlCalls).toEqual([
        "stop --force p2party-rehearsal",
        "delete --force p2party-rehearsal",
      ]);
    }
  });

  test("the sanitizer replaces every generated value in every encoding, the host's names and private keys", () => {
    const secret = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const password = "pa ss/wo+rd=&?";
    const list = replacements(
      [
        `secret ${secret}`,
        `secret ${password}`,
        "path /Users/someone ~",
        "path /private/tmp/work-p2party-dir <work>",
        "path someone <user>",
        "path somehost.local <host>",
      ].join("\n"),
    );
    const bytes = (value: string) => Buffer.from(value, "utf8");
    const forms = (value: string) => [
      value,
      bytes(value).toString("base64"),
      bytes(value).toString("base64").replace(/=+$/, ""),
      bytes(value).toString("base64url"),
      bytes(value).toString("hex"),
      bytes(value).toString("hex").toUpperCase(),
      encodeURIComponent(value),
      [...bytes(value)]
        .map((b) => `%${b.toString(16).padStart(2, "0").toUpperCase()}`)
        .join(""),
    ];
    const raw = [
      ...forms(secret).map((form) => `line with ${form} inside`),
      ...forms(password).map((form) => `url postgresql://u:${form}@h/db`),
      "home /Users/someone/x and user someone on somehost.local",
      "masked /private/tmp/work-$REDACTED$-dir/logs and /private/tmp/work-p2party-dir/raw",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----\nMHcC\n-----END EC PRIVATE KEY-----",
      "\u001b[31mred\u001b[0m",
    ].join("\n");
    const out = sanitize(raw, list);
    for (const form of [...forms(secret), ...forms(password)]) {
      expect(out.includes(form) ? `left: ${form}` : "gone").toBe("gone");
    }
    for (const left of [
      "someone",
      "somehost",
      "/private/tmp/work",
      "PRIVATE KEY",
      "MIIE",
      "\u001b[",
    ]) {
      expect(out.includes(left) ? `left: ${left}` : "gone").toBe("gone");
    }
    expect(out).toContain("home ~/x and user <user> on <host>");
    expect(out).toContain("masked <work>/logs and <work>/raw");
    expect(out.match(/<private key redacted>/g)).toHaveLength(3);
    expect(() => replacements("secret short")).toThrow();
  });

  test.skipIf(!(process.platform === "darwin" && process.arch === "arm64"))(
    "an interrupted run leaves no process of its own and says what it left on disk",
    async () => {
      const sandbox = mkdtempSync(join(tmpdir(), "p2party-rehearsal-test-"));
      try {
        const { repo, copy, runSh: script } = rehearsalRepository(sandbox);
        const tools = fakeTools(sandbox);
        const { stub, calls } = writeLimactlStub(sandbox);
        // limactl is simulated; an actual rehearsal may own both SSH and
        // HTTPS ports and the stub creates no VM disk. Model its host probes.
        const probes = join(sandbox, "probe-bin");
        mkdirSync(probes);
        writeFileSync(
          join(probes, "lsof"),
          '#!/bin/sh\ncase "$*" in *-iTCP:*) exit 1 ;; esac\necho "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME"\n',
          { mode: 0o755 },
        );
        writeFileSync(
          join(probes, "df"),
          '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/disk 104857600 1 52428800 50% /"\n',
          { mode: 0o755 },
        );
        const sleep = join(sandbox, "stub-sleep");
        symlinkSync("/bin/sleep", sleep);
        const child = Bun.spawn({
          cmd: [
            "bash",
            script,
            "--inventory",
            join(copy, "inventory.yml"),
            "vm-check",
          ],
          cwd: sandbox,
          env: {
            PATH: `${probes}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
            HOME: sandbox,
            TMPDIR: tmpdir(),
            LIMACTL: stub,
            LIMA_HOME: join(sandbox, "lima"),
            REHEARSAL_REPO: repo,
            REHEARSAL_TOOLS: tools,
            REHEARSAL_WORK_DIR: join(sandbox, "work"),
            STUB_START_SECONDS: "60",
            STUB_SLEEP_BIN: sleep,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const deadline = Date.now() + 60_000;
        while (
          !existsSync(join(sandbox, "start-called")) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(200);
        }
        expect(existsSync(join(sandbox, "start-called"))).toBe(true);
        child.kill("SIGINT");
        const exitCode = await child.exited;
        const stderr = await new Response(child.stderr).text();
        expect(exitCode).toBe(130);
        expect(stderr).toMatch(/run\.sh: left on disk:/);
        await Bun.sleep(500);
        expect(processesUnder(sandbox)).toEqual([]);
        expect(readFileSync(calls, "utf8")).toMatch(
          /^delete --force p2party-rehearsal$/m,
        );
        expect(existsSync(join(sandbox, "work", "secrets"))).toBe(false);
      } finally {
        for (const line of processesUnder(sandbox)) {
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (pid > 0) process.kill(pid, "SIGKILL");
        }
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
    RUN_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Fixtures for the guard, the watch and the interrupt test
// ---------------------------------------------------------------------------

/** What Ansible's ssh plugin passes for one command, port 56022. */
const guardOk = [
  "-F",
  "/dev/null",
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPersist=60s",
  "-o",
  "ForwardAgent=no",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
  "-o",
  "NumberOfPasswordPrompts=1",
  "-o",
  "UserKnownHostsFile=/w/secrets/known_hosts",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "Port=56022",
  "-o",
  'IdentityFile="/w/secrets/id_ed25519"',
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "PreferredAuthentications=gssapi-with-mic,gssapi-keyex,hostbased,publickey",
  "-o",
  "PasswordAuthentication=no",
  "-o",
  'User="p2party"',
  "-o",
  "ConnectTimeout=30",
  "-o",
  'ControlPath="/cp/abc"',
  "127.0.0.1",
  "/bin/sh -c 'echo ~p2party && sleep 0'",
];

/** ssh-guard.sh as ssh, scp and sftp, with stub real programs that record calls. */
function guardIn(sandbox: string) {
  const bin = join(sandbox, "guard-bin");
  const real = join(sandbox, "real-bin");
  const calls = join(sandbox, "real-calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(real, { recursive: true });
  for (const tool of ["ssh", "scp", "sftp"]) {
    symlinkSync(join(rehearsal, "ssh-guard.sh"), join(bin, tool));
    writeFileSync(
      join(real, tool),
      `#!/bin/sh\necho "${tool} $*" >> '${calls}'\n`,
      { mode: 0o755 },
    );
  }
  return {
    run: (tool: string, args: string[]) => {
      const result = Bun.spawnSync({
        cmd: [join(bin, tool), ...args],
        env: {
          PATH: "/usr/bin:/bin",
          REHEARSAL_GUARD_PORT: "56022",
          REHEARSAL_GUARD_REAL_DIR: real,
          REHEARSAL_GUARD_LOG: join(sandbox, "guard.log"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { exitCode: result.exitCode, stderr: result.stderr.toString() };
    },
    realCalls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""),
    clearCalls: () => rmSync(calls, { force: true }),
  };
}

/**
 * One pass of watch.sh with stub lsof, df, sleep and limactl: `normal` lsof
 * prints a header and the given lines, `normal` df 50 GiB free, `low` 3 GiB;
 * the stub sleep ends the loop after its first heartbeat.
 */
function runWatch(options: {
  tcp: string;
  udp: string;
  lsofScript?: string;
  dfScript?: string;
}) {
  return withSandbox((sandbox) => {
    const bin = join(sandbox, "bin");
    const work = join(sandbox, "work");
    mkdirSync(bin);
    mkdirSync(work);
    const header = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME";
    writeFileSync(
      join(sandbox, "tcp"),
      `${header}\npostgres 1 u 1u IPv4 0x1 0t0 TCP 127.0.0.1:5432 (LISTEN)\n${options.tcp}\n`,
    );
    writeFileSync(
      join(sandbox, "udp"),
      `${header}\nmDNSRespo 1 u 1u IPv4 0x1 0t0 UDP *:5353\n${options.udp}\n`,
    );
    const lsof =
      options.lsofScript === undefined || options.lsofScript === "normal"
        ? `case "$*" in *TCP*) cat '${sandbox}/tcp' ;; *) cat '${sandbox}/udp' ;; esac`
        : options.lsofScript;
    const df =
      options.dfScript === undefined || options.dfScript === "normal"
        ? "printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/disk 100 1 52428800 1%% /\\n'"
        : options.dfScript === "low"
          ? "printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/disk 100 1 3145728 1%% /\\n'"
          : options.dfScript;
    writeFileSync(join(bin, "lsof"), `#!/bin/sh\n${lsof}\n`, { mode: 0o755 });
    writeFileSync(join(bin, "df"), `#!/bin/sh\n${df}\n`, { mode: 0o755 });
    writeFileSync(join(bin, "sleep"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    const calls = join(sandbox, "calls");
    writeFileSync(
      join(bin, "limactl"),
      `#!/bin/sh\necho "$*" >> '${calls}'\n`,
      { mode: 0o755 },
    );
    // The stub sleep returns at once, so a watch that never trips would loop
    // forever; the timeout ends it after its first heartbeats.
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        join(rehearsal, "watch.sh"),
        work,
        join(bin, "limactl"),
        "p2party-rehearsal",
        "10",
        "8",
      ],
      env: { PATH: `${bin}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 1_000,
    });
    const read = (path: string) =>
      existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    return {
      exitCode: result.exitCode,
      tripped: read(join(work, "watch-tripped")),
      heartbeat: read(join(work, "watch-heartbeat")),
      limactlCalls: read(calls).split("\n").filter(Boolean),
    };
  });
}

/** A tool directory with an ansible-core 2.22 stand-in, for the interrupt test. */
function fakeTools(sandbox: string) {
  const tools = join(sandbox, "tools");
  const venv = join(tools, "venv", "bin");
  mkdirSync(venv, { recursive: true });
  writeFileSync(
    join(venv, "ansible-playbook"),
    "#!/bin/sh\necho 'ansible-playbook [core 2.22.0]'\n",
    { mode: 0o755 },
  );
  writeFileSync(join(venv, "python"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(venv, "ansible-vault"),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --output ] && { echo stand-in > "$2"; }; shift; done\n',
    { mode: 0o755 },
  );
  return tools;
}

/** Match only processes that belong to this fixture, including its sleep executable. */
function processesUnder(sandbox: string): string[] {
  const listing = Bun.spawnSync({
    cmd: ["ps", "-axo", "pid=,command="],
  }).stdout.toString();
  return listing
    .split("\n")
    .filter(
      (line) => line.includes(sandbox + "/") && !line.includes("ps -axo"),
    );
}
