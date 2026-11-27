# Deploying p2party-server

The reference deployment uses one signaling worker, PostgreSQL, Caddy and
coturn. Copy the tracked example inventory and vault files to their ignored
operational paths, encrypt the vault, and configure SSH access before deploying.
Never commit the resulting credentials, inventory, Terraform state or logs.

For supported Ubuntu upgrades and controlled host reboots, see [Ubuntu package maintenance](ansible/fleet-maintenance.md).

Run a release from a Git checkout of the server repository:

```bash
ansible-galaxy collection install -r deploy/ansible/requirements.yml
bun install --frozen-lockfile
bun run check
bun run format:check
./deploy/deploy.sh
```

The wrapper builds this repository's Linux binary, provisions verified database
TLS, then on the signaling host:

1. prepares the release while the old one keeps serving: installs migration
   tooling from this release's `package.json` and `bun.lock` (a registry
   fetch), copies the schema and migrations, stages the new binary, its
   environment and units in `/var/lib/p2party-release-staging/`, and
   validates the candidate Caddy configuration. For each configured port,
   systemd loads the staged environment and runs the staged binary's
   `--check-config` as the service account with network access isolated.
   A failure stops the deploy here. Check the workers' current health and
   the failed task. Earlier TLS provisioning may already have run;
2. writes `/var/lib/p2party-migration-failed`, then stops and disables every
   signaling worker (`p2party-signaling*.service`) before changing the schema;
3. applies pending migrations as the service account. PostgreSQL allows 10
   seconds to acquire a lock and 120 seconds for each statement. systemd
   allows 300 seconds for the full CLI run, then terminates the process group
   and kills any survivors after 10 seconds;
4. only if they succeed, installs the staged binary, environment file and
   units, removes the marker, installs the Caddy configuration, then enables and
   starts the desired workers and verifies their version through Caddy.

With several signaling hosts, a failure on one ends the play on all of them
(`any_errors_fatal`), so no migration runs while a worker anywhere still serves.
Clients are cut off from step 2 until the new workers start. The migration CLI
lives under the root-owned `/var/lib/p2party-migration-tooling` directory; it is installed from the
release's audited `package.json` and frozen `bun.lock` rather than fetched as an
independent CLI dependency tree. Its working directory remains the server
directory containing `prisma.config.ts` and `prisma/`.

The binary also checks the schema itself. Before it opens its listener it reads
Prisma's migration history, on its own connection, within 8 seconds, and exits
with one `p2party: refusing to start` line when the database does not answer,
cannot be reached, is empty, lacks a migration the build ships, has one it does
not ship, or holds a failed migration. It then re-runs the identity re-key
statement within its own bound of 60 seconds (normally a no-op); a re-key that
runs past it is cancelled, changes nothing, and ends the start with the same
kind of line. A lost connection can leave the result unknown. Once the
database is reachable the idempotent re-key can run again. The service
retries after 5 seconds with no fixed retry count. The deploy waits up to
113 seconds per worker for the schema check, re-key, LISTEN setup and restart.
Once LISTEN is ready, cleanup of expired routing state runs in the background;
a failed pass retries after 30 seconds. The worker pool allows 5 seconds to
acquire a connection, 8 seconds per SQL statement and 10 seconds to receive
its response.

Deploy server 0.2.0 before SDK 0.15.0. Verify that every direct
worker and the public `/health` endpoint report `version: "0.2.0"` and
`protocolVersion: 5` before updating clients. The signaling environment sets `SIGNALING_HOST` to the public
WebSocket authority from `domains.signaling`. Clients include this authority
in the login signature.

## Public testnet release

