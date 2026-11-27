/**
 * What the rehearsal hands to Ansible, checked before anything runs. The rule:
 * nothing here can make a connection go anywhere but the Lima instance,
 * 127.0.0.1 on the template's SSH port. Each input is checked against an
 * allowlist, not a list of names to refuse:
 *
 *   bun inventory-check.ts static <inventory.yml> <lima.yaml> <vars.yml> \
 *       <ansible.cfg> <ansible-connection-variables.json>
 *   bun inventory-check.ts resolved <lima.yaml> \
 *       <ansible-connection-variables.json> <host>=<ansible-inventory --host json>...
 *   bun inventory-check.ts extra-var <ansible-connection-variables.json> <name>
 *
 * Exit 0 when the inputs pass (static prints a one-line summary), 2 with one
 * "run.sh: refusing to start: ..." line per problem otherwise.
 *
 * ansible-connection-variables.json is ansible-core 2.22.0's own list: every
 * variable its connection plugins (local, psrp, ssh, winrm) read, from
 * `ansible-doc -t connection -j`, plus constants.MAGIC_VARIABLE_MAPPING,
 * which also maps the become variables, plus ansible_connection.
 *
 *   - Inventory. A host sets exactly ansible_host 127.0.0.1, ansible_port the
 *     template's SSH port and ansible_user p2party (the guest's account,
 *     which the user production's inventory names too); group vars may set
 *     only ansible_python_interpreter /usr/bin/python3, ansible_become true
 *     and ansible_become_method sudo, as production's example inventory does.
 *     Become chooses privilege escalation on a connection already chosen; it
 *     is on ansible-core's list because the magic mapping maps it. Any other
 *     ansible_* variable, any variable on the list, a host named localhost, a
 *     range pattern, an unknown group key or an empty inventory is refused.
 *   - vars.yml (passed with -e, which outranks everything): only the public
 *     names under `domains`, each a *.localhost name; no ansible_* variable
 *     and no variable on the list at any depth.
 *   - Every other -e run.sh passes: a name on run.sh's own short list, never
 *     ansible_* and never a name on the list.
 *   - ansible.cfg: only the sections and keys below; ssh_args only the
 *     options below, with -F /dev/null so no ssh_config file applies.
 *   - What ansible-inventory resolved for each host: the same values as the
 *     inventory allows, and nothing else from the list.
 */

export const REHEARSAL_ADDRESS = "127.0.0.1";
export const REHEARSAL_USER = "p2party";

type Variables = Record<string, unknown>;

export interface ConnectionVariables {
  ansible_core: string;
  all: string[];
}

export interface InventoryHost {
  name: string;
  address: string;
  port: unknown;
}

export interface Verdict {
  hosts: InventoryHost[];
  problems: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A host may set exactly these, with exactly these values. */
const hostAllowed = (sshPort: number): Record<string, unknown> => ({
  ansible_host: REHEARSAL_ADDRESS,
  ansible_port: sshPort,
  ansible_user: REHEARSAL_USER,
});

/** A group may set exactly these, with exactly these values. */
const GROUP_ALLOWED: Record<string, unknown> = {
  ansible_python_interpreter: "/usr/bin/python3",
  ansible_become: true,
  ansible_become_method: "sudo",
};

/** Is this a variable that only an allowlist entry may set? */
const isControlled = (name: string, connection: Set<string>) =>
  name.startsWith("ansible_") || connection.has(name);

function checkVariables(
  where: string,
  vars: Variables,
  allowed: Record<string, unknown>,
  connection: Set<string>,
  problems: string[],
) {
  for (const [name, value] of Object.entries(vars)) {
    if (!isControlled(name, connection)) continue;
    if (!(name in allowed)) {
      problems.push(
        `${where} sets ${name}, which only the rehearsal's own values may set`,
      );
    } else if (value !== allowed[name]) {
      problems.push(
        `${where} sets ${name} to ${JSON.stringify(value)}, not ${JSON.stringify(allowed[name])}`,
      );
    }
  }
}

export function checkInventory(
  inventoryText: string,
  sshPort: number,
  connectionVariables: string[],
): Verdict {
  const connection = new Set(connectionVariables);
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
    for (const key of Object.keys(group)) {
      if (!["hosts", "children", "vars"].includes(key)) {
        problems.push(
          `group ${groupName} has the key ${key}, which a YAML inventory group does not have`,
        );
      }
    }
    const {
      hosts: groupHosts,
      children,
      vars,
    } = group as {
      hosts?: unknown;
      children?: unknown;
      vars?: unknown;
    };
    if (vars !== undefined && vars !== null) {
      if (!isRecord(vars))
        problems.push(`group ${groupName}: vars is not a mapping`);
      else
        checkVariables(
          `group ${groupName}`,
          vars,
          GROUP_ALLOWED,
          connection,
          problems,
        );
    }
    if (groupHosts !== undefined && groupHosts !== null) {
      if (!isRecord(groupHosts)) {
        problems.push(`group ${groupName}: hosts is not a mapping`);
      } else {
        for (const [name, hostVars] of Object.entries(groupHosts)) {
          if (hostVars !== null && !isRecord(hostVars)) {
            problems.push(`host ${name}: its variables are not a mapping`);
          }
          const own = isRecord(hostVars) ? hostVars : {};
          hosts.set(name, { ...(hosts.get(name) ?? {}), ...own });
        }
      }
    }
    if (children !== undefined && children !== null) {
      if (!isRecord(children))
        problems.push(`group ${groupName}: children is not a mapping`);
      else
        for (const [childName, child] of Object.entries(children))
          visit(childName, child);
    }
  };
  for (const [groupName, group] of Object.entries(parsed))
    visit(groupName, group);

