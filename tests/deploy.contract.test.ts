import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const deploy = readFileSync(
  join(repoRoot, "deploy", "ansible", "playbooks", "deploy.yml"),
  "utf8",
);
const initialSetup = readFileSync(
  join(repoRoot, "deploy", "ansible", "playbooks", "initial-setup.yml"),
  "utf8",
);
const productionVars = readFileSync(
  join(repoRoot, "deploy", "ansible", "group_vars", "production", "vars.yml"),
  "utf8",
);
const signalingCloudInit = readFileSync(
  join(
    repoRoot,
    "deploy",
    "terraform",
    "templates",
    "signaling_cloud_init.yaml.tpl",
  ),
  "utf8",
);
const setupCoturn = readFileSync(
  join(repoRoot, "deploy", "ansible", "playbooks", "setup-coturn.yml"),
  "utf8",
);
const turnserverConfig = readFileSync(
  join(repoRoot, "deploy", "ansible", "templates", "turnserver.conf.j2"),
  "utf8",
);
const prismaConfig = readFileSync(join(repoRoot, "prisma.config.ts"), "utf8");
const postgresTls = readFileSync(
  join(repoRoot, "deploy/ansible/playbooks/postgres-tls.yml"),
  "utf8",
);
const installPostgres = readFileSync(
  join(repoRoot, "deploy/ansible/playbooks/install-postgres.yml"),
  "utf8",
);
const signalingEnvironment = readFileSync(
  join(repoRoot, "deploy/ansible/templates/signaling.env.j2"),
  "utf8",
);
const caddyfile = readFileSync(
  join(repoRoot, "deploy/ansible/templates/Caddyfile.j2"),
  "utf8",
);
const journaldRetention = () =>
  readFileSync(
    join(repoRoot, "deploy/ansible/templates/journald-retention.conf.j2"),
    "utf8",
  );

interface PlaybookTask {
  name: string;
  import_tasks?: string;
  environment?: unknown;
  become_user?: string;
  failed_when?: unknown;
  block?: PlaybookTask[];
  rescue?: PlaybookTask[];
  always?: PlaybookTask[];
  file?: Record<string, unknown>;
  command?: { argv?: string[] };
  slurp?: Record<string, unknown>;
  loop?: string[];
  vars?: Record<string, string>;
  template?: Record<string, unknown>;
  copy?: Record<string, unknown>;
  assert?: unknown;
  notify?: string;
  diff?: boolean;
  no_log?: boolean;
  systemd?: Record<string, unknown>;
  find?: { patterns?: string[] };
  fail?: { msg?: string };
  shell?: string;
  meta?: string;
  service?: Record<string, unknown>;
  stat?: Record<string, unknown>;
  when?: unknown;
}
interface Play {
  any_errors_fatal?: boolean;
  vars?: Record<string, string>;
  tasks: PlaybookTask[];
  handlers?: PlaybookTask[];
}

/** Tasks in execution order, with block, rescue and always sections expanded. */
const flatten = (tasks: PlaybookTask[]): PlaybookTask[] =>
  tasks.flatMap((t) => [
    t,
    ...flatten(t.block ?? []),
    ...flatten(t.rescue ?? []),
    ...flatten(t.always ?? []),
  ]);

/** The play of a playbook that contains the task named `name`. */
const playWithTask = (playbook: string, name: string): Play => {
  const plays = Bun.YAML.parse(playbook) as Partial<Play>[];
  const play = plays.find((p) =>
    flatten(p.tasks ?? []).some((t) => t.name === name),
  );
  if (!play) throw new Error(`no play has a task named ${name}`);
  return play as Play;
};

const task = (play: Play, name: string): PlaybookTask => {
  const found = flatten(play.tasks).find((t) => t.name === name);
  if (!found) throw new Error(`no task named ${name}`);
  return found;
};

/** Index of the task named `name` in execution order. */
const position = (play: Play, name: string): number => {
  const index = flatten(play.tasks).findIndex((t) => t.name === name);
  if (index < 0) throw new Error(`no task named ${name}`);
  return index;
};

/** The Jinja default of a `name={{ var | default(N) }}` coturn line. */
const coturnDefault = (name: string): number => {
  const match = new RegExp(
    `^${name}=\\{\\{ coturn_\\w+ \\| default\\(([0-9]+)\\) \\}\\}$`,
    "m",
  ).exec(turnserverConfig);
  if (!match) throw new Error(`no default for ${name}`);
  return Number(match[1]);
};