Ledger validation is optional in 0.2.1. To enable P2Party Testnet 1, add these variables under `signaling_production.vars` in the private operational inventory used by both setup and release. Replace the two controller source paths with absolute paths to the reviewed files. Keep the same configuration for subsequent releases. [Public genesis](https://p2party.com/downloads/testnet-1/genesis.json) · [Grant procedure for operators](testnet/README.md) · [Native Linux build](https://github.com/p2party/libdemos/actions/runs/46044375561)

```yaml
ledger_enabled: true
ledger_chain_id: "0x09a0ffa8e6af6aeb11d26671c6c76648965d60509cc3b7a1a4b454b6ec73c760"
ledger_rpc_chain_id: 1345474644
ledger_cors_origins: ["*"]
ledger_verifier_src: "/absolute/path/to/demos-ledger-verify"
ledger_verifier_source_commit: "fc8db3f038a8f7200dd5b0b188cc5eeee9473459"
ledger_verifier_sha256: "80be8acb4ee84b6c0c39159fe30fce2b8c10c341e8d2a086a943642ebfb689b1"
ledger_genesis_src: "/absolute/path/to/p2party-server/deploy/testnet/genesis.json"
ledger_genesis_sha256: "38d42d50a5a6d5ceb43fd6f63235e542716b1df5ccff59161c5fd7810aed17c6"
```

The native release workflow tests the shipped binary, including failure of its signature provider. The signaling CI runs its PostgreSQL, worker and wallet integration tests with both the production verifier and the previous v1 helper.

The play checks the controller files, installs them beneath root-owned, content-addressed paths in `/opt/p2party-ledger`, and exercises both signature suites as the worker. The staged binary checks its environment offline. A separate read-only database preflight checks initialization permission on a new node, or the stored chain identity and table access on an existing node. Both run before workers stop. Successful startup initializes or reopens the durable `p2party_ledger` schema. Include it in database backups. The release then checks `/rpc/health` through each worker and Caddy. Disabling the option on a subsequent release closes the routes and preserves stored history. [RPC limits and configuration](../src/ledger/README.md)

## Which Bun, and where it is checked

`package.json`'s `packageManager` is the one place the Bun version is written
(`bun@1.4.5`); CI's `setup-bun` reads it from there (`bun-version-file`), and
`group_vars/all/vars.yml` reads it into `bun.version`. Bun itself does not
enforce `packageManager` or `engines`, so `deploy.yml` requires that exact
version in three checks that run before it changes anything on any host, in
this order, and compares the staged binary afterwards:

1. **On the control machine.** `playbooks/local-preflight.yml`, the first play
   of every playbook here, requires `bun --version` on `PATH` to equal the pin,
   because `bun build --compile` embeds the Bun that runs it, and refuses a pin
   for which `bun.release_sha256` records no hashes. It also requires the
   ansible-core these playbooks were tested with: `ansible_core_tested`
   (2.22.0) or a later patch release of that minor line, below 2.23. Its tasks
   run once, on this machine only, without facts; the play also matches every
   host of the run, so a `--limit` that leaves `localhost` out does not skip
   it. It runs with `--skip-build` too.
2. **The binary's build record**, `deploy.yml`'s second play, also on this
   machine only. The build installs dependencies from the frozen lockfile before
   compiling so an older local installation cannot enter the binary. It then writes a record beside
   the binary, `builds/p2party_linux_x64.build.json`: the Bun that built it
   (the pre-flight has just required the pin), the commit, whether the tree
   had changes (`dirty`), and the binary's SHA-256. Every deploy then requires
   that the record exists and is valid JSON, matches the binary's SHA-256 and
   names the pin; a binary built by hand, rebuilt after its record, or built
   with another Bun is refused, and so is a missing or damaged record. A
   `--skip-build` deploy also requires both the recorded and current worktrees
   to be clean and their commits to match. Before provisioning, a currently
   serving package version must match the candidate binary byte for byte.
   Use a new version for changed bytes. After restart, the deploy hashes the
   installed file and each systemd worker's live executable before checking
   its health response.
3. **The signaling host runtime** comes from the pinned Linux release archive
   for the host architecture. Preparation checks its SHA-256 against the table
   below and runs the installed binary as the worker to verify its version.
   The package installer has a separate unprivileged account and cache. It
   downloads dependencies from the npm registry, the pinned `@ondemos/core` tarball
   from GitHub Releases, and Prisma's engine from `binaries.prisma.sh`. It has no database environment or credentials.

Then, in the deploy play's prepare block, after the binary is staged and before
any worker is stopped, the staged file's SHA-256 (read with `stat`, symlinks not
followed) must equal the built binary's. Root owns the staging directory and
its parent. The service account can traverse the directory and execute the
binary. systemd reads the root-only environment file before starting it.
Configuration validation checks the PostgreSQL URL and CA file, signing
authority, TURN secret length when configured, port and admission limits.
The check exits before opening a connection or changing the schema.

To install the pinned Bun on the signaling host, download the release zip for
its architecture and check it before unpacking. The SHA-256 values for
`bun-v1.4.5` come from that release's `SHASUMS256.txt.asc`, whose signature is
good for "Robobun <robobun@oven.sh>", key fingerprint
`F3DCC08A8572C0749B3E18888EAB4D40A7B22B59` (checked on 2026-11-26 in an empty
keyring, with the key from <https://github.com/robobun.gpg>; `robobun` is the
account that publishes the Bun releases, and GitHub lists that key,
`8EAB4D40A7B22B59`, for it):

| Bun     | Zip                     | SHA-256                                                            |
| ------- | ----------------------- | ------------------------------------------------------------------ |
| `1.4.5` | `bun-linux-x64.zip`     | `94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb` |
| `1.4.5` | `bun-linux-aarch64.zip` | `18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84` |

Initial setup and deploy install the verified executable at
`/opt/p2party-bun/1.4.5/bin/bun`. When changing Bun, update the two archive
hashes in `group_vars/all/vars.yml` and this table. An offline site can set
`bun_release_base_url` to an archive mirror with the same directory layout.
The mirror must serve the exact signed-release bytes.

