/**
 * The rehearsal's inventory check, run by run.sh before anything else:
 *
 *   bun deploy/rehearsal/inventory-check.ts <inventory.yml> <lima.yaml>
 *
 * It exits 0 when every host of the inventory is the Lima instance (address
 * 127.0.0.1, port lima.yaml's ssh.localPort, SSH) and exits 2 naming each
 * problem otherwise. run.sh has already refused any path other than the
 * tracked deploy/rehearsal/inventory.yml without opening it; this check reads
 * only that file.
 *
 * Ansible's YAML inventory: every top-level key is a group; a group has
 * `hosts` (name -> variables), `children` (name -> group) and `vars`. A host's
 * address is its `ansible_host` (or the older `ansible_ssh_host`), else its
 * name. Group `vars` may not set any variable that decides where or how
 * Ansible connects, because a group value would apply to every host in it.
 */

export const REHEARSAL_ADDRESS = "127.0.0.1";

/** Variables that change the target or the transport of a connection. */
const ROUTING_VARIABLES = [
  "ansible_host",
  "ansible_ssh_host",
  "ansible_port",
  "ansible_ssh_port",
  "ansible_connection",
  "ansible_ssh_common_args",
  "ansible_ssh_extra_args",
  "ansible_ssh_args",
  "ansible_ssh_executable",
  "ansible_sftp_extra_args",
  "ansible_scp_extra_args",
  "ansible_ssh_pass",
  "ansible_password",
  "ansible_paramiko_proxy_command",
  "ansible_docker_extra_args",
] as const;

/** What a host itself may set; anything else routing-related is refused. */
const HOST_ROUTING_ALLOWED = new Set([
  "ansible_host",
  "ansible_ssh_host",
  "ansible_port",
  "ansible_ssh_port",
]);

export interface InventoryHost {
  name: string;
  address: string;
  port: unknown;
}

export interface InventoryVerdict {
  hosts: InventoryHost[];
  problems: string[];
}

type Variables = Record<string, unknown>;

interface Group {
  hosts?: Record<string, Variables | null> | null;
  children?: Record<string, Group | null> | null;
  vars?: Variables | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function checkInventory(
  inventoryText: string,
  sshPort: number,
): InventoryVerdict {
  const problems: string[] = [];
  const hosts = new Map<string, Variables>();
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(inventoryText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { hosts: [], problems: [`the inventory is not YAML (${reason})`] };
  }
  if (!isRecord(parsed)) {
    return { hosts: [], problems: ["the inventory is not a YAML mapping"] };
  }

  const visit = (groupName: string, group: unknown): void => {
    if (group === null || group === undefined) return;
    if (!isRecord(group)) {
      problems.push(`group ${groupName} is not a mapping`);
      return;
    }
    const { hosts: groupHosts, children, vars } = group as Group;
    if (vars !== undefined && vars !== null) {
      if (!isRecord(vars)) {
        problems.push(`group ${groupName}: vars is not a mapping`);
      } else {
        for (const key of ROUTING_VARIABLES) {
          if (key in vars) {
            problems.push(
              `group ${groupName} sets ${key}, which would apply to every host in it`,
            );
          }
        }
      }
    }
    if (groupHosts !== undefined && groupHosts !== null) {
      if (!isRecord(groupHosts)) {
        problems.push(`group ${groupName}: hosts is not a mapping`);
      } else {
        for (const [name, hostVars] of Object.entries(groupHosts)) {
          const own = isRecord(hostVars) ? hostVars : {};
          if (hostVars !== null && !isRecord(hostVars)) {
            problems.push(`host ${name}: its variables are not a mapping`);
          }
          hosts.set(name, { ...(hosts.get(name) ?? {}), ...own });
        }
      }
    }
    if (children !== undefined && children !== null) {
      if (!isRecord(children)) {
        problems.push(`group ${groupName}: children is not a mapping`);
      } else {
        for (const [childName, child] of Object.entries(children)) {
          visit(childName, child);
        }
      }
    }
  };
  for (const [groupName, group] of Object.entries(parsed)) {
    visit(groupName, group);
  }

  const verdictHosts: InventoryHost[] = [];
  for (const [name, vars] of hosts) {
    if (/[[\]]/.test(name)) {
      problems.push(`host ${name} is a range pattern; name each host`);
    }
    for (const key of ROUTING_VARIABLES) {
      if (key in vars && !HOST_ROUTING_ALLOWED.has(key)) {
        problems.push(`host ${name} sets ${key}`);
      }
    }
    const address = String(vars.ansible_host ?? vars.ansible_ssh_host ?? name);
    const port = vars.ansible_port ?? vars.ansible_ssh_port;
    if (address !== REHEARSAL_ADDRESS) {
      problems.push(
        `host ${name} is ${address}, not ${REHEARSAL_ADDRESS} (the Lima instance)`,
      );
    }
    if (port !== sshPort) {
      problems.push(
        `host ${name} uses port ${String(port)}, not the instance's SSH port ${String(sshPort)}`,
      );
    }
    verdictHosts.push({ name, address, port });
  }
  if (hosts.size === 0) problems.push("the inventory names no host");
  return { hosts: verdictHosts, problems };
}

/** The instance's SSH port on 127.0.0.1, from the Lima template. */
export function templateSshPort(templateText: string): number {
  const template = Bun.YAML.parse(templateText) as {
    ssh?: { localPort?: unknown };
  };
  const port = template.ssh?.localPort;
  if (typeof port !== "number" || !Number.isInteger(port)) {
    throw new Error("lima.yaml has no numeric ssh.localPort");
  }
  return port;
}

if (import.meta.main) {
  const [inventoryPath, templatePath] = process.argv.slice(2);
  if (inventoryPath === undefined || templatePath === undefined) {
    console.error("usage: bun inventory-check.ts <inventory.yml> <lima.yaml>");
    process.exit(2);
  }
  const verdict = checkInventory(
    await Bun.file(inventoryPath).text(),
    templateSshPort(await Bun.file(templatePath).text()),
  );
  if (verdict.problems.length > 0) {
    for (const problem of verdict.problems) {
      console.error(`run.sh: refusing to start: ${problem}`);
    }
    process.exit(2);
  }
  console.log(
    `inventory: ${verdict.hosts.map((host) => host.name).join(", ")} -> ${REHEARSAL_ADDRESS}:${String(verdict.hosts[0]?.port)}`,
  );
}