  const allowed = hostAllowed(sshPort);
  const verdictHosts: InventoryHost[] = [];
  for (const [name, vars] of hosts) {
    if (/[[\]]/.test(name))
      problems.push(`host ${name} is a range pattern; name each host`);
    if (name === "localhost" || name === REHEARSAL_ADDRESS) {
      problems.push(`host ${name} would replace Ansible's implicit localhost`);
    }
    checkVariables(`host ${name}`, vars, allowed, connection, problems);
    const address = String(vars.ansible_host ?? name);
    const port = vars.ansible_port;
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

/** Variables with a name on the list or ansible_*, at any depth. */
function controlledNames(
  value: unknown,
  connection: Set<string>,
  path: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      controlledNames(item, connection, [...path, String(index)]),
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(isControlled(key, connection) ? [[...path, key].join(".")] : []),
    ...controlledNames(item, connection, [...path, key]),
  ]);
}

export const EXTRA_VARS_TOP_LEVEL = ["domains"];

export function checkExtraVars(
  varsText: string,
  connectionVariables: string[],
): string[] {
  const connection = new Set(connectionVariables);
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(varsText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`vars.yml is not YAML (${reason})`];
  }
  if (!isRecord(parsed)) return ["vars.yml is not a YAML mapping"];
  for (const name of controlledNames(parsed, connection)) {
    problems.push(
      `vars.yml sets ${name}; extra vars outrank every inventory value`,
    );
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!EXTRA_VARS_TOP_LEVEL.includes(key)) {
      problems.push(
        `vars.yml sets ${key}; it may set only ${EXTRA_VARS_TOP_LEVEL.join(", ")}`,
      );
      continue;
    }
    if (!isRecord(value)) {
      problems.push(`vars.yml: ${key} is not a mapping`);
      continue;
    }
    for (const [name, domain] of Object.entries(value)) {
      if (
        typeof domain !== "string" ||
        !/^[a-z0-9.-]+\.localhost$/.test(domain)
      ) {
        problems.push(
          `vars.yml: ${key}.${name} is ${JSON.stringify(domain)}, not a *.localhost name`,
        );
      }
    }
  }
  return problems;
}

/** The -e names run.sh itself may pass, besides @vars.yml. */
export const EXTRA_VAR_NAMES = ["skip_build", "vault_coturn_auth_secret"];

export function checkExtraVarName(
  name: string,
  connectionVariables: string[],
): string[] {
  if (
    isControlled(name, new Set(connectionVariables)) ||
    !EXTRA_VAR_NAMES.includes(name)
  ) {
    return [
      `the extra variable ${name} is not one run.sh may pass (${EXTRA_VAR_NAMES.join(", ")})`,
    ];
  }
  return [];
}

/** Sections and keys ansible.cfg may hold; ssh_args is checked token by token. */
const CFG_ALLOWED: Record<
  string,
  Record<string, ((value: string) => boolean) | null>
> = {
  defaults: {
    host_key_checking: (value) => value === "True",
    retry_files_enabled: null,
    timeout: null,
    forks: null,
    stdout_callback: null,
    result_format: null,
    interpreter_python: (value) => value === "/usr/bin/python3",
  },
  ssh_connection: {
    pipelining: null,
    ssh_args: null,
    retries: null,
    timeout: null,
  },
  privilege_escalation: {
    become: null,
    become_method: (value) => value === "sudo",
    become_user: (value) => value === "root",
    become_ask_pass: null,
  },
};

const SSH_ARG_OPTIONS: Record<string, (value: string) => boolean> = {
  ControlMaster: (value) => value === "auto",
  ControlPersist: (value) => /^[0-9]+s$/.test(value),
  ForwardAgent: (value) => value === "no",
  IdentitiesOnly: (value) => value === "yes",
  BatchMode: (value) => value === "yes",
};

