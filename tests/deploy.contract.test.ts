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
      "max-bps={{ coturn_max_bps | default(3000000) }}",
    );
    expect(setupCoturn).toContain("Require finite TURN bandwidth budgets");
    expect(setupCoturn).toContain("zero disables the bandwidth guard");
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
