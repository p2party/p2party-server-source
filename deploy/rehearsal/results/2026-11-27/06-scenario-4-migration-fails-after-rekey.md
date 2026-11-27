# Scenario 4: a migration that fails after the re-key

- Commit under test: `759ce4573d35e4bc75eb52979c2deb71087f1a49` (Upgrade Cloudflare state and rulesets to v5 and pin PostgreSQL collection)
- Baseline: `ecf691a957b2` (release 0.1.4 by default)
- Harness (`run.sh scenario-4`): run.sh sha256 `249a0be83b77d955f6ae2510a055326af6a314e1b4cd48a5986f73675b6d09ef`, lima.yaml sha256 `730b5c29b91e61b2470dc6563d29de378b93ed02ed813505f568f15772430b7f`; deploy/rehearsal as committed at `759ce4573d35`
- Started: 2026-11-27T09:54:00Z

## What deploy/README.md says about this case

> When `prisma migrate deploy` fails or is interrupted, the play ends with
> "Report the failed migration and how to recover", whose message is the steps
> below. Every signaling worker is then stopped and disabled, and the previous
> binary is still in place, so nothing serves. The migrate task is hidden from the
> Ansible output. systemd reads the database URL from a root-only environment
> file on the host. The play writes Prisma's output to
> `/var/log/p2party-migration-failure.log`, readable by root only, with the
> database password replaced by `<redacted>`. The log can contain database row
> values. A migration that timed out can have committed statements. Inspect its
> history before choosing a recovery command. A successful deploy removes both
> staged environment files and any previous migration error log.

> 1. Read why it failed: `sudo cat /var/log/p2party-migration-failure.log` on the
>    signaling host and, when Prisma recorded a failed migration, that row's
>    `logs` column in `"_prisma_migrations"`.
> 2. Fix the cause: a lock another session held, the database unreachable, a full
>    disk.
> 3. Once the deploy and its migration have stopped, inspect the migration
>    history on the PostgreSQL host. Open the application's database using
>    the configured port and database name (shown here with the example values):

(No paragraph of deploy/README.md at this commit matches /^From the moment a deploy stops the workers/: the README is silent here.)

> The binary also checks the schema itself. Before it opens its listener it reads
> Prisma's migration history, on its own connection, within 8 seconds, and exits
> with one `p2party: refusing to start` line when the database does not answer,
> cannot be reached, is empty, lacks a migration the build ships, has one it does
> not ship, or holds a failed migration. It then re-runs the identity re-key
> statement within its own bound of 60 seconds (normally a no-op); a re-key that
> runs past it is cancelled, changes nothing, and ends the start with the same
> kind of line. A lost connection can leave the result unknown. Once the
> database is reachable the idempotent re-key can run again. The service
> retries after 5 seconds with no fixed retry count. The deploy waits up to
> 113 seconds per worker for the schema check, re-key, LISTEN setup and restart.
> Once LISTEN is ready, cleanup of expired routing state runs in the background;
> a failed pass retries after 30 seconds. The worker pool allows 5 seconds to
> acquire a connection, 8 seconds per SQL statement and 10 seconds to receive
> its response.

## The run

- Lock holder: an open transaction ran `SELECT count(*) FROM "Peer";` and then `SELECT pg_sleep(900)`; its backend: 2213 active since 2026-11-27 09:54:01.104317+00
- The migration is waiting on the held lock: backend 3391: state active, wait Lock/relation, statement running for 00:00:00: -- The routing claim's owner token: Peer.serverId names the instance and -- Peer
- The waiting statement left the lock wait within 10 seconds of observation with the blocking transaction still open.

deploy.yml (exit 2):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [$REDACTED$-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Build the binary and check its build record on this machine] *************

TASK [Read the source revision and worktree state] *****************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Require the release Git checkout] ****************************************
ok: [$REDACTED$-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Build the Linux binary from this repo] ***********************************
changed: [$REDACTED$-signaling -> localhost]