`bun.lock` is Bun's text lockfile with `lockfileVersion` 2. In a local test Bun
1.4.0 installed from it and Bun 1.3.14 refused it (`UnknownLockfileVersion`).

## Host software

Host distribution packages keep receiving vendor security updates.

- **Bun** is installed by the pinned, checksum-verified archive task shared
  by signaling setup and deployment.
- **Caddy** (signaling host): the `caddy` package from Caddy's Cloudsmith
  `stable` repository. Caddy 2.11.9, the latest release on 2026-11-26
  (checksum-verified), accepts the rendered `templates/Caddyfile.j2`
  (`caddy validate`), and a silent WebSocket through its `reverse_proxy` block
  stayed open for 75 seconds on 2.11.9; 2.11.6 introduced one-minute stall
  timeouts. Since 2.11.6 Caddy also answers 431 to request headers over 16 KiB.
- **coturn** starts with Ubuntu's package at first boot. The setup playbook builds
  upstream 4.19.2 as a native Noble package. The builder verifies the pinned
  upstream source and Ubuntu packaging hashes, compiles in a temporary chroot
  and runs the upstream protocol tests while the relay continues serving.
  On existing hosts, run `playbooks/upgrade-coturn.yml` with the production
  inventory and vault. Use `--tags prepare` to build and `--tags activate`
  to install the package. Activation saves the previous package and protected
  configuration, restarts coturn, checks its executable, TLS and STUN, and
  restores the previous installation if a check fails.
- **PostgreSQL** on new database hosts uses the signed PGDG `postgresql-19`
  package. Upgrade an existing PostgreSQL 17 cluster during a separate
  maintenance window. [PostgreSQL major upgrade and recovery](postgresql-upgrade.md)

### First exercised at the release deploy

These parts of this release could not be run on the hosts before the deploy,
only locally as described:

1. The checks above. Locally, the pre-flight ran against this machine (also
   under a `--limit` that leaves `localhost` out, with a stand-in host that
   was never contacted), the host check against a scratch home (passing for
   1.4.5, refusing 1.4.4 and a missing Bun), and the build-record and
   staged-hash tasks, taken verbatim from `deploy.yml`, against a scratch
   repository and staging directory (refusing a missing, truncated or stale
   record, a binary built with 1.4.4 and a staged symlink); on the signaling
   host they have not run.
2. The migration tooling install now includes TypeScript 7, a native compiler shipped as one
   package per platform (`@typescript/typescript-linux-x64` on the host), since
   the tooling installs development dependencies.
3. Prisma 7.10.1's `migrate deploy`, run by the host's Bun, on a database whose
   migration history Prisma 7.9.0 wrote. Locally, on PostgreSQL 18.7, 7.10.1
   applied this release's three migrations after 7.9.0 had applied 0.1.4's two,
   and `migrate resolve --applied` and `--rolled-back` behaved as described
   below. For the production database major upgrade, see the [database procedure](postgresql-upgrade.md).
4. The `p2party_linux_x64` binary. The deploy builds it with the control
   machine's Bun, which the pre-flight requires to be the pin, records that Bun
   beside it and stages it only if the staged bytes are the built ones. A
   linux-x64 build with the `build:linux` flags was made locally with Bun 1.4.5
   but not started; a macOS build with the same flags passed its schema check
   and answered `/health`.
5. `caddy validate` and the reload on the host's own Caddy version.
6. On the operator's machine: `prisma generate` inside `bun run build:linux`
   runs under the `node` on `PATH` when there is one (Prisma's command starts
   with `#!/usr/bin/env node`; without one, Bun runs it). Prisma 7.10.1 needs
   Node 20.19 or a later 20.x, 22.12 or a later 22.x, or 24.0 or newer; this
   release was built with Node 26.13.1. Every playbook now requires
   ansible-core 2.22.0 or a later 2.22 patch release (the pre-flight).
