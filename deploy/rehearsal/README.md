# Release rehearsal on a local VM

`run.sh` runs this repository's production playbooks against one local Lima
VM, `p2party-rehearsal`, to find what the release deploy would do before it is
run against production: release 0.1.4 is installed first by its own
playbooks, then the commit under test is deployed over it, and each fault
scenario of the release is played out. Every run writes a dated result file
with the playbook's output verbatim beside the paragraph of
`deploy/README.md` that describes the case, and the state the VM is left in.

Nothing here contacts a production host. The VM is reached only on
127.0.0.1, and `run.sh` checks everything it hands to Ansible before it does
anything else.

## Prerequisites

- An Apple Silicon Mac with Lima 2.3.x (`limactl`; `run.sh` refuses any other
  release, because the port rules below were verified on Lima 2.3.0 only, and
  `lima.yaml` says `minimumLimaVersion: 2.3.0`). The vz VM type needs no sudo
  and no `socket_vmnet`.
- Rosetta 2 for Linux, if it is already installed: the x86-64 release binary
  runs under it. Nothing here installs Rosetta or anything else system-wide;
  with Rosetta absent, Lima refuses the template's `vmOpts.vz.rosetta`.
- A `bun` on `PATH` for the harness's own checks (`inventory-check.ts`,
  `sanitize.ts`, `seed.ts`), and the tool directory below.
- Scenario 1 uses this machine's own Homebrew Bun (`/opt/homebrew/bin/bun`, or
  `REHEARSAL_OTHER_BUN`) as the operator's "other" Bun.
- Free space: see "Running it".

## What stays local

- **Ports: the template is the protection.** [`lima.yaml`](lima.yaml)
  forwards two host ports, both on 127.0.0.1: the guest's SSH on 56022 and the
  guest's Caddy (443, the public signaling port) on 56443. Two rules after the
  forward ignore every other guest port, TCP and UDP, one for ports bound on
  the guest's loopback and one for its other addresses: Lima appends its own
  rule that forwards a port bound on the guest's 127.0.0.1 to the same port
  on the host's, and on Lima 2.3.0 a `guestIP: 0.0.0.0` rule does not cover the
  guest's loopback (Lima's own template says it does; on 2026-11-26 the guest's
  Caddy admin port reached the host's 127.0.0.1:2019 that way, before the
  loopback rule was added). The contract test evaluates the rules against every
  bind form the host agent reported (guest 127.0.0.1, ::1, ::, 0.0.0.0 and
  specific addresses, TCP and UDP), reading each rule both ways where Lima's
  documentation and 2.3.0 differ, and fails if any could reach a host port
  below 5000 or a host address other than 127.0.0.1. Lima's host agent also
  listens on 127.0.0.1 on two random high ports (TCP and UDP) for the guest's
  DNS.
- **The watch is a backstop.** [`watch.sh`](watch.sh) runs for the whole run in
  its own process group. Every 10 seconds it reads limactl's listening TCP
  sockets and unconnected UDP sockets (`lsof`) and the free space (`df`), and
  stops and deletes the instance at once if a limactl socket is below port 5000
  or off 127.0.0.1, if free space is below 8 GiB, or if a probe errors or prints
  nothing it can read. `run.sh` checks the watch's heartbeat before every Lima
  command, playbook and guest command, and stops the run (deleting the
  instance) when the watch has tripped, is gone, or has not written a heartbeat
  for three periods. The watch cannot see a socket that opens and closes
  between two passes, or one held by a process other than limactl; on a host
  with no listening TCP socket at all it trips, because it cannot tell that
  from a failed probe.