TASK [Read the commit and whether the tree has changes] ************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Read the Bun that built the binary] **************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Read the built binary's SHA-256] *****************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Write the build record beside the binary] ********************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Confirm the binary exists before touching the host] **********************
ok: [$REDACTED$-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [$REDACTED$-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Parse the build record] **************************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Require a build record that matches the binary and the pinned Bun] *******
ok: [$REDACTED$-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Require a reused binary to come from this clean revision] ****************
skipping: [$REDACTED$-signaling]

PLAY [Verify the candidate version against the running release before provisioning] ***

TASK [Read the previous signaling binary] **************************************
ok: [$REDACTED$-signaling]

TASK [Read the serving version before changing the host] ***********************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Refuse two different binaries with the same serving version] *************
skipping: [$REDACTED$-signaling] => (item=3001)
skipping: [$REDACTED$-signaling]

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [$REDACTED$-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-postgres]

TASK [Install certificate tooling] *********************************************
ok: [$REDACTED$-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [$REDACTED$-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [$REDACTED$-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [$REDACTED$-postgres]

TASK [Create the database server key and signing request] **********************
ok: [$REDACTED$-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [$REDACTED$-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [$REDACTED$-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [$REDACTED$-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [$REDACTED$-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [$REDACTED$-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [$REDACTED$-postgres] => (item=ca.key)
ok: [$REDACTED$-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [$REDACTED$-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [$REDACTED$-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [$REDACTED$-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [$REDACTED$-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [$REDACTED$-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [$REDACTED$-signaling]

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

TASK [Read the signaling host's architecture] **********************************
ok: [$REDACTED$-signaling]

TASK [Select the release archive for this host] ********************************
ok: [$REDACTED$-signaling]

TASK [Install unzip to read the verified archive] ******************************
ok: [$REDACTED$-signaling]

TASK [Create the root-owned Bun release directory] *****************************
changed: [$REDACTED$-signaling]

TASK [Fetch the signed-release archive by its pinned checksum] *****************
changed: [$REDACTED$-signaling]

TASK [Extract the checked Bun release] *****************************************
changed: [$REDACTED$-signaling]

TASK [Install the native Bun binary from the verified release] *****************
changed: [$REDACTED$-signaling]

TASK [Check the installed runtime as its unprivileged caller] ******************
ok: [$REDACTED$-signaling]

TASK [Create the unprivileged migration dependency installer] ******************
changed: [$REDACTED$-signaling]

TASK [Create an isolated directory for audited migration tooling] **************
changed: [$REDACTED$-signaling]

TASK [Give only the package installer write access to node_modules] ************
changed: [$REDACTED$-signaling]

TASK [Copy the audited package manifest and frozen dependency lock] ************
changed: [$REDACTED$-signaling] => (item=package.json)
changed: [$REDACTED$-signaling] => (item=bun.lock)

TASK [Install exactly the audited migration dependencies] **********************
[WARNING]: Module remote_tmp /var/cache/$REDACTED$-pkg/.ansible/tmp did not exist and was created with a mode of 0700, this may cause issues when running as another user. To avoid this, create the remote_tmp dir with the correct permissions manually
changed: [$REDACTED$-signaling]

TASK [Ensure the prisma directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Copy the schema] *********************************************************
changed: [$REDACTED$-signaling]

TASK [Copy the migrations] *****************************************************
changed: [$REDACTED$-signaling]

TASK [Copy the Prisma config] **************************************************
changed: [$REDACTED$-signaling]

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

TASK [Validate the staged environment as the signaling worker] *****************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Stage the private migration environment] *********************************
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

TASK [Record which installed workers currently serve] **************************
ok: [$REDACTED$-signaling] => (item=/etc/systemd/system/$REDACTED$-signaling-3001.service)

TASK [Preserve a recovery marker before the first stop] ************************
changed: [$REDACTED$-signaling]

TASK [Stop and disable every signaling worker before migrating] ****************
changed: [$REDACTED$-signaling] => (item=$REDACTED$-signaling-3001.service)

TASK [Mark that the binary on disk may not match the schema] *******************
changed: [$REDACTED$-signaling]

TASK [Apply migrations against Postgres] ***************************************
[ERROR]: Task failed: Module failed: A 'failed_when' expression evaluated to 'True'.
Origin: <work>/trees/759ce4573d35/deploy/ansible/playbooks/deploy.yml:692:11

690     - name: Apply Postgres migrations
691       block:
692         - name: Apply migrations against Postgres
              ^ column 11

fatal: [$REDACTED$-signaling]: FAILED! => {"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result", "changed": true}

TASK [Write the failed migration's output for the operator] ********************
changed: [$REDACTED$-signaling]

TASK [Determine whether migration history permits the previous release] ********
ok: [$REDACTED$-signaling -> $REDACTED$-postgres(127.0.0.1)]

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
2. Check for contention, lost connectivity or disk errors. A lock may
   wait 10s, a statement 120s, and the migration service 300s plus
   10s for termination. Inspect migration history even after a timeout.
3. Once the deploy and its migration have stopped, open the application
   database on the PostgreSQL host:
   sudo -u postgres psql -X -p 5432 -d $REDACTED$
   SELECT migration_name FROM public._prisma_migrations
   WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at;
   A successful query returning zero rows means there is nothing to resolve.
   If the table is absent, confirm the database and that the first migration
   never started. Correct any connection or permission error before proceeding.
   For each unfinished migration added in this release, from /home/$REDACTED$/server
   on the signaling host as $REDACTED$, with DATABASE_URL as the play sets it:
   /opt/$REDACTED$-bun/1.4.5/bin/bun /var/lib/$REDACTED$-migration-tooling/node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>
   Use the exact name from the query. For a failed migration from 0.1.4,
   check and reconcile any partial effects before retrying.
4. Run this playbook again. It applies the migration and only then
   installs and starts the new binary.
Rollback:
The re-key or a later migration has a recorded attempt. Starting the previous binary is not supported. Complete forward recovery above, or restore the verified pre-upgrade database backup and matching release together.
Until the documented recovery is complete, do not run initial-setup.yml.

Origin: <work>/trees/759ce4573d35/deploy/ansible/playbooks/deploy.yml:773:11

771             mode: "0600"
772
773         - name: Report the failed migration and how to recover
              ^ column 11

fatal: [$REDACTED$-signaling]: FAILED! => {"changed": false, "msg": "The PostgreSQL migration failed or was interrupted. Every signaling\nworker is stopped and disabled and the previous binary is still in\nplace, so nothing serves until this is resolved.\n\nRecover (deploy/README.md, \"A failed or interrupted migration\"):\n1. Read why it failed in /var/log/$REDACTED$-migration-failure.log (root only) on the\n   signaling host and, when Prisma recorded a failed migration, in its\n   row of \"_prisma_migrations\" (\"logs\" column).\n2. Check for contention, lost connectivity or disk errors. A lock may\n   wait 10s, a statement 120s, and the migration service 300s plus\n   10s for termination. Inspect migration history even after a timeout.\n3. Once the deploy and its migration have stopped, open the application\n   database on the PostgreSQL host:\n   sudo -u postgres psql -X -p 5432 -d $REDACTED$\n   SELECT migration_name FROM public._prisma_migrations\n   WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at;\n   A successful query returning zero rows means there is nothing to resolve.\n   If the table is absent, confirm the database and that the first migration\n   never started. Correct any connection or permission error before proceeding.\n   For each unfinished migration added in this release, from /home/$REDACTED$/server\n   on the signaling host as $REDACTED$, with DATABASE_URL as the play sets it:\n   /opt/$REDACTED$-bun/1.4.5/bin/bun /var/lib/$REDACTED$-migration-tooling/node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>\n   Use the exact name from the query. For a failed migration from 0.1.4,\n   check and reconcile any partial effects before retrying.\n4. Run this playbook again. It applies the migration and only then\n   installs and starts the new binary.\nRollback:\nThe re-key or a later migration has a recorded attempt. Starting the previous binary is not supported. Complete forward recovery above, or restore the verified pre-upgrade database backup and matching release together.\nUntil the documented recovery is complete, do not run initial-setup.yml.\n"}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=60   changed=27   unreachable=0    failed=1    skipped=2    rescued=1    ignored=0

```

- Lock holder ended: 1 backend(s) terminated

State of the VM after the failed migration:

```text

## signaling units
p2party-signaling-3001.service: enabled=disabled active=inactive restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3, embedded Bun 1.4.5
/var/lib/p2party-release-staging/p2party-server: sha256 26831df7f68c61d8ad16d6e6f2529c62341a6d2afd12854a22a7c8093bc7b9e9, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.3.14
migration Bun (/opt/p2party-bun/1.4.5/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: present (root:root mode 600, 2033 bytes)
/var/log/p2party-migration-failure.log: present (root:root mode 600, 1166 bytes)
--- first line of /var/lib/p2party-migration-failed:
The PostgreSQL migration failed or was interrupted. Every signaling
/etc/caddy/Caddyfile.p2party-candidate: present

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | t | f | 1 | f
20261127000000_rekey_peers_to_derived_ids | t | f | 1 | f
20261127000100_routing_claim_owner | f | f | 0 | t
(5 rows)

## schema details
Peer.socketGeneration: 0 column(s); PendingSignal.kind: 0 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
3 | 2 | 2 | 1 | 2
(1 row)

## serving
worker 127.0.0.1:3001/health: no answer
Caddy https://signaling.rehearsal.localhost/health: no answer
signaling processes:
caddy: active
postgresql: active
```

Seeded rows against the migration's intent after the failed migration (the re-key applied, the claim-owner columns not) (exit 1):

```text
ok      peer alpha: id b495975f-f1b2-48c5-a8a5-cfbf99a4cae1 is the derived id b495975f-f1b2-48c5-a8a5-cfbf99a4cae1
DIFFERS peer alpha: has the socketGeneration column
ok      peer alpha: routing claim rehearsal-seed-worker kept
ok      peer bravo: id 23634878-33c4-4e88-96fb-687f4799a934 is the derived id 23634878-33c4-4e88-96fb-687f4799a934
DIFFERS peer bravo: has the socketGeneration column
ok      peer bravo: routing claim null kept
ok      peer charlie: id d80742cc-a16e-4234-9f23-9743c206ea39 is the derived id d80742cc-a16e-4234-9f23-9743c206ea39
DIFFERS peer charlie: has the socketGeneration column
ok      peer charlie: routing claim null kept
ok      peer delta (non-hex key) is deleted
ok      3 peer rows (expected 3)
ok      room rehearsal-room-occupied: members ["23634878-33c4-4e88-96fb-687f4799a934","b495975f-f1b2-48c5-a8a5-cfbf99a4cae1"] = ["23634878-33c4-4e88-96fb-687f4799a934","b495975f-f1b2-48c5-a8a5-cfbf99a4cae1"]
ok      room rehearsal-room-empty: members [] = []
ok      challenge of alpha follows to b495975f-f1b2-48c5-a8a5-cfbf99a4cae1
ok      challenge of delta deleted with its peer
ok      signal for bravo: targetPeerId 23634878-33c4-4e88-96fb-687f4799a934 = 23634878-33c4-4e88-96fb-687f4799a934
DIFFERS signal for bravo: kind 'frame'
ok      signal for delta: targetPeerId a0000000-0000-4000-8000-000000000004 = a0000000-0000-4000-8000-000000000004
DIFFERS signal for delta: kind 'frame'
```

`sudo cat /var/log/p2party-migration-failure.log` (step 1 of the README's recovery):

```text
Datasource "db": PostgreSQL database "p2party", schema "public" at "10.231.0.2:5432"

5 migrations found in prisma/migrations

Applying migration `20261126120000_pending_signal_created_at_index`
Applying migration `20261127000000_rekey_peers_to_derived_ids`
Applying migration `20261127000100_routing_claim_owner`
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Error: P3018

A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve

Migration name: 20261127000100_routing_claim_owner

Database error code: 55P03

Database error:
ERROR: canceling statement due to lock timeout

DbError { severity: "ERROR", parsed_severity: Some(Error), code: SqlState(E55P03), message: "canceling statement due to lock timeout", detail: None, hint: None, position: None, where_: None, schema: None, table: None, column: None, datatype: None, constraint: None, file: Some("postgres.c"), line: Some(3411), routine: Some("ProcessInterrupts") }
The command exited with a non-zero return code.
```

### The README: initial-setup.yml refuses to start a unit while the marker exists

initial-setup.yml (exit 2):

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

PLAY [Pre-flight checks] *******************************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Verify SSH connectivity] *************************************************
ok: [p2party-signaling]

TASK [Display target info] *****************************************************
ok: [p2party-signaling] => {
    "msg": "Setting up signaling server on p2party-signaling (127.0.0.1)"
}

PLAY [Install Bun on Signaling Server] *****************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Read the signaling host's architecture] **********************************
ok: [p2party-signaling]

TASK [Select the release archive for this host] ********************************
ok: [p2party-signaling]

TASK [Install unzip to read the verified archive] ******************************
ok: [p2party-signaling]

TASK [Create the root-owned Bun release directory] *****************************
ok: [p2party-signaling]

TASK [Fetch the signed-release archive by its pinned checksum] *****************
ok: [p2party-signaling]

TASK [Extract the checked Bun release] *****************************************
ok: [p2party-signaling]

TASK [Install the native Bun binary from the verified release] *****************
ok: [p2party-signaling]

TASK [Check the installed runtime as its unprivileged caller] ******************
ok: [p2party-signaling]

PLAY [Install Caddy Reverse Proxy] *********************************************

TASK [Gathering Facts] *********************************************************
ok: [p2party-signaling]

TASK [Install Caddy dependencies] **********************************************
ok: [p2party-signaling]

TASK [Add Caddy GPG key] *******************************************************
ok: [p2party-signaling]

TASK [Add Caddy repository] ****************************************************
ok: [p2party-signaling]

TASK [Install Caddy] ***********************************************************
ok: [p2party-signaling]

TASK [Ensure Caddy's log directory belongs to caddy] ***************************
ok: [p2party-signaling]

TASK [Ensure Caddy's log files exist and belong to caddy] **********************
ok: [p2party-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Deploy Caddyfile] ********************************************************
changed: [p2party-signaling]

TASK [Keep Caddy's log files owned by caddy after validation] ******************
ok: [p2party-signaling] => (item=/var/log/caddy/signaling.rehearsal.localhost.log)

TASK [Enable Caddy] ************************************************************
ok: [p2party-signaling]

RUNNING HANDLER [Reload Caddy] *************************************************
changed: [p2party-signaling]

PLAY [Deploy Signaling Server Code] ********************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Create application directory] ********************************************
ok: [$REDACTED$-signaling]

TASK [Ensure the journald drop-in directory exists] ****************************
ok: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
ok: [$REDACTED$-signaling]

TASK [Deploy .env file] ********************************************************
changed: [$REDACTED$-signaling]

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Deploy systemd service files] ********************************************
changed: [$REDACTED$-signaling] => (item=3001)

TASK [Check whether a server binary has been deployed yet] *********************
ok: [$REDACTED$-signaling]

TASK [Check for a deploy that left the binary and schema out of step] **********
ok: [$REDACTED$-signaling]

TASK [Read the interrupted deploy's recovery steps] ****************************
ok: [$REDACTED$-signaling]

TASK [Refuse to start signaling services after an interrupted deploy] **********
[ERROR]: Task failed: Action failed: initial-setup.yml will not enable or start a signaling service:
/var/lib/$REDACTED$-migration-failed exists, so the binary on disk may not
match the database schema. It says:

The PostgreSQL migration failed or was interrupted. Every signaling
worker is stopped and disabled and the previous binary is still in
place, so nothing serves until this is resolved.

Recover (deploy/README.md, "A failed or interrupted migration"):
1. Read why it failed in /var/log/$REDACTED$-migration-failure.log (root only) on the
   signaling host and, when Prisma recorded a failed migration, in its
   row of "_prisma_migrations" ("logs" column).
2. Check for contention, lost connectivity or disk errors. A lock may
   wait 10s, a statement 120s, and the migration service 300s plus
   10s for termination. Inspect migration history even after a timeout.
3. Once the deploy and its migration have stopped, open the application
   database on the PostgreSQL host:
   sudo -u postgres psql -X -p 5432 -d $REDACTED$
   SELECT migration_name FROM public._prisma_migrations
   WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at;
   A successful query returning zero rows means there is nothing to resolve.
   If the table is absent, confirm the database and that the first migration
   never started. Correct any connection or permission error before proceeding.
   For each unfinished migration added in this release, from /home/$REDACTED$/server
   on the signaling host as $REDACTED$, with DATABASE_URL as the play sets it:
   /opt/$REDACTED$-bun/1.4.5/bin/bun /var/lib/$REDACTED$-migration-tooling/node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>
   Use the exact name from the query. For a failed migration from 0.1.4,
   check and reconcile any partial effects before retrying.
4. Run this playbook again. It applies the migration and only then
   installs and starts the new binary.
Rollback:
The re-key or a later migration has a recorded attempt. Starting the previous binary is not supported. Complete forward recovery above, or restore the verified pre-upgrade database backup and matching release together.
Until the documented recovery is complete, do not run initial-setup.yml.

Origin: <work>/trees/759ce4573d35/deploy/ansible/playbooks/initial-setup.yml:253:7

251       when: migration_failure_marker_file.stat.exists
252
253     - name: Refuse to start signaling services after an interrupted deploy
          ^ column 7

fatal: [$REDACTED$-signaling]: FAILED! => {"changed": false, "msg": "initial-setup.yml will not enable or start a signaling service:\n/var/lib/$REDACTED$-migration-failed exists, so the binary on disk may not\nmatch the database schema. It says:\n\nThe PostgreSQL migration failed or was interrupted. Every signaling\nworker is stopped and disabled and the previous binary is still in\nplace, so nothing serves until this is resolved.\n\nRecover (deploy/README.md, \"A failed or interrupted migration\"):\n1. Read why it failed in /var/log/$REDACTED$-migration-failure.log (root only) on the\n   signaling host and, when Prisma recorded a failed migration, in its\n   row of \"_prisma_migrations\" (\"logs\" column).\n2. Check for contention, lost connectivity or disk errors. A lock may\n   wait 10s, a statement 120s, and the migration service 300s plus\n   10s for termination. Inspect migration history even after a timeout.\n3. Once the deploy and its migration have stopped, open the application\n   database on the PostgreSQL host:\n   sudo -u postgres psql -X -p 5432 -d $REDACTED$\n   SELECT migration_name FROM public._prisma_migrations\n   WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at;\n   A successful query returning zero rows means there is nothing to resolve.\n   If the table is absent, confirm the database and that the first migration\n   never started. Correct any connection or permission error before proceeding.\n   For each unfinished migration added in this release, from /home/$REDACTED$/server\n   on the signaling host as $REDACTED$, with DATABASE_URL as the play sets it:\n   /opt/$REDACTED$-bun/1.4.5/bin/bun /var/lib/$REDACTED$-migration-tooling/node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>\n   Use the exact name from the query. For a failed migration from 0.1.4,\n   check and reconcile any partial effects before retrying.\n4. Run this playbook again. It applies the migration and only then\n   installs and starts the new binary.\nRollback:\nThe re-key or a later migration has a recorded attempt. Starting the previous binary is not supported. Complete forward recovery above, or restore the verified pre-upgrade database backup and matching release together.\nUntil the documented recovery is complete, do not run initial-setup.yml.\n"}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=37   changed=4    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

```

State of the VM after initial-setup.yml:

```text

## signaling units
p2party-signaling-3001.service: enabled=disabled active=inactive restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3, embedded Bun 1.4.5
/var/lib/p2party-release-staging/p2party-server: sha256 26831df7f68c61d8ad16d6e6f2529c62341a6d2afd12854a22a7c8093bc7b9e9, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.3.14
migration Bun (/opt/p2party-bun/1.4.5/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: present (root:root mode 600, 2033 bytes)
/var/log/p2party-migration-failure.log: present (root:root mode 600, 1166 bytes)
--- first line of /var/lib/p2party-migration-failed:
The PostgreSQL migration failed or was interrupted. Every signaling
/etc/caddy/Caddyfile.p2party-candidate: present

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | t | f | 1 | f
20261127000000_rekey_peers_to_derived_ids | t | f | 1 | f
20261127000100_routing_claim_owner | f | f | 0 | t
(5 rows)

## schema details
Peer.socketGeneration: 0 column(s); PendingSignal.kind: 0 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
3 | 2 | 2 | 1 | 2
(1 row)

## serving
worker 127.0.0.1:3001/health: no answer
Caddy https://signaling.rehearsal.localhost/health: no answer
signaling processes:
caddy: active
postgresql: active
```

### The README's recovery (the lock is gone: step 2)

- The migration history names `20261127000100_routing_claim_owner` as unfinished.

The installed Prisma CLI ran `migrate resolve --rolled-back 20261127000100_routing_claim_owner` in the migration environment (exit 0):

```text
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "p2party", schema "public" at "10.231.0.2:5432"

Migration 20261127000100_routing_claim_owner marked as rolled back.

```

### Step 4: run the deploy again

deploy.yml, second run (exit 0):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [$REDACTED$-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Build the binary and check its build record on this machine] *************

TASK [Read the source revision and worktree state] *****************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Require the release Git checkout] ****************************************
ok: [$REDACTED$-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Build the Linux binary from this repo] ***********************************
changed: [$REDACTED$-signaling -> localhost]

TASK [Read the commit and whether the tree has changes] ************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Read the Bun that built the binary] **************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Read the built binary's SHA-256] *****************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Write the build record beside the binary] ********************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Confirm the binary exists before touching the host] **********************
ok: [$REDACTED$-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [$REDACTED$-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Parse the build record] **************************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Require a build record that matches the binary and the pinned Bun] *******
ok: [$REDACTED$-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Require a reused binary to come from this clean revision] ****************
skipping: [$REDACTED$-signaling]

PLAY [Verify the candidate version against the running release before provisioning] ***

TASK [Read the previous signaling binary] **************************************
ok: [$REDACTED$-signaling]

TASK [Read the serving version before changing the host] ***********************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Refuse two different binaries with the same serving version] *************
skipping: [$REDACTED$-signaling] => (item=3001)
skipping: [$REDACTED$-signaling]

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [$REDACTED$-postgres -> localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [$REDACTED$-postgres -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Provision PostgreSQL server identity] ************************************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-postgres]

TASK [Install certificate tooling] *********************************************
ok: [$REDACTED$-postgres]

TASK [Create private PostgreSQL certificate directory] *************************
ok: [$REDACTED$-postgres]

TASK [Create a local database trust anchor] ************************************
ok: [$REDACTED$-postgres]

TASK [Require a valid trust anchor before issuing or deploying a leaf] *********
ok: [$REDACTED$-postgres]

TASK [Create the database server key and signing request] **********************
ok: [$REDACTED$-postgres]

TASK [Set the authenticated database address and server usage] *****************
ok: [$REDACTED$-postgres]

TASK [Check whether the server certificate needs renewal] **********************
ok: [$REDACTED$-postgres]

TASK [Sign the database certificate with its private-address SAN] **************
skipping: [$REDACTED$-postgres]

TASK [Verify the certificate chain and actual database IP before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Read the certificate public key for the key-pair check] ******************
ok: [$REDACTED$-postgres]

TASK [Derive only the public portion of the PostgreSQL private key] ************
ok: [$REDACTED$-postgres]

TASK [Require a matching certificate and private key before changing services] ***
ok: [$REDACTED$-postgres]

TASK [Restrict certificate private keys] ***************************************
ok: [$REDACTED$-postgres] => (item=ca.key)
ok: [$REDACTED$-postgres] => (item=server.key)

TASK [Locate the installed PostgreSQL configuration] ***************************
ok: [$REDACTED$-postgres]

TASK [Enable PostgreSQL TLS with the authenticated certificate] ****************
ok: [$REDACTED$-postgres]

TASK [Require TLS for private-network PostgreSQL clients] **********************
ok: [$REDACTED$-postgres]

TASK [Read only the public database CA for distribution over SSH] **************
ok: [$REDACTED$-postgres]

PLAY [Install the database trust anchor on signaling hosts] ********************

TASK [Gathering Facts] *********************************************************
ok: [$REDACTED$-signaling]

TASK [Require exactly one configured database host] ****************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Create the public trust directory] ***************************************
ok: [$REDACTED$-signaling]

TASK [Install the public PostgreSQL CA] ****************************************
ok: [$REDACTED$-signaling]

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

TASK [Read the signaling host's architecture] **********************************
ok: [$REDACTED$-signaling]

TASK [Select the release archive for this host] ********************************
ok: [$REDACTED$-signaling]

TASK [Install unzip to read the verified archive] ******************************
ok: [$REDACTED$-signaling]

TASK [Create the root-owned Bun release directory] *****************************
ok: [$REDACTED$-signaling]

TASK [Fetch the signed-release archive by its pinned checksum] *****************
ok: [$REDACTED$-signaling]

TASK [Extract the checked Bun release] *****************************************
ok: [$REDACTED$-signaling]

TASK [Install the native Bun binary from the verified release] *****************
ok: [$REDACTED$-signaling]

TASK [Check the installed runtime as its unprivileged caller] ******************
ok: [$REDACTED$-signaling]

TASK [Create the unprivileged migration dependency installer] ******************
ok: [$REDACTED$-signaling]

TASK [Create an isolated directory for audited migration tooling] **************
ok: [$REDACTED$-signaling]

TASK [Give only the package installer write access to node_modules] ************
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

TASK [Validate the staged environment as the signaling worker] *****************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Stage the private migration environment] *********************************
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

TASK [Record which installed workers currently serve] **************************
ok: [$REDACTED$-signaling] => (item=/etc/systemd/system/$REDACTED$-signaling-3001.service)

TASK [Preserve a recovery marker before the first stop] ************************
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

TASK [Verify the installed release file after startup] *************************
ok: [$REDACTED$-signaling]

TASK [Require the installed file to match the candidate] ***********************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Verify the executable of each running signaling worker] ******************
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
        "content": "{\"status\":\"ok\",\"protocolVersion\":5,\"version\":\"0.2.0\",\"serverId\":\"a9ef6e9f-f375-4db2-978b-70f7785e269a\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Fri, 27 Nov 2026 09:56:58 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 5,
            "serverId": "a9ef6e9f-f375-4db2-978b-70f7785e269a",
            "status": "ok",
            "version": "0.2.0"
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

TASK [Remove private staged environments and any previous migration error] *****
changed: [$REDACTED$-signaling] => (item=/var/lib/$REDACTED$-release-staging/.env)
changed: [$REDACTED$-signaling] => (item=/var/lib/$REDACTED$-release-staging/migration.env)
changed: [$REDACTED$-signaling] => (item=/var/log/$REDACTED$-migration-failure.log)

TASK [Deployment complete] *****************************************************
ok: [$REDACTED$-signaling] => {
    "msg": "$REDACTED$ signaling server 0.2.0 deployed to $REDACTED$-signaling on 1 verified workers"
}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=80   changed=10   unreachable=0    failed=0    skipped=5    rescued=0    ignored=0

```

State of the VM after the second run:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 26831df7f68c61d8ad16d6e6f2529c62341a6d2afd12854a22a7c8093bc7b9e9, embedded Bun 1.4.5
/var/lib/p2party-release-staging/p2party-server: sha256 26831df7f68c61d8ad16d6e6f2529c62341a6d2afd12854a22a7c8093bc7b9e9, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.3.14
migration Bun (/opt/p2party-bun/1.4.5/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: absent
/var/log/p2party-migration-failure.log: absent

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | t | f | 1 | f
20261127000000_rekey_peers_to_derived_ids | t | f | 1 | f
20261127000100_routing_claim_owner | f | t | 0 | t
20261127000100_routing_claim_owner | t | f | 1 | f
(6 rows)

## schema details
Peer.socketGeneration: 1 column(s); PendingSignal.kind: 1 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
3 | 2 | 2 | 1 | 0
(1 row)

## serving
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":5,"version":"0.2.0","serverId":"a9ef6e9f-f375-4db2-978b-70f7785e269a"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":5,"version":"0.2.0","serverId":"a9ef6e9f-f375-4db2-978b-70f7785e269a"}
signaling processes: 6204 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
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

From the host, https://signaling.rehearsal.localhost:56443/health (127.0.0.1, the guest's Caddy CA):

```text
{"status":"ok","protocolVersion":5,"version":"0.2.0","serverId":"a9ef6e9f-f375-4db2-978b-70f7785e269a"}
```

- Finished: 2026-11-27T09:57:04Z
