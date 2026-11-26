# Scenario 5: a new binary that will not start (a bad value in its environment file)

- Commit under test: `6a6cfc244f43b167fe3c03090211f3cadfaf45ed` (Run the release rehearsal: 0.1.4 baseline, upgrade and fault scenarios)
- Release before it: `ecf691a957b2` (0.1.4, `master`)
- Harness: `deploy/rehearsal/run.sh scenario-5` from the tree at `6a6cfc244f43`
- Started: 2026-11-26T23:15:17Z

## What deploy/README.md says about this case

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

> The binary also checks the schema itself. Before it opens its listener it reads
> Prisma's migration history, on its own connection, within 8 seconds, and exits
> with one `p2party: refusing to start` line when the database does not answer,
> cannot be reached, is empty, lacks a migration the build ships, has one it does
> not ship, or holds a failed migration. It then re-runs the identity re-key
> statement within its own bound of 60 seconds (normally a no-op); a re-key that
> runs past it is cancelled, changes nothing, and ends the start with the same
> kind of line. `Restart=always` then only repeats the refusal.

(No paragraph of deploy/README.md at this commit matches /COTURN_SECRET/: the README is silent here.)

## The run

Before deploying, deploy/README.md says to check the host's Bun: `sudo -u p2party /home/p2party/.bun/bin/bun --version` printed `1.3.14`; the pin is 1.4.5.

Stand-in `host-bun` (exit 0):

```text
1.4.5
```

- The deploy renders COTURN_SECRET from `vault_coturn_auth_secret`, given here as an extra variable of 21 bytes (`too-short-turn-secret`); the server refuses one under 32 bytes.

deploy.yml with the short secret (exit 2):

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
changed: [$REDACTED$-signaling]

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
[ERROR]: Task failed: Module failed: Timeout when waiting for 127.0.0.1:3001
Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:673:11

671     - name: Wait for signaling services to be healthy
672       block:
673         - name: Wait for each instance to accept connections
              ^ column 11

failed: [$REDACTED$-signaling] (item=3001) => {"ansible_loop_var": "item", "changed": false, "elapsed": 25, "item": 3001, "msg": "Timeout when waiting for 127.0.0.1:3001"}

TASK [Collect why the service did not start] ***********************************
ok: [$REDACTED$-signaling]

TASK [Report the service failure] **********************************************
[ERROR]: Task failed: Action failed: The signaling service did not start. Its own log follows.

Most likely: COTURN_SECRET missing or under 32 bytes, the
database unreachable or not answering, or a database schema this
build was not made for. For both database cases the server exits
within 10s with one "$REDACTED$: refusing to start" line saying what
it found and what to run (a startup re-key that runs past its own
60s bound is reported the same way).

● $REDACTED$-signaling-3001.service - P2Party Signaling Server
     Loaded: loaded (/etc/systemd/system/$REDACTED$-signaling-3001.service; enabled; preset: enabled)
     Active: activating (auto-restart) (Result: exit-code) since Thu 2026-11-26 23:16:15 UTC; 2s ago
    Process: 3250 ExecStart=/home/$REDACTED$/server/$REDACTED$-server (code=exited, status=1/FAILURE)
   Main PID: 3250 (code=exited, status=1/FAILURE)
        CPU: 504ms
