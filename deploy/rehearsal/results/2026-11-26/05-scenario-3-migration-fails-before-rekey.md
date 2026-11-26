# Scenario 3: a migration that fails before the re-key

- Commit under test: `6a6cfc244f43b167fe3c03090211f3cadfaf45ed` (Run the release rehearsal: 0.1.4 baseline, upgrade and fault scenarios)
- Release before it: `ecf691a957b2` (0.1.4, `master`)
- Harness: `deploy/rehearsal/run.sh scenario-3` from the tree at `6a6cfc244f43`
- Started: 2026-11-26T23:07:32Z

## What deploy/README.md says about this case

> When `prisma migrate deploy` fails or is interrupted, the play ends with
> "Report the failed migration and how to recover", whose message is the steps
> below. Every signaling worker is then stopped and disabled, and the previous
> binary is still in place, so nothing serves. The migrate task is hidden from the
> Ansible output (`no_log`: its environment holds the connection string), so the
> play writes Prisma's output to `/var/log/p2party-migration-failure.log`,
> readable by root only, with the database password replaced by `<redacted>`.

> 1. Read why it failed: `sudo cat /var/log/p2party-migration-failure.log` on the
>    signaling host and, when Prisma recorded a failed migration, that row's
>    `logs` column in `"_prisma_migrations"`.
> 2. Fix the cause: a lock another session held, the database unreachable, a full
>    disk.
> 3. On the signaling host, as `p2party`, from `~p2party/server`, with
>    `DATABASE_URL` exported as the play builds it, ask Prisma which migration
>    failed, and if it names one, mark it rolled back by its exact name:

> From the moment a deploy stops the workers until it has installed the new
> binary, and after any failure in between, the file
> `/var/lib/p2party-migration-failed` exists on the signaling host and holds these
> steps (or, if the deploy ended after a successful migration, an instruction to
> run it again). `playbooks/initial-setup.yml` (also run by `site.yml`) refuses to
> enable or start a signaling unit while it exists, and prints it, although it
> still renders `.env` and the unit files first; a deploy that installs the new
> binary removes it. Do not start the previous binary by hand
> either: rolling the binary back after
> `20261127000000_rekey_peers_to_derived_ids` is not supported. A new binary
> started on such a database refuses with the same instructions.

> The binary also checks the schema itself. Before it opens its listener it reads
> Prisma's migration history, on its own connection, within 8 seconds, and exits
> with one `p2party: refusing to start` line when the database does not answer,
> cannot be reached, is empty, lacks a migration the build ships, has one it does
> not ship, or holds a failed migration. It then re-runs the identity re-key
> statement within its own bound of 60 seconds (normally a no-op); a re-key that
> runs past it is cancelled, changes nothing, and ends the start with the same
> kind of line. `Restart=always` then only repeats the refusal.

## The run

Before deploying, deploy/README.md says to check the host's Bun: `sudo -u p2party /home/p2party/.bun/bin/bun --version` printed `1.3.14`; the pin is 1.4.5.

Stand-in `host-bun` (exit 0):

```text
1.4.5
```

- Lock holder: an open transaction ran `LOCK TABLE "PendingSignal" IN ROW EXCLUSIVE MODE;` and then `SELECT pg_sleep(900)`; its backend: 2181 active since 2026-11-26 23:07:34.456469+00
- The migration's statement waits on the lock: backend 3106: state active, wait Lock/relation, statement running for 00:00:01: -- Prisma does not run a migration in a transaction and may fail to record a --
- 75 s later it still waits (nothing in the migration path sets a statement or lock timeout): backend 3106: state active, wait Lock/relation, statement running for 00:01:16: -- Prisma does not run a migration in a transaction and may fail to record a --
- Terminated the waiting backend: t

deploy.yml (exit 2):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Build the binary and check its build record on this machine] *************

TASK [Build the Linux binary from this repo] ***********************************
changed: [p2party-signaling -> localhost]

TASK [Read the commit and whether the tree has changes] ************************
ok: [p2party-signaling -> localhost]

