#!/bin/bash
# ============================================================================
# What a refused deploy must have left alone
# ============================================================================
# Run as root inside the rehearsal VM before and after a deploy that should
# change nothing (run.sh compares the two). For each file that deploy.yml,
# postgres-tls.yml or initial-setup.yml write: a checksum prefix and the
# modification time (files holding secrets: the time only). For each service
# they restart: when it last entered the active state. Then the directories
# the prepare block fills.
# ============================================================================
set -uo pipefail

for file in \
  /etc/postgresql/*/main/postgresql.conf /etc/postgresql/*/main/pg_hba.conf \
  /etc/postgresql/p2party-tls/ca.crt /etc/postgresql/p2party-tls/server.crt \
  /etc/postgresql/p2party-tls/server.ext /etc/p2party/postgres-ca.crt \
  /etc/systemd/journald.conf.d/p2party-retention.conf /etc/caddy/Caddyfile \
  /etc/caddy/Caddyfile.p2party-candidate /etc/systemd/system/p2party-signaling*.service \
  /home/p2party/server/p2party-server /home/p2party/server/prisma.config.ts \
  /home/p2party/server/prisma/schema.prisma /home/p2party/server/migration-tooling/package.json \
  /home/p2party/server/migration-tooling/bun.lock /home/p2party/server/migration-tooling/bun.lockb \
  /var/lib/p2party-migration-failed /var/log/p2party-migration-failure.log; do
  if [ -e "$file" ]; then
    printf '%s  mtime %s  %s\n' "$(sha256sum "$file" | cut -c1-16)" "$(stat -c %Y "$file")" "$file"
  else
    printf 'absent            %s\n' "$file"
  fi
done
for file in /home/p2party/server/.env /etc/postgresql/p2party-tls/ca.key /etc/postgresql/p2party-tls/server.key; do
  if [ -e "$file" ]; then
    printf '(secret)          mtime %s  %s\n' "$(stat -c %Y "$file")" "$file"
  else
    printf 'absent            %s\n' "$file"
  fi
done
for dir in /home/p2party/server/release-staging /home/p2party/server/migration-tooling/node_modules /home/p2party/server/prisma/migrations; do
  if [ -d "$dir" ]; then
    printf 'directory  mtime %s  %s entries  %s\n' "$(stat -c %Y "$dir")" "$(find "$dir" -mindepth 1 -maxdepth 1 | wc -l)" "$dir"
  else
    printf 'absent            %s\n' "$dir"
  fi
done
for unit in postgresql@16-main caddy systemd-journald p2party-signaling-3001; do
  printf 'service %s: active since %s, main pid %s\n' "$unit" \
    "$(systemctl show -p ActiveEnterTimestamp --value "$unit" 2>&1)" \
    "$(systemctl show -p MainPID --value "$unit" 2>&1)"
done