- **Connections.** Nothing `run.sh` hands to Ansible may send a connection
  anywhere but 127.0.0.1 on the instance's SSH port. Before anything else,
  `run.sh` refuses: a caller environment with any `ANSIBLE_*` variable (or
  `LIMA_*` but `LIMA_HOME`); the production inventory path, by name, without
  opening it; any inventory but this directory's [`inventory.yml`](inventory.yml);
  and, through [`inventory-check.ts`](inventory-check.ts), anything outside
  its allowlists. A host sets exactly `ansible_host` 127.0.0.1, `ansible_port`
  56022 and `ansible_user` p2party; groups set only `ansible_python_interpreter`,
  `ansible_become` and `ansible_become_method`, with production's values; every
  other `ansible_*` variable, and every variable on ansible-core 2.22.0's own
  list of connection variables ([`ansible-connection-variables.json`](ansible-connection-variables.json):
  what its `local`, `psrp`, `ssh` and `winrm` plugins read, from
  `ansible-doc -t connection -j`, and `constants.MAGIC_VARIABLE_MAPPING`), is
  refused, as are an empty inventory, a host named `localhost` and a symbolic
  link. [`vars.yml`](vars.yml), passed with `-e`, may set `*.localhost`
  names under `domains` and the Bun archive mirror at `http://127.0.0.1:18641` inside the guest; the other `-e` values `run.sh` passes come from a
  two-name list. [`ansible.cfg`](ansible.cfg) may hold only listed keys, and
  its `ssh_args` only listed options with `-F /dev/null`. With a repository,
  those files and the guards must equal its `HEAD` byte for byte. Before the
  first play, `ansible-inventory --host` must resolve every host to
  127.0.0.1:56022. Every Ansible command runs through
  [`play-env.sh`](play-env.sh), under `env -i` with only the harness's own
  variables, and with [`ssh-guard.sh`](ssh-guard.sh) first on `PATH` as `ssh`,
  `scp` and `sftp`: it runs `/usr/bin`'s program only for 127.0.0.1 on port
  56022 as p2party, with `-F /dev/null` and options from its allowlist, so a
  value from the commit's own playbooks is checked where the connection is
  made. The tool directory may hold no connection library (paramiko, winrm,
  psrp) that would connect without the ssh binary.
- **Files.** `mounts: []` and no base template, so the guest sees no host
  directory. The only share is Virtualization.framework's Rosetta runtime,
  which runs the x86-64 artefact. `networkOpts.hostLoopback: false`: the guest
  cannot reach services on the host's loopback. `propagateProxyEnv: false`, no
  `env` and no `copyToHost`.
- **Network.** User-mode networking only. A boot script masks the image's own
  background services that contact Canonical (snap store, MOTD and apt news,
  Ubuntu Pro, firmware metadata, entropy seeding, NTP) and the unattended apt
  timers. What leaves the VM is Ubuntu's package mirrors, the npm registry (the
  playbooks' frozen install) and Prisma's engine download, which that install's
  `@prisma/engines` postinstall makes.
