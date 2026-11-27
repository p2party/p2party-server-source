#!/bin/bash
# ============================================================================
# The machine state the rehearsal records after every playbook run
# ============================================================================
# Run as root inside the rehearsal VM (run.sh pipes it through `limactl
# shell`). It prints what a release leaves behind: the signaling units, the
# binary on disk and the staged one, the deploy markers, the host's Bun, the
# migration history, the row counts, and what answers on the worker port and
# through Caddy. It never prints the environment file or the database
# password: PostgreSQL is read as the postgres user over its local socket.
# ============================================================================
set -uo pipefail

DB=${1:-p2party}
SERVER=/home/p2party/server
SIGNALING_NAME=${2:-signaling.rehearsal.localhost}

section() { printf '\n## %s\n' "$1"; }

section "signaling units"
found=false
for unit_file in /etc/systemd/system/p2party-signaling*.service; do
  [ -e "$unit_file" ] || continue
  found=true
  unit=$(basename "$unit_file")
  printf '%s: enabled=%s active=%s restarts=%s\n' "$unit" \
    "$(systemctl is-enabled "$unit" 2>&1)" \
    "$(systemctl is-active "$unit" 2>&1)" \
    "$(systemctl show -p NRestarts --value "$unit" 2>&1)"
done
$found || echo "(no signaling unit files)"

section "binaries"
for binary in "$SERVER/p2party-server" "/var/lib/p2party-release-staging/p2party-server"; do
  if [ -f "$binary" ]; then
    printf '%s: sha256 %s, embedded Bun %s\n' "$binary" \
      "$(sha256sum "$binary" | cut -c1-64)" \
      "$(BUN_BE_BUN=1 timeout 30 "$binary" --version 2>&1 | head -1)"
  else
    printf '%s: absent\n' "$binary"
  fi
done
printf 'host Bun (%s): %s\n' /home/p2party/.bun/bin/bun \
  "$(sudo -u p2party timeout 30 /home/p2party/.bun/bin/bun --version 2>&1 | head -1)"

for managed_bun in /opt/p2party-bun/*/bin/bun; do
  [ -x "$managed_bun" ] || continue
  printf 'migration Bun (%s): %s\n' "$managed_bun" "$(sudo -u p2party "$managed_bun" --version)"
done

section "deploy markers"
for marker in /var/lib/p2party-migration-failed /var/log/p2party-migration-failure.log; do
  if [ -e "$marker" ]; then
    printf '%s: present (%s)\n' "$marker" "$(stat -c '%U:%G mode %a, %s bytes' "$marker")"
  else
    printf '%s: absent\n' "$marker"
  fi
done
if [ -e /var/lib/p2party-migration-failed ]; then
  echo "--- first line of /var/lib/p2party-migration-failed:"
  head -1 /var/lib/p2party-migration-failed
fi
for candidate in /etc/caddy/Caddyfile.p2party-candidate /etc/turnserver.conf.p2party-candidate; do
  [ -e "$candidate" ] && printf '%s: present\n' "$candidate"
done
true

section "migration history (_prisma_migrations)"
sudo -u postgres psql -X -q -A -F ' | ' -d "$DB" -c \
  'SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count AS steps, logs IS NOT NULL AS has_logs FROM "_prisma_migrations" ORDER BY started_at, migration_name' 2>&1

section "schema details"
sudo -u postgres psql -X -q -A -t -d "$DB" -c \
  "SELECT 'Peer.socketGeneration: ' || (SELECT count(*) FROM information_schema.columns WHERE table_name = 'Peer' AND column_name = 'socketGeneration') || ' column(s); PendingSignal.kind: ' || (SELECT count(*) FROM information_schema.columns WHERE table_name = 'PendingSignal' AND column_name = 'kind') || ' column(s); PendingSignal_createdAt_idx: ' || (SELECT count(*) FROM pg_indexes WHERE indexname = 'PendingSignal_createdAt_idx') || ' index(es)'" 2>&1

section "rows"
sudo -u postgres psql -X -q -A -F ' | ' -d "$DB" -c \
  'SELECT (SELECT count(*) FROM "Peer") AS peers, (SELECT count(*) FROM "Room") AS rooms, (SELECT count(*) FROM "_PeerRooms") AS memberships, (SELECT count(*) FROM "Challenge") AS challenges, (SELECT count(*) FROM "PendingSignal") AS pending_signals' 2>&1

section "serving"
printf 'worker 127.0.0.1:3001/health: %s\n' "$(curl -s -m 5 http://127.0.0.1:3001/health 2>&1 || echo 'no answer')"
printf 'Caddy https://%s/health: %s\n' "$SIGNALING_NAME" \
  "$(curl -s -m 5 "https://$SIGNALING_NAME/health" 2>&1 || echo 'no answer')"
printf 'signaling processes: %s\n' "$(pgrep -a -f "$SERVER/p2party-server" | grep -v pgrep | cut -c1-120 || true)"
printf 'caddy: %s\n' "$(systemctl is-active caddy 2>&1)"
printf 'postgresql: %s\n' "$(systemctl is-active postgresql 2>&1)"
