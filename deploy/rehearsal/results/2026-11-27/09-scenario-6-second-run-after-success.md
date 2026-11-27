# Scenario 6: a second run after a success

- Commit under test: `759ce4573d35e4bc75eb52979c2deb71087f1a49` (Upgrade Cloudflare state and rulesets to v5 and pin PostgreSQL collection)
- Baseline: `ecf691a957b2` (release 0.1.4 by default)
- Harness (`run.sh scenario-6`): run.sh sha256 `9ed6268fd6a9b622a5bb645e841e55c8854c0cc0772e71b65b8dd56f11ef6458`, lima.yaml sha256 `730b5c29b91e61b2470dc6563d29de378b93ed02ed813505f568f15772430b7f`; deploy/rehearsal as committed at `99a4760213c4`
- Started: 2026-11-27T10:03:57Z

deploy.yml, the first run (the upgrade) (exit 0):

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
changed: [$REDACTED$-signaling]

TASK [Install the staged binary] ***********************************************
changed: [$REDACTED$-signaling]

TASK [Install the staged signaling environment file] ***************************
changed: [$REDACTED$-signaling]

TASK [Install the staged systemd unit files] ***********************************
changed: [$REDACTED$-signaling] => (item=3001)

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
        "content": "{\"status\":\"ok\",\"protocolVersion\":5,\"version\":\"0.2.0\",\"serverId\":\"44d5108d-f856-455e-9ecf-8825caed26bf\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Fri, 27 Nov 2026 10:05:05 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 5,
            "serverId": "44d5108d-f856-455e-9ecf-8825caed26bf",
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
ok: [$REDACTED$-signaling] => (item=/var/log/$REDACTED$-migration-failure.log)

TASK [Deployment complete] *****************************************************
ok: [$REDACTED$-signaling] => {
    "msg": "$REDACTED$ signaling server 0.2.0 deployed to $REDACTED$-signaling on 1 verified workers"
}

RUNNING HANDLER [Restart journald] *********************************************
changed: [$REDACTED$-signaling]

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=81   changed=35   unreachable=0    failed=0    skipped=5    rescued=0    ignored=0

```

## What deploy/README.md says about this case

> 1. prepares the release while the old one keeps serving: installs migration
>    tooling from this release's `package.json` and `bun.lock` (a registry
>    fetch), copies the schema and migrations, stages the new binary, its
>    environment and units in `/var/lib/p2party-release-staging/`, and
>    validates the candidate Caddy configuration. For each configured port,
>    systemd loads the staged environment and runs the staged binary's
>    `--check-config` as the service account with network access isolated.
>    A failure stops the deploy here. Check the workers' current health and
>    the failed task. Earlier TLS provisioning may already have run;
> 2. writes `/var/lib/p2party-migration-failed`, then stops and disables every
>    signaling worker (`p2party-signaling*.service`) before changing the schema;
> 3. applies pending migrations as the service account. PostgreSQL allows 10
>    seconds to acquire a lock and 120 seconds for each statement. systemd
>    allows 300 seconds for the full CLI run, then terminates the process group
>    and kills any survivors after 10 seconds;
> 4. only if they succeed, installs the staged binary, environment file and
>    units, removes the marker, installs the Caddy configuration, then enables and
>    starts the desired workers and verifies their version through Caddy.

> With several signaling hosts, a failure on one ends the play on all of them
> (`any_errors_fatal`), so no migration runs while a worker anywhere still serves.
> Clients are cut off from step 2 until the new workers start. The migration CLI
> lives under the root-owned `/var/lib/p2party-migration-tooling` directory; it is installed from the
> release's audited `package.json` and frozen `bun.lock` rather than fetched as an
> independent CLI dependency tree. Its working directory remains the server
> directory containing `prisma.config.ts` and `prisma/`.

## The run

- Before: the worker's MainPID=3386 ActiveEnterTimestamp=Fri 2026-11-27 10:05:00 UTC

deploy.yml, run again on the upgraded host (exit 0):

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
ok: [$REDACTED$-signaling] => (item=3001) => {
    "ansible_loop_var": "item",
    "changed": false,
    "item": {
        "ansible_loop_var": "item",
        "ansible_parsed": true,
        "cache_control": "no-store",
        "changed": false,
        "changed_when_result": false,
        "content": "{\"status\":\"ok\",\"protocolVersion\":5,\"version\":\"0.2.0\",\"serverId\":\"44d5108d-f856-455e-9ecf-8825caed26bf\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Fri, 27 Nov 2026 10:05:13 GMT",
        "elapsed": 0,
        "failed": false,
        "failed_when_result": false,
        "item": 3001,
        "json": {
            "protocolVersion": 5,
            "serverId": "44d5108d-f856-455e-9ecf-8825caed26bf",
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
changed: [$REDACTED$-signaling]

TASK [Validate the staged environment as the signaling worker] *****************
ok: [$REDACTED$-signaling] => (item=3001)

TASK [Stage the private migration environment] *********************************
changed: [$REDACTED$-signaling]

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

TASK [Record which installed workers currently serve] **************************
ok: [$REDACTED$-signaling] => (item=/etc/systemd/system/$REDACTED$-signaling-3001.service)

TASK [Preserve a recovery marker before the first stop] ************************
changed: [$REDACTED$-signaling]

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
        "content": "{\"status\":\"ok\",\"protocolVersion\":5,\"version\":\"0.2.0\",\"serverId\":\"943ad4ab-fc68-4846-a929-7f969f84609e\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Fri, 27 Nov 2026 10:05:57 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 5,
            "serverId": "943ad4ab-fc68-4846-a929-7f969f84609e",
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
ok: [$REDACTED$-signaling] => (item=/var/log/$REDACTED$-migration-failure.log)

TASK [Deployment complete] *****************************************************
ok: [$REDACTED$-signaling] => {
    "msg": "$REDACTED$ signaling server 0.2.0 deployed to $REDACTED$-signaling on 1 verified workers"
}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=81   changed=14   unreachable=0    failed=0    skipped=4    rescued=0    ignored=0

```

- After: the worker's MainPID=4599 ActiveEnterTimestamp=Fri 2026-11-27 10:05:53 UTC

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
20261127000100_routing_claim_owner | t | f | 1 | f
(5 rows)

## schema details
Peer.socketGeneration: 1 column(s); PendingSignal.kind: 1 column(s); PendingSignal_createdAt_idx: 1 index(es)

## rows
peers | rooms | memberships | challenges | pending_signals
3 | 2 | 2 | 1 | 0
(1 row)

## serving
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":5,"version":"0.2.0","serverId":"943ad4ab-fc68-4846-a929-7f969f84609e"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":5,"version":"0.2.0","serverId":"943ad4ab-fc68-4846-a929-7f969f84609e"}
signaling processes: 4599 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

From the host, https://signaling.rehearsal.localhost:56443/health (127.0.0.1, the guest's Caddy CA):

```text
{"status":"ok","protocolVersion":5,"version":"0.2.0","serverId":"943ad4ab-fc68-4846-a929-7f969f84609e"}
```

Seeded rows against the migration's intent after the second run (exit 0):

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

- Finished: 2026-11-27T10:06:03Z