- **Names.** `vars.yml` replaces the public names with `*.localhost` ones (as
  extra vars: the playbooks' `vars_files` outrank every inventory variable).
  Caddy then issues its certificate from its own local CA, and no name reaches
  a public CA.
- **Secrets** are generated for each new instance under the work directory
  (`secrets/`, mode 0700, files 0600): an SSH key, the vault password and the
  vault (encrypted with it). The baseline snapshot keeps a copy, since its
  disk holds the same database password and key. They are deleted with the
  instance, and the snapshot's copy by `clean`.
- **Result files** are written only through [`sanitize.ts`](sanitize.ts):
  every secret the harness generated is replaced, in plain text and as base64,
  base64url, hex and percent-encoding, by `<redacted>`; this machine's paths,
  user name and host name by `<work>`, `<tools>`, `<repo>`, `~`, `<user>` and
  `<host>` (also as Ansible prints them once it masks a vaulted value inside
  them); every PEM private-key block by a placeholder. It does not cover a
  secret made inside the guest that a playbook prints, a secret split across
  lines, or another encoding. The raw logs stay in the work directory until
  `clean`.

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
| The host's Bun from Bun's online installer                       | Release 0.1.4 uses its original worker-home Bun 1.3.14. The candidate downloads and verifies its pinned archive from the guest-local mirror and installs the managed runtime. The migration tooling therefore installs the arm64 packages (`@typescript/typescript-linux-arm64`, Prisma's `linux-arm64` engine)                                                                                                     |
| Release 0.1.4's binary, built with whatever Bun the operator had | Built from `ecf691a` with the pinned Bun of the commit under test (0.1.4 pins 1.3.14, of which there is no checksum-verified macOS copy here)                                                                                                                                                                                                                                                                       |
| `deploy/deploy.sh`                                               | The same `ansible-playbook` command with the rehearsal inventory, `vars.yml` and vault (`deploy.sh` names the production inventory)                                                                                                                                                                                                                                                                                 |
| The operator's checkout                                          | A `git archive` of the commit, given that commit's git metadata (`deploy.yml`'s build record runs `git rev-parse HEAD` in the tree); the upgrade mode also runs once from a plain archive                                                                                                                                                                                                                           |
| Prisma's usage report from the migrate task                      | `CHECKPOINT_DISABLE=1` for every session in the guest and the name pointed at nothing                                                                                                                                                                                                                                                                                                                               |

## Tools

`REHEARSAL_TOOLS` names a directory laid out as below. `run.sh` checks the
four binaries and the Linux arm64 release archive against [`tools.sha256`](tools.sha256) before every run.

| Path                                                   | What and from where                                                                                                                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun-1.4.5/bun`                                        | Bun 1.4.5 for macOS: `bun-darwin-aarch64.zip` of the GitHub release, SHA-256 `b5d6bc2e…cd10` as in its `SHASUMS256.txt`                                                                                                      |
| `bun-linux-x64-1.4.5/bun`                              | The `bin/bun` of the npm package `@oven/bun-linux-x64@1.4.5`, its tarball checked against the registry's `sha512-IWX9BELo…` integrity; byte for byte the runtime `bun build --compile --target=bun-linux-x64-modern` fetches |
| `bun-linux-aarch64-1.4.5/bun`                          | The `bin/bun` of `@oven/bun-linux-aarch64@1.4.5` (`sha512-4BXmsSKn…`): the host's Bun after the README's install step                                                                                                        |
| `bun-linux-aarch64-1.3.14/bun`                         | Likewise `@oven/bun-linux-aarch64@1.3.14` (`sha512-X5SsPZHs…`): release 0.1.4's Bun, for the baseline's host                                                                                                                 |
| `bun-linux-aarch64-1.4.5/bun-linux-aarch64.zip`        | Official Linux arm64 release archive. The guest-local mirror serves these bytes to the production installer. Its SHA-256 is the signed upstream release hash pinned in the playbook.                                         |
| `venv/`                                                | A Python virtual environment with `ansible-core==2.22.0` from PyPI                                                                                                                                                           |
| `collections/ansible_collections/community/postgresql` | `community.postgresql` 5.1.1, extracted from PyPI's `ansible-15.0.0-py3-none-any.whl` (which requires ansible-core 2.22)                                                                                                     |

`lima.yaml` pins the Ubuntu 24.04 image by its dated release URL and the
SHA-256 from that release's `SHA256SUMS`; Lima checks it on download.

## Running it

```bash
export REHEARSAL_REPO="$PWD" REHEARSAL_TOOLS=/path/to/tools REHEARSAL_WORK_DIR=/path/outside/the/repo
deploy/rehearsal/run.sh vm-check      # optional: the template, the watch and the SSH guard on this host
deploy/rehearsal/run.sh baseline      # once: the snapshot every other mode starts from
deploy/rehearsal/run.sh upgrade
deploy/rehearsal/run.sh scenario-3    # and so on; see run.sh --help
deploy/rehearsal/run.sh clean         # or clean-all
```

Run it from an archive copy of the repository rather than the working tree.
`--commit` names the commit under test (default: the repository's `HEAD`),
`--baseline-commit` the release installed first (default `ecf691a`, release
0.1.4) and `--other-commit` scenario 8c's other commit (default `35d94c8`).
Every mode deletes the instance, and with it the instance's secrets, at the
end unless `--keep` is given; an interrupted run (Ctrl-C, SIGTERM) ends every
process it started and says what it left on disk. The work directory must be
absolute, outside the repository and the home directory, and either new or
made by `run.sh` (it holds `.p2party-rehearsal-work`); nothing is deleted
anywhere else.

Disk, measured on 2026-11-26 (`du`): at its peak a run holds the instance's
disk (up to 4.2 GiB of an 8 GiB sparse file), the one snapshot of the baseline
(3.7 GiB; an APFS clone, so the instance shares its blocks until they
diverge), one tree each for the baseline and the commit under test (0.5 GiB
each, with their `node_modules`), Bun's package cache (0.7 GiB) and Lima's
copy of the image in its own cache (2.4 GiB: the 0.6 GiB download and its
converted raw form): about 12 GiB. The tools take another 0.4 GiB. So the
instance is created or started only with 20 GiB free (that peak plus the
8 GiB abort floor), and the watch deletes it at once below 8 GiB. Between modes
the snapshot, the trees, the package cache and Lima's image stay (about
7.8 GiB). `clean` deletes the instance, the snapshot and its secrets, the
trees, the package cache and the raw logs, and keeps the sanitized results;
`clean-all` also deletes the results, the work directory, and the image in
Lima's cache when `run.sh`'s own create downloaded it (it records that at the
time), leaving every other cached image alone.

## Results

The result files are under [`results/`](results/), one directory per date.
Each names the commit it ran against. The committed copies were formatted
with the repository's Prettier, which changes only the fence markers, trailing
spaces, blank lines and apt's carriage-return progress lines in the recorded
output. The runs of 2026-11-26, in short
(the defects are listed in the task report that goes with them, for the
follow-up task; no playbook was changed here):

| Run                                              | What happened                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline (0.1.4 from `ecf691a`)                  | `install-postgres.yml` and `deploy.yml` passed; `initial-setup.yml` ends in failure on its last task (`git_commit` is undefined), after doing everything else. 0.1.4 served through Caddy and on 127.0.0.1:56443                                                                                              |
| Upgrade                                          | Passed. All five migrations applied; every seeded row as the re-key intends. Health still reports version 0.1.4 (`package.json` is unchanged). From a plain `git archive` the deploy stops at its build record (`git rev-parse HEAD`), before any host changes                                                |
| 1. Another Bun on the operator's PATH            | Refused by the local pre-flight; nothing on the host changed; 0.1.4 kept serving; the README's next step worked                                                                                                                                                                                               |
| 2. Another Bun on the host                       | Refused by the host's Bun check before `postgres-tls.yml`; nothing on the host changed; 0.1.4 kept serving; installing the pin and running again worked                                                                                                                                                       |
| 3. A migration fails before the re-key           | The migration waited on the lock with no timeout until its session was terminated. `migrate status` then named no failed migration, so the README's steps say there is nothing to resolve, and the next deploy failed with P3009 naming it                                                                    |
| 4. A migration fails after the re-key            | The same wait. The re-key was applied and the next migration failed; here `migrate status` named it, and the README's recovery (resolve as rolled back, run again) worked. `initial-setup.yml` refused to start the unit while the marker existed                                                             |
| 5. The new binary will not start                 | The deploy reported the server's own error after the migration and the cutover; nothing served until the value was fixed and the deploy run again. The README is silent on this case                                                                                                                          |
| 6. A second run after a success                  | Passed; it stops and restarts the worker even with nothing to change (10 tasks changed)                                                                                                                                                                                                                       |
| 7. A second run after each failure               | In each result file of 1–5 and 8                                                                                                                                                                                                                                                                              |
| 8. `--skip-build` with another commit's artefact | 0.1.4's binary without a record, and with another binary's record: refused on the control machine, nothing on the host changed. Another commit's binary with its own record: accepted (the record's commit is not compared, as the README says)                                                               |
| Fresh install (`site.yml`)                       | `site.yml` (without its coturn tag: coturn and Caddy both need 443 and share this VM) provisioned PostgreSQL and the signaling host and ended on the same `git_commit` failure; `deploy.yml` then passed; `setup-coturn.yml` installed its checked configuration and coturn could not bind 443, held by Caddy |