TASK [Read the Bun that built the binary] **************************************
ok: [p2party-signaling -> localhost]

TASK [Read the built binary's SHA-256] *****************************************
ok: [p2party-signaling -> localhost]

TASK [Write the build record beside the binary] ********************************
ok: [p2party-signaling -> localhost]

TASK [Confirm the binary exists before touching the host] **********************
ok: [p2party-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Parse the build record] **************************************************
ok: [p2party-signaling -> localhost]

TASK [Require a build record that matches the binary and the pinned Bun] *******
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Require the pinned Bun on the signaling hosts] ***************************

TASK [Read the Bun version of the signaling host] ******************************
ok: [p2party-signaling]

TASK [Read the signaling host's architecture] **********************************
ok: [p2party-signaling]

TASK [Require Bun 1.4.5 on the signaling host] *********************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-postgres]

TASK [Install certificate tooling] *********************************************
ok: [p2party-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [p2party-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [p2party-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [p2party-postgres]

TASK [Create the database server key and signing request] **********************
ok: [p2party-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [p2party-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [p2party-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [p2party-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [p2party-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [p2party-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [p2party-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [p2party-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [p2party-postgres] => (item=ca.key)
ok: [p2party-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [p2party-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [p2party-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [p2party-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [p2party-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [p2party-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [p2party-signaling]

PLAY [Deploy $REDACTED$ signaling server] *****************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Ensure the journald drop-in directory exists] ****************************
changed: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
changed: [$REDACTED$-signaling]

TASK [Ensure the server directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Create an isolated directory for audited migration tooling] **************
ok: [$REDACTED$-signaling]

TASK [Copy the audited package manifest and frozen dependency lock] ************
changed: [$REDACTED$-signaling] => (item=package.json)
changed: [$REDACTED$-signaling] => (item=bun.lock)

TASK [Install exactly the audited migration dependencies] **********************
changed: [$REDACTED$-signaling]

TASK [Ensure the prisma directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Copy the schema] *********************************************************
changed: [$REDACTED$-signaling]

TASK [Copy the migrations] *****************************************************
changed: [$REDACTED$-signaling]

TASK [Copy the Prisma config] **************************************************
ok: [$REDACTED$-signaling]

TASK [Ensure the release staging directory exists] *****************************
changed: [$REDACTED$-signaling]

TASK [Stage the compiled binary] ***********************************************
changed: [$REDACTED$-signaling]

TASK [Read the staged binary's SHA-256] ****************************************
ok: [$REDACTED$-signaling]

TASK [Require the staged binary to be the one built] ***************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Stage the signaling environment file] ************************************
changed: [$REDACTED$-signaling]

TASK [Stage the systemd unit files] ********************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Render the candidate Caddy configuration] ********************************
changed: [$REDACTED$-signaling]

TASK [Ensure Caddy's log directory belongs to caddy] ***************************
ok: [$REDACTED$-signaling]

TASK [Ensure Caddy's log files exist and belong to caddy] **********************
changed: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Validate the candidate Caddy configuration] ******************************
ok: [$REDACTED$-signaling]

TASK [Keep Caddy's log files owned by caddy after validation] ******************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Discover the signaling units to stop before migrating] *******************
ok: [$REDACTED$-signaling]

TASK [Stop and disable every signaling worker before migrating] ****************
changed: [$REDACTED$-signaling] => (item=$REDACTED$-signaling-3001.service)

TASK [Mark that the binary on disk may not match the schema] *******************
changed: [$REDACTED$-signaling]

TASK [Apply migrations against Postgres] ***************************************
[ERROR]: Task failed: Module failed: A 'failed_when' expression evaluated to 'True'.
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:548:11

546     - name: Apply Postgres migrations
547       block:
548         - name: Apply migrations against Postgres
              ^ column 11

fatal: [$REDACTED$-signaling]: FAILED! => {"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result", "changed": true}

TASK [Write the failed migration's output for the operator] ********************
changed: [$REDACTED$-signaling]

TASK [Record in the marker that the migration failed] **************************
changed: [$REDACTED$-signaling]

TASK [Report the failed migration and how to recover] **************************
[ERROR]: Task failed: Action failed: The PostgreSQL migration failed or was interrupted. Every signaling
worker is stopped and disabled and the previous binary is still in
place, so nothing serves until this is resolved.

Recover (deploy/README.md, "A failed or interrupted migration"):
1. Read why it failed in /var/log/$REDACTED$-migration-failure.log (root only) on the
   signaling host and, when Prisma recorded a failed migration, in its
   row of "_prisma_migrations" ("logs" column).
2. Fix the cause: a lock another session held, the database
   unreachable, a full disk.
3. From /home/$REDACTED$/server as $REDACTED$, with DATABASE_URL set
   as this play sets it, run `migrate status`:
   /home/$REDACTED$/.bun/bin/bun /home/$REDACTED$/server/migration-tooling/node_modules/prisma/build/index.js migrate status
   If it names a failed migration, mark it rolled back with the same
   command and `migrate resolve --rolled-back <migration name>`. Every
   migration of this release can run again after a failure at any
   statement. If it names none (the database was unreachable before a
   migration started), there is nothing to resolve.
4. Run this playbook again. It applies the migration and only then
   installs and starts the new binary.
Until then, do not run initial-setup.yml (it refuses to enable or start
a signaling unit while /var/lib/$REDACTED$-migration-failed exists) and do not
start the previous binary: rolling it back after
20261127000000_rekey_peers_to_derived_ids is not supported.

Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:596:11

594             mode: "0600"
595
596         - name: Report the failed migration and how to recover
              ^ column 11

fatal: [$REDACTED$-signaling]: FAILED! => {"changed": false, "msg": "The PostgreSQL migration failed or was interrupted. Every signaling\nworker is stopped and disabled and the previous binary is still in\nplace, so nothing serves until this is resolved.\n\nRecover (deploy/README.md, \"A failed or interrupted migration\"):\n1. Read why it failed in /var/log/$REDACTED$-migration-failure.log (root only) on the\n   signaling host and, when Prisma recorded a failed migration, in its\n   row of \"_prisma_migrations\" (\"logs\" column).\n2. Fix the cause: a lock another session held, the database\n   unreachable, a full disk.\n3. From /home/$REDACTED$/server as $REDACTED$, with DATABASE_URL set\n   as this play sets it, run `migrate status`:\n   /home/$REDACTED$/.bun/bin/bun /home/$REDACTED$/server/migration-tooling/node_modules/prisma/build/index.js migrate status\n   If it names a failed migration, mark it rolled back with the same\n   command and `migrate resolve --rolled-back <migration name>`. Every\n   migration of this release can run again after a failure at any\n   statement. If it names none (the database was unreachable before a\n   migration started), there is nothing to resolve.\n4. Run this playbook again. It applies the migration and only then\n   installs and starts the new binary.\nUntil then, do not run initial-setup.yml (it refuses to enable or start\na signaling unit while /var/lib/$REDACTED$-migration-failed exists) and do not\nstart the previous binary: rolling it back after\n20261127000000_rekey_peers_to_derived_ids is not supported.\n"}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=44   changed=17   unreachable=0    failed=1    skipped=0    rescued=1    ignored=0

```

- Lock holder ended: 1 backend(s) terminated

State of the VM after the failed migration:

```text

## signaling units
p2party-signaling-3001.service: enabled=disabled active=inactive restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: present (root:root mode 600, 1461 bytes)
/var/log/p2party-migration-failure.log: present (root:root mode 600, 384 bytes)
--- first line of /var/lib/p2party-migration-failed:
The PostgreSQL migration failed or was interrupted. Every signaling
/etc/caddy/Caddyfile.p2party-candidate: present

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | f | f | 0 | f
(3 rows)

## schema details
Peer.socketGeneration: 0 column(s); PendingSignal.kind: 0 column(s); PendingSignal_createdAt_idx: 0 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
4 | 2 | 3 | 2 | 2
(1 row)

## serving
worker 127.0.0.1:3001/health: no answer
Caddy https://signaling.rehearsal.localhost/health: no answer
signaling processes:
caddy: active
postgresql: active
```

`sudo cat /var/log/p2party-migration-failure.log` (step 1 of the README's recovery):

```text
Datasource "db": PostgreSQL database "p2party", schema "public" at "10.231.0.2:5432"

5 migrations found in prisma/migrations

Applying migration `20261126120000_pending_signal_created_at_index`\nLoaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Error: P1017

Server has closed the connection.\nThe command exited with a non-zero return code.~~~~

### The README's recovery (the cause, the lock, is gone: step 2)

As the README says: `~/.bun/bin/bun migration-tooling/node_modules/prisma/build/index.js migrate status` (exit 1):

~~~~text
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "p2party", schema "public" at "10.231.0.2:5432"

5 migrations found in prisma/migrations
Following migrations have not yet been applied:
20261127000000_rekey_peers_to_derived_ids
20261127000100_routing_claim_owner

To apply migrations in development run prisma migrate dev.
To apply migrations in production run prisma migrate deploy.
```

- `migrate status` names no failed migration; the README says there is nothing to resolve.

### Step 4: run the deploy again

deploy.yml, second run (exit 2):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Build the binary and check its build record on this machine] *************

TASK [Build the Linux binary from this repo] ***********************************
changed: [p2party-signaling -> localhost]

TASK [Read the commit and whether the tree has changes] ************************
ok: [p2party-signaling -> localhost]

TASK [Read the Bun that built the binary] **************************************
ok: [p2party-signaling -> localhost]

TASK [Read the built binary's SHA-256] *****************************************
ok: [p2party-signaling -> localhost]

TASK [Write the build record beside the binary] ********************************
ok: [p2party-signaling -> localhost]

TASK [Confirm the binary exists before touching the host] **********************
ok: [p2party-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Parse the build record] **************************************************
ok: [p2party-signaling -> localhost]

TASK [Require a build record that matches the binary and the pinned Bun] *******
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Require the pinned Bun on the signaling hosts] ***************************

TASK [Read the Bun version of the signaling host] ******************************
ok: [p2party-signaling]

TASK [Read the signaling host's architecture] **********************************
ok: [p2party-signaling]

TASK [Require Bun 1.4.5 on the signaling host] *********************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-postgres]

TASK [Install certificate tooling] *********************************************
ok: [p2party-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [p2party-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [p2party-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [p2party-postgres]

TASK [Create the database server key and signing request] **********************
ok: [p2party-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [p2party-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [p2party-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [p2party-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [p2party-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [p2party-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [p2party-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [p2party-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [p2party-postgres] => (item=ca.key)
ok: [p2party-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [p2party-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [p2party-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [p2party-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [p2party-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [p2party-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [p2party-signaling]

PLAY [Deploy $REDACTED$ signaling server] *****************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Ensure the journald drop-in directory exists] ****************************
ok: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
ok: [$REDACTED$-signaling]

TASK [Ensure the server directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Create an isolated directory for audited migration tooling] **************
ok: [$REDACTED$-signaling]

TASK [Copy the audited package manifest and frozen dependency lock] ************
ok: [$REDACTED$-signaling] => (item=package.json)
ok: [$REDACTED$-signaling] => (item=bun.lock)

TASK [Install exactly the audited migration dependencies] **********************
changed: [$REDACTED$-signaling]

TASK [Ensure the prisma directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Copy the schema] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Copy the migrations] *****************************************************
ok: [$REDACTED$-signaling]

TASK [Copy the Prisma config] **************************************************
ok: [$REDACTED$-signaling]

TASK [Ensure the release staging directory exists] *****************************
ok: [$REDACTED$-signaling]

TASK [Stage the compiled binary] ***********************************************
ok: [$REDACTED$-signaling]

TASK [Read the staged binary's SHA-256] ****************************************
ok: [$REDACTED$-signaling]

TASK [Require the staged binary to be the one built] ***************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Stage the signaling environment file] ************************************
ok: [$REDACTED$-signaling]

TASK [Stage the systemd unit files] ********************************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Render the candidate Caddy configuration] ********************************
ok: [$REDACTED$-signaling]

TASK [Ensure Caddy's log directory belongs to caddy] ***************************
ok: [$REDACTED$-signaling]

TASK [Ensure Caddy's log files exist and belong to caddy] **********************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Validate the candidate Caddy configuration] ******************************
ok: [$REDACTED$-signaling]

TASK [Keep Caddy's log files owned by caddy after validation] ******************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Discover the signaling units to stop before migrating] *******************
ok: [$REDACTED$-signaling]

TASK [Stop and disable every signaling worker before migrating] ****************
ok: [$REDACTED$-signaling] => (item=$REDACTED$-signaling-3001.service)

TASK [Mark that the binary on disk may not match the schema] *******************
changed: [$REDACTED$-signaling]

TASK [Apply migrations against Postgres] ***************************************
[ERROR]: Task failed: Module failed: A 'failed_when' expression evaluated to 'True'.
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:548:11

546     - name: Apply Postgres migrations
547       block:
548         - name: Apply migrations against Postgres
              ^ column 11

fatal: [$REDACTED$-signaling]: FAILED! => {"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result", "changed": true}

TASK [Write the failed migration's output for the operator] ********************
changed: [$REDACTED$-signaling]

TASK [Record in the marker that the migration failed] **************************
changed: [$REDACTED$-signaling]

TASK [Report the failed migration and how to recover] **************************
[ERROR]: Task failed: Action failed: The PostgreSQL migration failed or was interrupted. Every signaling
worker is stopped and disabled and the previous binary is still in
place, so nothing serves until this is resolved.

Recover (deploy/README.md, "A failed or interrupted migration"):
1. Read why it failed in /var/log/$REDACTED$-migration-failure.log (root only) on the
   signaling host and, when Prisma recorded a failed migration, in its
   row of "_prisma_migrations" ("logs" column).
2. Fix the cause: a lock another session held, the database
   unreachable, a full disk.
3. From /home/$REDACTED$/server as $REDACTED$, with DATABASE_URL set
   as this play sets it, run `migrate status`:
   /home/$REDACTED$/.bun/bin/bun /home/$REDACTED$/server/migration-tooling/node_modules/prisma/build/index.js migrate status
   If it names a failed migration, mark it rolled back with the same
   command and `migrate resolve --rolled-back <migration name>`. Every
   migration of this release can run again after a failure at any
   statement. If it names none (the database was unreachable before a
   migration started), there is nothing to resolve.
4. Run this playbook again. It applies the migration and only then
   installs and starts the new binary.
Until then, do not run initial-setup.yml (it refuses to enable or start
a signaling unit while /var/lib/$REDACTED$-migration-failed exists) and do not
start the previous binary: rolling it back after
20261127000000_rekey_peers_to_derived_ids is not supported.

Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:596:11

594             mode: "0600"
595
596         - name: Report the failed migration and how to recover
              ^ column 11

fatal: [$REDACTED$-signaling]: FAILED! => {"changed": false, "msg": "The PostgreSQL migration failed or was interrupted. Every signaling\nworker is stopped and disabled and the previous binary is still in\nplace, so nothing serves until this is resolved.\n\nRecover (deploy/README.md, \"A failed or interrupted migration\"):\n1. Read why it failed in /var/log/$REDACTED$-migration-failure.log (root only) on the\n   signaling host and, when Prisma recorded a failed migration, in its\n   row of \"_prisma_migrations\" (\"logs\" column).\n2. Fix the cause: a lock another session held, the database\n   unreachable, a full disk.\n3. From /home/$REDACTED$/server as $REDACTED$, with DATABASE_URL set\n   as this play sets it, run `migrate status`:\n   /home/$REDACTED$/.bun/bin/bun /home/$REDACTED$/server/migration-tooling/node_modules/prisma/build/index.js migrate status\n   If it names a failed migration, mark it rolled back with the same\n   command and `migrate resolve --rolled-back <migration name>`. Every\n   migration of this release can run again after a failure at any\n   statement. If it names none (the database was unreachable before a\n   migration started), there is nothing to resolve.\n4. Run this playbook again. It applies the migration and only then\n   installs and starts the new binary.\nUntil then, do not run initial-setup.yml (it refuses to enable or start\na signaling unit while /var/lib/$REDACTED$-migration-failed exists) and do not\nstart the previous binary: rolling it back after\n20261127000000_rekey_peers_to_derived_ids is not supported.\n"}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=44   changed=5    unreachable=0    failed=1    skipped=0    rescued=1    ignored=0

```

State of the VM after the second run:

```text

## signaling units
p2party-signaling-3001.service: enabled=disabled active=inactive restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: present (root:root mode 600, 1461 bytes)
/var/log/p2party-migration-failure.log: present (root:root mode 600, 593 bytes)
--- first line of /var/lib/p2party-migration-failed:
The PostgreSQL migration failed or was interrupted. Every signaling
/etc/caddy/Caddyfile.p2party-candidate: present

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | f | f | 0 | f
(3 rows)

## schema details
Peer.socketGeneration: 0 column(s); PendingSignal.kind: 0 column(s); PendingSignal_createdAt_idx: 0 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
4 | 2 | 3 | 2 | 2
(1 row)

## serving
worker 127.0.0.1:3001/health: no answer
Caddy https://signaling.rehearsal.localhost/health: no answer
signaling processes:
caddy: active
postgresql: active
```

`sudo cat /var/log/p2party-migration-failure.log` (step 1 of the README's recovery):

```text
Datasource "db": PostgreSQL database "p2party", schema "public" at "10.231.0.2:5432"

5 migrations found in prisma/migrations\nLoaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve
The `20261126120000_pending_signal_created_at_index` migration started at 2026-11-26 23:08:00.906292 UTC failed\nThe command exited with a non-zero return code.~~~~

### Beyond the README: the migration the second run's failure log names, rolled back, and a third run
- The failure log names `20261126120000_pending_signal_created_at_index`, which `migrate status` did not.

As the README says: `~/.bun/bin/bun migration-tooling/node_modules/prisma/build/index.js migrate resolve --rolled-back 20261126120000_pending_signal_created_at_index` (exit 0):

~~~~text
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "p2party", schema "public" at "10.231.0.2:5432"

Migration 20261126120000_pending_signal_created_at_index marked as rolled back.

```

deploy.yml, third run (exit 0):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Build the binary and check its build record on this machine] *************

TASK [Build the Linux binary from this repo] ***********************************
changed: [p2party-signaling -> localhost]

TASK [Read the commit and whether the tree has changes] ************************
ok: [p2party-signaling -> localhost]

TASK [Read the Bun that built the binary] **************************************
ok: [p2party-signaling -> localhost]

TASK [Read the built binary's SHA-256] *****************************************
ok: [p2party-signaling -> localhost]

TASK [Write the build record beside the binary] ********************************
ok: [p2party-signaling -> localhost]

TASK [Confirm the binary exists before touching the host] **********************
ok: [p2party-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Parse the build record] **************************************************
ok: [p2party-signaling -> localhost]

TASK [Require a build record that matches the binary and the pinned Bun] *******
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Require the pinned Bun on the signaling hosts] ***************************

TASK [Read the Bun version of the signaling host] ******************************
ok: [p2party-signaling]

TASK [Read the signaling host's architecture] **********************************
ok: [p2party-signaling]

TASK [Require Bun 1.4.5 on the signaling host] *********************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [p2party-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [p2party-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-postgres]

TASK [Install certificate tooling] *********************************************
ok: [p2party-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [p2party-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [p2party-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [p2party-postgres]

TASK [Create the database server key and signing request] **********************
ok: [p2party-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [p2party-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [p2party-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [p2party-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [p2party-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [p2party-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [p2party-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [p2party-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [p2party-postgres] => (item=ca.key)
ok: [p2party-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [p2party-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [p2party-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [p2party-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [p2party-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [p2party-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [p2party-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [p2party-signaling]

PLAY [Deploy $REDACTED$ signaling server] *****************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Ensure the journald drop-in directory exists] ****************************
ok: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
ok: [$REDACTED$-signaling]

TASK [Ensure the server directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Create an isolated directory for audited migration tooling] **************
ok: [$REDACTED$-signaling]

TASK [Copy the audited package manifest and frozen dependency lock] ************
ok: [$REDACTED$-signaling] => (item=package.json)
ok: [$REDACTED$-signaling] => (item=bun.lock)

TASK [Install exactly the audited migration dependencies] **********************
changed: [$REDACTED$-signaling]

TASK [Ensure the prisma directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Copy the schema] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Copy the migrations] *****************************************************
ok: [$REDACTED$-signaling]

TASK [Copy the Prisma config] **************************************************
ok: [$REDACTED$-signaling]

TASK [Ensure the release staging directory exists] *****************************
ok: [$REDACTED$-signaling]

TASK [Stage the compiled binary] ***********************************************
ok: [$REDACTED$-signaling]

TASK [Read the staged binary's SHA-256] ****************************************
ok: [$REDACTED$-signaling]

TASK [Require the staged binary to be the one built] ***************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Stage the signaling environment file] ************************************
ok: [$REDACTED$-signaling]

TASK [Stage the systemd unit files] ********************************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Render the candidate Caddy configuration] ********************************
ok: [$REDACTED$-signaling]

TASK [Ensure Caddy's log directory belongs to caddy] ***************************
ok: [$REDACTED$-signaling]

TASK [Ensure Caddy's log files exist and belong to caddy] **********************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Validate the candidate Caddy configuration] ******************************
ok: [$REDACTED$-signaling]

TASK [Keep Caddy's log files owned by caddy after validation] ******************
ok: [$REDACTED$-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Discover the signaling units to stop before migrating] *******************
ok: [$REDACTED$-signaling]

TASK [Stop and disable every signaling worker before migrating] ****************
ok: [$REDACTED$-signaling] => (item=$REDACTED$-signaling-3001.service)

TASK [Mark that the binary on disk may not match the schema] *******************
changed: [$REDACTED$-signaling]

TASK [Apply migrations against Postgres] ***************************************
changed: [$REDACTED$-signaling]

TASK [Install the staged binary] ***********************************************
changed: [$REDACTED$-signaling]

TASK [Install the staged signaling environment file] ***************************
ok: [$REDACTED$-signaling]

TASK [Install the staged systemd unit files] ***********************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Remove the marker now that the binary matches the schema] ****************
changed: [$REDACTED$-signaling]

TASK [Atomically install the validated Caddy configuration] ********************
changed: [$REDACTED$-signaling]

TASK [Reload Caddy onto the desired signaling ports] ***************************
changed: [$REDACTED$-signaling]

TASK [Restart signaling services] **********************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Wait for each instance to accept connections] ****************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Read health from every signaling instance] *******************************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Verify every signaling instance reports the expected build] **************
ok: [$REDACTED$-signaling] => (item=3001) => {
    "ansible_loop_var": "item",
    "changed": false,
    "item": {
        "ansible_loop_var": "item",
        "ansible_parsed": true,
        "cache_control": "no-store",
        "changed": false,
        "content": "{\"status\":\"ok\",\"protocolVersion\":4,\"version\":\"0.1.4\",\"serverId\":\"310ef7ae-668b-453a-bb5a-ced0b633e021\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Thu, 26 Nov 2026 23:10:31 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 4,
            "serverId": "310ef7ae-668b-453a-bb5a-ced0b633e021",
            "status": "ok",
            "version": "0.1.4"
        },
        "msg": "OK (103 bytes)",
        "redirected": false,
        "status": 200,
        "url": "http://127.0.0.1:3001/health"
    },
    "msg": "All assertions passed"
}

TASK [Collect signaling instance identifiers] **********************************
ok: [$REDACTED$-signaling]

TASK [Verify every signaling port belongs to a distinct process] ***************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Build the desired signaling unit path list] ******************************
ok: [$REDACTED$-signaling]

TASK [Discover installed signaling unit files] *********************************
ok: [$REDACTED$-signaling]

TASK [Resolve obsolete signaling unit files] ***********************************
ok: [$REDACTED$-signaling]

TASK [Stop and disable obsolete signaling services] ****************************
skipping: [$REDACTED$-signaling]

TASK [Remove obsolete signaling unit files] ************************************
skipping: [$REDACTED$-signaling]

TASK [Reload systemd after retiring obsolete signaling services] ***************
skipping: [$REDACTED$-signaling]

TASK [Read public signaling health through Caddy] ******************************
ok: [$REDACTED$-signaling]

TASK [Verify Caddy exposes only the expected signaling build] ******************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Deployment complete] *****************************************************
ok: [$REDACTED$-signaling] => {
    "msg": "$REDACTED$ signaling server 0.1.4 deployed to $REDACTED$-signaling on 1 verified workers"
}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=61   changed=9    unreachable=0    failed=0    skipped=3    rescued=0    ignored=0

```

State of the VM after the third run:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: absent
/var/log/p2party-migration-failure.log: present (root:root mode 600, 593 bytes)

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | f | t | 0 | f
20261126120000_pending_signal_created_at_index | t | f | 1 | f
20261127000000_rekey_peers_to_derived_ids | t | f | 1 | f
20261127000100_routing_claim_owner | t | f | 1 | f
(6 rows)

## schema details
Peer.socketGeneration: 1 column(s); PendingSignal.kind: 1 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
3 | 2 | 2 | 1 | 0
(1 row)

## serving
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"310ef7ae-668b-453a-bb5a-ced0b633e021"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"310ef7ae-668b-453a-bb5a-ced0b633e021"}
signaling processes: 5125 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

Seeded rows against the migration's intent after the recovery (exit 0):

```text
ok      peer alpha: id b495975f-f1b2-48c5-a8a5-cfbf99a4cae1 is the derived id b495975f-f1b2-48c5-a8a5-cfbf99a4cae1
ok      peer alpha: socketGeneration added empty
runtime peer alpha: routing claim rehearsal-seed-worker -> null (changed after the migration, by a server)
ok      peer bravo: id 23634878-33c4-4e88-96fb-687f4799a934 is the derived id 23634878-33c4-4e88-96fb-687f4799a934
ok      peer bravo: socketGeneration added empty
ok      peer bravo: routing claim null kept
ok      peer charlie: id d80742cc-a16e-4234-9f23-9743c206ea39 is the derived id d80742cc-a16e-4234-9f23-9743c206ea39
ok      peer charlie: socketGeneration added empty
ok      peer charlie: routing claim null kept
ok      peer delta (non-hex key) is deleted
ok      3 peer rows (expected 3)
ok      room rehearsal-room-occupied: members ["23634878-33c4-4e88-96fb-687f4799a934","b495975f-f1b2-48c5-a8a5-cfbf99a4cae1"] = ["23634878-33c4-4e88-96fb-687f4799a934","b495975f-f1b2-48c5-a8a5-cfbf99a4cae1"]
ok      room rehearsal-room-empty: members [] = []
ok      challenge of alpha follows to b495975f-f1b2-48c5-a8a5-cfbf99a4cae1
ok      challenge of delta deleted with its peer
runtime signal for bravo: removed (not by the migration)
runtime signal for delta: removed (not by the migration)
```

- Finished: 2026-11-26T23:10:33Z
