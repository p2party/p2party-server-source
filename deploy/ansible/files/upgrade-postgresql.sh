#!/usr/bin/env bash
# Run on the single Ubuntu database host during the documented maintenance window.
set -euo pipefail
export PAGER=cat PSQL_PAGER=cat PGOPTIONS='-c statement_timeout=120000 -c lock_timeout=5000 -c timezone=UTC'
mode=${1:-}
case "$mode" in check|upgrade|rollback-before-writes) ;; *) echo 'Usage: upgrade-postgresql.sh check|upgrade|rollback-before-writes [port] [app-database]' >&2; exit 2 ;; esac
port=${2:-5432}
database=${3:-p2party}
[[ $EUID == 0 && $port =~ ^[1-9][0-9]{0,4}$ && $port -le 65535 && $database =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || { echo 'Root privileges, a valid port and database name are required.' >&2; exit 2; }
state=/var/lib/p2party-postgresql-upgrade/17-to-19-$port
umask 077
exec 9>"/run/lock/p2party-postgresql-major-$port.lock"
flock -n 9 || { echo 'Another P2Party major upgrade is running.' >&2; exit 1; }
fail() { echo "$*" >&2; exit 1; }
query() { runuser -u postgres -- /usr/lib/postgresql/19/bin/psql -XAtq -v ON_ERROR_STOP=1 -h /var/run/postgresql -p "$port" -d "$1" -c "$2"; }
cluster_port() { pg_lsclusters --no-header | awk -v v="$1" '$1 == v && $2 == "main" {print $3}'; }
expect_active() {
  [[ $(cluster_port "$1") == "$port" ]] && systemctl is-active --quiet "postgresql@$1-main" &&
    [[ $(query postgres "SELECT current_setting('server_version_num')::int / 10000") == "$1" ]] || fail "Expected $1/main online at port $port."
}
no_clients() {
  [[ $(query postgres "SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid <> pg_backend_pid()") == 0 ]] || fail 'Other client sessions are open. Stop application writers and maintenance sessions before cutover.'
}
# Compare application data, including byte values in signed challenges, without writing database contents to disk.
identity() {
  local table cert hba
  for table in Peer Room _PeerRooms Challenge PendingSignal _prisma_migrations; do
    printf '%s ' "$table"
    query "$database" "COPY (SELECT row_to_json(t)::text FROM public.\"$table\" t ORDER BY row_to_json(t)::text COLLATE \"C\") TO STDOUT" | sha256sum | cut -d' ' -f1
  done
  printf 'login roles and verifiers '
  query postgres "SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolpassword FROM pg_authid WHERE oid>=16384 ORDER BY rolname COLLATE \"C\"" | sha256sum | cut -d' ' -f1
  printf 'database and role settings '; query postgres 'SELECT setdatabase,setrole,setconfig FROM pg_db_role_setting ORDER BY 1,2' | sha256sum | cut -d' ' -f1
  printf 'role memberships '
  query postgres "SELECT roleid::regrole, member::regrole, admin_option, inherit_option, set_option FROM pg_auth_members WHERE roleid>=16384 OR member>=16384 ORDER BY 1,2" | sha256sum | cut -d' ' -f1
  printf 'database and table permissions '
  { query postgres "SELECT datname,datdba::regrole,datacl FROM pg_database WHERE NOT datistemplate ORDER BY datname COLLATE \"C\""; query "$database" "SELECT n.nspname,c.relname,c.relowner::regrole,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f') ORDER BY 1,2"; } | sha256sum | cut -d' ' -f1
  [[ $(query postgres 'SHOW ssl') == on ]] || fail 'PostgreSQL must have TLS enabled.'
  cert=$(query postgres 'SHOW ssl_cert_file'); hba=$(query postgres 'SHOW hba_file')
  [[ $cert == /* ]] || cert="$(query postgres 'SHOW data_directory')/$cert"
  printf 'schema permissions '
  query "$database" "SELECT nspname,nspowner::regrole,nspacl FROM pg_namespace WHERE nspname='public'" | sha256sum | cut -d' ' -f1
  printf 'sequence values and increment state '
  query "$database" "SELECT format('SELECT %L, last_value, is_called FROM %I.%I;', schemaname || '.' || sequencename, schemaname, sequencename) FROM pg_sequences WHERE schemaname='public' ORDER BY schemaname,sequencename" |
    runuser -u postgres -- /usr/lib/postgresql/19/bin/psql -XAtq -v ON_ERROR_STOP=1 -h /var/run/postgresql -p "$port" -d "$database" | sha256sum | cut -d' ' -f1
  printf 'TLS certificate '; sha256sum "$cert" | cut -d' ' -f1
  printf 'HBA rules '; query postgres "SELECT type,database,user_name,address,netmask,auth_method,options,error FROM pg_hba_file_rules ORDER BY rule_number" | sha256sum | cut -d' ' -f1
  [[ -s $hba && $(query postgres 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL') == 0 ]] || fail 'Invalid authentication rules.'
}
if [[ $mode == rollback-before-writes ]]; then
  [[ -f $state/old.identity && -f $state/old.start.conf ]] || fail 'Missing verified pre-upgrade identity record.'
  [[ $(cluster_port 19) == "$port" ]] || fail 'Expected the new cluster at the application port.'
  parked=$(cluster_port 17)
  [[ $parked =~ ^[0-9]+$ && $parked != "$port" ]] || fail 'Expected the original 17/main cluster on its retained port.'
  if systemctl is-active --quiet postgresql@19-main; then
    no_clients
    identity > "$state/pre-rollback.identity"
    cmp -s "$state/old.identity" "$state/pre-rollback.identity" || fail 'The new cluster has diverged. Keep it online and reconcile the newer data before rollback.'
  fi
  systemctl stop postgresql@19-main
  printf 'manual\n' > /etc/postgresql/19/main/start.conf
  pg_conftool 19 main set port "$parked"
  pg_conftool 17 main set port "$port"
  cp --preserve=mode "$state/old.start.conf" /etc/postgresql/17/main/start.conf
  systemctl daemon-reload
  systemctl start postgresql@17-main
  expect_active 17
  identity > "$state/rolled-back.identity"
  diff -u "$state/old.identity" "$state/rolled-back.identity"
  echo "PostgreSQL 17/main restored at port $port. The PostgreSQL 19 cluster remains stopped with manual startup."
  exit 0
fi
expect_active 17
[[ -z $(cluster_port 19) ]] || fail 'A target cluster already exists. Inspect its status and retained data before retrying.'
pg_upgradecluster --check -v 19 17 main
[[ $(query postgres "SELECT NOT pg_is_in_recovery() AND NOT EXISTS (SELECT FROM pg_prepared_xacts) AND NOT EXISTS (SELECT FROM pg_replication_slots) AND NOT EXISTS (SELECT FROM pg_stat_replication) AND NOT EXISTS (SELECT FROM pg_tablespace WHERE oid>=16384)") == t ]] || fail 'Coordinate prepared transactions, replication, or custom tablespaces separately before upgrading.'
[[ $(query "$database" "SELECT NOT EXISTS (SELECT FROM pg_publication) AND NOT EXISTS (SELECT FROM pg_subscription)") == t ]] || fail 'Coordinate logical replication before this procedure.'
data_dir=$(query postgres 'SHOW data_directory')
source_kib=$(du -sk "$data_dir" | cut -f1)
free_kib=$(df -Pk /var/lib/postgresql | awk 'END {print $4}')
(( free_kib > source_kib )) || fail 'The target filesystem has less free space than the source data directory.'
if [[ $mode == check ]]; then
  identity > /dev/null
  echo 'Database contents, role and privilege catalogs, sequences, TLS and HBA can be verified.'
  exit 0
fi
no_clients
install -d -m 0700 "$state"
identity > "$state/old.identity.tmp"
mv "$state/old.identity.tmp" "$state/old.identity"
cp --preserve=mode /etc/postgresql/17/main/start.conf "$state/old.start.conf"
start=$SECONDS
pg_upgradecluster --method=upgrade --start -v 19 17 main
expect_active 19
identity > "$state/new.identity"
diff -u "$state/old.identity" "$state/new.identity"
[[ $(pg_lsclusters --no-header | awk '$1 == 17 && $2 == "main" {print $4}') == down ]] || fail 'Retained PostgreSQL 17 cluster is still running.'
echo "PostgreSQL 19/main validated at port $port in $((SECONDS-start)) seconds. Keep writers stopped until TLS login, authorization and rollback checks are complete."