--- journal ---
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: 135 | export const assertSecureTurnSecret = (secret: string | undefined): void => {
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: 136 |   if (secret !== undefined && Buffer.byteLength(secret, "utf8") < 32)
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: 137 |     throw new Error("COTURN_SECRET must contain at least 32 bytes");
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]:                     ^
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: error: COTURN_SECRET must contain at least 32 bytes
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]:       at FE (src/utils/socketAuth.ts:137:15)
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]:       at src/index.ts:22:1
Nov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: Bun v1.4.5 (Linux x64)
Nov 26 23:16:04 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Main process exited, code=exited, status=1/FAILURE
Nov 26 23:16:04 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Failed with result 'exit-code'.
Nov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Scheduled restart job, restart counter is at 3.
Nov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: Started $REDACTED$-signaling-3001.service - P2Party Signaling Server.
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 132 |   return normalizeTurnUrls(raw.split(","));
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 133 | };
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 134 |
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 135 | export const assertSecureTurnSecret = (secret: string | undefined): void => {
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 136 |   if (secret !== undefined && Buffer.byteLength(secret, "utf8") < 32)
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 137 |     throw new Error("COTURN_SECRET must contain at least 32 bytes");
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]:                     ^
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: error: COTURN_SECRET must contain at least 32 bytes
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]:       at FE (src/utils/socketAuth.ts:137:15)
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]:       at src/index.ts:22:1
Nov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: Bun v1.4.5 (Linux x64)
Nov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Main process exited, code=exited, status=1/FAILURE
Nov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Failed with result 'exit-code'.
Nov 26 23:16:14 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Scheduled restart job, restart counter is at 4.
Nov 26 23:16:14 lima-$REDACTED$-rehearsal systemd[1]: Started $REDACTED$-signaling-3001.service - P2Party Signaling Server.
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 132 |   return normalizeTurnUrls(raw.split(","));
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 133 | };
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 134 |
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 135 | export const assertSecureTurnSecret = (secret: string | undefined): void => {
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 136 |   if (secret !== undefined && Buffer.byteLength(secret, "utf8") < 32)
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 137 |     throw new Error("COTURN_SECRET must contain at least 32 bytes");
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]:                     ^
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: error: COTURN_SECRET must contain at least 32 bytes
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]:       at FE (src/utils/socketAuth.ts:137:15)
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]:       at src/index.ts:22:1
Nov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: Bun v1.4.5 (Linux x64)
Nov 26 23:16:15 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Main process exited, code=exited, status=1/FAILURE
Nov 26 23:16:15 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Failed with result 'exit-code'.

Origin: <work>/trees/6a6cfc244f43/deploy/ansible/playbooks/deploy.yml:695:11

693           failed_when: false
694
695         - name: Report the service failure
              ^ column 11

fatal: [$REDACTED$-signaling]: FAILED! => {"changed": false, "msg": "The signaling service did not start. Its own log follows.\n\nMost likely: COTURN_SECRET missing or under 32 bytes, the\ndatabase unreachable or not answering, or a database schema this\nbuild was not made for. For both database cases the server exits\nwithin 10s with one \"$REDACTED$: refusing to start\" line saying what\nit found and what to run (a startup re-key that runs past its own\n60s bound is reported the same way).\n\n● $REDACTED$-signaling-3001.service - P2Party Signaling Server\n     Loaded: loaded (/etc/systemd/system/$REDACTED$-signaling-3001.service; enabled; preset: enabled)\n     Active: activating (auto-restart) (Result: exit-code) since Thu 2026-11-26 23:16:15 UTC; 2s ago\n    Process: 3250 ExecStart=/home/$REDACTED$/server/$REDACTED$-server (code=exited, status=1/FAILURE)\n   Main PID: 3250 (code=exited, status=1/FAILURE)\n        CPU: 504ms\n--- journal ---\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: 135 | export const assertSecureTurnSecret = (secret: string | undefined): void => {\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: 136 |   if (secret !== undefined && Buffer.byteLength(secret, \"utf8\") < 32)\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: 137 |     throw new Error(\"COTURN_SECRET must contain at least 32 bytes\");\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]:                     ^\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: error: COTURN_SECRET must contain at least 32 bytes\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]:       at FE (src/utils/socketAuth.ts:137:15)\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]:       at src/index.ts:22:1\nNov 26 23:16:04 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3233]: Bun v1.4.5 (Linux x64)\nNov 26 23:16:04 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Main process exited, code=exited, status=1/FAILURE\nNov 26 23:16:04 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Failed with result 'exit-code'.\nNov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Scheduled restart job, restart counter is at 3.\nNov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: Started $REDACTED$-signaling-3001.service - P2Party Signaling Server.\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 132 |   return normalizeTurnUrls(raw.split(\",\"));\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 133 | };\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 134 |\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 135 | export const assertSecureTurnSecret = (secret: string | undefined): void => {\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 136 |   if (secret !== undefined && Buffer.byteLength(secret, \"utf8\") < 32)\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: 137 |     throw new Error(\"COTURN_SECRET must contain at least 32 bytes\");\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]:                     ^\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: error: COTURN_SECRET must contain at least 32 bytes\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]:       at FE (src/utils/socketAuth.ts:137:15)\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]:       at src/index.ts:22:1\nNov 26 23:16:09 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3241]: Bun v1.4.5 (Linux x64)\nNov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Main process exited, code=exited, status=1/FAILURE\nNov 26 23:16:09 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Failed with result 'exit-code'.\nNov 26 23:16:14 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Scheduled restart job, restart counter is at 4.\nNov 26 23:16:14 lima-$REDACTED$-rehearsal systemd[1]: Started $REDACTED$-signaling-3001.service - P2Party Signaling Server.\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 132 |   return normalizeTurnUrls(raw.split(\",\"));\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 133 | };\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 134 |\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 135 | export const assertSecureTurnSecret = (secret: string | undefined): void => {\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 136 |   if (secret !== undefined && Buffer.byteLength(secret, \"utf8\") < 32)\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: 137 |     throw new Error(\"COTURN_SECRET must contain at least 32 bytes\");\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]:                     ^\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: error: COTURN_SECRET must contain at least 32 bytes\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]:       at FE (src/utils/socketAuth.ts:137:15)\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]:       at src/index.ts:22:1\nNov 26 23:16:15 lima-$REDACTED$-rehearsal $REDACTED$-signaling-3001[3250]: Bun v1.4.5 (Linux x64)\nNov 26 23:16:15 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Main process exited, code=exited, status=1/FAILURE\nNov 26 23:16:15 lima-$REDACTED$-rehearsal systemd[1]: $REDACTED$-signaling-3001.service: Failed with result 'exit-code'.\n"}

