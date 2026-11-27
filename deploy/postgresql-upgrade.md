# PostgreSQL 17 to 19 on Ubuntu 24.04

PostgreSQL 19.0 is the current stable major as of November 27, 2026. The PostgreSQL Global Development Group publishes versioned `postgresql-19` packages for Ubuntu 24.04 on amd64 and arm64. New database hosts and `install-postgres.yml` use the same signed PGDG repository and installation script. Provisioning an existing, older `main` cluster on the application port directs the operator to this procedure. Terraform ignores first-boot user-data changes on an existing database server. [PostgreSQL releases](https://www.postgresql.org/support/versioning/) · [PGDG Ubuntu repository](https://www.postgresql.org/download/linux/ubuntu/)

From `deploy/ansible`, operators can run the tracked maintenance playbook against their inventory. It keeps credentials in the vault and checks an actual private-IP `verify-full` connection with the application's role. The explicit actions are `prepare`, `check`, `upgrade` and `rollback-before-writes`. Run `upgrade` and `rollback-before-writes` only after quiescing all writers as described below.

```sh
ansible-playbook -i inventory/production.yml playbooks/upgrade-postgres.yml -e maintenance_mode=prepare
```

## Prepare while the application is online

Run on the database host as root. Copy `deploy/ansible/files/install-postgresql.sh` and `deploy/ansible/files/upgrade-postgresql.sh` from the reviewed release tree into a root-owned directory, with mode `0700`. Commands below assume `/root/p2party-maint/` and the example application database and port. The physical upgrade uses `pg_upgradecluster --method=upgrade`, which copies data into an independent cluster and changes the application port over. Both packages and both data directories remain available. [Debian cluster upgrade procedure](https://manpages.debian.org/testing/postgresql-common/pg_upgradecluster.1.en.html) · [PostgreSQL major upgrades](https://www.postgresql.org/docs/19/upgrading.html)

1. Verify an independently stored backup by restoring it, including the application database and role grants. Retain the PostgreSQL configuration, TLS CA and private keys in protected backup storage. Check `pg_lsclusters`, available disk and the size of the old cluster. Budget space for another complete copy of the cluster, indexes, and WAL. Confirm each installed extension has a PostgreSQL 19 build. PostgreSQL 17 must be the primary. Logical replication, standbys, prepared transactions and user tablespaces require a plan for those resources.
2. Check the source's `SHOW ssl`, `SHOW ssl_cert_file`, `SHOW ssl_key_file` and the private network rules in `pg_hba_file_rules`. The application connects with `sslmode=verify-full` to the private IP using its configured CA. If the host still uses the distro certificate, complete `playbooks/postgres-tls.yml` on the original active cluster and validate the application before scheduling the major upgrade. That play may restart PostgreSQL when it changes the TLS configuration.
3. Stage the target version. This checks the PGDG signing key, scopes its repository key to the official source, suppresses service restarts during package installation, and verifies the source process is the same afterwards. The PGDG package leaves an existing cluster in place. The helper verifies the target has no cluster yet.

   ```sh
   cd /root/p2party-maint
   ./install-postgresql.sh prepare-upgrade 5432
   ./upgrade-postgresql.sh check 5432 p2party
   ```

4. As the configured application role, connect over the private IP using the current CA and `sslmode=verify-full`. Verify database `CONNECT`, public schema `USAGE` and the four table privileges `SELECT`, `INSERT`, `UPDATE`, and `DELETE`. Use the existing secret provider and avoid putting credentials into command arguments or logs.

## Cut over during the approved maintenance window

1. Record the enabled and active signaling worker units on every application host. Quiesce the workers and any other database writers, and prevent automatic restart while the check runs. External signaling will be unavailable during this window. Confirm `pg_stat_activity` has no other client sessions. Keep the previous application binary and its production configuration available.
2. Run the following on the database host. It stores only comparison hashes and the original startup setting under `/var/lib/p2party-postgresql-upgrade/17-to-19-5432/`. It verifies all six application tables, signed challenge values, roles and stored verifier hashes, grants, database and schema settings, sequence state, the public TLS certificate and HBA rules. The PGDG helper moves the old cluster to an unused port and sets it to manual startup.

   ```sh
   cd /root/p2party-maint
   ./upgrade-postgresql.sh upgrade 5432 p2party
   pg_lsclusters
   ```

3. Check `postgresql@19-main.service` and perform the same application-role TLS login and permissions checks. Check the worker configuration and `SHOW server_version` before permitting writes. Restore the earlier signaling units and confirm the public `/health` returns the expected signaling version and protocol. The database major upgrade and the signaling release have separate health checks.
4. Keep the old cluster stopped with manual startup, and retain the verified backup through the production rollback window. Schedule planner-statistics refresh as required by the installed `pg_upgrade` output. Perform any extension or collation remediation it reports before releasing dependent workloads.

## Restore service before allowing writes to PostgreSQL 19

If `pg_upgradecluster` stopped with an error, first inspect `pg_lsclusters`, its printed log location and `journalctl -u postgresql@19-main`. If 17 still owns port 5432, start the original unit and verify its TLS login and application health. If 19 owns 5432 and 17 is retained on another port, keep all clients quiesced and run the following. With 19 online it first compares its current data and access settings against the original fingerprints and refuses rollback on divergence. The command parks the new cluster, returns the old configuration to its original port and startup behavior, and checks the original data, role and TLS hashes.

```sh
cd /root/p2party-maint
./upgrade-postgresql.sh rollback-before-writes 5432 p2party
pg_lsclusters
```

Repeat the application-role TLS login and start the recorded units. After writers resume on 19, falling back to the retained 17 snapshot would discard newer writes. Recover forward, or capture and reconcile new writes in a separately validated restore before switching. Inspect a partial or parked target before any later retry. The helpers leave both data directories intact.

## Production result on November 27, 2026

Production upgraded directly from PGDG 17.8 to 19.0 on Ubuntu 24.04. The source cluster occupied 112 MiB and had 69 GiB of free space. It had one application database, the default `plpgsql` extension, and zero application sequences, prepared transactions, replication slots, replication consumers or user tablespaces.

The source process remained active while the 19.0 packages were staged. After the signaling worker stopped, the first cutover attempt refused to proceed while an idle read-only maintenance connection was open. Closing that session allowed the physical copy and data checks to complete in **7 seconds**. That time excludes application quiescence, the initial refusal, and public health verification.

All six application table hashes matched, including signed challenge data. Role definitions, SCRAM verifiers, memberships, privileges, the TLS leaf certificate, and ordered HBA rules matched. The application role connected to 19 with `verify-full` and had its original `CONNECT`, `USAGE`, and table CRUD privileges. The PGDG finish hook completed both planner-statistics passes. A subsequent service check found `19/main` online on 5432 with automatic startup and `17/main` down on 5433 with manual startup. The existing signaling worker resumed and both local and public health returned `0.1.4`, protocol `4`, status `ok`. The production change used forward cutover. The original cluster and verified backup were retained for recovery.
