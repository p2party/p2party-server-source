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

describe("production deployment contract", () => {
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
});
