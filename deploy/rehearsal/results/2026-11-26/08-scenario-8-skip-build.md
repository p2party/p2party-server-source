# Scenario 8: --skip-build with an artefact built from another commit

- Commit under test: `6a6cfc244f43b167fe3c03090211f3cadfaf45ed` (Run the release rehearsal: 0.1.4 baseline, upgrade and fault scenarios)
- Release before it: `ecf691a957b2` (0.1.4, `master`)
- Harness: `deploy/rehearsal/run.sh scenario-8` from the tree at `6a6cfc244f43`
- Started: 2026-11-26T23:17:17Z

## What deploy/README.md says about this case

> 1. **On the control machine.** `playbooks/local-preflight.yml`, the first play
>    of every playbook here, requires `bun --version` on `PATH` to equal the pin,
>    because `bun build --compile` embeds the Bun that runs it, and refuses a pin
>    for which `bun.release_sha256` records no hashes. It also requires the
>    ansible-core these playbooks were tested with: `ansible_core_tested`
>    (2.22.0) or a later patch release of that minor line, below 2.23. Its tasks
>    run once, on this machine only, without facts; the play also matches every
>    host of the run, so a `--limit` that leaves `localhost` out does not skip
>    it. It runs with `--skip-build` too.
> 2. **The binary's build record**, `deploy.yml`'s second play, also on this
>    machine only. The build (skipped with `--skip-build`) writes a record beside
>    the binary, `builds/p2party_linux_x64.build.json`: the Bun that built it
>    (the pre-flight has just required the pin), the commit, whether the tree
>    had changes (`dirty`), and the binary's SHA-256. Every deploy then requires
>    that the record exists and is valid JSON, matches the binary's SHA-256 and
>    names the pin; a binary built by hand, rebuilt after its record, or built
>    with another Bun is refused, and so is a missing or damaged record. The
>    commit and dirty flag are there to prove later that a `--skip-build` binary
>    is the build of the tree being deployed; nothing compares them yet.
> 3. **The signaling host's own Bun**, `~p2party/.bun/bin/bun`, which installs
>    and runs the migration tooling from `bun.lock`. `deploy.yml`'s third play
>    only reads: it runs that Bun's `--version` as `p2party` and requires the
>    pin, before `postgres-tls.yml` and the deploy play change anything.
>    `playbooks/initial-setup.yml` installs Bun only when it is absent and never
>    upgrades it, so an existing host may fail here; the message prints the
>    install command below.

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

## The run

Before deploying, deploy/README.md says to check the host's Bun: `sudo -u p2party /home/p2party/.bun/bin/bun --version` printed `1.3.14`; the pin is 1.4.5.

Stand-in `host-bun` (exit 0):

```text
1.4.5
```

### a. Release 0.1.4's binary, no build record

- `deploy/ansible/builds/p2party_linux_x64`: 0.1.4's binary, SHA-256 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3; no `.build.json`.

deploy.yml -e skip_build=true (exit 2):

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
skipping: [p2party-signaling]

TASK [Read the commit and whether the tree has changes] ************************
skipping: [p2party-signaling]

TASK [Read the Bun that built the binary] **************************************
skipping: [p2party-signaling]