PLAY RECAP *********************************************************************
$REDACTED$-postgres           : ok=23   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
$REDACTED$-signaling          : ok=51   changed=22   unreachable=0    failed=1    skipped=0    rescued=1    ignored=0

```

State of the VM after the failed start:

```text

## signaling units
p2party-signaling-3001.service: enabled=enabled active=activating restarts=4

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
3 | 2 | 2 | 1 | 2
(1 row)

## serving
worker 127.0.0.1:3001/health: no answer
Caddy https://signaling.rehearsal.localhost/health: no answer
signaling processes:
caddy: active
postgresql: active
```

### Next step: the value fixed (the vault's own secret), the deploy again

deploy.yml, second run (exit 0):

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

TASK [Stop and disable every signaling worker before migrating] ****************
changed: [$REDACTED$-signaling] => (item=$REDACTED$-signaling-3001.service)

TASK [Mark that the binary on disk may not match the schema] *******************
changed: [$REDACTED$-signaling]

TASK [Apply migrations against Postgres] ***************************************
changed: [$REDACTED$-signaling]

TASK [Install the staged binary] ***********************************************
ok: [$REDACTED$-signaling]

TASK [Install the staged signaling environment file] ***************************
changed: [$REDACTED$-signaling]

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
        "content": "{\"status\":\"ok\",\"protocolVersion\":4,\"version\":\"0.1.4\",\"serverId\":\"107ca084-b9e1-44da-8bb1-98a43e905a1b\"}",
        "content_length": "103",
        "content_type": "application/json;charset=utf-8",
        "cookies": {},
        "cookies_string": "",
        "date": "Thu, 26 Nov 2026 23:16:56 GMT",
        "elapsed": 0,
        "failed": false,
        "item": 3001,
        "json": {
            "protocolVersion": 4,
            "serverId": "107ca084-b9e1-44da-8bb1-98a43e905a1b",
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
$REDACTED$-signaling          : ok=61   changed=12   unreachable=0    failed=0    skipped=3    rescued=0    ignored=0

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
worker 127.0.0.1:3001/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"107ca084-b9e1-44da-8bb1-98a43e905a1b"}
Caddy https://signaling.rehearsal.localhost/health: {"status":"ok","protocolVersion":4,"version":"0.1.4","serverId":"107ca084-b9e1-44da-8bb1-98a43e905a1b"}
signaling processes: 4338 /mnt/lima-rosetta/rosetta /home/p2party/server/p2party-server
caddy: active
postgresql: active
```

- Finished: 2026-11-26T23:16:58Z
