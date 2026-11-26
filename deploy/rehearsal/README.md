# Release rehearsal on a local VM

`run.sh` runs this repository's production playbooks against one local Lima
VM, `p2party-rehearsal`, to find what the release deploy would do before it is
run against production: release 0.1.4 is installed first by its own
playbooks, then the commit under test is deployed over it, and each fault
scenario of the release is played out. Every run writes a dated result file
with the playbook's output verbatim beside the paragraph of
`deploy/README.md` that describes the case, and the state the VM is left in.

Nothing here contacts a production host. The VM is reached only on
127.0.0.1, and `run.sh` refuses any inventory but [`inventory.yml`](inventory.yml)
before it does anything else.

## What stays local

- **Ports.** [`lima.yaml`](lima.yaml) forwards two host ports, both on
  127.0.0.1: the guest's SSH on 56022 and the guest's Caddy (443, the public
  signaling port) on 56443. A rule after them ignores every other guest port,
  TCP and UDP, so the guest's PostgreSQL on 5432 never reaches the host's 5432. Lima's host agent also listens on 127.0.0.1 on two random high ports
  for the guest's DNS. Nothing binds a host port below 5000.
- **Files.** `mounts: []` and no base template, so the guest sees no host
  directory. The only share is Virtualization.framework's Rosetta runtime,
  which runs the x86-64 artefact. `networkOpts.hostLoopback: false`: the guest
  cannot reach services on the host's loopback.