7. The next `./deploy/tf init -upgrade` and plan against the real state, with
   hcloud 1.70.2 and Cloudflare 5.29.0. Local tests use isolated provider mocks and synthetic state. See
   [Terraform after this release](#terraform-after-this-release) first.

## A failed or interrupted migration

When `prisma migrate deploy` fails or is interrupted, the play ends with
"Report the failed migration and how to recover", whose message is the steps
below. Every signaling worker is then stopped and disabled, and the previous
binary is still in place, so nothing serves. The migrate task is hidden from the
Ansible output. systemd reads the database URL from a root-only environment
file on the host. The play writes Prisma's output to
`/var/log/p2party-migration-failure.log`, readable by root only, with the
database password replaced by `<redacted>`. The log can contain database row
values. A migration that timed out can have committed statements. Inspect its
history before choosing a recovery command. A successful deploy removes both
staged environment files and any previous migration error log.

Prisma does not run a migration in a transaction, and a statement can commit
without Prisma recording the migration as finished. Each migration this release
adds runs again cleanly after a failure at any statement: the index and the
claim-owner columns are created only if missing, and the re-key is one
idempotent statement (`tests/db/migrationRerun.throwaway.test.ts` checks every
statement boundary). The two migrations released in 0.1.4 are unchanged.

1. Read why it failed: `sudo cat /var/log/p2party-migration-failure.log` on the
   signaling host and, when Prisma recorded a failed migration, that row's
   `logs` column in `"_prisma_migrations"`.
2. Fix the cause: a lock another session held, the database unreachable, a full
   disk.
3. Once the deploy and its migration have stopped, inspect the migration
   history on the PostgreSQL host. Open the application's database using
   the configured port and database name (shown here with the example values):

   ```bash
   sudo -u postgres psql -X -p 5432 -d p2party
   ```

   ```sql
   SELECT migration_name FROM public._prisma_migrations
   WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at;
   ```

   `migrate status` can show later pending migrations and omit the failed
   one. A successful query returning zero rows means there is no unfinished
   migration to resolve. If the history table is absent, confirm the target
   database and that the first migration never started. A connection or
   permission error must be corrected before deciding.

   For each unfinished migration added in this release, use its exact name
   on the signaling host, as `p2party`, from `~p2party/server`, with
   `DATABASE_URL` exported as the play builds it:

   ```bash
   /opt/p2party-bun/1.4.5/bin/bun /var/lib/p2party-migration-tooling/node_modules/prisma/build/index.js \
     migrate resolve --rolled-back <migration name>
   ```

   The next deploy runs that migration again. For a failed migration from
   0.1.4, check and reconcile any partial effects before retrying. Use
   `migrate resolve --applied <migration name>` only after verifying that
   every statement took effect.

4. Run `./deploy/deploy.sh` again. It applies the migration and only then
   installs and starts the new binary.

From the moment a deploy starts stopping workers until it has installed the new
binary, and after any failure in between, the file
`/var/lib/p2party-migration-failed` exists on the signaling host and holds these
steps (or, if the deploy ended after a successful migration, an instruction to
run it again). `playbooks/initial-setup.yml` (also run by `site.yml`) refuses to
enable or start a signaling unit while it exists, and prints it, although it
still renders `.env` and the unit files first; a deploy that installs the new
binary removes it. A partial worker stop or interrupted install has its own
recovery message. Inspect the affected units, fix the failed task, and rerun
`./deploy/deploy.sh` to finish the cutover.

**Returning to 0.1.4.** The migration failure marker records the history check,
the previously running units and the original binary's SHA-256 when verified.
If both 0.1.4 migrations completed, **no re-key or later migration ever started**,
and the previous 0.1.4 file is still installed, compare
`sha256sum ~p2party/server/p2party-server` with that recorded digest. Run the
marker’s `sudo systemctl enable --now <previous-unit...>` command on each
signaling host. Check every previous port with
`curl -fsS http://127.0.0.1:<port>/health`. Remove the marker only once each
worker again reports 0.1.4. Keep Prisma’s failed row for the next upgrade.
If the re-key or a later migration has a recorded attempt, the old binary
requires a verified pre-upgrade database restore and matching release. If
the state is unknown, keep workers stopped and perform forward recovery.

## Relay capacity

**The default TURN budget permits 48 ordinary concurrent allocations.**
The aggregate budget is 30,000,000 bytes/second and the per-allocation budget is
625,000 bytes/second. Ordinary clients reserve the per-allocation maximum even
when idle; input and output are counted separately. Set the Ansible variable
`coturn_bps_capacity` higher for larger relay-heavy rooms and apply
`playbooks/setup-coturn.yml`. Both bandwidth settings must be positive. Allocation
quotas remain 1,200 total and 12 per credential username, and an allocation
that is not refreshed is released within `coturn_max_allocate_lifetime` (600 s
by default). The playbook refuses settings where `coturn_user_quota` ×
`coturn_max_bps`, what one credential username can reserve, exceeds half of
`coturn_bps_capacity`.

coturn counts the quota per username, here the hourly tag, and checks a
username's expiry only on a session's first request (`check_stun_auth` in
`src/server/ns_turn_server.c`, coturn 4.6.1 and master `44fa529`). One identity
therefore holds at most three tags' quota at once if it stops refreshing, and
gains one more tag's quota every lifetime for as long as it keeps refreshing its
old allocations. The quota guards against one client's runaway use; it is not a
bound on an adversary, who can also simply use several identities. See "Relay
bound" in the root [README](../README.md#relay-bound), and its
[admission section](../README.md#admission-and-database-security) for
signaling admission defaults, trusted proxy handling and their overrides.

### Relay exhaustion

The relay's total capacity is the only hard limit: `total-quota` (1,200
allocations) and `coturn_bps_capacity` (30,000,000 bytes/second, 48 reserved
allocations at the default `coturn_max_bps`). Four identities with a full quota
each reserve all of it. Once it is reached, coturn answers new Allocate requests
with 486 ("Allocation Quota Reached" or "Allocation Bandwidth Quota Reached"),
and clients that need the relay cannot connect.

With this template an operator sees no sign of exhaustion on the TURN host: the
log goes to `/dev/null`, the telnet CLI is off (`no-cli`), and neither coturn's
`prometheus` exporter nor its `redis-statsdb` statistics are configured.
Diagnosing it means enabling one of them for the occasion, for example running
`turnserver` by hand with `--log-file=stdout`, or `--prometheus` without
username labels if the installed package was built with it. Clients report
relay failures before the host does.

Two mitigations were considered and not built:

- **Per-source-address limits at the TURN host's firewall**, for example
  nftables connection or rate limits on ports 3478 and 443. They cap what one
  address can open, but everyone behind one carrier-grade NAT or campus address
  shares the limit, and an adversary with many addresses is not slowed.
- **A stable per-identity tag with TLS-only TURN** (no plain `turn:` URL).
  coturn would pool the quota per identity and the pseudonym would cross the
  network only inside TLS. But the TURN host would hold a permanent pseudonym
  per identity, every relayed connection would move to TLS over TCP with its
  head-of-line blocking and connectivity cost, and an adversary with several
  identities would still not be bounded.

## Upgrading to 0.2.0

`deploy.yml` stops every 0.1.4 worker before it migrates, so no 0.1.4 worker
serves after the identity re-key. Where workers are run by other means, do the
same: stop every 0.1.4 worker before migrating and before the first 0.2.0 worker
starts, and run all workers under one database role. A 0.2.0 worker counts
another as live only through its named PostgreSQL session, which 0.1.4 does not
open, so it would clear a running 0.1.4 worker's routing claims.

## Database trust

`playbooks/postgres-tls.yml` creates a private database CA and a server certificate
with the configured private IP in its SAN. Only the public CA certificate is
copied to signaling hosts over SSH. PostgreSQL rejects plaintext private-network
connections before legacy HBA rules; clients use `verify-full` and the pinned CA.
The playbook checks certificate chain, IP, private-key match and expiry before
restarting services. Run provisioning monthly for leaf renewal. CA rotation is
explicit and requires protected operational backups of the CA key.

The first rollout changes database TLS configuration and may restart PostgreSQL.
Schedule that rollout accordingly. Local development uses the explicit
`sslmode=disable` URL in `.env.example`; production must retain verified TLS.

## Frontend response headers

[`terraform/p2party_frontend_headers.tf`](terraform/p2party_frontend_headers.tf)
manages the five response headers documented by the frontend: CSP,
Permissions-Policy, Referrer-Policy, HSTS and X-Content-Type-Options. The rule
matches only `p2party.com` until `frontend_response_headers_all_app_hosts` is
set (see [Frontend HTTPS and TLS](#frontend-https-and-tls)); signaling continues
to set its own headers in Caddy. Both management and activation default to
`false`, so an ordinary server deploy does not change the frontend edge policy.
The apex DNS record must be proxied through Cloudflare for the rule to run. This
rule is the only source of HSTS that Terraform manages; the zone HSTS setting
is left unmanaged on purpose (see [Frontend HTTPS and TLS](#frontend-https-and-tls)).

The configuration requires Terraform 1.17.2 or newer (`required_version` in
`terraform/p2party_main.tf`). `terraform test` runs the offline provider-mock
plans covering the default-off behavior, disabled initial rules, existing-rule
preservation, and that each opt-in changes only its own resource. Run them from
a clean copy of the committed tree. In `deploy/terraform` itself,
`terraform test` loads the ignored `terraform.tfvars`, whose rollout flags make
the default-off tests fail. From the repository root, after
`./deploy/tf init -upgrade` has installed the providers this configuration
names (the ignored `.terraform.lock.hcl` records the versions installed before;
`-upgrade` replaces them):

```bash
tf_test_dir="$(mktemp -d)"
git archive HEAD deploy/terraform deploy/ssh_public_keys | tar -x -C "$tf_test_dir"
cp deploy/ssh_public_keys/*.pub "$tf_test_dir/deploy/ssh_public_keys/"
terraform -chdir="$tf_test_dir/deploy/terraform" init -backend=false \
  -plugin-dir="$PWD/deploy/terraform/.terraform/providers"
terraform -chdir="$tf_test_dir/deploy/terraform" test
rm -rf "$tf_test_dir"
```

The copy holds no state, variables file or credentials, and every provider is
mocked, so nothing contacts Cloudflare or Hetzner.

The CSP permits same-origin scripts and WebAssembly compilation, without
allowing inline JavaScript. **Deploy and test a CSP-compatible frontend before
activating it.** Earlier prerenders contained inline React hydration scripts
that this policy blocks. Do not weaken `script-src` to make an older build pass.
Inline styles remain permitted for the frontend's existing React style usage.

Cloudflare has one zone entrypoint ruleset for
`http_response_headers_transform`; this Terraform resource owns its complete
rule list. Before enabling management:

1. Give the existing zone-scoped token **Zone → Transform Rules → Edit** in
   addition to its DNS permissions. The corresponding API permission is
   `Zone Transform Rules Write`; read access is required to inspect the phase.
   Keep the token in ignored `deploy/.env`, never a tracked Terraform file.
2. Inspect the response-header phase in Cloudflare and every Terraform state
   that might own it. The opt-in data source reads existing rules and refuses a
   differently named ruleset or any additional rule references. A 403 is an
   unresolved ownership check, not evidence that no rules exist.
3. If the phase is absent, set `manage_frontend_response_headers = true` in
   ignored `terraform.tfvars` while keeping `frontend_response_headers_enabled
= false`. If it exists, preserve its rules and reconcile ownership first.
   Importing a populated phase into this single-rule configuration and applying
   would otherwise remove its other rules; the precondition refuses that case.
   A phase already created from this exact configuration may be imported with
   `./deploy/tf import 'cloudflare_ruleset.frontend_response_headers[0]'
'zone/<zone-id>/<ruleset-id>'` after checking its contents.
4. Run `./deploy/tf init -lockfile=readonly`, `./deploy/tf validate`, then
   `./deploy/tf plan -out=tfplan`. Review the entire plan, including unrelated
   infrastructure drift, before applying it. Plan files and JSON plan output can
   contain credentials or infrastructure details; retain them only in ignored,
   private local storage. A newly created rule is disabled until activation.
5. Deploy the frontend build whose browser checks pass with these exact headers.
   Then set `frontend_response_headers_enabled = true`, review a fresh plan, and
   apply that reviewed plan. Verify all five headers on `/`, `/r`, and a blog
   route, then test a room join, text/file delivery and reload recovery against
   the public frontend.

For rollback, set `frontend_response_headers_enabled = false` and review/apply
the resulting rule update. Keep management enabled; `prevent_destroy` protects
the entire phase ruleset against accidental removal. A browser that already
received HSTS retains it until expiry, so disabling the rule does not undo that
browser policy immediately.

On 2026-09-09, after updating the token permissions, the response-header phase
was confirmed empty and frontend `deploy-2026-09-09.2` was verified live with
CSP-compatible prerenders. The reviewed full plan created the enabled ruleset:
one resource added, none changed or destroyed. Both flags are now enabled in
the deployment's ignored `terraform.tfvars`; the full post-apply plan reported
no changes and both checks passed.

Public browser checks confirmed all five headers on 15 pages and their assets,
with no CSP violations or uncaught page errors. Separate room checks passed
WebRTC text and byte-exact file delivery, reload recovery with the received
file retained, and same-identity tab replacement under the actual edge policy.

See Cloudflare's [response-transform API workflow](https://developers.cloudflare.com/rules/transform/response-header-modification/create-api/)
and the [version 5 provider ruleset schema](https://registry.terraform.io/providers/cloudflare/cloudflare/5.29.0/docs/resources/ruleset).

## Terraform after this release

This release requires Terraform 1.17.2 or newer, moves hcloud to `~> 1.70` and
Cloudflare to `~> 5.29.0`, and no longer names the `hashicorp/null` provider,
which no resource here uses. Before the first `./deploy/tf init -upgrade`:

1. Back up the state (`deploy/terraform/terraform.tfstate`) to private storage.
2. Check that the state holds no instance of that provider:

   ```bash
   ./deploy/tf state list | grep -E '(^|\.)null_'
   ```

   If this prints nothing, continue with `./deploy/tf init -upgrade` and a
   reviewed plan. If it prints anything, stop, and do not plan or apply: those
   instances are in the state but in no configuration. Terraform keeps the
   `null` provider required by the state, installs it without a version
   constraint, and the next plan destroys them. A `null_*` resource has nothing
   outside Terraform, and with its resource block gone none of its destroy-time
   provisioners run (Terraform's provisioner documentation, "Remove a resource
   block containing a destroy-time provisioner"), so the deliberate way out is
   to remove each one from the state, address by address, after reading it:

   ```bash
   ./deploy/tf state show '<address>'
   ./deploy/tf state rm '<address>'
   ```

   Then list the state again (it must print nothing) and continue.

## Cloudflare provider 5

The server uses Cloudflare provider 5.29.0. The six DNS record addresses
have Terraform `moved` blocks. Their fully qualified DNS names, addresses,
TTL and proxy settings are preserved. The two phase rulesets retain their
resource addresses. Each opted-in phase lists zone rulesets, reads their
rules by ID and blocks the plan when another owner or rule is present. A
synthetic migration from the 4.52.10 schema preserved all six DNS IDs and
the header ruleset with all five policies. Both plans produced zero creates,
changes or deletes. A loopback API fixture added a dashboard rule and the
real 5.29.0 provider refused the plan.

**Existing state.** Use the current 4.x checkout for the following inventory
before switching to the new configuration. Keep the backup private. Terraform
state can contain credentials.

```bash
umask 077
backup="$(mktemp ~/p2party-before-cloudflare-v5.XXXXXXXX)"
./deploy/tf state pull > "$backup"
test -s "$backup"
./deploy/tf state list
```

1. Record the IDs and current values of the managed Cloudflare DNS records
   and rulesets. If `cloudflare_zone_settings_override.frontend_tls[0]`
   exists, read its `initial_settings` using
   `./deploy/tf state show 'cloudflare_zone_settings_override.frontend_tls[0]'`.
   Save the original `always_use_https` and `min_tls_version` values in
   `frontend_tls_previous_settings` in the private variables file. Confirm the
   current values in Cloudflare. If the originals cannot be established,
   reconcile that state before migrating.
2. For a state containing the old TLS override, remove only its Terraform
   ownership with the **4.x** checkout. This command leaves the zone settings
   in place. A state with no override skips this command and both imports.

   ```bash
   ./deploy/tf state rm 'cloudflare_zone_settings_override.frontend_tls[0]'
   ```

3. Switch to this checkout and run `./deploy/tf init -upgrade` and
   `./deploy/tf validate`. For a previously managed override, keep
   `manage_frontend_tls_settings = true` and import the two existing
   settings. Use the actual zone ID.

   ```bash
   ./deploy/tf import 'cloudflare_zone_setting.frontend_tls["always_use_https"]' '<zone-id>/always_use_https'
   ./deploy/tf import 'cloudflare_zone_setting.frontend_tls["min_tls_version"]' '<zone-id>/min_tls_version'
   ```

4. Save and review a normal refreshed plan against the actual state. Confirm
   each existing DNS ID moves in place, existing rulesets retain their IDs,
   and no DNS record, ruleset or unrelated host is created, replaced or
   deleted by the provider migration. Review any changes separately before
   applying that saved plan. Restore the state backup only after reconciling
   remote changes and acquiring the normal state lock.

The v5 setting resource leaves the remote value in place on deletion. The
configuration restores both original values when the operator sets
`manage_frontend_tls_settings = false` while keeping
`frontend_tls_previous_settings`. A never-managed zone keeps that object
null. Destruction is protected against accidentally clearing both inputs.

## Frontend HTTPS and TLS

On 2026-09-09 the apex and dev answered 200 over plain HTTP, www redirected
both HTTP and HTTPS requests to `http://p2party.com/`, and apex, www, cdn and dev
accepted TLS 1.0 and 1.1. On 2026-11-26 the apex still answered 200 over HTTP
and `https://www.p2party.com/` still redirected to `http://p2party.com/`. The www
redirect comes from the www S3 bucket, not from Cloudflare.
[`terraform/p2party_frontend_tls.tf`](terraform/p2party_frontend_tls.tf) and
the header rule above declare the fix in three opt-ins, each defaulting to
`false` so an ordinary server deploy changes none of it:

- `manage_frontend_www_redirect`, then `frontend_www_redirect_enabled`: a
  single-redirect rule sends every `www.p2party.com` request to
  `https://p2party.com` with the same path and query (301), at the edge, before
  the request reaches the bucket. Browsers keep the URL fragment, so an
  invitation's capability survives the redirect. The rule is created disabled;
  the second flag activates it.
- `manage_frontend_tls_settings`: Always Use HTTPS on and minimum TLS 1.2, as
  zone settings, so they apply to every proxied record in the zone, including
  any added after 2026-09-09 (then: apex, www, dev, cdn). Takes effect on apply.
- `frontend_response_headers_all_app_hosts`: the existing header rule matches
  `p2party.com`, `www.p2party.com` and `dev.p2party.com` instead of the apex
  only. cdn is excluded: it serves SDK files to other sites.

**HSTS has one source, the header rule.** The zone HSTS setting is not managed
here and should stay off in the dashboard. Cloudflare's public documentation
gives no accepted range for that setting's max-age, so the rule's two-year value
could fail part-way through an apply. It also does not say what happens when a
response already carries `Strict-Transport-Security`, so two values could be
sent. As a result cdn sends no HSTS header of its own. Browsers that have
visited the apex over HTTPS apply its `includeSubDomains` to cdn as well.

**What this does not fix.** The four proxied hostnames are CNAMEs to S3 website
endpoints, which serve HTTP only and do not listen on port 443. Cloudflare
therefore fetches every page and script from S3 over unauthenticated HTTP across
the internet. Anyone on that path can read or replace the app's JavaScript
before Cloudflare serves it over HTTPS. These settings protect only the hop
between the visitor and Cloudflare. Closing the other hop needs an origin that
terminates TLS with a certificate Cloudflare verifies, and then the zone SSL
mode set to Full (strict). One option is a TLS-terminating CDN in front of the
bucket, for example CloudFront with origin access. That requires the S3 REST
endpoint instead of the website endpoint, which loses the website endpoint's
index documents and redirect rules, so `/r`, directory indexes and the www
redirect must then be handled by CloudFront or Cloudflare rules. The other is
serving the files from Cloudflare itself, for example Pages, so that no public
origin hop remains. This Terraform does not manage the SSL mode. Do not switch
it to Full or Full (strict) while the origin is an S3 website endpoint: with
nothing on port 443, both modes fail.

Before enabling any of them:

1. Give the existing zone-scoped token **Zone → Zone Settings → Edit** and
   **Zone → Single Redirect → Edit**. On 2026-09-09 the token returned 403 for
   zone settings and Page Rules. Keep the token in ignored `deploy/.env`.
2. Inspect the `http_request_dynamic_redirect` phase (Rules → Redirect Rules)
   and every Terraform state that might own it. On 2026-09-09 the zone had no
   ruleset in that phase. As with the header rule, the opt-in data source
   refuses a differently named ruleset or any additional rule, and a 403 is an
   unresolved ownership check. Also look for a Page Rule that forwards www; it
   was unreadable on 2026-09-09.
3. Deploy a CSP-compatible build to dev, or remove the dev record and bucket,
   before step 8. The dev page recorded on 2026-09-09 was a January 2025 build.

Roll out one opt-in per reviewed plan, from the repository root, after
`./deploy/tf init -lockfile=readonly` and `./deploy/tf validate`. Each plan
must show only the change named, apart from drift you have reviewed:

4. Set `manage_frontend_www_redirect = true` in ignored `terraform.tfvars`, then
   `./deploy/tf plan -out=tfplan` and `./deploy/tf apply tfplan`. One ruleset
   is added with its rule disabled.
5. Set `frontend_www_redirect_enabled = true`, plan, apply (one ruleset updated
   in place). Check that `https://www.p2party.com/r?x=1` and
   `http://www.p2party.com/r?x=1` answer 301 with
   `location: https://p2party.com/r?x=1`.
6. Before the zone settings, take stock, because they reach every proxied
   record and not only the four above. In the dashboard, list the DNS records
   whose proxy status is Proxied and confirm each one can serve HTTPS at the
   edge. In the zone's analytics, check which TLS versions clients of
   `cdn.p2party.com` use: other sites load the SDK from there, and TLS 1.0 and
   1.1 clients lose access in step 7. Write down the current Always Use HTTPS
   and Minimum TLS Version values (SSL/TLS → Edge Certificates); confirm the
   HSTS setting there is off.
7. In the same change, set `frontend_tls_previous_settings` to the two values
   just recorded and `manage_frontend_tls_settings = true`. Review the two
   `cloudflare_zone_setting` entries and apply the saved plan. Check that
   `http://p2party.com/`, `http://dev.p2party.com/` and `http://cdn.p2party.com/`
   answer 301 to HTTPS; that a TLS 1.1 handshake to each of the four hostnames
   is refused (allow legacy ciphers locally, for example
   `openssl s_client -tls1_1 -cipher 'DEFAULT:@SECLEVEL=0'`, so a local refusal
   is not mistaken for the server's); and that HTTPS responses on the apex still
   carry exactly one
   `strict-transport-security: max-age=63072000; includeSubDomains; preload`.
8. Set `frontend_response_headers_all_app_hosts = true`, plan, apply (the header
   ruleset updated in place). Verify all five headers, including that single
   HSTS value, on dev pages; record which headers the edge-generated www
   redirect carries; then repeat the header rule's browser checks on dev.

If step 7 fails part-way, check both values in Cloudflare against the
private `frontend_tls_previous_settings` object and read both
`cloudflare_zone_setting.frontend_tls` entries in Terraform state. Fix the
reported error and plan again. To restore the original settings, keep the
recorded object, set `manage_frontend_tls_settings = false`, and apply a
reviewed plan that writes both original values. Verify both in Cloudflare.
Keep the object in the private configuration while Terraform owns them.

To roll back the www redirect or expanded headers, set
`frontend_www_redirect_enabled = false` or
`frontend_response_headers_all_app_hosts = false` and review the update. The
rulesets retain their destruction protection. Browsers cache the 301.
Browsers that received HSTS keep it until it expires. Fix the www bucket's own
redirect to `https` as well, so disabling the edge rule does not bring the
downgrade back.

The offline tests in [Frontend response headers](#frontend-response-headers)
also cover these defaults, the disabled first redirect, the redirect phase
ownership checks, the unmanaged zone HSTS setting, the host list, and that each
flag changes only its own resource. Run them from a clean copy as shown there.