TASK [Read the built binary's SHA-256] *****************************************
skipping: [p2party-signaling]

TASK [Write the build record beside the binary] ********************************
skipping: [p2party-signaling]

TASK [Confirm the binary exists before touching the host] **********************
ok: [p2party-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [p2party-signaling -> localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Parse the build record] **************************************************
[ERROR]: Task failed: Finalization of task args for 'ansible.builtin.set_fact' failed: Error while resolving value for 'build_record': The lookup plugin 'ansible.builtin.file' failed: Unable to access the file '<work>/trees/6a6cfc244f43/deploy/ansible/playbooks/../../../deploy/ansible/builds/p2party_linux_x64.build.json': File not found. Use -vvvvv to see paths searched.

Task failed.
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:115:15

113         - name: Read the build record
114           block:
115             - name: Parse the build record
                  ^ column 15

<<< caused by >>>

Finalization of task args for 'ansible.builtin.set_fact' failed.
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:116:15

114           block:
115             - name: Parse the build record
116               set_fact:
                  ^ column 15

<<< caused by >>>

Error while resolving value for 'build_record': The lookup plugin 'ansible.builtin.file' failed: Unable to access the file '<work>/trees/6a6cfc244f43/deploy/ansible/playbooks/../../../deploy/ansible/builds/p2party_linux_x64.build.json': File not found. Use -vvvvv to see paths searched.
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:117:31

115             - name: Parse the build record
116               set_fact:
117                 build_record: "{{ lookup('ansible.builtin.file', build_record_path) | from_json }}"
                                  ^ column 31

fatal: [p2party-signaling -> localhost]: FAILED! => {"changed": false, "msg": "Task failed: Finalization of task args for 'ansible.builtin.set_fact' failed: Error while resolving value for 'build_record': The lookup plugin 'ansible.builtin.file' failed: Unable to access the file '<work>/trees/6a6cfc244f43/deploy/ansible/playbooks/../../../deploy/ansible/builds/p2party_linux_x64.build.json': File not found. Use -vvvvv to see paths searched."}

TASK [Treat a missing or unreadable build record as none] **********************
ok: [p2party-signaling -> localhost]

TASK [Require a build record that matches the binary and the pinned Bun] *******
[ERROR]: Task failed: Action failed: deploy/ansible/builds/p2party_linux_x64 has no readable build record (deploy/ansible/builds/p2party_linux_x64.build.json is missing or not valid JSON): it was not built by this playbook, or its record was removed or damaged. Nothing on any host has been changed. Run deploy/deploy.sh without --skip-build on a control machine whose bun is 1.4.5.
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:125:11

123         # Also after --skip-build: the binary must carry a record that matches
124         # its bytes and names the pinned Bun, before anything is staged.
125         - name: Require a build record that matches the binary and the pinned Bun
              ^ column 11

fatal: [p2party-signaling -> localhost]: FAILED! => {
    "assertion": "build_record.sha256 | default('') == built_binary.stat.checksum",
    "changed": false,
    "evaluated_to": false,
    "msg": "deploy/ansible/builds/p2party_linux_x64 has no readable build record (deploy/ansible/builds/p2party_linux_x64.build.json is missing or not valid JSON): it was not built by this playbook, or its record was removed or damaged. Nothing on any host has been changed. Run deploy/deploy.sh without --skip-build on a control machine whose bun is 1.4.5."
}

PLAY RECAP *********************************************************************
p2party-postgres           : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
p2party-signaling          : ok=3    changed=0    unreachable=0    failed=1    skipped=5    rescued=1    ignored=0

```

- On the host, every file and service of guest/fingerprint.sh is as it was before the run with no build record (no difference).

State of the VM after 8a:

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
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"7bd928e5-8281-497c-a2a3-cb296051adfc"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"7bd928e5-8281-497c-a2a3-cb296051adfc"}
signaling processes: 1414 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

### b. The same binary beside a build record whose SHA-256 is another binary's

- `p2party_linux_x64.build.json`: the record this commit's own build wrote (in the upgrade run):

```text
{
    "artefact": "p2party_linux_x64",
    "bun": "1.4.5",
    "commit": "6a6cfc244f43b167fe3c03090211f3cadfaf45ed",
    "dirty": false,
    "sha256": "7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912"
}
```

deploy.yml -e skip_build=true (exit 2):

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
skipping: [p2party-signaling]

TASK [Read the commit and whether the tree has changes] ************************
skipping: [p2party-signaling]

TASK [Read the Bun that built the binary] **************************************
skipping: [p2party-signaling]

TASK [Read the built binary's SHA-256] *****************************************
skipping: [p2party-signaling]

TASK [Write the build record beside the binary] ********************************
skipping: [p2party-signaling]

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
[ERROR]: Task failed: Action failed: deploy/ansible/builds/p2party_linux_x64 does not match its build record (recorded SHA-256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, binary 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3): it was rebuilt or replaced after the record was written. Nothing on any host has been changed. Run deploy/deploy.sh without --skip-build on a control machine whose bun is 1.4.5.
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:125:11

123         # Also after --skip-build: the binary must carry a record that matches
124         # its bytes and names the pinned Bun, before anything is staged.
125         - name: Require a build record that matches the binary and the pinned Bun
              ^ column 11

fatal: [p2party-signaling -> localhost]: FAILED! => {
    "assertion": "build_record.sha256 | default('') == built_binary.stat.checksum",
    "changed": false,
    "evaluated_to": false,
    "msg": "deploy/ansible/builds/p2party_linux_x64 does not match its build record (recorded SHA-256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, binary 5245f43d191593542c81d1d98321c43a8e275c0e5ccd78a2504e748925488fb3): it was rebuilt or replaced after the record was written. Nothing on any host has been changed. Run deploy/deploy.sh without --skip-build on a control machine whose bun is 1.4.5."
}

PLAY RECAP *********************************************************************
p2party-postgres           : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
p2party-signaling          : ok=3    changed=0    unreachable=0    failed=1    skipped=5    rescued=0    ignored=0

```

- On the host, every file and service of guest/fingerprint.sh is as it was before the run with a record of another binary (no difference).

State of the VM after 8b:

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
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"7bd928e5-8281-497c-a2a3-cb296051adfc"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"7bd928e5-8281-497c-a2a3-cb296051adfc"}
signaling processes: 1414 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

### Next step (scenario 7): deploy.sh without --skip-build

deploy.yml, second run (builds) (exit 0):

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
changed: [p2party-signaling -> localhost]

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
        "content": "{\"status\":\"ok\",\"protocolVersion\":4,\"version\":\"0.1.4\",\"serverId\":\"c8b8a5ee-4448-4b1b-ab05-73f37702410c\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Thu, 26 Nov 2026 23:17:54 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 4,
            "serverId": "c8b8a5ee-4448-4b1b-ab05-73f37702410c",
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
$REDACTED$-signaling          : ok=62   changed=23   unreachable=0    failed=0    skipped=3    rescued=0    ignored=0

```

State of the VM after the second run:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 7a7297618ffed272c2b2fefb063feae0592d597718059d8ad5b92a84f9e5d912, embedded Bun 1.4.5
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
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"c8b8a5ee-4448-4b1b-ab05-73f37702410c"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"c8b8a5ee-4448-4b1b-ab05-73f37702410c"}
signaling processes: 3658 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

### c. The binary and build record of a deploy of another commit

- First, `35d94c8a280e` (Check the staged binary by its hash and a build record, never by running it) deployed normally, which builds its binary and writes its record:

deploy.yml at 35d94c8a280e (exit 0):

```text

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

PLAY [Check this machine's toolchain before any host is contacted] *************

TASK [Require the ansible-core these playbooks were tested with] ***************
ok: [localhost] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Find the Bun on PATH] ****************************************************
ok: [localhost]

TASK [Require the Bun package.json pins] ***************************************
ok: [localhost] => {
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

TASK [Build the Linux binary from this repo] ***********************************
changed: [$REDACTED$-signaling -> localhost]

TASK [Read the commit and whether the tree has changes] ************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Read the Bun that built the binary] **************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Read the built binary's SHA-256] *****************************************
ok: [$REDACTED$-signaling -> localhost]

TASK [Write the build record beside the binary] ********************************
changed: [$REDACTED$-signaling -> localhost]

TASK [Confirm the binary exists before touching the host] **********************
ok: [$REDACTED$-signaling -> localhost]

TASK [Fail early when there is nothing to deploy] ******************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Require a build record that matches the binary and the pinned Bun] *******
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Resolve the desired signaling instance ports] ****************************
ok: [$REDACTED$-signaling]

