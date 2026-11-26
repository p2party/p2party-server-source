# Upgrade: the commit under test deployed over release 0.1.4

- Commit under test: `f6802bd7f7f49a1639f3667935f0cb13c6a4f1b3` (Tell a room's members when a member leaves or its last socket closes)
- Release before it: `ecf691a957b2` (0.1.4, `master`)
- Harness: `deploy/rehearsal/run.sh upgrade` from the tree at `f6802bd7f7f4`
- Started: 2026-11-26T23:29:24Z

The README's paragraph on the deploy order:

> 1. prepares the release while the old one keeps serving: installs migration
>    tooling from this release's `package.json` and `bun.lock` (a registry
>    fetch), copies the schema and migrations, stages the new binary, its
>    environment file and its units in `~p2party/server/release-staging/`, and
>    renders and validates a candidate Caddy configuration. Nothing the running
>    workers read changes. If any of this fails, the play ends with "Report that
>    preparing the release failed" and production is still running the previous
>    release, untouched;
> 2. stops and disables every signaling worker (`p2party-signaling*.service`), so
>    neither `Restart=always` nor a reboot can start one while the schema changes,
>    and writes the marker `/var/lib/p2party-migration-failed` (below);
> 3. applies pending migrations;
> 4. only if they succeed, installs the staged binary, environment file and
>    units, removes the marker, installs the Caddy configuration, then enables and
>    starts the desired workers and verifies their version through Caddy.

Before deploying, deploy/README.md says to check the host's Bun: `sudo -u p2party /home/p2party/.bun/bin/bun --version` printed `1.3.14`; the pin is 1.4.5.

Stand-in `host-bun` (exit 0):

```text
1.4.5
```

## 1. From a plain `git archive` of the commit (no git metadata)

deploy.yml from the plain archive (exit 2):

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
[ERROR]: Task failed: Module failed: The command exited with a non-zero return code.
Origin: <work>/trees/f6802bd7f7f4-archive-only/deploy/ansible/playbooks/deploy.yml:66:15

64           when: not (skip_build | default(false) | bool)
65           block:
66             - name: Read the commit and whether the tree has changes
                 ^ column 15

fatal: [p2party-signaling -> localhost]: FAILED! => {"changed": false, "changed_when_result": false, "cmd": "git -C \"<work>/trees/f6802bd7f7f4-archive-only/deploy/ansible/playbooks/../../..\" rev-parse HEAD && git -C \"<work>/trees/f6802bd7f7f4-archive-only/deploy/ansible/playbooks/../../..\" status --porcelain", "delta": "0:00:00.019048", "end": "2026-11-27 01:29:30.749740", "msg": "The command exited with a non-zero return code.", "rc": 128, "start": "2026-11-27 01:29:30.730692", "stderr": "fatal: not a git repository (or any of the parent directories): .git", "stderr_lines": ["fatal: not a git repository (or any of the parent directories): .git"], "stdout": "", "stdout_lines": []}

PLAY RECAP *********************************************************************
p2party-postgres           : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
p2party-signaling          : ok=1    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

```

State of the VM after the run from the plain archive:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: absent
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: absent
/var/log/p2party-migration-failure.log: absent

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
(2 rows)

## schema details
Peer.socketGeneration: 0 column(s); PendingSignal.kind: 0 column(s); PendingSignal_createdAt_idx: 0 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
4 | 2 | 3 | 2 | 2
(1 row)

## serving
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"bcd896f9-1758-4c63-935b-7526c9bd7a3d"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"bcd896f9-1758-4c63-935b-7526c9bd7a3d"}
signaling processes: 1411 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

## 2. From the archive with the commit's git metadata

deploy.yml (exit 0):

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
        "content": "{\"status\":\"ok\",\"protocolVersion\":4,\"version\":\"0.1.4\",\"serverId\":\"54d5e8bc-c364-4171-819c-256131f41f9b\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Thu, 26 Nov 2026 23:30:00 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 4,
            "serverId": "54d5e8bc-c364-4171-819c-256131f41f9b",
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

RUNNING HANDLER [Restart journald] *********************************************
changed: [$REDACTED$-signaling]

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=62   changed=22   unreachable=0    failed=0    skipped=3    rescued=0    ignored=0

```

State of the VM after the upgrade:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 67ad3186e428ae5e4a8f824d00644c80e09907f3ac89e5a18e44f05ac1d653ab, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 67ad3186e428ae5e4a8f824d00644c80e09907f3ac89e5a18e44f05ac1d653ab, embedded Bun 1.4.5
host Bun (/home/p2party/.bun/bin/bun): 1.4.5

## deploy markers
/var/lib/p2party-migration-failed: absent
/var/log/p2party-migration-failure.log: absent

## migration history (_prisma_migrations)
migration_name | finished | rolled_back | steps | has_logs
20260224171205_init | t | f | 1 | f
20260224172227_add_pubsub | t | f | 1 | f
20261126120000_pending_signal_created_at_index | t | f | 1 | f
20261127000000_rekey_peers_to_derived_ids | t | f | 1 | f
20261127000100_routing_claim_owner | t | f | 1 | f
(5 rows)

## schema details
Peer.socketGeneration: 1 column(s); PendingSignal.kind: 1 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
3 | 2 | 2 | 1 | 0
(1 row)

## serving
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"54d5e8bc-c364-4171-819c-256131f41f9b"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"54d5e8bc-c364-4171-819c-256131f41f9b"}
signaling processes: 3268 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

Seeded rows against the migration's intent after the upgrade (exit 0):

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
{"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"54d5e8bc-c364-4171-819c-256131f41f9b"}
```

The build record the deploy wrote (`deploy/ansible/builds/p2party_linux_x64.build.json`):

```text
{
    "artefact": "p2party_linux_x64",
    "bun": "1.4.5",
    "commit": "f6802bd7f7f49a1639f3667935f0cb13c6a4f1b3",
    "dirty": false,
    "sha256": "67ad3186e428ae5e4a8f824d00644c80e09907f3ac89e5a18e44f05ac1d653ab"
}
```

The items of deploy/README.md "First exercised at the release deploy" as they ran here (architecture, Rosetta, the binary's ELF header, TypeScript's native package in the tooling, Prisma, Caddy, PostgreSQL, the host's Bun):

```text
+ uname -m
aarch64
+ ls /proc/sys/fs/binfmt_misc/
+ grep -i rosetta
rosetta
+ head -c 20 /home/p2party/server/p2party-server
+ od -A n -t x1
+ head -1
 7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00
+ ls /home/p2party/server/migration-tooling/node_modules/@typescript/
typescript-linux-arm64
+ grep -m1 '"version"' /home/p2party/server/migration-tooling/node_modules/prisma/package.json
  "version": "7.10.1",
+ caddy version
2.6.2
+ psql --version
psql (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
+ sudo -u p2party /home/p2party/.bun/bin/bun --version
1.4.5
```

- Finished: 2026-11-26T23:30:11Z