- **Network.** User-mode networking only (no `socket_vmnet`, no sudo). A boot
  script masks the image's own background services that contact Canonical
  (snap store, MOTD and apt news, Ubuntu Pro, firmware metadata, entropy
  seeding, NTP) and the unattended apt timers. What leaves the VM is Ubuntu's
  package mirrors, the npm registry (the playbooks' frozen install) and Prisma's
  engine download, which that install's `@prisma/engines` postinstall makes.
- **Inventory.** Every host is 127.0.0.1:56022 under the production group
  names. `run.sh` refuses, before anything else: the production inventory path
  by name, without opening it; any file but this directory's `inventory.yml`
  (and, when it knows the repository, one that differs from the committed
  copy); any host not on 127.0.0.1 or not on the instance's SSH port; and any
  variable that redirects a connection (`ansible_connection`,
  `ansible_ssh_common_args` and the like). `tests/deployRehearsal.contract.test.ts`
  checks each of these.
- **Names.** [`vars.yml`](vars.yml) replaces the public names with
  `*.localhost` ones (as extra vars: the playbooks' `vars_files` outrank every
  inventory variable). Caddy then issues its certificate from its own local
  CA, and no name reaches a public CA.
- **Secrets** are generated at run time under the work directory
  (`secrets/`, mode 0700, files 0600), which must be outside every repository;
  the vault is encrypted with a generated password. Result files are written
  with every generated secret replaced by `<redacted>` and this machine's paths
  by `<work>`, `<tools>`, `<repo>` and `~`.

## What it reproduces, and what stands in for what

One VM is the signaling host, the PostgreSQL host and the TURN host. It is
brought to the state production's hosts were brought to:

1. the signaling host's Terraform cloud-init
   (`deploy/terraform/templates/signaling_cloud_init.yaml.tpl`), rendered as
   `templatefile()` renders it ([`render-cloud-init.ts`](render-cloud-init.ts)),
   validated by `cloud-init schema` and applied by cloud-init itself
   (`cloud-init single`, module by module), including its firewall, its sshd
   settings and its reboot;
2. release 0.1.4 from a `git archive` of `ecf691a` (the `master` branch) by
   that tree's `install-postgres.yml`, `initial-setup.yml` and `deploy.yml`, in
   that order;
3. rows in every table of 0.1.4's schema ([`seed.ts`](seed.ts)).

The commit under test is then deployed from a `git archive` of it, as
`deploy/deploy.sh` would deploy it.

| Production                                                       | In the rehearsal                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four Hetzner hosts, x86-64                                       | One aarch64 VM. The x86-64 release binary runs under Rosetta, with Ubuntu's amd64 C runtime and OpenSSL (multiarch, from Ubuntu's archive). The host's own Bun is the aarch64 build of the same version: under Rosetta, the x86-64 Bun ran 0.1.4's `migrate deploy` from the playbook's task into a hang (its schema engine exited and was never reaped), while the same command by hand finished in under a second |
| The private network 10.231.0.0/24 and WireGuard                   | The two addresses the playbooks use (10.231.0.2 for PostgreSQL, 10.231.0.4 for signaling) on a dummy interface of the VM; WireGuard is not set up (`setup-wireguard.yml` has no host)                                                                                                                                                                                                                                 |
| SSH from the private network only, on a custom port              | The cloud-init's firewall and sshd settings as rendered, with SSH port 22 (Lima forwards to 22 only) and one added firewall rule for Lima's user-mode gateway                                                                                                                                                                                                                                                       |
| DNS and public certificates                                      | `*.localhost` names, which the guest resolves to itself; Caddy's local CA, trusted by the guest; a self-signed pair where certbot's certificate would be                                                                                                                                                                                                                                                            |
| PostgreSQL 17 from apt.postgresql.org                            | PostgreSQL 16 from Ubuntu's mirrors, installed before `install-postgres.yml` (which then skips its own install and configures it), with `python3-psycopg2` from the PostgreSQL host's cloud-init package list                                                                                                                                                                                                       |
| Caddy from Caddy's Cloudsmith repository                         | Ubuntu's `caddy` package (the playbook adds the repository only when two files are missing; they are created empty)                                                                                                                                                                                                                                                                                                 |
| The host's Bun from Bun's online installer                       | A checksum-verified aarch64 Bun placed at `~p2party/.bun/bin/bun` (0.1.4's 1.3.14 for the baseline; the pin when the README says to install it). The migration tooling therefore installs the arm64 packages (`@typescript/typescript-linux-arm64`, Prisma's `linux-arm64` engine)                                                                                                                                  |
| Release 0.1.4's binary, built with whatever Bun the operator had | Built from `ecf691a` with the pinned Bun of the commit under test (0.1.4 pins 1.3.14, of which there is no checksum-verified macOS copy here)                                                                                                                                                                                                                                                                       |
| `deploy/deploy.sh`                                               | The same `ansible-playbook` command with the rehearsal inventory, `vars.yml` and vault (`deploy.sh` names the production inventory)                                                                                                                                                                                                                                                                                 |
| The operator's checkout                                          | A `git archive` of the commit, given that commit's git metadata (`deploy.yml`'s build record runs `git rev-parse HEAD` in the tree); the upgrade mode also runs once from a plain archive                                                                                                                                                                                                                           |
| Prisma's usage report from the migrate task                      | `CHECKPOINT_DISABLE=1` for every session in the guest and the name pointed at nothing                                                                                                                                                                                                                                                                                                                               |

## Tools

`REHEARSAL_TOOLS` names a directory laid out as below. `run.sh` checks the
four binaries against [`tools.sha256`](tools.sha256) before every run.

| Path                                                   | What and from where                                                                                                                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun-1.4.5/bun`                                        | Bun 1.4.5 for macOS: `bun-darwin-aarch64.zip` of the GitHub release, SHA-256 `b5d6bc2e…cd10` as in its `SHASUMS256.txt`                                                                                                      |
| `bun-linux-x64-1.4.5/bun`                              | The `bin/bun` of the npm package `@oven/bun-linux-x64@1.4.5`, its tarball checked against the registry's `sha512-IWX9BELo…` integrity; byte for byte the runtime `bun build --compile --target=bun-linux-x64-modern` fetches |
| `bun-linux-aarch64-1.4.5/bun`                          | The `bin/bun` of `@oven/bun-linux-aarch64@1.4.5` (`sha512-4BXmsSKn…`): the host's Bun after the README's install step                                                                                                        |
| `bun-linux-aarch64-1.3.14/bun`                         | Likewise `@oven/bun-linux-aarch64@1.3.14` (`sha512-X5SsPZHs…`): release 0.1.4's Bun, for the baseline's host                                                                                                                 |
| `venv/`                                                | A Python virtual environment with `ansible-core==2.22.0` from PyPI                                                                                                                                                           |
| `collections/ansible_collections/community/postgresql` | `community.postgresql` 5.1.1, extracted from PyPI's `ansible-15.0.0-py3-none-any.whl` (which requires ansible-core 2.22)                                                                                                     |

`lima.yaml` pins the Ubuntu 24.04 image by its dated release URL and the
SHA-256 from that release's `SHA256SUMS`; Lima checks it on download.

## Running it

```bash
export REHEARSAL_REPO="$PWD" REHEARSAL_TOOLS=/path/to/tools REHEARSAL_WORK_DIR=/path/outside/the/repo
deploy/rehearsal/run.sh baseline      # once: the snapshot every other mode starts from
deploy/rehearsal/run.sh upgrade
deploy/rehearsal/run.sh scenario-3    # and so on; see run.sh --help
deploy/rehearsal/run.sh clean
```

Run it from an archive copy of the repository rather than the working tree;
`--commit` names the commit under test (default: the repository's `HEAD`).
Every mode deletes the instance at the end unless `--keep` is given; the
snapshots (APFS clones of the instance's disk) stay in the work directory
until `clean`. The instance is created or started only with at least 15 GiB
free on the host, and a background check stops and deletes it at once if free
space falls below 8 GiB.

## Results

The result files are under [`results/`](results/), one directory per date.