describe("production deployment contract", () => {
  test("the deploy playbook stops every worker before it migrates and installs the binary only after", () => {
    const play = playWithTask(deploy, "Apply migrations against Postgres");
    const tasks = flatten(play.tasks);
    const at = (name: string) => position(play, name);
    const prepare = "Prepare the release without touching the running workers";
    const discover = "Discover the signaling units to stop before migrating";
    const stop = "Stop and disable every signaling worker before migrating";
    const mark = "Mark that the binary on disk may not match the schema";
    const migrate = "Apply migrations against Postgres";
    const unmark = "Remove the marker now that the binary matches the schema";

    // With several hosts, a host whose stop fails ends the play everywhere:
    // the migration may not run while any worker anywhere serves.
    expect(play.any_errors_fatal).toBe(true);

    // Everything that can fail without touching the database happens in the
    // preparation block, before any worker is stopped, and stages the new
    // files away from the paths the running workers read.
    const preparation = task(play, prepare);
    const prepared = flatten(preparation.block ?? []).map(({ name }) => name);
    for (const name of [
      "Install exactly the audited migration dependencies",
      "Copy the migrations",
      "Copy the Prisma config",
      "Stage the compiled binary",
      "Stage the signaling environment file",
      "Stage the systemd unit files",
      "Validate the candidate Caddy configuration",
    ])
      expect(prepared, name).toContain(name);
    expect(at(prepare)).toBeLessThan(at(discover));
    const preparedFailure = preparation.rescue?.find(
      ({ name }) => name === "Report that preparing the release failed",
    )?.fail?.msg;
    expect(preparedFailure).toContain(
      "Production is still running the previous release, untouched.",
    );
    expect(preparedFailure).toContain("an earlier deploy had already stopped");

    // Every installed unit, the legacy cloud-init name included, is stopped
    // and disabled: Restart=always does not restart a stopped unit and a
    // disabled one does not start at boot.
    expect(task(play, discover).find?.patterns).toEqual([
      "p2party-signaling.service",
      "p2party-signaling-*.service",
    ]);
    expect(task(play, stop).systemd).toEqual({
      name: "{{ item | basename }}",
      state: "stopped",
      enabled: false,
    });
    expect(String(task(play, stop).loop)).toContain(
      "signaling_units_before_migration.files",
    );

    // Stop, mark, migrate, install, unmark, start.
    expect(at(discover)).toBeLessThan(at(stop));
    expect(at(stop)).toBeLessThan(at(mark));
    expect(at(mark)).toBeLessThan(at(migrate));
    for (const install of [
      "Install the staged binary",
      "Install the staged signaling environment file",
      "Install the staged systemd unit files",
    ]) {
      expect(at(migrate), install).toBeLessThan(at(install));
      expect(at(install), install).toBeLessThan(at(unmark));
    }
    expect(at(unmark)).toBeLessThan(at("Restart signaling services"));
    // The migration block holds only the migration: its rescue speaks for it.
    expect(
      (task(play, "Apply Postgres migrations").block ?? []).map(
        ({ name }) => name,
      ),
    ).toEqual([migrate]);

    // Before the migration nothing writes the live binary, environment or
    // units, and nothing but the stop acts on a signaling service, by any
    // module: systemd, service, a command or shell naming systemctl, or a
    // handler flush.
    const live = [
      "{{ app.home }}/server/p2party-server",
      "{{ app.home }}/server/.env",
    ];
    for (const earlier of tasks.slice(0, at(migrate))) {
      for (const dest of [earlier.copy?.dest, earlier.template?.dest]) {
        if (dest === undefined) continue;
        expect(live, earlier.name).not.toContain(String(dest));
        expect(String(dest), earlier.name).not.toContain(
          "/etc/systemd/system/",
        );
      }
      expect(earlier.meta, earlier.name).toBeUndefined();
      expect(earlier.service, earlier.name).toBeUndefined();
      const command = [
        ...(earlier.command?.argv ?? []),
        typeof earlier.command === "string" ? earlier.command : "",
        earlier.shell ?? "",
      ].join(" ");
      expect(command, earlier.name).not.toMatch(/systemctl|service\s/);
      if (earlier.systemd && earlier.name !== stop)
        expect(String(earlier.systemd.name ?? ""), earlier.name).not.toContain(
          "p2party-signaling",
        );
    }

    // A failed migration ends the play with the recovery, the service stopped,
    // the previous binary in place, Prisma's output in a root-only file and
    // the recovery recorded in the marker.
    const failed = task(play, "Apply Postgres migrations").rescue ?? [];
    const failedNames = failed.map(({ name }) => name);
    expect(failedNames).toEqual([
      "Write the failed migration's output for the operator",
      "Record in the marker that the migration failed",
      "Report the failed migration and how to recover",
    ]);
    expect(failed[0]!.copy).toMatchObject({
      dest: "{{ migration_log }}",
      owner: "root",
      group: "root",
      mode: "0600",
    });
    expect(failed[0]!.no_log).toBe(true);
    expect(String(failed[0]!.copy?.content)).toContain(
      "replace(database.password",
    );
    expect(failed[1]!.copy).toMatchObject({
      dest: "{{ migration_failure_marker }}",
      content: "{{ migration_recovery }}",
      mode: "0600",
    });
    expect(failed[2]!.fail?.msg).toBe("{{ migration_recovery }}");
    expect(task(play, migrate).no_log).toBe(true);
    const recovery = play.vars?.migration_recovery ?? "";
    for (const stated of [
      "previous binary is still in\nplace",
      "{{ migration_log }} (root only)",
      "migrate resolve --rolled-back <migration name>",
      "do not run initial-setup.yml",
      "is not supported",
    ])
      expect(recovery, stated).toContain(stated);
    expect(play.vars?.migration_log).toBe(
      "/var/log/p2party-migration-failure.log",
    );

    // Only after the binary is in place are the units enabled and started.
    expect(task(play, "Restart signaling services").systemd).toMatchObject({
      state: "restarted",
      enabled: true,
    });
  });

  test("initial-setup refuses to start signaling services while a deploy is unfinished", () => {
    const deployPlay = playWithTask(
      deploy,
      "Apply migrations against Postgres",
    );
    const setupPlay = playWithTask(initialSetup, "Enable signaling services");
    expect(setupPlay.vars?.migration_failure_marker).toBe(
      deployPlay.vars?.migration_failure_marker,
    );
    const check = task(
      setupPlay,
      "Check for a deploy that left the binary and schema out of step",
    );
    expect(check.stat).toEqual({ path: "{{ migration_failure_marker }}" });
    const refuse = task(
      setupPlay,
      "Refuse to start signaling services after an interrupted deploy",
    );
    expect(refuse.when).toBe("migration_failure_marker_file.stat.exists");
    expect(refuse.fail?.msg).toContain(
      "{{ migration_failure_marker_text.content | b64decode }}",
    );
    const refusal = position(
      setupPlay,
      "Refuse to start signaling services after an interrupted deploy",
    );
    // Before anything enables, starts or restarts a signaling unit.
    for (const [index, later] of flatten(setupPlay.tasks).entries())
      if (
        later.systemd &&
        String(later.systemd.name ?? "").includes("p2party-signaling")
      )
        expect(index, later.name).toBeGreaterThan(refusal);
  });

  test("every provisioning path installs verified PostgreSQL TLS ahead of client cutover", () => {
    expect(productionVars).toContain("ssl_mode: verify-full");
    expect(signalingEnvironment).toContain(
      "sslrootcert={{ database.ssl_root_cert }}",
    );
    expect(signalingEnvironment).toContain("TRUST_LOCAL_PROXY=true");
    for (const play of [deploy, initialSetup, installPostgres])
      expect(play).toContain("import_playbook: postgres-tls.yml");
    expect(postgresTls).toContain("subjectAltName=IP:{{ network.postgres }}");
    expect(postgresTls).toContain("insertbefore: BOF");
    expect(postgresTls).toContain(
      "hostnossl all all {{ network.range }} reject",
    );
    expect(postgresTls).toContain(
      "hostssl all all {{ network.range }} scram-sha-256",
    );
    expect(installPostgres).not.toMatch(/^\s+host\s+all\s+all\s+10\.42/m);
    expect(postgresTls).toContain("-verify_ip");
    expect(postgresTls).toContain('src: "{{ database_tls_dir }}/ca.crt"');
    expect(postgresTls).not.toContain('src: "{{ database_tls_dir }}/ca.key"');
  });
  test("single-worker production is explicit and multi-worker is opt-in", () => {
    expect(productionVars).toContain("signaling_ports: [3001]");
    expect(deploy).toContain("| default([app_port])");
    expect(initialSetup).toContain("signaling_ports | default([app_port])");
    expect(deploy).not.toContain("processor_vcpus");
    expect(initialSetup).not.toContain("processor_vcpus");
  });

  test("Caddy narrows routing before restart and obsolete units retire after direct health", () => {
    const render = deploy.indexOf(
      "- name: Render the candidate Caddy configuration",
    );
    const validate = deploy.indexOf(
      "- name: Validate the candidate Caddy configuration",
    );
    const install = deploy.indexOf(
      "- name: Atomically install the validated Caddy configuration",
    );
    const reload = deploy.indexOf(
      "- name: Reload Caddy onto the desired signaling ports",
    );
    const restart = deploy.indexOf("- name: Restart signaling services");
    const directHealth = deploy.indexOf(
      "- name: Verify every signaling instance reports the expected build",
    );
    const retire = deploy.indexOf(
      "- name: Stop and disable obsolete signaling services",
    );
    const remove = deploy.indexOf(
      "- name: Remove obsolete signaling unit files",
    );
    const daemonReload = deploy.indexOf(
      "- name: Reload systemd after retiring obsolete signaling services",
    );
    const publicHealth = deploy.indexOf(
      "- name: Verify Caddy exposes only the expected signaling build",
    );

    expect(render).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(render);
    expect(install).toBeGreaterThan(validate);
    expect(reload).toBeGreaterThan(install);
    expect(restart).toBeGreaterThan(reload);
    expect(directHealth).toBeGreaterThan(restart);
    expect(retire).toBeGreaterThan(directHealth);
    expect(remove).toBeGreaterThan(retire);
    expect(daemonReload).toBeGreaterThan(remove);
    expect(publicHealth).toBeGreaterThan(daemonReload);
    expect(
      deploy.slice(
        restart,
        deploy.indexOf("- name: Wait for signaling services to be healthy"),
      ),
    ).toContain("enabled: true");
  });

  test("public health is bound to a directly verified desired worker", () => {
    expect(deploy).toContain(
      "public_signaling_health.json.serverId in signaling_server_ids",
    );
    expect(deploy).toContain("use_proxy: false");
    expect(deploy).toContain("validate_certs: true");
  });

  test("the legacy unnumbered cloud-init service is retired and never recreated", () => {
    const discovery = deploy.slice(
      deploy.indexOf("- name: Discover installed signaling unit files"),
      deploy.indexOf("- name: Resolve obsolete signaling unit files"),
    );

    expect(discovery).toContain('"p2party-signaling.service"');
    expect(discovery).toContain('"p2party-signaling-*.service"');
    expect(signalingCloudInit).not.toContain(
      "/etc/systemd/system/p2party-signaling.service",
    );
    expect(signalingCloudInit).not.toContain(
      "systemctl enable p2party-signaling",
    );
  });

  test("secret-bearing environment renders suppress diffs", () => {
    const deployEnvironment = deploy.slice(
      deploy.indexOf("- name: Stage the signaling environment file"),
      deploy.indexOf("- name: Stage the systemd unit files"),
    );
    const deployInstall = deploy.slice(
      deploy.indexOf("- name: Install the staged signaling environment file"),
      deploy.indexOf("- name: Install the staged systemd unit files"),
    );
    expect(deployInstall).toContain("diff: false");
    const setupEnvironment = initialSetup.slice(
      initialSetup.indexOf("- name: Deploy .env file"),
      initialSetup.indexOf(
        "# Dependencies, Prisma client, and migrations handled by deploy.yml",
      ),
    );

    expect(deployEnvironment).toContain("diff: false");
    expect(setupEnvironment).toContain("diff: false");
  });

  test("directly addressed dual-stack coturn does not apply a NAT mapping", () => {
    expect(turnserverConfig).not.toMatch(/^external-ip=/m);
    expect(turnserverConfig).not.toMatch(/^listening-ip=/m);
    expect(turnserverConfig).not.toMatch(/^relay-ip=/m);
    expect(setupCoturn).not.toContain("coturn_external_ipv4");
    expect(setupCoturn).not.toContain("coturn_external_ipv6");
    expect(setupCoturn).not.toContain("ifconfig.me");
  });

  test("TURN has a finite operator-overridable aggregate bandwidth budget", () => {
    expect(turnserverConfig).toContain(
      "bps-capacity={{ coturn_bps_capacity | default(30000000) }}",
    );
    expect(turnserverConfig).toContain(
      "max-bps={{ coturn_max_bps | default(625000) }}",
    );
    expect(setupCoturn).toContain("Require finite TURN bandwidth budgets");
    expect(setupCoturn).toContain("zero disables the bandwidth guard");
  });

  test("every relay passage states the bound coturn enforces, not a per-identity one", () => {
    // The five passages that describe the TURN quota, as prose: comment
    // markers and line breaks removed.
    const prose = (path: string) =>
      readFileSync(join(repoRoot, path), "utf8")
        .split("\n")
        .map((line) => line.replace(/^\s*(?:#|\/\/|\/?\*+\/?)\s?/, ""))
        .join(" ")
        .replace(/\s+/g, " ");
    for (const path of [
      "deploy/ansible/templates/turnserver.conf.j2",
      "deploy/ansible/playbooks/setup-coturn.yml",
      "README.md",
      "deploy/README.md",
      "src/utils/socketAuth.ts",
    ]) {
      const text = prose(path);
      // The withdrawn claim: one identity limited to half the relay through
      // at most two valid usernames, enforced with a fixed 4x multiplier.
      for (const withdrawn of [
        /at most two valid usernames/i,
        /at most two are valid/i,
        /one identity can reserve at most/i,
        /half the capacity; the playbook refuses/i,
        /2 × 12 × 625,000/,
        /per-identity bound:/i,
        /quota therefore applies per identity(?! per hour)/i,
        /4 \* \(coturn_user_quota/,
      ])
        expect(text, `${path}: ${String(withdrawn)}`).not.toMatch(withdrawn);
      // What holds, with its source.
      for (const stated of [
        /first request/i,
        /three tags/i,
        /one more tag/i,
        /runaway use/i,
        /several identities/i,
        /check_stun_auth/,
        /4\.6\.1/,
      ])
        expect(text, `${path}: ${String(stated)}`).toMatch(stated);
    }
  });

  test("max-allocate-lifetime is set", () => {
    // coturn's default is 3600 s; an allocation that is not refreshed holds
    // its bandwidth reservation at most this long after its last request.
    expect(turnserverConfig).toContain(
      "max-allocate-lifetime={{ coturn_max_allocate_lifetime | default(600) }}",
    );
    const lifetime = coturnDefault("max-allocate-lifetime");
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(3600);
    const budgets = task(
      playWithTask(setupCoturn, "Require finite TURN bandwidth budgets"),
      "Require finite TURN bandwidth budgets",
    ).assert as { that: string[] };
    expect(budgets.that).toContain(
      "coturn_max_allocate_lifetime | default(600) | int > 0",
    );
    expect(budgets.that).toContain(
      "coturn_max_allocate_lifetime | default(600) | int <= 3600",
    );
  });

  test("the relay bound asserted by the playbook is computed from the template values", () => {
    const budgets = (
      task(
        playWithTask(setupCoturn, "Require finite TURN bandwidth budgets"),
        "Require finite TURN bandwidth budgets",
      ).assert as { that: string[] }
    ).that;
    const bound = budgets.filter((check) => check.includes("*"));
    expect(bound).toHaveLength(1);
    // Every Jinja expression in the bound is a template variable with the
    // template's own default.
    const used = [
      ...bound[0]!.matchAll(/(coturn_\w+) \| default\(([0-9]+)\) \| int/g),
    ].map(([, name, fallback]) => [name!, Number(fallback)] as const);
    const fromTemplate = new Map(
      [
        ...turnserverConfig.matchAll(
          /^[a-z-]+=\{\{ (coturn_\w+) \| default\(([0-9]+)\) \}\}$/gm,
        ),
      ].map(([, name, fallback]) => [name!, Number(fallback)]),
    );
    expect(used.map(([name]) => name).sort()).toEqual([
      "coturn_bps_capacity",
      "coturn_max_bps",
      "coturn_user_quota",
    ]);
    // No fixed multiplier for an assumed number of usernames per identity:
    // the only constant outside the defaults is the 2 that means "half".
    expect(
      bound[0]!.replace(/default\([0-9]+\)/g, "").match(/[0-9]+/g),
    ).toEqual(["2"]);
    for (const [name, fallback] of used)
      expect(fromTemplate.get(name)).toBe(fallback);

    // Evaluate the expression the way Jinja does, for the defaults and for an
    // override that breaks it: one username's user-quota * max-bps reservation
    // must stay within half the aggregate capacity.
    const evaluate = (values: Record<string, number>) => {
      const arithmetic = bound[0]!
        .replace(
          /\(?(coturn_\w+) \| default\([0-9]+\) \| int\)?/g,
          (_, name: string) =>
            `(${String(values[name] ?? fromTemplate.get(name))})`,
        )
        .trim();
      expect(arithmetic).toMatch(/^[0-9\s*()<=]+$/);
      return Function(`return ${arithmetic};`)() as boolean;
    };
    expect(evaluate({})).toBe(true);
    expect(
      2 * coturnDefault("user-quota") * coturnDefault("max-bps"),
    ).toBeLessThanOrEqual(coturnDefault("bps-capacity"));
    expect(evaluate({ coturn_max_bps: 3_000_000 })).toBe(false);
    expect(evaluate({ coturn_user_quota: 25 })).toBe(false);
    expect(
      evaluate({ coturn_max_bps: 1_250_000, coturn_bps_capacity: 30_000_000 }),
    ).toBe(true);
  });

  test("coturn keeps no log file of usernames and client addresses", () => {
    expect(turnserverConfig).toMatch(/^log-file=\/dev\/null$/m);
    expect(turnserverConfig).toMatch(/^no-stdout-log$/m);
    expect(turnserverConfig).toMatch(/^simple-log$/m);
    for (const option of ["syslog", "verbose", "Verbose", "log-binding"])
      expect(turnserverConfig).not.toMatch(new RegExp(`^${option}$`, "m"));
    expect(turnserverConfig).not.toContain("/var/log/turnserver");
    // Hosts provisioned before keep their rotated files until removed.
    const removal = setupCoturn.slice(
      setupCoturn.indexOf(
        "- name: Remove the coturn file log and its rotation",
      ),
    );
    expect(removal).toContain("/var/log/turnserver");
    expect(removal).toContain("/etc/logrotate.d/coturn");
    expect(removal).toContain("state: absent");
    expect(setupCoturn).not.toContain("rotate 14");
  });

  test("Caddy's default logger records no request URI, headers or raw client IP", () => {
    // Upstream failures are logged by Caddy's default logger, not the site's
    // access log, with the request including the ?publickey= query.
    const globalBlock = caddyfile.slice(
      caddyfile.indexOf("\n{\n"),
      caddyfile.indexOf("{{ domains.signaling }} {"),
    );
    expect(globalBlock).toContain("log default {");
    for (const filter of [
      "request>uri delete",
      "request>headers delete",
      "request>client_ip delete",
      "request>remote_ip ip_mask {",
    ])
      expect(globalBlock).toContain(filter);
  });

  test("journald keeps at most seven days on the signaling host", () => {
    expect(journaldRetention()).toMatch(/^\[Journal\]$/m);
    expect(journaldRetention()).toMatch(/^MaxRetentionSec=7day$/m);
    // journald vacuums archived files only; the active file is archived at
    // least daily, so an entry is gone within about eight days.
    expect(journaldRetention()).toMatch(/^MaxFileSec=1day$/m);
    // Both paths that provision the signaling host install it and restart
    // journald, which reads its configuration only at start.
    for (const [name, source] of [
      ["deploy.yml", deploy],
      ["initial-setup.yml", initialSetup],
    ] as const) {
      const play = playWithTask(
        source,
        "Keep the journal for at most seven days",
      );
      const install = task(play, "Keep the journal for at most seven days");
      expect(install.template, name).toEqual({
        src: "{{ playbook_dir }}/../templates/journald-retention.conf.j2",
        dest: "/etc/systemd/journald.conf.d/p2party-retention.conf",
        owner: "root",
        group: "root",
        mode: "0644",
      });
      expect(install.notify, name).toBe("Restart journald");
      const handler = (play.handlers ?? []).find(
        (h) => h.name === "Restart journald",
      );
      expect(handler?.systemd, name).toEqual({
        name: "systemd-journald",
        state: "restarted",
      });
      const directory = task(
        play,
        "Ensure the journald drop-in directory exists",
      );
      expect(flatten(play.tasks).indexOf(directory), name).toBeGreaterThan(-1);
      expect(flatten(play.tasks).indexOf(directory), name).toBeLessThan(
        flatten(play.tasks).indexOf(install),
      );
    }
  });

  test("a Caddyfile that fails validation never replaces the running one", () => {
    // deploy.yml renders a candidate, validates it, then moves it into place
    // (ordering pinned above); initial-setup.yml validates in the template task.
    const play = playWithTask(initialSetup, "Deploy Caddyfile");
    expect(task(play, "Deploy Caddyfile").template?.validate).toBe(
      "caddy validate --config %s --adapter caddyfile",
    );
    expect(deploy).toContain("- /etc/caddy/Caddyfile.p2party-candidate");
  });

  test("a coturn configuration that fails validation never replaces the running one", () => {
    const play = playWithTask(
      setupCoturn,
      "Validate the candidate coturn configuration",
    );
    const order = [
      "Read the effective coturn unit",
      "Read /etc/default/coturn",
      "Refuse coturn command-line flags that override turnserver.conf",
      "Render the candidate coturn configuration",
      "Read the candidate coturn configuration",
      "Validate the candidate coturn configuration",
      "Install the validated coturn configuration",
      "Remove the coturn configuration candidate",
    ].map((name) => position(play, name));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Only the install step writes the live file, and only it restarts coturn.
    const writers = flatten(play.tasks).filter(
      (t) =>
        t.template?.dest === "/etc/turnserver.conf" ||
        t.copy?.dest === "/etc/turnserver.conf",
    );
    expect(writers.map((t) => t.name)).toEqual([
      "Install the validated coturn configuration",
    ]);
    expect(writers[0]!.notify).toBe("Restart Coturn");
    // The candidate holds the TURN secret: no diff, no logged contents.
    expect(task(play, "Render the candidate coturn configuration").diff).toBe(
      false,
    );
    expect(writers[0]!.diff).toBe(false);
    expect(task(play, "Read the candidate coturn configuration").no_log).toBe(
      true,
    );
    const checks = (
      task(play, "Validate the candidate coturn configuration").assert as {
        that: string[];
      }
    ).that.join("\n");
    for (const required of [
      "[{][{]|[{]%",
      "^static-auth-secret=\\S{32,}$",
      "^log-file=/dev/null$",
      "^user-quota=[1-9][0-9]*$",
      "^max-bps=[1-9][0-9]*$",
      "^bps-capacity=[1-9][0-9]*$",
      "^max-allocate-lifetime=[1-9][0-9]*$",
    ])
      expect(checks).toContain(required);
    // The candidate holds the TURN secret: it is removed whatever happens.
    const flow = task(play, "Validate and install the coturn configuration");
    expect(flow.block?.map((t) => t.name)).toContain(
      "Validate the candidate coturn configuration",
    );
    expect(flow.always?.map((t) => t.name)).toEqual([
      "Remove the coturn configuration candidate",
    ]);
    expect(flow.always?.[0]?.file).toEqual({
      path: "/etc/turnserver.conf.p2party-candidate",
      state: "absent",
    });
  });

  test("a coturn unit or default that overrides the logging is refused", () => {
    const play = playWithTask(
      setupCoturn,
      "Refuse coturn command-line flags that override turnserver.conf",
    );
    expect(task(play, "Read the effective coturn unit").command?.argv).toEqual([
      "systemctl",
      "cat",
      "coturn",
    ]);
    expect(task(play, "Read /etc/default/coturn").slurp).toEqual({
      src: "/etc/default/coturn",
    });
    const refuse = task(
      play,
      "Refuse coturn command-line flags that override turnserver.conf",
    );
    // The checked text is the unit's ExecStart lines and the defaults file
    // without comments.
    expect(refuse.vars?.coturn_command_text).toContain(
      "select('match', '^\\s*ExecStart')",
    );
    expect(refuse.vars?.coturn_command_text).toContain(
      "reject('match', '^\\s*(#|$)')",
    );
    // Ansible keeps '\n' in a Jinja literal as two characters, which would
    // glue a trailing flag to the next line; the lines are joined by spaces.
    expect(refuse.vars?.coturn_command_text).toContain("| join(' ')");
    // Run the playbook's own patterns (Python and JavaScript agree on these
    // constructs) against unit and defaults lines.
    const patterns = (refuse.assert as { that: string[] }).that.map((check) => {
      const pattern = /search\('(.*)', multiline=True\)$/.exec(check)?.[1];
      if (!pattern) throw new Error(`no pattern in ${check}`);
      return new RegExp(pattern.replace(/\\x27/g, "'"), "m");
    });
    const refused = (text: string) => patterns.some((re) => re.test(text));
    for (const accepted of [
      "ExecStart=/usr/bin/turnserver -c /etc/turnserver.conf --pidfile=",
      "TURNSERVER_ENABLED=1",
      'DAEMON_ARGS="-c /etc/turnserver.conf -o -v"',
      "ExecStart=/usr/bin/turnserver -c=/etc/turnserver.conf --no-stdout-log",
    ])
      expect(refused(accepted), accepted).toBe(false);
    for (const overriding of [
      "ExecStart=/usr/bin/turnserver -c /etc/turnserver.conf --log-file=/var/log/turn.log",
      "ExecStart=/usr/bin/turnserver -c /etc/turnserver.conf -l /var/log/turn.log",
      'DAEMON_ARGS="-c /etc/turnserver.conf --syslog"',
      "ExecStart=/usr/bin/turnserver -n --listening-port=3478",
      "ExecStart=/usr/bin/turnserver -c /etc/coturn/other.conf",
      "EXTRA_OPTIONS='--log-file /tmp/t.log'",
      // A unit line and a defaults line as the playbook joins them.
      "ExecStart=/usr/bin/turnserver -c /etc/turnserver.conf --syslog TURNSERVER_ENABLED=1",
    ])
      expect(refused(overriding), overriding).toBe(true);
    expect(
      String(refuse.assert && (refuse.assert as { fail_msg: string }).fail_msg),
    ).toContain("systemctl cat coturn");
  });

  test("Caddy's log files belong to caddy before and after caddy validate", () => {
    // caddy validate opens (and creates) every log file the Caddyfile names.
    const named = [...caddyfile.matchAll(/^\s*output file (.+?) \{$/gm)].map(
      ([, path]) => path!,
    );
    expect(named).toEqual(["/var/log/caddy/{{ domains.signaling }}.log"]);
    for (const [name, source, validation] of [
      ["deploy.yml", deploy, "Validate the candidate Caddy configuration"],
      ["initial-setup.yml", initialSetup, "Deploy Caddyfile"],
    ] as const) {
      const play = playWithTask(source, validation);
      const directory = task(
        play,
        "Ensure Caddy's log directory belongs to caddy",
      );
      expect(directory.file, name).toEqual({
        path: "/var/log/caddy",
        state: "directory",
        owner: "caddy",
        group: "caddy",
        mode: "0755",
      });
      for (const ownership of [
        "Ensure Caddy's log files exist and belong to caddy",
        "Keep Caddy's log files owned by caddy after validation",
      ]) {
        const files = task(play, ownership);
        expect(files.loop, `${name}: ${ownership}`).toEqual(named);
        expect(files.file, `${name}: ${ownership}`).toMatchObject({
          path: "{{ item }}",
          state: "touch",
          owner: "caddy",
          group: "caddy",
          modification_time: "preserve",
          access_time: "preserve",
        });
      }
      const at = (task: string) => position(play, task);
      expect(at("Ensure Caddy's log directory belongs to caddy")).toBeLessThan(
        at(validation),
      );
      expect(
        at("Ensure Caddy's log files exist and belong to caddy"),
      ).toBeLessThan(at(validation));
      expect(
        at("Keep Caddy's log files owned by caddy after validation"),
      ).toBeGreaterThan(at(validation));
    }
    // deploy.yml re-asserts ownership before the validated file goes live.
    const deployPlay = playWithTask(
      deploy,
      "Validate the candidate Caddy configuration",
    );
    expect(
      position(
        deployPlay,
        "Keep Caddy's log files owned by caddy after validation",
      ),
    ).toBeLessThan(
      position(deployPlay, "Reload Caddy onto the desired signaling ports"),
    );
  });

  test("deployed migrations use the audited lockfile and the server's schema/config", () => {
    const copyLock = deploy.indexOf(
      "- name: Copy the audited package manifest and frozen dependency lock",
    );
    const installTooling = deploy.indexOf(
      "- name: Install exactly the audited migration dependencies",
    );
    const copySchema = deploy.indexOf("- name: Copy the schema");
    const migrate = deploy.indexOf("- name: Apply migrations against Postgres");
    expect(copyLock).toBeGreaterThan(-1);
    expect(installTooling).toBeGreaterThan(copyLock);
    expect(copySchema).toBeGreaterThan(installTooling);
    expect(migrate).toBeGreaterThan(copySchema);
    expect(deploy).toContain("loop: [package.json, bun.lock]");
    expect(deploy).toContain("- --frozen-lockfile");
    expect(deploy).toContain(
      '"{{ migration_tooling }}/node_modules/prisma/build/index.js"',
    );
    expect(deploy.slice(migrate)).toContain('chdir: "{{ app.home }}/server"');
    expect(deploy).not.toContain("bunx prisma@");
    expect(deploy).toContain('dest: "{{ app.home }}/server/prisma.config.ts"');
    expect(deploy).toContain(
      'dest: "{{ app.home }}/server/prisma/schema.prisma"',
    );
  });

  test("prisma.config.ts is loadable on a host that has no node_modules", () => {
    // The host carries one compiled binary and no node_modules; the playbook
    // runs the CLI from an isolated migration-tooling/node_modules tree. A value
    // import inside the server-root config is resolved
    // from this file's directory upwards and never reaches that tree, so it
    // fails with "Cannot find module 'prisma/config'" and no migration runs.
    // Type-only imports are erased before the loader ever sees them.
    // Read the code, not the comment that explains it: the comment has to
    // name both `defineConfig` and the import it warns against.
    const code = prismaConfig
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//u.test(line))
      .join("\n");

    const valueImports = code
      .split("\n")
      .filter(
        (line) =>
          /^\s*import\s/u.test(line) && !/^\s*import\s+type\s/u.test(line),
      );
    expect(valueImports).toEqual([]);
    expect(code).not.toMatch(/\brequire\s*\(/u);
    // Nothing is lost by not calling it: the loader's parseDefaultExport()
    // tries the plain PrismaConfig shape first and applies defineConfig itself.
    expect(code).not.toMatch(/\bdefineConfig\s*\(/u);
    expect(code).toContain("satisfies PrismaConfig");

    // The file is only consulted if the playbook still ships it beside the
    // schema; without it the Prisma 7 CLI has no datasource at all.
    expect(deploy).toContain('dest: "{{ app.home }}/server/prisma.config.ts"');
  });
});

/** package.json's Bun pin, the one place the version is written. */
const bunPin = (() => {
  const { packageManager } = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { packageManager: string };
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager);
  if (!match)
    throw new Error(`packageManager is not bun@x.y.z: ${packageManager}`);
  return match[1]!;
})();
const ansibleDir = join(repoRoot, "deploy", "ansible");
const playbooksDir = join(ansibleDir, "playbooks");
const readAnsible = (path: string) =>
  readFileSync(join(ansibleDir, path), "utf8");
const localPreflight = () => readAnsible("playbooks/local-preflight.yml");
const pinnedBunTasks = () => readAnsible("tasks/require-pinned-bun.yml");
const allVars = Bun.YAML.parse(readAnsible("group_vars/all/vars.yml")) as {
  ansible_core_tested: string;
  bun: { version: string; release_sha256: Record<string, string> };
};
const deployReadme = readFileSync(
  join(repoRoot, "deploy", "README.md"),
  "utf8",
);

interface PreflightPlay {
  hosts: string;
  connection: string;
  gather_facts: boolean;
  become: boolean;
  tags: string[];
  tasks: (PlaybookTask & { delegate_to?: string })[];
}

const preflightTask = (name: string) => {
  const [play] = Bun.YAML.parse(localPreflight()) as PreflightPlay[];
  const found = play!.tasks.find((t) => t.name === name);
  if (!found) throw new Error(`no pre-flight task named ${name}`);
  return found;
};

describe("toolchain pins", () => {
  test("the playbook reads the pin from package.json", () => {
    // One source: group_vars/all/vars.yml derives bun.version from
    // packageManager; no Ansible file writes the number itself.
    expect(allVars.bun.version).toContain(
      "lookup('ansible.builtin.file', playbook_dir ~ '/../../../package.json')",
    );
    expect(allVars.bun.version).toContain(
      ".packageManager | regex_replace('^bun@', '')",
    );
    // Only tracked Ansible files, named explicitly: the ignored vault and the
    // real inventory sit beside them in a working tree and must never be read.
    const ansibleYaml = [
      ...readdirSync(playbooksDir)
        .filter((f) => f.endsWith(".yml"))
        .map((f) => `playbooks/${f}`),
      ...readdirSync(join(ansibleDir, "tasks"))
        .filter((f) => f.endsWith(".yml"))
        .map((f) => `tasks/${f}`),
      "group_vars/all/vars.yml",
      "group_vars/production/vars.yml",
      "group_vars/all/vault.yml.example",
      "inventory/production.yml.example",
    ];
    for (const file of ansibleYaml)
      expect(readAnsible(file), file).not.toContain(bunPin);
  });

  test("the build refuses a Bun other than the pinned one", () => {
    const [play, ...others] = Bun.YAML.parse(
      localPreflight(),
    ) as PreflightPlay[];
    expect(others).toEqual([]);
    expect(play!.hosts).toBe("localhost");
    expect(play!.connection).toBe("local");
    expect(play!.gather_facts).toBe(false);
    expect(play!.tags).toContain("always");
    expect(localPreflight()).toContain(
      '"{{ playbook_dir }}/../group_vars/all/vars.yml"',
    );
    expect(preflightTask("Find the Bun on PATH").shell).toBe(
      "command -v bun && bun --version",
    );
    expect(
      (
        preflightTask("Require the Bun package.json pins").assert as {
          that: string[];
        }
      ).that,
    ).toContain("(local_bun.stdout_lines | last | default('')) == bun.version");
    // deploy.yml runs the pre-flight before every play, so before the build.
    const plays = Bun.YAML.parse(deploy) as {
      import_playbook?: string;
      tasks?: PlaybookTask[];
    }[];
    expect(plays[0]!.import_playbook).toBe("local-preflight.yml");
    const builds = plays.flatMap((p, i) =>
      flatten(p.tasks ?? [])
        .filter((t) => String(t.shell ?? "").includes("build_command"))
        .map(() => i),
    );
    expect(builds.length).toBeGreaterThan(0);
    for (const index of builds) expect(index).toBeGreaterThan(0);
  });

  test("the host's Bun is checked before the service is stopped", () => {
    const play = playWithTask(deploy, "Apply migrations against Postgres");
    const prepare = task(
      play,
      "Prepare the release without touching the running workers",
    );
    const inBlock = (prepare.block ?? []).map((t) => t.name);
    const host = "Require the pinned Bun on the signaling host";
    const binary = "Require the pinned Bun in the staged binary";
    // First in the block whose rescue reports that production is untouched,
    // so nothing on the host changes before it.
    expect(inBlock[0]).toBe(host);
    expect(inBlock.indexOf(host)).toBeLessThan(
      inBlock.indexOf("Install exactly the audited migration dependencies"),
    );
    expect(inBlock.indexOf(binary)).toBe(
      inBlock.indexOf("Stage the compiled binary") + 1,
    );
    expect((prepare.rescue ?? []).map((t) => t.name)).toContain(
      "Report that preparing the release failed",
    );
    for (const later of [
      "Stop and disable every signaling worker before migrating",
      "Apply migrations against Postgres",
    ]) {
      expect(position(play, host)).toBeLessThan(position(play, later));
      expect(position(play, binary)).toBeLessThan(position(play, later));
    }
    for (const [name, check] of [
      [host, "host"],
      [binary, "binary"],
    ] as const) {
      const imported = task(play, name);
      expect(imported.import_tasks).toBe(
        "{{ playbook_dir }}/../tasks/require-pinned-bun.yml",
      );
      expect(imported.vars).toEqual({ pinned_bun_check: check });
    }
    // The imported tasks compare with the pin and report rather than crash.
    const [read, require] = Bun.YAML.parse(pinnedBunTasks()) as PlaybookTask[];
    expect(read!.failed_when).toBe(false);
    expect(JSON.stringify(read!.command)).toContain(
      "bun.install_dir ~ '/bin/bun'",
    );
    expect(JSON.stringify(read!.command)).toContain(
      "release_staging ~ '/p2party-server'",
    );
    expect(String(read!.environment)).toContain("'BUN_BE_BUN': '1'");
    expect((require!.assert as { that: string[] }).that).toContain(
      "(pinned_bun_found.stdout | trim) == bun.version",
    );
  });

  test("every playbook starts with the local pre-flight before any host is contacted", () => {
    const playbooks = readdirSync(playbooksDir).filter(
      (f) => f.endsWith(".yml") && f !== "local-preflight.yml",
    );
    expect(playbooks.sort()).toEqual([
      "deploy.yml",
      "initial-setup.yml",
      "install-postgres.yml",
      "postgres-tls.yml",
      "setup-coturn.yml",
      "setup-wireguard.yml",
      "site.yml",
    ]);
    for (const file of playbooks) {
      const [first] = Bun.YAML.parse(
        readFileSync(join(playbooksDir, file), "utf8"),
      ) as { import_playbook?: string }[];
      expect(first?.import_playbook, file).toBe("local-preflight.yml");
    }
    const [play] = Bun.YAML.parse(localPreflight()) as PreflightPlay[];
    for (const t of play!.tasks) expect(t.delegate_to, t.name).toBeUndefined();
    expect(
      (
        preflightTask(
          "Require the ansible-core these playbooks were tested with",
        ).assert as { that: string[] }
      ).that,
    ).toEqual(["ansible_version.full == ansible_core_tested"]);
    expect(allVars.ansible_core_tested).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the README's host Bun instructions name the pinned release", () => {
    const section = deployReadme.slice(
      deployReadme.indexOf("## Which Bun, and where it is checked"),
      deployReadme.indexOf("## Host software"),
    );
    expect(section).toContain(`\`bun@${bunPin}\``);
    // Every release the section names is the pinned one.
    const named = [...section.matchAll(/bun-v(\d+\.\d+\.\d+)/g)].map(
      (m) => m[1],
    );
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([bunPin]));
    // The hashes the host check prints are the ones the README records.
    for (const [arch, sha256] of Object.entries(allVars.bun.release_sha256)) {
      expect(sha256, arch).toMatch(/^[0-9a-f]{64}$/);
      expect(section).toContain(`\`bun-linux-${arch}.zip\``);
      expect(section).toContain(sha256);
    }
    expect(Object.keys(allVars.bun.release_sha256).sort()).toEqual([
      "aarch64",
      "x64",
    ]);
    expect(section).toContain("F3DCC08A8572C0749B3E18888EAB4D40A7B22B59");
  });
});