TASK [Read the Bun version of the signaling host] ******************************
ok: [$REDACTED$-signaling]

TASK [Require Bun 1.4.5 on the signaling host] *********************************
ok: [$REDACTED$-signaling] => {
    "changed": false,
    "msg": "All assertions passed"
}

TASK [Ensure the journald drop-in directory exists] ****************************
ok: [$REDACTED$-signaling]

TASK [Keep the journal for at most seven days] *********************************
ok: [$REDACTED$-signaling]

TASK [Ensure the server directory exists] **************************************
ok: [$REDACTED$-signaling]

TASK [Create an isolated directory for audited migration tooling] **************
ok: [$REDACTED$-signaling]

TASK [Copy the audited package manifest and frozen dependency lock] ************
changed: [$REDACTED$-signaling] => (item=package.json)
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
changed: [$REDACTED$-signaling]

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
changed: [$REDACTED$-signaling]

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
        "content": "{\"status\":\"ok\",\"protocolVersion\":4,\"version\":\"0.1.4\",\"serverId\":\"65eb3dc9-c9ba-4b3c-a353-c043522d094d\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Thu, 26 Nov 2026 23:18:34 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 4,
            "serverId": "65eb3dc9-c9ba-4b3c-a353-c043522d094d",
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
localhost                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
$REDACTED$-postgres           : ok=17   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=59   changed=14   unreachable=0    failed=0    skipped=3    rescued=0    ignored=0

