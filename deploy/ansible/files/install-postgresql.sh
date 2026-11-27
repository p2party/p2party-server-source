#!/usr/bin/env bash
# Shared by new database hosts and the explicit major upgrade procedure.
set -euo pipefail
mode=${1:-provision}
port=${2:-5432}
[[ $port =~ ^[1-9][0-9]{0,4}$ && $port -le 65535 ]] || { echo 'Invalid PostgreSQL port.' >&2; exit 2; }
case "$mode" in provision|prepare-upgrade) ;; *) echo 'Usage: install-postgresql.sh [provision|prepare-upgrade] [port]' >&2; exit 2 ;; esac
major=19
. /etc/os-release
[[ $ID == ubuntu && $VERSION_CODENAME == noble ]] || { echo 'This release supports Ubuntu 24.04 (noble).' >&2; exit 1; }
clusters=''
if command -v pg_lsclusters >/dev/null; then clusters=$(pg_lsclusters --no-header); fi
listener=$(awk -v port="$port" '$3 == port {print $1 "/" $2}' <<< "$clusters")
if [[ $mode == prepare-upgrade ]]; then
  [[ $listener == 17/main ]] || { echo "Expected 17/main on port $port before preparing the upgrade." >&2; exit 1; }
  if awk -v major="$major" '$1 == major && $2 == "main" {found=1} END {exit !found}' <<< "$clusters"; then
    echo '19/main already exists. Inspect both clusters before continuing.' >&2; exit 1
  fi
elif [[ -n $clusters && $listener != "$major/main" ]]; then
  echo 'Existing PostgreSQL data requires the explicit procedure in deploy/postgresql-upgrade.md.' >&2; exit 1
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l PAGER=cat PSQL_PAGER=cat
changed=false
key=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
key_fingerprint=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
scratch=$(mktemp -d)
policy=/usr/sbin/policy-rc.d
stage_policy=false
restore_policy() {
  if $stage_policy; then
    if [[ -e $scratch/old-policy || -L $scratch/old-policy ]]; then mv -fT "$scratch/old-policy" "$policy"; else rm -f "$policy"; fi
  fi
  rm -rf "$scratch"
}
trap restore_policy EXIT
if [[ $mode == prepare-upgrade ]]; then
  pid_before=$(systemctl show postgresql@17-main -p MainPID --value)
  [[ $pid_before =~ ^[1-9][0-9]*$ ]] || { echo 'PostgreSQL 17/main is not running.' >&2; exit 1; }
  if [[ -e $policy || -L $policy ]]; then cp -a "$policy" "$scratch/old-policy"; fi
  printf '#!/bin/sh\nexit 101\n' > "$scratch/no-service-restarts"
  stage_policy=true
  install -m 0755 -T "$scratch/no-service-restarts" "$policy"
fi
if ! command -v gpg >/dev/null || ! command -v curl >/dev/null; then
  apt-get update -q
  apt-get install -y ca-certificates curl gnupg
fi
if [[ ! -s $key ]]; then
  curl --fail --silent --show-error --location https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$scratch/key.asc"
  candidate_key=$scratch/key.asc
else
  candidate_key=$key
fi
primary=$(gpg --homedir "$scratch" --batch --show-keys --with-colons "$candidate_key" | awk -F: '$1=="pub" {primary=1; next} $1=="fpr" && primary {print $10;primary=0}')
[[ $primary == "$key_fingerprint" ]] || { echo 'Unexpected PGDG archive signing key fingerprint.' >&2; exit 1; }
if [[ $candidate_key != "$key" ]]; then
  changed=true
  install -D -m 0644 "$candidate_key" "$key"
fi
printf 'deb [arch=%s signed-by=%s] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$(dpkg --print-architecture)" "$key" "$VERSION_CODENAME" > "$scratch/pgdg.list"
repo=/etc/apt/sources.list.d/pgdg.list
if ! cmp -s "$scratch/pgdg.list" "$repo" || ! dpkg-query -s "postgresql-$major" python3-psycopg2 >/dev/null 2>&1; then
  changed=true
  install -m 0644 "$scratch/pgdg.list" "$repo"
  apt-get update -q
  if [[ $mode == prepare-upgrade ]]; then
    apt-get -s --no-install-recommends install "postgresql-$major" python3-psycopg2 > "$scratch/apt-plan"
    if grep -Eq '^(Remv |Inst postgresql-17 )' "$scratch/apt-plan"; then
      echo 'Package staging would remove a package or replace the live PostgreSQL 17 binary.' >&2; exit 1
    fi
  fi
  apt-get install -y --no-install-recommends "postgresql-$major" python3-psycopg2
fi
[[ -x /usr/lib/postgresql/$major/bin/postgres ]]
if [[ $mode == prepare-upgrade ]]; then
  # PGDG skips main-cluster creation when there is already a cluster.
  [[ ! -e /etc/postgresql/$major/main/postgresql.conf ]] || { echo 'Unexpected target cluster. Inspect it before upgrading.' >&2; exit 1; }
  [[ $(systemctl show postgresql@17-main -p MainPID --value) == "$pid_before" ]] || { echo 'Original database process changed during staging.' >&2; exit 1; }
  pg_upgradecluster --check -v "$major" 17 main
else
  if [[ ! -f /etc/postgresql/$major/main/postgresql.conf ]]; then
    changed=true
    pg_createcluster --port "$port" "$major" main
  fi
  [[ $(pg_lsclusters --no-header | awk -v port="$port" '$3 == port {print $1 "/" $2}') == "$major/main" ]]
  if ! systemctl is-enabled --quiet postgresql.service; then systemctl enable postgresql.service; changed=true; fi
  if ! systemctl is-active --quiet "postgresql@$major-main.service"; then systemctl start "postgresql@$major-main.service"; changed=true; fi
fi
if $changed; then echo 'P2PARTY PostgreSQL provisioned'; fi