export function checkSshArgs(sshArgs: string): string[] {
  const problems: string[] = [];
  const tokens = sshArgs.split(/\s+/).filter((token) => token.length > 0);
  let configFile = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "-F") {
      const file = tokens[++index];
      if (file !== "/dev/null")
        problems.push(
          `ssh_args names the ssh config file ${String(file)}, not /dev/null`,
        );
      else configFile = true;
    } else if (token === "-o") {
      const option = tokens[++index] ?? "";
      const [key, ...rest] = option.split("=");
      const check = SSH_ARG_OPTIONS[key ?? ""];
      if (!check || !check(rest.join("=")))
        problems.push(
          `ssh_args passes -o ${option}, which is not on its allowlist`,
        );
    } else {
      problems.push(`ssh_args passes ${token}, which is not on its allowlist`);
    }
  }
  if (!configFile)
    problems.push(
      "ssh_args does not pass -F /dev/null, so ~/.ssh/config would apply",
    );
  return problems;
}

export function checkAnsibleCfg(cfgText: string): string[] {
  const problems: string[] = [];
  let section = "";
  let sshArgs: string | undefined;
  for (const raw of cfgText.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      if (!(section in CFG_ALLOWED))
        problems.push(`ansible.cfg has the section [${section}]`);
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) {
      problems.push(`ansible.cfg has a line that is not key = value: ${line}`);
      continue;
    }
    const [, key, value] = pair as unknown as [string, string, string];
    const keys = CFG_ALLOWED[section];
    if (!keys) continue;
    if (!(key in keys)) {
      problems.push(
        `ansible.cfg sets ${key} in [${section}], which is not on its allowlist`,
      );
      continue;
    }
    const check = keys[key];
    if (check && !check(value))
      problems.push(`ansible.cfg sets ${key} = ${value} in [${section}]`);
    if (section === "ssh_connection" && key === "ssh_args") sshArgs = value;
  }
  problems.push(
    ...(sshArgs === undefined
      ? ["ansible.cfg sets no ssh_args"]
      : checkSshArgs(sshArgs)),
  );
  return problems;
}

/** What ansible-inventory --host printed for one host. */
export function checkResolvedHost(
  name: string,
  resolvedText: string,
  sshPort: number,
  connectionVariables: string[],
): string[] {
  let resolved: unknown;
  try {
    resolved = JSON.parse(resolvedText);
  } catch {
    return [`ansible-inventory printed no JSON for ${name}`];
  }
  if (!isRecord(resolved))
    return [`ansible-inventory printed no mapping for ${name}`];
  const problems: string[] = [];
  const allowed = { ...hostAllowed(sshPort), ...GROUP_ALLOWED };
  checkVariables(
    `ansible-inventory: host ${name}`,
    resolved,
    allowed,
    new Set(connectionVariables),
    problems,
  );
  if (
    resolved.ansible_host !== REHEARSAL_ADDRESS ||
    resolved.ansible_port !== sshPort
  ) {
    problems.push(
      `ansible-inventory resolves ${name} to ${String(resolved.ansible_host)}:${String(resolved.ansible_port)}, not ${REHEARSAL_ADDRESS}:${String(sshPort)}`,
    );
  }
  return problems;
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

const refuse = (problems: string[]) => {
  for (const problem of problems)
    console.error(`run.sh: refusing to start: ${problem}`);
  process.exit(2);
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const read = (path: string) => Bun.file(path).text();
  const connection = async (path: string) =>
    ((await Bun.file(path).json()) as ConnectionVariables).all;
  if (command === "static" && args.length === 5) {
    const [inventoryPath, templatePath, varsPath, cfgPath, variablesPath] =
      args as [string, string, string, string, string];
    const variables = await connection(variablesPath);
    const port = templateSshPort(await read(templatePath));
    const verdict = checkInventory(await read(inventoryPath), port, variables);
    const problems = [
      ...verdict.problems,
      ...checkExtraVars(await read(varsPath), variables),
      ...checkAnsibleCfg(await read(cfgPath)),
    ];
    if (problems.length > 0) refuse(problems);
    console.log(
      `inventory: ${verdict.hosts.map((host) => host.name).join(", ")} -> ${REHEARSAL_ADDRESS}:${String(port)}`,
    );
  } else if (command === "resolved" && args.length >= 3) {
    const [templatePath, variablesPath, ...pairs] = args as [
      string,
      string,
      ...string[],
    ];
    const variables = await connection(variablesPath);
    const port = templateSshPort(await read(templatePath));
    const problems: string[] = [];
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      problems.push(
        ...checkResolvedHost(
          pair.slice(0, at),
          await read(pair.slice(at + 1)),
          port,
          variables,
        ),
      );
    }
    if (problems.length > 0) refuse(problems);
  } else if (command === "extra-var" && args.length === 2) {
    const problems = checkExtraVarName(args[1]!, await connection(args[0]!));
    if (problems.length > 0) refuse(problems);
  } else {
    console.error(
      "usage: bun inventory-check.ts static <inventory> <lima.yaml> <vars.yml> <ansible.cfg> <variables.json> | resolved <lima.yaml> <variables.json> <host>=<json>... | extra-var <variables.json> <name>",
    );
    process.exit(2);
  }
}