```

- Then its binary and record copied into this commit's tree:

```text
{
    "artefact": "p2party_linux_x64",
    "bun": "1.4.5",
    "commit": "35d94c8a280eb542ce2469986255da5c01b7f16a",
    "dirty": false,
    "sha256": "c9480b3156ec568b1b3db884876db98a18be5e03f5400f75d503772b01800a0f"
}
```

deploy.yml -e skip_build=true at 6a6cfc244f43 (exit 0):

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
skipping: [p2party-signaling]

TASK [Read the commit and whether the tree has changes] ************************
skipping: [p2party-signaling]

TASK [Read the Bun that built the binary] **************************************
skipping: [p2party-signaling]

TASK [Read the built binary's SHA-256] *****************************************
skipping: [p2party-signaling]

TASK [Write the build record beside the binary] ********************************
skipping: [p2party-signaling]

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
changed: [$REDACTED$-signaling] => (item=package.json)
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
changed: [$REDACTED$-signaling]

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
changed: [$REDACTED$-signaling] => (item=$REDACTED$-signaling-3001.service)

TASK [Mark that the binary on disk may not match the schema] *******************
changed: [$REDACTED$-signaling]

TASK [Apply migrations against Postgres] ***************************************
changed: [$REDACTED$-signaling]

TASK [Install the staged binary] ***********************************************
ok: [$REDACTED$-signaling]

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
        "content": "{\"status\":\"ok\",\"protocolVersion\":4,\"version\":\"0.1.4\",\"serverId\":\"597977c6-2a38-4707-9781-0e8e7295db90\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Thu, 26 Nov 2026 23:19:04 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 4,
            "serverId": "597977c6-2a38-4707-9781-0e8e7295db90",
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
$REDACTED$-signaling          : ok=56   changed=10   unreachable=0    failed=0    skipped=8    rescued=0    ignored=0

```

State of the VM after 8c:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=active restarts=0

## binaries
/home/p2party/server/p2party-server: sha256 c9480b3156ec568b1b3db884876db98a18be5e03f5400f75d503772b01800a0f, embedded Bun 1.4.5
/home/p2party/server/release-staging/p2party-server: sha256 c9480b3156ec568b1b3db884876db98a18be5e03f5400f75d503772b01800a0f, embedded Bun 1.4.5
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
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"597977c6-2a38-4707-9781-0e8e7295db90"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"597977c6-2a38-4707-9781-0e8e7295db90"}
signaling processes: 5755 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

- Finished: 2026-11-26T23:19:12Z
