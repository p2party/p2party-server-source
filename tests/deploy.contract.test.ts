import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  template?: Record<string, unknown>;
  copy?: Record<string, unknown>;
  assert?: unknown;
  notify?: string;
  diff?: boolean;
  no_log?: boolean;
  systemd?: Record<string, unknown>;
}
interface Play {
  tasks: PlaybookTask[];
  handlers?: PlaybookTask[];
}

/** The play of a playbook that contains the task named `name`. */
const playWithTask = (playbook: string, name: string): Play => {
  const plays = Bun.YAML.parse(playbook) as Partial<Play>[];
  const play = plays.find((p) => p.tasks?.some((t) => t.name === name));
  if (!play) throw new Error(`no play has a task named ${name}`);
  return play as Play;
};

const task = (play: Play, name: string): PlaybookTask => {
  const found = play.tasks.find((t) => t.name === name);
  if (!found) throw new Error(`no task named ${name}`);
  return found;
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
      deploy.indexOf("- name: Deploy the signaling environment file"),
      deploy.indexOf("- name: Deploy the systemd unit files"),
    );
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

  test("one TURN identity can reserve at most half the relay bandwidth", () => {
    const userQuota = coturnDefault("user-quota");
    const maxBps = coturnDefault("max-bps");
    const capacity = coturnDefault("bps-capacity");
    // user-quota counts allocations per username. A username is stable per
    // identity for one credential lifetime, and the previous lifetime's
    // credential is still valid, so one identity holds at most two.
    expect(userQuota * maxBps).toBeLessThanOrEqual(capacity / 2);
    expect(2 * userQuota * maxBps).toBeLessThanOrEqual(capacity / 2);
    // The same bound is enforced for operator overrides.
    expect(setupCoturn).toContain(
      "- 4 * (coturn_user_quota | default(12) | int) * (coturn_max_bps | default(625000) | int) <= coturn_bps_capacity | default(30000000) | int",
    );
    expect(setupCoturn).toContain("coturn_user_quota | default(12) | int > 0");
    expect(turnserverConfig).toContain(
      "user-quota={{ coturn_user_quota | default(12) }}",
    );
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
      expect(play.tasks.indexOf(directory)).toBeLessThan(
        play.tasks.indexOf(install),
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
    const names = play.tasks.map((t) => t.name);
    const order = [
      "Render the candidate coturn configuration",
      "Read the candidate coturn configuration",
      "Validate the candidate coturn configuration",
      "Install the validated coturn configuration",
      "Remove the coturn configuration candidate",
    ].map((name) => names.indexOf(name));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Only the install step writes the live file, and only it restarts coturn.
    const writers = play.tasks.filter(
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
    ])
      expect(checks).toContain(required);
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
    expect(deploy).toContain("loop: [package.json, bun.lockb]");
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
