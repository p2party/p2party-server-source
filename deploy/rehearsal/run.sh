#!/usr/bin/env bash
# ============================================================================
# p2party release rehearsal
# ============================================================================
# Runs the production playbooks against one local Lima VM, p2party-rehearsal,
# reached only on 127.0.0.1 (deploy/rehearsal/README.md).
#
#   run.sh [OPTIONS] MODE
#
#   check      check everything handed to Ansible and stop (contacts nothing)
#   vm-check   a new VM from lima.yaml, with no playbook: what the host then
#              listens on (TCP and UDP), the watch, and Ansible through the SSH
#              guard (a ping, a copy, a refused connection); then deleted
#   baseline   a new VM brought to production's state: the signaling host's
#              cloud-init, then release 0.1.4 installed by its own playbooks
#              from a `git archive` of the baseline commit, rows in every
#              table; kept as the one snapshot every other mode starts from
#   upgrade    from the baseline, the commit under test deployed over 0.1.4
#   scenario-1 ... scenario-8
#              the fault scenarios of deploy/rehearsal/README.md, each from
#              the baseline (scenario-6 runs the upgrade first); each ends with
#              the README's next step and a second run (scenario 7)
#   fresh      a new VM provisioned by the commit's own site.yml (with
#              install-postgres and initial-setup), then deploy.yml, then
#              initial-setup.yml again and setup-coturn.yml
#   clean      delete the instance, the snapshot (with its secrets), the
#              trees, the package cache and the raw logs; keep the sanitized
#              results
#   clean-all  everything clean deletes, the results and the work directory
#              itself, and the image in Lima's cache if this harness
#              downloaded it
#
# Options: --commit REV, the commit under test (default: the repository's
# HEAD); --baseline-commit REV, the release installed first (default ecf691a,
# release 0.1.4); --other-commit REV, the other commit of scenario 8c
# (default 35d94c8); --keep, leave the instance running at the end;
# --hold SECONDS, keep the vm-check instance up that long; --repo DIR;
# --inventory PATH (only this directory's inventory.yml is accepted).
#
# Environment: REHEARSAL_REPO, the repository to archive from (or --repo);
# REHEARSAL_TOOLS, the tool directory (README, "Tools"); REHEARSAL_WORK_DIR
# (default $TMPDIR/p2party-rehearsal), outside every repository; LIMACTL
# (default /opt/homebrew/bin/limactl); LIMA_HOME (default ~/.lima).
#
# Before anything else, every mode refuses a caller environment holding any
# ANSIBLE_* or LIMA_* variable (LIMA_HOME aside), an inventory other than
# this directory's tracked inventory.yml (the production inventory path is
# refused by name, without being opened), and anything in the inventory,
# vars.yml or ansible.cfg that could send a connection anywhere but 127.0.0.1
# on the instance's SSH port (inventory-check.ts). With a repository, those
# files and the guards must also equal the repository's HEAD byte for byte.
# ============================================================================
set -euo pipefail
# The run's own output, kept on 8 and 9: a signal can arrive while a command's
# output is redirected to a log, and cleanup must still speak to the caller.
exec 8>&1 9>&2

SCRIPT_DIR="$(builtin cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTANCE=p2party-rehearsal

refuse() {
  printf 'run.sh: refusing to start: %s\n' "$*" >&2
  exit 2
}
die() {
  printf 'run.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  awk 'NR > 4 && /^# =====/ { exit } NR > 4 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}" >&2
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
inventory="$SCRIPT_DIR/inventory.yml"
repo="${REHEARSAL_REPO:-}"
commit="HEAD"
BASELINE_REV=ecf691a
OTHER_REV=35d94c8
keep=false
hold=0
mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    --inventory) [ $# -ge 2 ] || die "--inventory needs a path"; inventory="$2"; shift 2 ;;
    --inventory=*) inventory="${1#*=}"; shift ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a directory"; repo="$2"; shift 2 ;;
    --repo=*) repo="${1#*=}"; shift ;;
    --commit) [ $# -ge 2 ] || die "--commit needs a revision"; commit="$2"; shift 2 ;;
    --commit=*) commit="${1#*=}"; shift ;;
    --baseline-commit) [ $# -ge 2 ] || die "--baseline-commit needs a revision"; BASELINE_REV="$2"; shift 2 ;;
    --other-commit) [ $# -ge 2 ] || die "--other-commit needs a revision"; OTHER_REV="$2"; shift 2 ;;
    --hold) [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]] || die "--hold needs a number of seconds"; hold="$2"; shift 2 ;;
    --keep) keep=true; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *)
      [ -z "$mode" ] || die "one mode only (got $mode and $1)"
      mode="$1"
      shift
      ;;
  esac
done
[ -n "$mode" ] || die "no mode given (see --help)"

# ---------------------------------------------------------------------------
# 1. What reaches Ansible, before anything else
# ---------------------------------------------------------------------------
# Every Ansible command runs under play-env.sh's `env -i`; a caller's ANSIBLE_*
# variable is refused here as well, so that none can be mistaken for the
# harness's own. A LIMA_* variable could change how Lima forwards ports.
caller_variables="$(env | grep -E '^(ANSIBLE|LIMA)_[A-Za-z0-9_]*=' | cut -d= -f1 | grep -v -x LIMA_HOME | tr '\n' ' ' || true)"
[ -z "$caller_variables" ] ||
  refuse "the environment sets ${caller_variables}; run.sh sets every Ansible and Lima variable itself"

# The inventory by name first, so that the production inventory is refused
# without being opened, read or even stat'ed through a link.
case "$inventory" in
  *deploy/ansible/inventory/* | *production*)
    refuse "$inventory is the production inventory or named like it; run.sh only uses $SCRIPT_DIR/inventory.yml"
    ;;
esac
inventory_dir="$(builtin cd -- "$(dirname -- "$inventory")" 2>/dev/null && pwd -P)" ||
  refuse "$inventory is not the tracked rehearsal inventory ($SCRIPT_DIR/inventory.yml)"
inventory_real="$inventory_dir/$(basename -- "$inventory")"
[ "$inventory_real" = "$SCRIPT_DIR/inventory.yml" ] ||
  refuse "$inventory is not the tracked rehearsal inventory ($SCRIPT_DIR/inventory.yml)"
[ ! -L "$inventory_real" ] || refuse "$inventory is a symbolic link"
[ -f "$inventory_real" ] || refuse "$inventory does not exist"
inventory="$inventory_real"
for file in vars.yml ansible.cfg lima.yaml ansible-connection-variables.json; do
  [ -f "$SCRIPT_DIR/$file" ] && [ ! -L "$SCRIPT_DIR/$file" ] || refuse "$SCRIPT_DIR/$file is missing or a symbolic link"
done
CONNECTION_VARIABLES="$SCRIPT_DIR/ansible-connection-variables.json"

command -v bun >/dev/null 2>&1 || die "bun is not on PATH (it runs the checks)"
# Exits 2 with one "refusing to start" line per problem.
inventory_summary="$(bun "$SCRIPT_DIR/inventory-check.ts" static "$inventory" "$SCRIPT_DIR/lima.yaml" \
  "$SCRIPT_DIR/vars.yml" "$SCRIPT_DIR/ansible.cfg" "$CONNECTION_VARIABLES")"

# The repository the rehearsal archives from. When it is known, everything
# handed to Ansible and every guard must be what its HEAD holds, byte for byte.
PROTECTED_FILES=(inventory.yml vars.yml ansible.cfg lima.yaml ansible-connection-variables.json
  inventory-check.ts play-env.sh ssh-guard.sh watch.sh)
if [ -z "$repo" ] && git -C "$SCRIPT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  repo="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
fi
if [ -n "$repo" ]; then
  repo="$(builtin cd -- "$repo" 2>/dev/null && pwd -P)" || refuse "--repo $repo is not a directory"
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null || refuse "$repo is not a git repository"
  for file in "${PROTECTED_FILES[@]}"; do
    git -C "$repo" cat-file -p "HEAD:deploy/rehearsal/$file" 2>/dev/null | cmp -s - "$SCRIPT_DIR/$file" ||
      refuse "$SCRIPT_DIR/$file differs from deploy/rehearsal/$file at $repo's HEAD (or is not tracked there)"
  done
fi

echo "$inventory_summary"
if [ "$mode" = check ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. The mode, the repository and Lima
# ---------------------------------------------------------------------------
case "$mode" in
  vm-check | baseline | upgrade | scenario-[1234568] | fresh | clean | clean-all) ;;
  *) die "unknown mode $mode (see --help)" ;;
esac
[ -n "$repo" ] || refuse "no repository: give --repo DIR or set REHEARSAL_REPO (the commit under test is archived from it)"

LIMACTL="${LIMACTL:-/opt/homebrew/bin/limactl}"
LIMA_HOME="${LIMA_HOME:-$HOME/.lima}"
INSTANCE_DIR="$LIMA_HOME/$INSTANCE"
[ -x "$LIMACTL" ] || refuse "no limactl at $LIMACTL"
# lima.yaml's ignore rules keep guest ports off the host only as Lima 2.3.0
# matched them (a guestIP 0.0.0.0 rule did not cover the guest's loopback,
# although Lima's own template says it matches any interface). Other releases
# are refused until they are checked the same way.
lima_version="$("$LIMACTL" --version 2>/dev/null | awk '{ print $NF; exit }')"
[[ "$lima_version" =~ ^2\.3\.[0-9]+$ ]] ||
  refuse "limactl is version ${lima_version:-unknown}; the rehearsal's port rules were verified on Lima 2.3.0 only, so it runs only with Lima 2.3.x"

# Lima merges $LIMA_HOME/_config/default.yaml, override.yaml and base.yaml
# into every instance it creates, which could add mounts or port forwards.
refuse_lima_overrides() {
  local file
  for file in default.yaml override.yaml base.yaml; do
    [ ! -e "$LIMA_HOME/_config/$file" ] || refuse "$LIMA_HOME/_config/$file exists and would change the instance"
  done
}
refuse_lima_overrides

# ---------------------------------------------------------------------------
# 3. The work directory
# ---------------------------------------------------------------------------
# Absolute, outside the repository and the home directory, and either new or
# made by run.sh (it holds WORK_MARKER). Nothing is ever deleted anywhere else.
WORK_MARKER=.p2party-rehearsal-work
WORK="${REHEARSAL_WORK_DIR:-${TMPDIR:-/tmp}/p2party-rehearsal}"
case "$WORK" in /*) ;; *) refuse "REHEARSAL_WORK_DIR $WORK is not an absolute path" ;; esac
[ ! -L "$WORK" ] || refuse "$WORK is a symbolic link"
home_real="$(builtin cd -- "$HOME" && pwd -P)"
# Where WORK is, through any link in the path: the directory itself if it
# exists, else its parent's real path and its name.
if [ -d "$WORK" ]; then
  work_real="$(builtin cd -- "$WORK" && pwd -P)"
elif [ -d "$(dirname -- "$WORK")" ]; then
  work_real="$(builtin cd -- "$(dirname -- "$WORK")" && pwd -P)/$(basename -- "$WORK")"
else
  work_real="$WORK"
fi
case "$work_real" in
  / | /Users | /home | /private | /tmp | /private/tmp | /var | /private/var | /Volumes | "$home_real")
    refuse "$WORK is the root, a top-level directory or the home directory, not a work directory" ;;
esac
case "$(dirname -- "$work_real")" in
  /Users | /home) refuse "$WORK is a home directory, not a work directory" ;;
esac
case "$work_real/" in "$repo"/*) refuse "the work directory $WORK is inside the repository" ;; esac
case "$repo/" in "$work_real"/*) refuse "the repository is inside the work directory $WORK" ;; esac
case "$home_real/" in "$work_real"/*) refuse "the home directory is inside the work directory $WORK" ;; esac
if [ -e "$WORK" ]; then
  [ -d "$WORK" ] || refuse "$WORK is not a directory"
  [ -f "$WORK/$WORK_MARKER" ] || [ -z "$(ls -A "$WORK")" ] ||
    refuse "$WORK exists, is not empty and was not made by run.sh (no $WORK_MARKER)"
else
  [ "$mode" != clean ] && [ "$mode" != clean-all ] || refuse "$WORK does not exist; there is nothing to clean"
  mkdir -p "$WORK"
fi
WORK="$(builtin cd -- "$WORK" && pwd -P)"
[ -f "$WORK/$WORK_MARKER" ] || printf 'made by deploy/rehearsal/run.sh %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$WORK/$WORK_MARKER"

SECRETS="$WORK/secrets"
TREES="$WORK/trees"
SNAPSHOTS="$WORK/snapshots"
LOGS="$WORK/logs"
RAW="$WORK/raw"
RESULTS="$WORK/results"
CACHE="$WORK/cache"
GUARD_BIN="$WORK/guard-bin"
mkdir -p "$TREES" "$SNAPSHOTS" "$LOGS" "$RAW" "$RESULTS" "$CACHE/bun" "$WORK/tmp" "$WORK/host" \
  "$WORK/home" "$WORK/ansible/home" "$WORK/ansible/tmp" "$WORK/rendered"

SSH_PORT="$(awk '/^ssh:/ { s = 1 } s && /localPort:/ { print $2; exit }' "$SCRIPT_DIR/lima.yaml")"
SIGNALING_HOST_PORT=56443
SIGNALING_NAME="$(awk '/^domains:/ { d = 1 } d && /signaling:/ { print $2; exit }' "$SCRIPT_DIR/vars.yml")"
TURN_NAME="$(awk '/^domains:/ { d = 1 } d && /turn:/ { print $2; exit }' "$SCRIPT_DIR/vars.yml")"
STUN_NAME="$(awk '/^domains:/ { d = 1 } d && /stun:/ { print $2; exit }' "$SCRIPT_DIR/vars.yml")"
# Free space on the host's volume. A full run measured about 12 GiB at its
# peak (README, "Running it"), so the instance is created or started only
# with that plus the abort floor free; below the abort floor the watch
# deletes the instance at once.
ABORT_FREE_GIB=8
PEAK_GIB=12
START_MIN_FREE_GIB=$((PEAK_GIB + ABORT_FREE_GIB))
WATCH_PERIOD=10
IMAGE_URL="$(awk '/^ *- location:/ { gsub(/"/, "", $3); print $3; exit }' "$SCRIPT_DIR/lima.yaml")"
LIMA_CACHE="${LIMA_CACHE_DIR:-$HOME/Library/Caches/lima}"

# Ansible's SSH control socket is <dir>/<40-character hash>, and a Unix socket
# path is limited to 104 bytes on macOS.
CONTROL_DIR="${TMPDIR:-/tmp}"
CONTROL_DIR="${CONTROL_DIR%/}/p2r"
[ $((${#CONTROL_DIR} + 41)) -lt 104 ] || refuse "the SSH control directory $CONTROL_DIR is too long for a socket path"

log() { printf '[run.sh %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# ---------------------------------------------------------------------------
# 4. The tools
# ---------------------------------------------------------------------------
# The playbook modes need everything in tools.sha256 and the venv; vm-check
# needs the venv; clean needs nothing. The venv must hold no connection
# plugin library beyond ansible-core's ssh (paramiko, winrm and psrp would
# connect without the ssh binary, past the SSH guard), and the collections
# directory only community.postgresql.
case "$mode" in
  clean | clean-all) TOOLS="" ;;
  *)
    TOOLS="${REHEARSAL_TOOLS:-}"
    [ -n "$TOOLS" ] && [ -d "$TOOLS" ] || refuse "REHEARSAL_TOOLS is not a directory (README, \"Tools\")"
    TOOLS="$(builtin cd -- "$TOOLS" && pwd -P)"
    ansible_version="$("$TOOLS/venv/bin/ansible-playbook" --version 2>/dev/null | awk 'NR == 1 { gsub(/[^0-9.]/, "", $3); print $3 }')"
    [[ "$ansible_version" =~ ^2\.22\.[0-9]+$ ]] || refuse "$TOOLS/venv has ansible-core ${ansible_version:-none}, not 2.22.x"
    "$TOOLS/venv/bin/python" -I -c 'import importlib.util as u, sys; sys.exit(any(u.find_spec(m) for m in ("paramiko", "winrm", "pypsrp", "pypsexec")))' ||
      refuse "$TOOLS/venv has a connection library (paramiko, winrm, pypsrp or pypsexec) that would bypass the SSH guard"
    ;;
esac
if [ "$mode" != vm-check ] && [ -n "$TOOLS" ]; then
  (builtin cd "$TOOLS" && shasum -a 256 -c --quiet "$SCRIPT_DIR/tools.sha256") ||
    refuse "a tool in $TOOLS does not match $SCRIPT_DIR/tools.sha256"
  [ "$(ls "$TOOLS/collections/ansible_collections" 2>/dev/null)" = community ] &&
    [ "$(ls "$TOOLS/collections/ansible_collections/community" 2>/dev/null)" = postgresql ] ||
    refuse "$TOOLS/collections must hold community.postgresql and nothing else"
  grep -q '"version": "5.1.1"' "$TOOLS/collections/ansible_collections/community/postgresql/MANIFEST.json" ||
    refuse "$TOOLS/collections has no community.postgresql 5.1.1"
fi

# The SSH guard, as ssh, scp and sftp.
mkdir -p "$GUARD_BIN"
for tool in ssh scp sftp; do
  ln -sfn "$SCRIPT_DIR/ssh-guard.sh" "$GUARD_BIN/$tool"
done

# ---------------------------------------------------------------------------
# Processes: every long or background command runs in its own process group,
# which cleanup ends, so an interrupted run leaves no process behind.
# ---------------------------------------------------------------------------
STARTED_GROUPS=()
LAST_PID=""
start_group() {
  perl -e 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV or die "run.sh: cannot run $ARGV[0]: $!\n"' "$@" &
  LAST_PID=$!
  STARTED_GROUPS+=("$LAST_PID")
}
wait_group() {
  local pid="$1" rc=0 kept=() started
  wait "$pid" || rc=$?
  for started in "${STARTED_GROUPS[@]+"${STARTED_GROUPS[@]}"}"; do
    [ "$started" = "$pid" ] || kept+=("$started")
  done
  STARTED_GROUPS=("${kept[@]+"${kept[@]}"}")
  return "$rc"
}
# A command in its own group, waited for (so a signal interrupts the wait).
run_group() {
  start_group "$@"
  wait_group "$LAST_PID"
}
stop_groups() {
  local pid any=false
  for pid in "${STARTED_GROUPS[@]+"${STARTED_GROUPS[@]}"}"; do
    kill -TERM -- "-$pid" 2>/dev/null && any=true
  done
  if $any; then
    sleep 2
    for pid in "${STARTED_GROUPS[@]+"${STARTED_GROUPS[@]}"}"; do
      kill -KILL -- "-$pid" 2>/dev/null || true
    done
  fi
  STARTED_GROUPS=()
}

# ---------------------------------------------------------------------------
# Host-side helpers and the watch
# ---------------------------------------------------------------------------
host_free_gib() { df -k "$WORK" | awk 'NR == 2 { print int($4 / 1048576) }'; }

# What the host looks like at a point of the run: TCP listeners, UDP sockets,
# free disk space and the Lima instances.
record_host() {
  local label="$1"
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print "TCP", $1, $2, $9 }' | sort -u >"$WORK/host/$label-listen.txt" || true
  lsof -nP -iUDP 2>/dev/null | awk 'NR > 1 && $9 !~ /->/ { print "UDP", $1, $2, $9 }' | sort -u >>"$WORK/host/$label-listen.txt" || true
  df -h "$WORK" >"$WORK/host/$label-df.txt"
  "$LIMACTL" list 2>&1 >"$WORK/host/$label-limactl.txt" | grep -v 'No instance found' || true
  log "host at $label: $(host_free_gib) GiB free, $(grep -c '^TCP' "$WORK/host/$label-listen.txt" | tr -d ' ') TCP listeners, $(grep -c '^UDP' "$WORK/host/$label-listen.txt" | tr -d ' ') UDP sockets"
}

# Before every create or start of the instance.
require_free_disk() {
  local free
  free="$(host_free_gib)"
  [ "$free" -ge "$START_MIN_FREE_GIB" ] ||
    die "only $free GiB free on the host; the instance is created or started only with at least $START_MIN_FREE_GIB GiB free (a full run's measured peak of $PEAK_GIB GiB plus the $ABORT_FREE_GIB GiB abort floor)"
}

WATCH_PID=""
watch_start() {
  rm -f "$WORK/watch-tripped" "$WORK/watch-heartbeat"
  start_group bash "$SCRIPT_DIR/watch.sh" "$WORK" "$LIMACTL" "$INSTANCE" "$WATCH_PERIOD" "$ABORT_FREE_GIB" \
    >>"$LOGS/watch.log" 2>&1
  WATCH_PID="$LAST_PID"
  local waited=0
  while [ ! -s "$WORK/watch-heartbeat" ]; do
    [ ! -s "$WORK/watch-tripped" ] || die "the watch stopped at once: $(cat "$WORK/watch-tripped")"
    waited=$((waited + 1))
    [ "$waited" -lt 30 ] || die "the watch did not start (no heartbeat after 30 s; $LOGS/watch.log)"
    sleep 1
  done
}
# The watch fails closed: if it tripped, is gone, or its heartbeat is older
# than three periods, the instance is stopped and deleted and the run ends.
watch_check() {
  local reason="" beat now
  if [ -s "$WORK/watch-tripped" ]; then
    reason="the watch tripped: $(cat "$WORK/watch-tripped")"
  elif [ -z "$WATCH_PID" ] || ! kill -0 "$WATCH_PID" 2>/dev/null; then
    reason="the watch is not running"
  else
    beat="$(cat "$WORK/watch-heartbeat" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    [ $((now - beat)) -le $((3 * WATCH_PERIOD)) ] || reason="the watch's heartbeat is $((now - beat)) s old"
  fi
  if [ -n "$reason" ]; then
    printf 'run.sh: %s; stopping and deleting %s\n' "$reason" "$INSTANCE" >&2
    "$LIMACTL" stop --force "$INSTANCE" >/dev/null 2>&1 || true
    "$LIMACTL" delete --force "$INSTANCE" >/dev/null 2>&1 || true
    die "$reason"
  fi
}

# Generated for each new instance, and kept with the baseline snapshot as long
# as that snapshot exists (its disk holds the same database password and key).
# They are deleted with the instance and, in the snapshot, by clean.
new_secrets() {
  rm -rf "${SECRETS:?}"
  mkdir -p "$SECRETS"
  chmod 0700 "$SECRETS"
  (
    umask 077
    builtin cd "$SECRETS"
    ssh-keygen -q -t ed25519 -N '' -C p2party-rehearsal -f id_ed25519
    openssl rand -hex 32 >vault-pass
    cat >vault.plain.yml <<EOF
# Generated by deploy/rehearsal/run.sh for the rehearsal VM only.
vault_coturn_auth_secret: "$(openssl rand -hex 32)"
vault_coturn_realm: "$TURN_NAME"
vault_admin_email: "rehearsal@example.invalid"
vault_postgres_user: "p2party"
vault_postgres_password: "$(openssl rand -hex 24)"
vault_postgres_db_name: "p2party"
vault_wireguard_private_key: "unused-in-the-rehearsal"
vault_wireguard_peers: []
EOF
    "$TOOLS/venv/bin/ansible-vault" encrypt --vault-password-file vault-pass \
      --output vault.yml vault.plain.yml >/dev/null
    touch known_hosts
  )
}
drop_secrets() { rm -rf "${SECRETS:?}"; }

# The values the sanitizer replaces (sanitize.ts): every secret generated
# here, and this machine's paths and names.
sanitizer_values() {
  local file="$WORK/tmp/sanitizer-values" value
  (
    umask 077
    : >"$file"
    if [ -f "$SECRETS/vault-pass" ]; then
      printf 'secret %s\n' "$(cat "$SECRETS/vault-pass")" >>"$file"
      sed -n -e 's/^vault_coturn_auth_secret: "\(.*\)"$/secret \1/p' \
        -e 's/^vault_postgres_password: "\(.*\)"$/secret \1/p' "$SECRETS/vault.plain.yml" >>"$file"
    fi
    for value in "$WORK:<work>" "${WORK#/private}:<work>" "${TOOLS:-}:<tools>" "${TOOLS#/private}:<tools>" \
      "$repo:<repo>" "$CONTROL_DIR:<control-dir>" "$HOME:~" "$home_real:~" "$(id -un):<user>" \
      "$(hostname -s):<host>" "$(hostname):<host>"; do
      [ "${value%:*}" != "" ] && printf 'path %s %s\n' "${value%:*}" "${value##*:}" >>"$file"
    done
  )
  printf '%s\n' "$file"
}
sanitize() {
  local values
  values="$(sanitizer_values)"
  bun "$SCRIPT_DIR/sanitize.ts" "$values"
  rm -f "$values"
}

# ---------------------------------------------------------------------------
# Result files
# ---------------------------------------------------------------------------
# One markdown file per mode: what ran, against which commit, the playbook
# output verbatim, the README paragraph it is checked against, and the state
# of the machine afterwards. Written raw under $RAW (deleted by clean) and,
# only through sanitize, into $RESULTS/<date>/ at the end.
RESULT=""
RESULT_NAME=""

# The harness itself: its two main files' SHA-256, and the commit whose
# deploy/rehearsal it is, when every file of it equals that commit's.
harness_identity() {
  local head tracked ours same=true path
  head="$(git -C "$repo" rev-parse --short=12 HEAD)"
  tracked="$(git -C "$repo" ls-tree -r --name-only HEAD -- deploy/rehearsal | grep -v '^deploy/rehearsal/results/' | sed 's|^deploy/rehearsal/||' | sort)"
  ours="$(builtin cd "$SCRIPT_DIR" && find . -type f ! -path './results/*' | sed 's|^\./||' | sort)"
  [ "$tracked" = "$ours" ] || same=false
  if $same; then
    while IFS= read -r path; do
      git -C "$repo" cat-file -p "HEAD:deploy/rehearsal/$path" | cmp -s - "$SCRIPT_DIR/$path" || { same=false; break; }
    done <<<"$tracked"
  fi
  printf 'run.sh sha256 `%s`, lima.yaml sha256 `%s`; ' \
    "$(shasum -a 256 "$SCRIPT_DIR/run.sh" | cut -c1-64)" "$(shasum -a 256 "$SCRIPT_DIR/lima.yaml" | cut -c1-64)"
  if $same; then printf 'deploy/rehearsal as committed at `%s`' "$head"; else printf 'not a committed tree (differs from deploy/rehearsal at `%s`)' "$head"; fi
}

result_open() {
  RESULT_NAME="$1"
  RESULT="$RAW/$RESULT_NAME.md"
  {
    printf '# %s\n\n' "$2"
    if [ "${3:-}" = no-commit ]; then
      printf -- '- Commit under test: none (this run installs the baseline only)\n'
    else
      printf -- '- Commit under test: `%s` (%s)\n' "${COMMIT_SHA:-none}" "${COMMIT_SUBJECT:-}"
    fi
    printf -- '- Baseline: `%s` (release 0.1.4 by default)\n' "$(git -C "$repo" rev-parse --short=12 "$BASELINE_REV")"
    printf -- '- Harness (`run.sh %s`): %s\n' "$mode" "$(harness_identity)"
    printf -- '- Started: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$RESULT"
}
res() { printf '%s\n' "$*" >>"$RESULT"; }
res_block() {
  local title="$1" file="$2"
  {
    printf '\n%s\n\n~~~~text\n' "$title"
    cat "$file"
    printf '~~~~\n'
  } >>"$RESULT"
}
result_close() {
  [ -n "$RESULT" ] || return 0
  local dated
  dated="$RESULTS/$(date -u +%Y-%m-%d)"
  mkdir -p "$dated"
  res ""
  res "- Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sanitize <"$RESULT" >"$dated/$RESULT_NAME.md"
  log "result: $dated/$RESULT_NAME.md"
  RESULT=""
}

# The paragraph(s) of the tree's deploy/README.md matching an extended
# regular expression, quoted, or a line saying the README is silent.
readme_quote() {
  local tree="$1" pattern="$2" quoted
  quoted="$(awk -v RS= -v pat="$pattern" '$0 ~ pat { print; print "" }' "$tree/deploy/README.md")"
  if [ -n "$quoted" ]; then
    printf '%s\n' "$quoted" | sed 's/^/> /'
  else
    printf '(No paragraph of deploy/README.md at this commit matches /%s/: the README is silent here.)\n' "$pattern"
  fi
}

# ---------------------------------------------------------------------------
# Trees under test
# ---------------------------------------------------------------------------
# A `git archive` of the commit, extracted into the work directory. Unless
# "archive-only" is asked for, the copy also gets that one commit's git
# metadata (fetched from the repository, so HEAD is the same commit and
# `git status` is clean): from 35d94c8 on, deploy.yml's build record runs
# `git rev-parse HEAD` and `git status` in the tree it builds.
# The vault is a link to this instance's generated one, at the path the
# playbooks' vars_files name. Prints the tree's path.
prepare_tree() {
  local rev="$1" flavour="${2:-git}" sha dir
  sha="$(git -C "$repo" rev-parse --verify "$rev^{commit}")"
  dir="$TREES/${sha:0:12}"
  prune_trees "${sha:0:12}"
  if [ ! -f "$dir.ready" ]; then
    log "preparing a tree of ${sha:0:12}"
    rm -rf "${dir:?}"
    mkdir -p "$dir"
    git -C "$repo" archive "$sha" | tar -x -C "$dir"
    git -C "$dir" init -q
    git -C "$dir" fetch -q --depth 1 "$repo" "$sha"
    git -C "$dir" reset -q "$sha"
    mkdir -p "$dir/deploy/ansible/group_vars/all"
    ln -sfn "$SECRETS/vault.yml" "$dir/deploy/ansible/group_vars/all/vault.yml"
    (
      builtin cd "$dir"
      env -i HOME="$HOME" LANG=C.UTF-8 TMPDIR="$WORK/tmp" PATH="$TOOLS/bun-$(tree_bun_pin "$dir"):/usr/bin:/bin" \
        BUN_INSTALL_CACHE_DIR="$CACHE/bun" CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
        bun install --frozen-lockfile
    ) >"$LOGS/install-${sha:0:12}.log" 2>&1 || die "bun install --frozen-lockfile failed in the tree of ${sha:0:12} ($LOGS/install-${sha:0:12}.log)"
    [ -z "$(git -C "$dir" status --porcelain)" ] || die "the tree of ${sha:0:12} differs from its commit"
    touch "$dir.ready"
  fi
  if [ "$flavour" = archive-only ]; then
    local plain="$dir-archive-only"
    if [ ! -d "$plain" ]; then
      cp -c -R "$dir" "$plain"
      rm -rf "${plain:?}/.git"
    fi
    dir="$plain"
  fi
  printf '%s\n' "$dir"
}

# At most one tree per release is kept: the baseline's, the commit under
# test's, and the one being prepared (each with its own node_modules, about
# 0.5 GB).
prune_trees() {
  local keep_baseline keep_commit entry name
  keep_baseline="$(git -C "$repo" rev-parse --short=12 "$BASELINE_REV")"
  keep_commit="${COMMIT_SHA:0:12}"
  for entry in "$TREES"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    name="${name%.ready}"
    case "$name" in
      "$keep_baseline" | "$keep_commit" | "$1") ;;
      *) rm -rf "${entry:?}" ;;
    esac
  done
}

# The Bun a tree's package.json pins, for building it. Release 0.1.4 pins
# 1.3.14, of which the rehearsal has no macOS build: it is built with the
# Bun of the commit under test (README, "What stands in for what").
tree_bun_pin() {
  local pin
  pin="$(sed -n 's/.*"packageManager": "bun@\([0-9.]*\)".*/\1/p' "$1/package.json")"
  if [ -x "$TOOLS/bun-$pin/bun" ]; then printf '%s\n' "$pin"; else printf '%s\n' "$PIN"; fi
}

# An Ansible command (ansible, ansible-playbook, ansible-inventory) in
# play-env.sh's environment, from DIR. PLAY_BUN_DIR goes first on PATH after
# the SSH guard (default: the pinned Bun).
ansible_in() {
  local dir="$1"
  shift
  (
    builtin cd "$dir" &&
      exec bash "$SCRIPT_DIR/play-env.sh" --work "$WORK" --tools "$TOOLS" --cfg "$SCRIPT_DIR/ansible.cfg" \
        --control "$CONTROL_DIR" --guard-bin "$GUARD_BIN" --ssh-port "$SSH_PORT" \
        --bun-dir "${PLAY_BUN_DIR:-$TOOLS/bun-${PIN:-none}}" -- "$@"
  )
}

# After Ansible's own parsing, what it resolved for every host of the
# inventory must be 127.0.0.1 on the instance's port (inventory-check.ts
# resolved), before any play.
RESOLVED_CHECKED=false
check_resolved_inventory() {
  $RESOLVED_CHECKED && return 0
  local host pairs=()
  mkdir -p "$CONTROL_DIR"
  chmod 0700 "$CONTROL_DIR"
  for host in $(printf '%s\n' "$inventory_summary" | sed 's/^inventory: \(.*\) -> .*/\1/' | tr -d ','); do
    ansible_in "$SCRIPT_DIR" ansible-inventory -i "$inventory" --host "$host" >"$WORK/tmp/resolved-$host.json" 2>"$LOGS/ansible-inventory.log" ||
      die "ansible-inventory --host $host failed ($LOGS/ansible-inventory.log)"
    pairs+=("$host=$WORK/tmp/resolved-$host.json")
  done
  bun "$SCRIPT_DIR/inventory-check.ts" resolved "$SCRIPT_DIR/lima.yaml" "$CONNECTION_VARIABLES" "${pairs[@]}"
  log "ansible-inventory resolves every host to 127.0.0.1:$SSH_PORT"
  RESOLVED_CHECKED=true
}

# The arguments run.sh adds to a playbook: -e only with a name on
# inventory-check.ts's short list, and --skip-tags.
check_play_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -e)
        [ $# -ge 2 ] || die "-e needs a value"
        bun "$SCRIPT_DIR/inventory-check.ts" extra-var "$CONNECTION_VARIABLES" "${2%%=*}"
        shift 2
        ;;
      --skip-tags) [ $# -ge 2 ] || die "--skip-tags needs a value"; shift 2 ;;
      *) die "run.sh passes no playbook argument $1" ;;
    esac
  done
}

# ansible-playbook from a tree, with the rehearsal's inventory, variables,
# vault and configuration, in its own process group: run_play_start starts it
# (its pid in LAST_PID), run_play_finish waits for it; run_play does both.
run_play_start() {
  local logfile="$1" tree="$2" playbook="$3"
  shift 3
  check_play_args "$@"
  check_resolved_inventory
  watch_check
  log "ansible-playbook $playbook (tree ${tree##*/}) -> ${logfile##*/}"
  start_group bash -c 'cd "$1" && shift && exec "$@"' run-play "$tree/deploy/ansible" \
    bash "$SCRIPT_DIR/play-env.sh" --work "$WORK" --tools "$TOOLS" --cfg "$SCRIPT_DIR/ansible.cfg" \
    --control "$CONTROL_DIR" --guard-bin "$GUARD_BIN" --ssh-port "$SSH_PORT" \
    --bun-dir "${PLAY_BUN_DIR:-$TOOLS/bun-$PIN}" -- \
    ansible-playbook -i "$inventory" "playbooks/$playbook" \
    -e "@$SCRIPT_DIR/vars.yml" --vault-password-file "$SECRETS/vault-pass" "$@" >"$logfile" 2>&1
}
run_play_finish() {
  local pid="$1" playbook="$2" rc=0
  wait_group "$pid" || rc=$?
  log "ansible-playbook $playbook exited $rc"
  watch_check
  return "$rc"
}
run_play() {
  run_play_start "$@"
  run_play_finish "$LAST_PID" "$3"
}

# Runs a playbook and records its output verbatim in the result file.
# Prints nothing; returns the playbook's exit code.
play_recorded() {
  local title="$1" logfile="$2" rc=0
  shift 2
  run_play "$logfile" "$@" || rc=$?
  res_block "$title (exit $rc):" "$logfile"
  return "$rc"
}

# ---------------------------------------------------------------------------
# The VM
# ---------------------------------------------------------------------------
vm_exists() { "$LIMACTL" list --format '{{.Name}}' 2>/dev/null | grep -qx "$INSTANCE"; }
vm_status() { "$LIMACTL" list --format '{{.Status}}' "$INSTANCE" 2>/dev/null || true; }

vm_start() {
  require_free_disk
  watch_check
  log "starting $INSTANCE"
  run_group "$LIMACTL" start --tty=false --timeout=30m "$INSTANCE" >>"$LOGS/limactl.log" 2>&1 ||
    die "limactl start failed ($LOGS/limactl.log)"
  watch_check
  # cloud-init gives the guest new SSH host keys on every Lima start.
  ssh-keygen -q -R "[127.0.0.1]:$SSH_PORT" -f "$SECRETS/known_hosts" >/dev/null 2>&1 || true
}

vm_stop() {
  if vm_exists && [ "$(vm_status)" = Running ]; then
    log "stopping $INSTANCE"
    run_group "$LIMACTL" stop "$INSTANCE" >>"$LOGS/limactl.log" 2>&1 || true
    # The host agent's log names every port it forwarded or ignored.
    cp "$INSTANCE_DIR/ha.stderr.log" "$LOGS/ha-$(date -u +%Y%m%dT%H%M%S).log" 2>/dev/null || true
  fi
}

# Deleting the instance also deletes its secrets (a snapshot keeps its own).
vm_delete() {
  if vm_exists; then
    vm_stop || true
    log "deleting $INSTANCE"
    "$LIMACTL" delete --force "$INSTANCE" >>"$LOGS/limactl.log" 2>&1 || true
  fi
  drop_secrets
}

# Every creation of the instance, new or for a snapshot, goes through here.
lima_create() {
  refuse_lima_overrides
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || refuse "this rehearsal is written for an Apple Silicon Mac (lima.yaml: vz, aarch64)"
  for port in "$SSH_PORT" "$SIGNALING_HOST_PORT"; do
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || refuse "host port $port is in use"
  done
  require_free_disk
  # Whether the image is in Lima's cache before this harness asks for it.
  if ! grep -rlx -F -- "$IMAGE_URL" "$LIMA_CACHE"/download/by-url-sha256/*/url >/dev/null 2>&1; then
    printf '%s\n' "$IMAGE_URL" >"$WORK/lima-image-downloaded-by-run.sh"
  fi
  log "creating $INSTANCE from lima.yaml"
  run_group "$LIMACTL" create --name="$INSTANCE" --tty=false "$SCRIPT_DIR/lima.yaml" >>"$LOGS/limactl.log" 2>&1 ||
    die "limactl create failed ($LOGS/limactl.log)"
}

# A new instance from lima.yaml, with new secrets.
vm_create() {
  if vm_exists; then
    log "$INSTANCE exists from an earlier run; it is replaced"
    vm_delete
  fi
  record_host before-create
  new_secrets
  lima_create
  vm_start
  record_host after-first-start
}

# The instance's disk and firmware state, copied as APFS clones (no space is
# used until the instance's copy diverges), and the secrets that disk was
# made with. A snapshot outlives the instance: restoring creates the instance
# again and puts the files back. It is whole only with its `complete` marker,
# written last. Lima 2.3 names the vz disk "disk"; older releases "diffdisk".
SNAPSHOT_FILES=(disk diffdisk vz-efi vz-identifier)
snapshot_save() {
  local name="$1" file
  vm_stop
  rm -rf "${SNAPSHOTS:?}/$name"
  mkdir -p "$SNAPSHOTS/$name"
  for file in "${SNAPSHOT_FILES[@]}"; do
    if [ -e "$INSTANCE_DIR/$file" ]; then
      cp -c "$INSTANCE_DIR/$file" "$SNAPSHOTS/$name/$file"
    fi
  done
  [ -e "$SNAPSHOTS/$name/disk" ] || [ -e "$SNAPSHOTS/$name/diffdisk" ] ||
    die "snapshot $name holds no disk (no disk or diffdisk in $INSTANCE_DIR)"
  cp -R "$SECRETS" "$SNAPSHOTS/$name/secrets"
  chmod 0700 "$SNAPSHOTS/$name/secrets"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$SNAPSHOTS/$name/complete"
  log "snapshot $name saved"
}

snapshot_restore() {
  local name="$1" file
  [ -f "$SNAPSHOTS/$name/complete" ] || die "no complete snapshot $name (an interrupted save is never restored)"
  if vm_exists; then
    vm_stop
  else
    lima_create
  fi
  for file in "${SNAPSHOT_FILES[@]}"; do
    if [ -e "$SNAPSHOTS/$name/$file" ]; then
      rm -f "$INSTANCE_DIR/$file"
      cp -c "$SNAPSHOTS/$name/$file" "$INSTANCE_DIR/$file"
    fi
  done
  drop_secrets
  cp -R "$SNAPSHOTS/$name/secrets" "$SECRETS"
  chmod 0700 "$SECRETS"
  log "snapshot $name restored"
  vm_start
}

# What a run leaves on disk, for the last lines of every run.
left_on_disk() {
  local item size
  printf 'run.sh: left on disk:'
  if vm_exists; then printf ' the instance %s (%s);' "$INSTANCE" "$(du -sh "$INSTANCE_DIR" 2>/dev/null | cut -f1)"; fi
  for item in snapshots trees cache secrets logs raw results; do
    if [ -n "$(ls -A "$WORK/$item" 2>/dev/null)" ]; then
      size="$(du -sh "$WORK/$item" 2>/dev/null | cut -f1)"
      printf ' %s (%s);' "$WORK/$item" "$size"
    fi
  done
  if [ -f "$WORK/lima-image-downloaded-by-run.sh" ]; then printf " the image in Lima's cache (run.sh clean-all removes it);"; fi
  printf '\n'
}

cleanup() {
  local rc=$?
  exec 1>&8 2>&9
  trap - EXIT INT TERM HUP
  stop_groups
  result_close || true
  if ! $keep && [ "$mode" != clean ] && [ "$mode" != clean-all ]; then
    vm_delete || true
    record_host after-delete || true
  fi
  [ -d "$WORK" ] && left_on_disk >&2
  exit "$rc"
}

# Guest commands as root, over Lima's own channel (not the rehearsal key).
guest_cmd() {
  watch_check
  "$LIMACTL" shell --workdir / "$INSTANCE" sudo bash -c "$1"
}
guest_copy() { "$LIMACTL" copy "$1" "$INSTANCE:$2" >/dev/null; }
GUEST_LIB=/usr/local/lib/p2party-rehearsal
guest_install_helpers() {
  guest_copy "$SCRIPT_DIR/guest/standins.sh" /tmp/standins.sh
  guest_copy "$SCRIPT_DIR/guest/state.sh" /tmp/state.sh
  guest_copy "$SCRIPT_DIR/guest/fingerprint.sh" /tmp/fingerprint.sh
  guest_cmd "install -d $GUEST_LIB && install -m 0755 /tmp/standins.sh /tmp/state.sh /tmp/fingerprint.sh $GUEST_LIB/ && rm -f /tmp/standins.sh /tmp/state.sh /tmp/fingerprint.sh"
}
standin() {
  local out="$WORK/tmp/standin-$1.txt" rc=0
  guest_cmd "$GUEST_LIB/standins.sh $*" >"$out" 2>&1 || rc=$?
  res_block "Stand-in \`$1\` (exit $rc):" "$out"
  [ "$rc" -eq 0 ] || die "stand-in $1 failed ($out)"
}
guest_bun() {
  guest_copy "$TOOLS/bun-linux-aarch64-$1/bun" "/tmp/bun-$1"
  standin host-bun "/tmp/bun-$1"
  guest_cmd "rm -f /tmp/bun-$1"
}

# What a deploy that should change nothing changed: guest/fingerprint.sh
# before and after, and the difference.
fingerprint_before() { guest_cmd "$GUEST_LIB/fingerprint.sh" >"$WORK/tmp/fingerprint-before.txt" 2>&1 || true; }
fingerprint_compare() {
  guest_cmd "$GUEST_LIB/fingerprint.sh" >"$WORK/tmp/fingerprint-after.txt" 2>&1 || true
  if diff -u "$WORK/tmp/fingerprint-before.txt" "$WORK/tmp/fingerprint-after.txt" >"$WORK/tmp/fingerprint-diff.txt"; then
    res ""
    res "- On the host, every file and service of guest/fingerprint.sh is as it was before the run $1 (no difference)."
  else
    res_block "On the host, what changed during the run $1 (guest/fingerprint.sh before and after; checksum prefix, modification time, service start):" \
      "$WORK/tmp/fingerprint-diff.txt"
  fi
}

record_state() {
  local out="$WORK/tmp/state.txt"
  guest_cmd "$GUEST_LIB/state.sh p2party $SIGNALING_NAME" >"$out" 2>&1 || true
  res_block "State of the VM $1:" "$out"
}

# The seeded rows as one JSON value, and their comparison with what this
# release's migrations should have made of them (seed.ts).
record_rows() {
  local dump="$WORK/tmp/rows.json" out="$WORK/tmp/rows-check.txt" rc=0
  bun "$SCRIPT_DIR/seed.ts" dump-sql >"$WORK/tmp/dump.sql"
  guest_copy "$WORK/tmp/dump.sql" /tmp/dump.sql
  guest_cmd "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q -A -t -d p2party -f /tmp/dump.sql" >"$dump"
  bun "$SCRIPT_DIR/seed.ts" check "$dump" >"$out" 2>&1 || rc=$?
  res_block "Seeded rows against the migration's intent $1 (exit $rc):" "$out"
  return "$rc"
}

# Health from the host, through the one forwarded port, with the guest's
# Caddy CA: what Task Z1's end-to-end run would reach.
record_host_health() {
  local ca="$WORK/tmp/caddy-local-ca.crt" out="$WORK/tmp/host-health.txt"
  guest_cmd "cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt" >"$ca" 2>/dev/null || true
  curl -fsS --retry 4 --retry-connrefused -m 10 --cacert "$ca" --resolve "$SIGNALING_NAME:$SIGNALING_HOST_PORT:127.0.0.1" \
    "https://$SIGNALING_NAME:$SIGNALING_HOST_PORT/health" >"$out" 2>&1 || echo "(no answer: curl exit $?)" >>"$out"
  echo >>"$out"
  res_block "From the host, https://$SIGNALING_NAME:$SIGNALING_HOST_PORT/health (127.0.0.1, the guest's Caddy CA):" "$out"
  bun -e 'const [file, version, protocol] = process.argv.slice(1);
    const body = await Bun.file(file).json();
    if (body.status !== "ok" || body.version !== version || body.protocolVersion !== Number(protocol))
      throw Error("unexpected signaling health response");' "$out" "$1" "$2" ||
    die "the loopback Caddy endpoint did not serve the expected release $1 and protocol $2"
}

record_candidate_health() {
  local tree="$1" version protocol
  version="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$tree/package.json")"
  protocol="$(bun -e 'console.log((await import(process.argv[1])).SIGNALING_PROTOCOL_VERSION)' "$tree/src/utils/signalingProtocol.ts")"
  record_host_health "$version" "$protocol"
}



# ---------------------------------------------------------------------------
# The signaling host's cloud-init, applied by cloud-init itself
# ---------------------------------------------------------------------------
# deploy/terraform/templates/signaling_cloud_init.yaml.tpl, rendered as
# Terraform renders it (render-cloud-init.ts) with the rehearsal's key and SSH
# port 22 (Lima forwards to the guest's 22 only), validated by
# `cloud-init schema`, then applied module by module with `cloud-init single`
# in the order cloud-init runs them. Its runcmd ends in a reboot.
apply_signaling_cloud_init() {
  local tree="$1" rendered="$WORK/rendered/signaling_cloud_init.yaml" out="$WORK/tmp/cloud-init.txt" source_ip status
  bun "$SCRIPT_DIR/render-cloud-init.ts" \
    "$tree/deploy/terraform/templates/signaling_cloud_init.yaml.tpl" "$SECRETS/id_ed25519.pub" 22 >"$rendered"
  guest_install_helpers
  guest_copy "$rendered" /tmp/signaling_cloud_init.yaml
  guest_cmd "cloud-init schema --config-file /tmp/signaling_cloud_init.yaml" >"$out" 2>&1 ||
    { res_block "cloud-init schema (failed):" "$out"; die "the rendered cloud-init does not validate"; }
  res_block "cloud-init schema --config-file (the rendered signaling template):" "$out"

  # Where Lima's SSH comes from, for the stand-in firewall rule.
  source_ip="$(guest_cmd "ss -Htn state established '( sport = :22 )'" | awk '{ print $4 }' | sed 's/:[0-9]*$//' | head -1)"
  [ -n "$source_ip" ] || die "cannot see Lima's SSH connection in the guest"
  standin lima-ssh-firewall "${source_ip%.*}.0/24"

  : >"$out"
  for module in users_groups package_update_upgrade_install write_files runcmd; do
    log "cloud-init single --name $module"
    if ! guest_cmd "cloud-init single --name $module --frequency always --file /tmp/signaling_cloud_init.yaml" >>"$out" 2>&1; then
      # package_upgrade also refreshes snaps, and the rehearsal's snapd is
      # masked (lima.yaml). That one failure is accepted when the apt part
      # finished and every package of the template is installed.
      if [ "$module" = package_update_upgrade_install ] &&
        guest_cmd "grep -q \"Running command \\['snap', \" /var/log/cloud-init.log && dpkg -s fail2ban ufw net-tools unzip >/dev/null" >/dev/null 2>&1; then
        guest_cmd "grep -E 'snap|failed with exceptions' /var/log/cloud-init.log | tail -4 | cut -c1-200" >>"$out" 2>&1 || true
        res "- \`package_update_upgrade_install\` ran apt's update, dist-upgrade and the template's package installs, then failed at its snap refresh: the rehearsal masks snapd (lima.yaml), so cloud-init's snap step is the one part of the template not reproduced."
      else
        res_block "cloud-init single (failed at $module):" "$out"
        die "cloud-init module $module failed"
      fi
    fi
  done
  log "cloud-init single --name scripts_user (runs runcmd, which reboots)"
  guest_cmd "cloud-init single --name scripts_user --frequency always --file /tmp/signaling_cloud_init.yaml" >>"$out" 2>&1 || true
  res_block "cloud-init single, modules users_groups, package_update_upgrade_install, write_files, runcmd, scripts_user:" "$out"

  # Wait for the reboot: Lima either brings the guest back or reports the
  # instance stopped, which is then started again.
  local waited=0
  sleep 10
  while :; do
    status="$(vm_status)"
    if [ "$status" = Stopped ]; then
      res "- The runcmd's \`reboot\` stopped the vz instance; run.sh started it again."
      vm_start
      break
    fi
    if [ "$status" = Running ] && guest_cmd "test -f /root/.provisioning_complete && systemctl is-system-running --wait >/dev/null 2>&1; test -f /root/.provisioning_complete" >/dev/null 2>&1; then
      res "- The runcmd's \`reboot\` restarted the guest; Lima reconnected."
      break
    fi
    waited=$((waited + 10))
    [ "$waited" -lt 600 ] || die "the guest did not come back after cloud-init's reboot"
    sleep 10
  done
  ssh-keygen -q -R "[127.0.0.1]:$SSH_PORT" -f "$SECRETS/known_hosts" >/dev/null 2>&1 || true
  guest_cmd "cat /root/.provisioning_complete; ufw status verbose; sshd -T | grep -E '^(port|permitrootlogin|passwordauthentication|allowusers|allowtcpforwarding|authenticationmethods) '" \
    >"$out" 2>&1 || true
  res_block "After the reboot (provisioning marker, firewall, effective sshd settings):" "$out"
}

# The common stand-ins after cloud-init (README, "What stands in for what").
apply_standins() {
  guest_install_helpers
  standin private-network
  standin amd64-runtime
  standin no-prisma-checkpoint
  standin postgresql-from-ubuntu
  standin caddy-from-ubuntu
}


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
# Release 0.1.4, as production runs it, from a `git archive` of the baseline
# commit with that tree's own playbooks, in the order its deploy/README.md
# gives (install-postgres, initial-setup, deploy), then rows in every table.
mode_baseline() {
  local tree014 rc
  vm_create
  result_open 01-baseline-0.1.4 "Baseline: release 0.1.4 installed by its own playbooks" no-commit
  tree014="$(prepare_tree "$BASELINE_REV")"
  res ""
  res "Release 0.1.4's tree: \`git archive $BASELINE_REV\`; its package.json pins Bun $(sed -n 's/.*"packageManager": "bun@\([0-9.]*\)".*/\1/p' "$tree014/package.json"); it is built with Bun $(tree_bun_pin "$tree014")."
  apply_signaling_cloud_init "$tree014"
  apply_standins
  guest_bun 1.3.14
  rc=0
  play_recorded "install-postgres.yml at $BASELINE_REV" "$LOGS/014-install-postgres.log" "$tree014" install-postgres.yml || rc=$?
  [ "$rc" -eq 0 ] || die "release 0.1.4's install-postgres.yml failed"
  rc=0
  play_recorded "initial-setup.yml at $BASELINE_REV" "$LOGS/014-initial-setup.log" "$tree014" initial-setup.yml || rc=$?
  standin trust-caddy-ca
  rc=0
  PLAY_BUN_DIR="$TOOLS/bun-$(tree_bun_pin "$tree014")" \
    play_recorded "deploy.yml at $BASELINE_REV (builds 0.1.4)" "$LOGS/014-deploy.log" "$tree014" deploy.yml || rc=$?
  [ "$rc" -eq 0 ] || die "release 0.1.4's deploy.yml failed"
  record_host_health 0.1.4 4
  bun "$SCRIPT_DIR/seed.ts" sql >"$WORK/tmp/seed.sql"
  guest_copy "$WORK/tmp/seed.sql" /tmp/seed.sql
  guest_cmd "sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d p2party -f /tmp/seed.sql && rm -f /tmp/seed.sql" >"$WORK/tmp/seed.txt" 2>&1 ||
    die "seeding failed ($WORK/tmp/seed.txt)"
  res ""
  res "Seeded with \`bun deploy/rehearsal/seed.ts sql\`: 4 peers (one with an upper-case key), 2 rooms, 3 memberships, 2 challenges, 2 queued signals."
  record_state "with 0.1.4 serving and the seed in place"
  record_host after-baseline
  snapshot_save baseline
  result_close
}

ensure_baseline() {
  if [ ! -f "$SNAPSHOTS/baseline/complete" ]; then
    mode_baseline
  fi
  snapshot_restore baseline
  guest_install_helpers
  # cloud-init runs its per-instance modules again on every Lima start (a new
  # instance id), apt's source list included; the multiarch restriction of
  # the amd64-runtime stand-in is put back.
  guest_cmd "$GUEST_LIB/standins.sh amd64-sources" >/dev/null
}

# The README's step before a deploy: check the host's Bun and, if it is not
# the pin, install the pinned release. The README's command downloads it from
# GitHub inside the host; the rehearsal copies the same release in (README,
# "What stands in for what").
host_bun_to_pin() {
  local found
  found="$(guest_cmd "sudo -u p2party /home/p2party/.bun/bin/bun --version" 2>&1 | tail -1)"
  res ""
  res "Before deploying, deploy/README.md says to check the host's Bun: \`sudo -u p2party /home/p2party/.bun/bin/bun --version\` printed \`$found\`; the pin is $PIN."
  if [ "$found" != "$PIN" ]; then
    guest_bun "$PIN"
  fi
}

mode_upgrade() {
  local tree tree_plain rc
  ensure_baseline
  result_open 02-upgrade "Upgrade: the commit under test deployed over release 0.1.4"
  tree="$(prepare_tree "$COMMIT_SHA")"
  tree_plain="$(prepare_tree "$COMMIT_SHA" archive-only)"
  res ""
  res "The README's paragraph on the deploy order:"
  res ""
  readme_quote "$tree" "prepares the release while the old one keeps serving" >>"$RESULT"
  host_bun_to_pin

  res ""
  res "## 1. From a plain \`git archive\` of the commit (no git metadata)"
  rc=0
  play_recorded "deploy.yml from the plain archive" "$LOGS/upgrade-plain-archive.log" "$tree_plain" deploy.yml || rc=$?
  record_state "after the run from the plain archive"
  rm -rf "${tree_plain:?}"

  res ""
  res "## 2. From the archive with the commit's git metadata"
  rc=0
  play_recorded "deploy.yml" "$LOGS/upgrade-deploy.log" "$tree" deploy.yml || rc=$?
  record_state "after the upgrade"
  [ "$rc" -eq 0 ] || die "the upgrade's deploy.yml failed (exit $rc)"
  record_rows "after the upgrade" || die "seeded rows failed validation after the upgrade"
  record_candidate_health "$tree"
  if [ -f "$tree/deploy/ansible/builds/p2party_linux_x64.build.json" ]; then
    cp "$tree/deploy/ansible/builds/p2party_linux_x64.build.json" "$WORK/tmp/build-record-${COMMIT_SHA:0:12}.json"
    res_block "The build record the deploy wrote (\`deploy/ansible/builds/p2party_linux_x64.build.json\`):" \
      "$WORK/tmp/build-record-${COMMIT_SHA:0:12}.json"
  fi
  guest_cmd "set -x; uname -m; ls /proc/sys/fs/binfmt_misc/ | grep -i rosetta; head -c 20 /home/p2party/server/p2party-server | od -A n -t x1 | head -1; ls /home/p2party/server/migration-tooling/node_modules/@typescript/; grep -m1 '\"version\"' /home/p2party/server/migration-tooling/node_modules/prisma/package.json; caddy version; psql --version; sudo -u p2party /home/p2party/.bun/bin/bun --version" \
    >"$WORK/tmp/first-exercised.txt" 2>&1 || true
  res_block "The items of deploy/README.md \"First exercised at the release deploy\" as they ran here (architecture, Rosetta, the binary's ELF header, TypeScript's native package in the tooling, Prisma, Caddy, PostgreSQL, the host's Bun):" \
    "$WORK/tmp/first-exercised.txt"
  record_host after-upgrade
  result_close
}

# ---------------------------------------------------------------------------
# Scenario helpers
# ---------------------------------------------------------------------------
# SQL in the guest's database as the postgres user, from stdin.
guest_sql() {
  printf '%s\n' "$1" | "$LIMACTL" shell --workdir / "$INSTANCE" sudo -u postgres psql -X -v ON_ERROR_STOP=1 -q -A -t -d p2party
}

# A session that holds a lock in an open transaction, detached in the guest,
# until lock_holder_end. $1 is the statement that takes the lock.
lock_holder_start() {
  printf 'BEGIN;\n%s\nSELECT pg_sleep(900);\n' "$1" >"$WORK/tmp/lock-holder.sql"
  guest_copy "$WORK/tmp/lock-holder.sql" /tmp/lock-holder.sql
  # Fully detached: a descriptor left open on the shell session would keep
  # `limactl shell` waiting for the 900-second sleep.
  guest_cmd "chmod 0644 /tmp/lock-holder.sql && setsid -f bash -c 'sudo -u postgres psql -X -q -d p2party -f /tmp/lock-holder.sql' </dev/null >/tmp/lock-holder.log 2>&1"
  sleep 3
  res "- Lock holder: an open transaction ran \`$1\` and then \`SELECT pg_sleep(900)\`; its backend: $(guest_sql "SELECT pid || ' ' || state || ' since ' || xact_start FROM pg_stat_activity WHERE query LIKE '%pg_sleep(900)%' AND pid <> pg_backend_pid();")"
}
lock_holder_end() {
  res "- Lock holder ended: $(guest_sql "SELECT count(pg_terminate_backend(pid)) || ' backend(s) terminated' FROM pg_stat_activity WHERE query LIKE '%pg_sleep(900)%' AND pid <> pg_backend_pid();")"
}

# Waits up to $2 seconds for a backend of the p2party role whose statement
# matches the LIKE pattern $1 to wait on a lock; prints its pid.
wait_for_lock_wait() {
  local pattern="$1" deadline=$((SECONDS + $2)) pid
  while [ "$SECONDS" -lt "$deadline" ] && kill -0 "$3" 2>/dev/null; do
    watch_check
    pid="$(guest_sql "SELECT pid FROM pg_stat_activity WHERE usename = 'p2party' AND wait_event_type = 'Lock' AND query ILIKE '$pattern' LIMIT 1;" | tr -d '[:space:]')"
    if [ -n "$pid" ]; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 3
  done
  return 1
}
backend_line() {
  guest_sql "SELECT 'backend ' || pid || ': state ' || state || ', wait ' || coalesce(wait_event_type || '/' || wait_event, 'none') || ', statement running for ' || date_trunc('second', now() - query_start) || ': ' || left(regexp_replace(query, '\s+', ' ', 'g'), 80) FROM pg_stat_activity WHERE pid = $1;"
}

# Keep the blocking transaction open until the deploy fails by itself. A
# successful recovery must not depend on someone killing the waiting backend.
deploy_with_blocked_migration() {
  local logfile="$1" tree="$2" pattern="$3" play_pid pid start rc=0
  run_play_start "$logfile" "$tree" deploy.yml
  play_pid="$LAST_PID"
  if ! pid="$(wait_for_lock_wait "$pattern" 900 "$play_pid")"; then
    res_block "deploy.yml before the expected migration lock was observed:" "$logfile"
    die "the rehearsal did not observe the expected migration lock wait"
  fi
  start=$SECONDS
  res "- The migration is waiting on the held lock: $(backend_line "$pid")"
  while [ "$(guest_sql "SELECT count(*) FROM pg_stat_activity WHERE pid = $pid AND wait_event_type = 'Lock' AND query ILIKE '$pattern';")" = 1 ]; do
    [ $((SECONDS - start)) -le 30 ] || die "the migration was still waiting 30 seconds after observing the lock"
    sleep 1
  done
  res "- The waiting statement left the lock wait within $((SECONDS - start)) seconds of observation with the blocking transaction still open."
  run_play_finish "$play_pid" deploy.yml || rc=$?
  res_block "deploy.yml (exit $rc):" "$logfile"
  [ "$rc" -ne 0 ] || die "deploy unexpectedly succeeded with the migration blocked"
  guest_cmd "test -e /var/lib/p2party-migration-failed && grep -qi 'lock timeout' /var/log/p2party-migration-failure.log" ||
    die "the deploy did not retain the migration marker and lock timeout diagnostic"
}

# The README's recovery commands (deploy/README.md, "A failed or interrupted
# migration", step 3), as written: on the signaling host, as p2party, from
# ~p2party/server, with DATABASE_URL exported as the play builds it. The URL
# reaches the guest in a root-only file and is never printed.
readme_prisma() {
  local password url_file="$WORK/tmp/db-url" out="$WORK/tmp/readme-prisma.txt" rc=0
  password="$(sed -n 's/^vault_postgres_password: "\(.*\)"$/\1/p' "$SECRETS/vault.plain.yml")"
  (
    umask 077
    printf 'postgresql://p2party:%s@10.231.0.2:5432/p2party?schema=public&sslmode=verify-full&sslrootcert=/etc/p2party/postgres-ca.crt' \
      "$password" >"$url_file"
  )
  guest_copy "$url_file" /tmp/rehearsal-db-url
  rm -f "$url_file"
  cat >"$WORK/tmp/readme-prisma.sh" <<'EOF'
chown p2party:p2party /tmp/rehearsal-db-url
chmod 0600 /tmp/rehearsal-db-url
sudo -u p2party -H bash -c 'cd ~/server && export DATABASE_URL="$(cat /tmp/rehearsal-db-url)" && ~/.bun/bin/bun migration-tooling/node_modules/prisma/build/index.js "$@"' readme "$@"
rc=$?
rm -f /tmp/rehearsal-db-url
exit $rc
EOF
  guest_copy "$WORK/tmp/readme-prisma.sh" /tmp/readme-prisma.sh
  guest_cmd "bash /tmp/readme-prisma.sh $*" >"$out" 2>&1 || rc=$?
  res_block "As the README says: \`~/.bun/bin/bun migration-tooling/node_modules/prisma/build/index.js $*\` (exit $rc):" "$out"
  return "$rc"
}

record_failure_log() {
  local out="$WORK/tmp/failure-log.txt"
  guest_cmd "if [ -e /var/log/p2party-migration-failure.log ]; then cat /var/log/p2party-migration-failure.log; else echo '(absent)'; fi" >"$out" 2>&1 || true
  res_block "\`sudo cat /var/log/p2party-migration-failure.log\` (step 1 of the README's recovery):" "$out"
}

# Step 3 of the README's recovery, then step 4.
readme_recover_and_rerun() {
  local tree="$1" logprefix="$2" names name rc=0
  names="$(guest_sql 'SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at;')" ||
    die "could not read the migration history"
  # Both scenarios interrupt a specific migration added in this release.
  # A missing or unexpected row means the rehearsal never exercised that case.
  [ "$names" = "$3" ] || die "expected unfinished migration $3 in the database"
  name="$3"
  res "- The migration history names \`$name\` as unfinished."
  readme_prisma migrate resolve --rolled-back "$name" || die "could not resolve $name"
  res ""
  res "### Step 4: run the deploy again"
  play_recorded "deploy.yml, second run" "$LOGS/$logprefix-second-run.log" "$tree" deploy.yml || rc=$?
  record_state "after the second run"
  if [ "$rc" -ne 0 ]; then
    record_failure_log
    die "the second deploy failed after the documented recovery"
  fi
}

# The start of every scenario: the baseline (0.1.4 serving, seeded), the tree
# under test, and the README paragraphs the scenario is checked against.
scenario_tree=""
scenario_start() {
  local name="$1" title="$2" pattern
  shift 2
  ensure_baseline
  result_open "$name" "$title"
  scenario_tree="$(prepare_tree "$COMMIT_SHA")"
  res ""
  res "## What deploy/README.md says about this case"
  for pattern in "$@"; do
    res ""
    readme_quote "$scenario_tree" "$pattern" >>"$RESULT"
  done
  res ""
  res "## The run"
}

README_DEPLOY_ORDER="prepares the release while the old one keeps serving"
README_BUN_CHECKS="On the control machine"
README_MIGRATION_FAILED="^When .prisma migrate deploy. fails or is interrupted"
README_RECOVERY_STEPS="^1\\. Read why it failed"
README_RECOVERY_RERUN="^4\\. Run .\\./deploy/deploy\\.sh. again"
README_MARKER="^From the moment a deploy stops the workers"
README_SCHEMA_CHECK="^The binary also checks the schema itself"

# (1) A Bun other than the pinned one on the operator's PATH: this machine's
# own Homebrew Bun.
mode_scenario_1() {
  local other="$WORK/other-bun" found rc=0
  scenario_start 11-scenario-1-operator-bun "Scenario 1: a Bun other than the pinned one on the operator's PATH" \
    "$README_BUN_CHECKS" "$README_DEPLOY_ORDER"
  host_bun_to_pin
  mkdir -p "$other"
  ln -sfn "${REHEARSAL_OTHER_BUN:-/opt/homebrew/bin/bun}" "$other/bun"
  found="$("$other/bun" --version 2>&1 || true)"
  res "- The operator's PATH starts with a Bun $found (\`${REHEARSAL_OTHER_BUN:-/opt/homebrew/bin/bun}\`); the pin is $PIN."
  fingerprint_before
  PLAY_BUN_DIR="$other" play_recorded "deploy.yml with that Bun first on PATH" "$LOGS/s1-deploy.log" "$scenario_tree" deploy.yml || rc=$?
  fingerprint_compare "refused by the local pre-flight"
  record_state "after the refused run (0.1.4 should still be serving)"
  res ""
  res "### The README's next step: the pinned Bun first on PATH, then the deploy again"
  rc=0
  play_recorded "deploy.yml with Bun $PIN first on PATH" "$LOGS/s1-second-run.log" "$scenario_tree" deploy.yml || rc=$?
  record_state "after the second run"
}

# (2) Another Bun on the host: the baseline's host Bun is 0.1.4's 1.3.14.
mode_scenario_2() {
  local found rc=0
  scenario_start 12-scenario-2-host-bun "Scenario 2: another Bun on the signaling host" \
    "$README_BUN_CHECKS" "^To install the pinned Bun on the signaling host" "$README_DEPLOY_ORDER"
  found="$(guest_cmd "sudo -u p2party /home/p2party/.bun/bin/bun --version" 2>&1 | tail -1)"
  res "- The host's Bun is $found (left as release 0.1.4 had it); the pin is $PIN. The README's pre-deploy check is skipped on purpose."
  fingerprint_before
  play_recorded "deploy.yml" "$LOGS/s2-deploy.log" "$scenario_tree" deploy.yml || rc=$?
  fingerprint_compare "refused by the host's Bun check"
  record_state "after the refused run (0.1.4 should still be serving)"
  res ""
  res "### The README's next step: install the pinned Bun on the host, then the deploy again"
  res "The printed command downloads the release zip from GitHub inside the host, which the rehearsal VM may not do; the same release is copied in instead (checksum-verified on the operator's side, tools.sha256)."
  guest_bun "$PIN"
  rc=0
  play_recorded "deploy.yml, second run" "$LOGS/s2-second-run.log" "$scenario_tree" deploy.yml || rc=$?
  record_state "after the second run"
}

# (3) A migration that fails before the re-key: an open transaction holds a
# lock that the first new migration (the PendingSignal index) needs.
mode_scenario_3() {
  scenario_start 05-scenario-3-migration-fails-before-rekey "Scenario 3: a migration that fails before the re-key" \
    "$README_MIGRATION_FAILED" "$README_RECOVERY_STEPS" "$README_MARKER" "$README_SCHEMA_CHECK"
  host_bun_to_pin
  lock_holder_start 'LOCK TABLE "PendingSignal" IN ROW EXCLUSIVE MODE;'
  deploy_with_blocked_migration "$LOGS/s3-deploy.log" "$scenario_tree" '%CREATE INDEX%'
  lock_holder_end
  record_state "after the failed migration"
  record_failure_log
  res ""
  res "### The README's recovery (the cause, the lock, is gone: step 2)"
  readme_recover_and_rerun "$scenario_tree" s3 20261126120000_pending_signal_created_at_index
  record_rows "after the recovery" || die "seeded rows failed validation after recovery"
  record_candidate_health "$scenario_tree"
}

# (4) A migration that fails after the re-key: an open transaction that has
# read "Peer" lets the re-key's UPDATE through and blocks the next
# migration's ALTER TABLE "Peer".
mode_scenario_4() {
  local rc=0 out="$WORK/tmp/s4-initial-setup.log"
  scenario_start 06-scenario-4-migration-fails-after-rekey "Scenario 4: a migration that fails after the re-key" \
    "$README_MIGRATION_FAILED" "$README_RECOVERY_STEPS" "$README_MARKER" "$README_SCHEMA_CHECK"
  host_bun_to_pin
  lock_holder_start 'SELECT count(*) FROM "Peer";'
  deploy_with_blocked_migration "$LOGS/s4-deploy.log" "$scenario_tree" '%ALTER TABLE%'
  lock_holder_end
  record_state "after the failed migration"
  record_rows "after the failed migration (the re-key applied, the claim-owner columns not)" || true
  record_failure_log
  res ""
  res "### The README: initial-setup.yml refuses to start a unit while the marker exists"
  rc=0
  play_recorded "initial-setup.yml" "$LOGS/s4-initial-setup.log" "$scenario_tree" initial-setup.yml || rc=$?
  record_state "after initial-setup.yml"
  res ""
  res "### The README's recovery (the lock is gone: step 2)"
  readme_recover_and_rerun "$scenario_tree" s4 20261127000100_routing_claim_owner
  record_rows "after the recovery" || die "seeded rows failed validation after recovery"
  record_candidate_health "$scenario_tree"
}

# (5) Staged validation must reject a short COTURN_SECRET before cutover.
mode_scenario_5() {
  local rc=0 previous_invocation current_invocation
  scenario_start 07-scenario-5-binary-will-not-start "Scenario 5: reject a bad staged environment before cutover" \
    "$README_DEPLOY_ORDER" "$README_SCHEMA_CHECK" "COTURN_SECRET"
  host_bun_to_pin
  res "- The deploy renders COTURN_SECRET from \`vault_coturn_auth_secret\`, given here as an extra variable of 21 bytes (\`too-short-turn-secret\`); the server refuses one under 32 bytes."
  previous_invocation="$(guest_cmd "systemctl show -p InvocationID --value p2party-signaling-3001.service")"
  [ -n "$previous_invocation" ] || die "could not identify the running baseline worker"
  play_recorded "deploy.yml with the short secret" "$LOGS/s5-deploy.log" "$scenario_tree" deploy.yml \
    -e vault_coturn_auth_secret=too-short-turn-secret || rc=$?
  [ "$rc" -ne 0 ] || die "deploy accepted an invalid staged environment"
  grep -qi 'COTURN_SECRET' "$LOGS/s5-deploy.log" || die "deploy did not identify the invalid TURN configuration"
  current_invocation="$(guest_cmd "systemctl show -p InvocationID --value p2party-signaling-3001.service")"
  [ "$previous_invocation" = "$current_invocation" ] || die "the old signaling worker restarted during staged validation"
  record_state "after rejection of the bad environment"
  guest_cmd "test ! -e /var/lib/p2party-migration-failed" || die "the invalid environment reached cutover"
  record_host_health 0.1.4 4
  res ""
  res "### Next step: the value fixed (the vault's own secret), the deploy again"
  rc=0
  play_recorded "deploy.yml, second run" "$LOGS/s5-second-run.log" "$scenario_tree" deploy.yml || rc=$?
  record_state "after the second run"
  [ "$rc" -eq 0 ] || die "deploy failed after correcting the environment"
  record_candidate_health "$scenario_tree"
}

# (6) A second run after a success.
mode_scenario_6() {
  local rc=0 before after
  # From the baseline: the upgrade first (the first success), then the run
  # under test. Only the baseline is ever kept as a snapshot.
  ensure_baseline
  result_open 09-scenario-6-second-run-after-success "Scenario 6: a second run after a success"
  scenario_tree="$(prepare_tree "$COMMIT_SHA")"
  host_bun_to_pin
  rc=0
  play_recorded "deploy.yml, the first run (the upgrade)" "$LOGS/s6-first-run.log" "$scenario_tree" deploy.yml || rc=$?
  [ "$rc" -eq 0 ] || die "the first deploy of scenario 6 failed (exit $rc)"
  res ""
  res "## What deploy/README.md says about this case"
  res ""
  readme_quote "$scenario_tree" "$README_DEPLOY_ORDER" >>"$RESULT"
  res ""
  readme_quote "$scenario_tree" "^With several signaling hosts" >>"$RESULT"
  res ""
  res "## The run"
  before="$(guest_cmd "systemctl show -p MainPID -p ActiveEnterTimestamp p2party-signaling-3001" | tr '\n' ' ')"
  res "- Before: the worker's $before"
  play_recorded "deploy.yml, run again on the upgraded host" "$LOGS/s6-deploy.log" "$scenario_tree" deploy.yml || rc=$?
  after="$(guest_cmd "systemctl show -p MainPID -p ActiveEnterTimestamp p2party-signaling-3001" | tr '\n' ' ')"
  res "- After: the worker's $after"
  record_state "after the second run"
  record_rows "after the second run" || true
}

# (8) --skip-build with an artefact that is not this commit's build:
#   a. release 0.1.4's binary, with no build record (0.1.4 writes none);
#   b. the same binary beside the build record of this commit's own build;
#   c. the binary and record of a deploy of another commit, deployed with
#      this commit's playbook.
mode_scenario_8() {
  local rc=0 builds tree014 other_sha other_tree record
  scenario_start 08-scenario-8-skip-build "Scenario 8: --skip-build with an artefact built from another commit" \
    "$README_BUN_CHECKS" "$README_DEPLOY_ORDER"
  host_bun_to_pin
  builds="$scenario_tree/deploy/ansible/builds"
  tree014="$(prepare_tree "$BASELINE_REV")"
  record="$WORK/tmp/build-record-${COMMIT_SHA:0:12}.json"
  if [ ! -f "$record" ]; then
    res "- No build record of this commit's own build is saved yet; building it once (\`bun run build:linux\` as deploy.yml's build step runs it, then the same record fields)."
  fi

  res ""
  res "### a. Release 0.1.4's binary, no build record"
  rm -f "$builds/p2party_linux_x64" "$builds/p2party_linux_x64.build.json"
  cp "$tree014/deploy/ansible/builds/p2party_linux_x64" "$builds/p2party_linux_x64"
  res "- \`deploy/ansible/builds/p2party_linux_x64\`: 0.1.4's binary, SHA-256 $(shasum -a 256 "$builds/p2party_linux_x64" | cut -c1-64); no \`.build.json\`."
  rc=0
  fingerprint_before
  play_recorded "deploy.yml -e skip_build=true" "$LOGS/s8a-deploy.log" "$scenario_tree" deploy.yml -e skip_build=true || rc=$?
  fingerprint_compare "with no build record"
  record_state "after 8a"

  res ""
  res "### b. The same binary beside a build record whose SHA-256 is another binary's"
  if [ -f "$record" ]; then
    cp "$record" "$builds/p2party_linux_x64.build.json"
    res "- \`p2party_linux_x64.build.json\`: the record this commit's own build wrote (in the upgrade run):"
    res_block "" "$builds/p2party_linux_x64.build.json"
    rc=0
    fingerprint_before
    play_recorded "deploy.yml -e skip_build=true" "$LOGS/s8b-deploy.log" "$scenario_tree" deploy.yml -e skip_build=true || rc=$?
    fingerprint_compare "with a record of another binary"
    record_state "after 8b"
  else
    res "- Not run: no saved build record of this commit (run the upgrade mode first)."
  fi

  res ""
  res "### Next step (scenario 7): deploy.sh without --skip-build"
  rm -f "$builds/p2party_linux_x64" "$builds/p2party_linux_x64.build.json"
  rc=0
  play_recorded "deploy.yml, second run (builds)" "$LOGS/s8-second-run.log" "$scenario_tree" deploy.yml || rc=$?
  record_state "after the second run"

  res ""
  res "### c. The binary and build record of a deploy of another commit"
  other_sha="$(git -C "$repo" rev-parse --verify "$OTHER_REV^{commit}")"
  if [ "$other_sha" = "$COMMIT_SHA" ]; then
    res "- Not run: the other commit is the commit under test."
  else
    other_tree="$(prepare_tree "$other_sha")"
    res "- First, \`${other_sha:0:12}\` ($(git -C "$repo" log -1 --format=%s "$other_sha")) deployed normally, which builds its binary and writes its record:"
    rc=0
    play_recorded "deploy.yml at ${other_sha:0:12}" "$LOGS/s8c-other-deploy.log" "$other_tree" deploy.yml || rc=$?
    cp "$other_tree/deploy/ansible/builds/p2party_linux_x64" "$other_tree/deploy/ansible/builds/p2party_linux_x64.build.json" "$builds/"
    res "- Then its binary and record copied into this commit's tree:"
    res_block "" "$builds/p2party_linux_x64.build.json"
    rc=0
    play_recorded "deploy.yml -e skip_build=true at ${COMMIT_SHA:0:12}" "$LOGS/s8c-deploy.log" "$scenario_tree" deploy.yml -e skip_build=true || rc=$?
    record_state "after 8c"
    rm -f "$builds/p2party_linux_x64" "$builds/p2party_linux_x64.build.json"
    rm -rf "$other_tree" "$other_tree.ready"
  fi
}

# A new host provisioned by the commit's own playbooks, as far as they run
# without a public address. Stand-ins as in the baseline, plus the TURN
# certificate (README, "What stands in for what"); the host's Bun is the pin,
# in place of the online installer initial-setup.yml runs when it is absent.
# coturn and Caddy both listen on 443 and production gives each its own host;
# on this one VM, site.yml runs without its coturn tag and setup-coturn.yml
# runs last, on its own.
mode_fresh() {
  local tree rc=0
  result_open 10-fresh-install "Fresh install: the commit's site.yml on a new VM, then deploy.yml and initial-setup.yml"
  vm_create
  tree="$(prepare_tree "$COMMIT_SHA")"
  apply_signaling_cloud_init "$tree"
  apply_standins
  guest_bun "$PIN"
  standin coturn-certificate "$TURN_NAME" "$STUN_NAME"
  res ""
  res "## site.yml"
  play_recorded "site.yml --skip-tags coturn" "$LOGS/fresh-site.log" "$tree" site.yml --skip-tags coturn || rc=$?
  record_state "after site.yml"
  [ "$rc" -eq 0 ] || die "fresh site.yml failed (exit $rc)"
  if guest_cmd "test -s /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt" >/dev/null 2>&1; then
    standin trust-caddy-ca
  else
    res "- Caddy has not created its local CA (it has not loaded the site), so deploy.yml's check through Caddy cannot pass certificate validation."
  fi
  res ""
  res "## deploy.yml"
  rc=0
  play_recorded "deploy.yml" "$LOGS/fresh-deploy.log" "$tree" deploy.yml || rc=$?
  record_state "after deploy.yml"
  [ "$rc" -eq 0 ] || die "fresh deploy.yml failed (exit $rc)"
  record_candidate_health "$tree"
  res ""
  res "## initial-setup.yml again, with a binary deployed"
  rc=0
  play_recorded "initial-setup.yml" "$LOGS/fresh-initial-setup.log" "$tree" initial-setup.yml || rc=$?
  record_state "after initial-setup.yml"
  [ "$rc" -eq 0 ] || die "fresh initial-setup.yml failed (exit $rc)"
  record_candidate_health "$tree"
  res ""
  res "## setup-coturn.yml"
  res "Caddy and coturn use port 443 on separate production hosts. Stop Caddy on the shared test VM while the TURN role is exercised."
  guest_cmd "systemctl stop caddy"
  rc=0
  play_recorded "setup-coturn.yml" "$LOGS/fresh-setup-coturn.log" "$tree" setup-coturn.yml || rc=$?
  guest_cmd "systemctl is-active coturn; ss -Hltnup | grep -E ':(443|3478) ' | awk '{print \$1, \$5, \$7}' | sort -u" >"$WORK/tmp/coturn.txt" 2>&1 || true
  res_block "coturn after setup-coturn.yml (unit state; listeners on 443 and 3478):" "$WORK/tmp/coturn.txt"
  [ "$rc" -eq 0 ] || die "fresh setup-coturn.yml failed (exit $rc)"
  guest_cmd "systemctl is-active --quiet coturn && ss -Hltnp 'sport = :443' | grep -q turnserver && ss -Hlunp 'sport = :3478' | grep -q turnserver" ||
    die "coturn did not start with TLS and STUN listeners"
  guest_cmd "systemctl stop coturn && systemctl start caddy"
  record_candidate_health "$tree"
  record_host after-fresh
}

# A new instance from lima.yaml and no playbook: what the host listens on
# once it runs (TCP and UDP), the watch, and Ansible through the SSH guard (a
# ping, a copy, which goes over sftp, and connections the guard refuses).
mode_vm_check() {
  local out="$WORK/tmp/vm-check.txt" rc=0 seconds
  vm_create
  result_open 00-vm-check "VM check: the template's forwarding, the watch and the SSH guard on this host" no-commit
  res_block "Host sockets before the instance was created (TCP listeners, unconnected UDP sockets):" "$WORK/host/before-create-listen.txt"
  res_block "Host sockets after its first start:" "$WORK/host/after-first-start-listen.txt"
  diff "$WORK/host/before-create-listen.txt" "$WORK/host/after-first-start-listen.txt" >"$out" || true
  res_block "The difference (lines starting with > are new):" "$out"
  {
    lsof -nP -a -c limactl -iTCP -sTCP:LISTEN 2>/dev/null || true
    lsof -nP -a -c limactl -iUDP 2>/dev/null || true
  } >"$out"
  res_block "Every TCP listener and UDP socket of limactl:" "$out"
  res "- The watch is running (pid $WATCH_PID, a pass every $WATCH_PERIOD s); its last heartbeat: $(cat "$WORK/watch-heartbeat")."

  guest_cmd "install -d -m 0700 -o p2party -g p2party /home/p2party/.ssh && cat >>/home/p2party/.ssh/authorized_keys && chown p2party:p2party /home/p2party/.ssh/authorized_keys" \
    <"$SECRETS/id_ed25519.pub"
  check_resolved_inventory
  res "- ansible-inventory resolves every host of inventory.yml to 127.0.0.1:$SSH_PORT."
  rc=0
  ansible_in "$SCRIPT_DIR" ansible -i "$inventory" p2party-signaling -m ansible.builtin.ping >"$out" 2>&1 || rc=$?
  res_block "\`ansible -m ping\`, through play-env.sh and the SSH guard (exit $rc):" "$out"
  [ "$rc" -eq 0 ] || die "unexpected ping result (exit $rc)"
  rc=0
  ansible_in "$SCRIPT_DIR" ansible -i "$inventory" p2party-signaling -m ansible.builtin.copy \
    -a "content=checked dest=/tmp/p2party-rehearsal-guard-check mode=0600" >"$out" 2>&1 || rc=$?
  res_block "\`ansible -m copy\` (a file transfer over sftp; exit $rc):" "$out"
  [ "$rc" -eq 0 ] || die "unexpected copy result (exit $rc)"
  rc=0
  ansible_in "$SCRIPT_DIR" ssh -F /dev/null -o Port=22 127.0.0.1 true >"$out" 2>&1 || rc=$?
  res_block "ssh to 127.0.0.1 port 22 from the same environment (exit $rc):" "$out"
  [ "$rc" -ne 0 ] || die "unexpected SSH port check result (exit $rc)"
  rc=0
  ansible_in "$SCRIPT_DIR" ssh -F /dev/null -o Port="$SSH_PORT" -o ProxyJump=jump.example.invalid 127.0.0.1 true >"$out" 2>&1 || rc=$?
  res_block "ssh with a ProxyJump from the same environment (exit $rc):" "$out"
  [ "$rc" -ne 0 ] || die "unexpected SSH route check result (exit $rc)"
  cp "$LOGS/ssh-guard.log" "$out" 2>/dev/null || : >"$out"
  res_block "The SSH guard's log:" "$out"

  seconds=0
  while [ "$seconds" -lt "$hold" ]; do
    watch_check
    sleep 5
    seconds=$((seconds + 5))
  done
  record_host before-delete
  res_block "Host sockets just before the instance is deleted:" "$WORK/host/before-delete-listen.txt"
  result_close
}

# Everything but the sanitized results: the instance, the snapshot and its
# secrets, the trees, the package cache, the raw logs.
mode_clean() {
  [ -f "$WORK/$WORK_MARKER" ] || refuse "$WORK has no $WORK_MARKER; run.sh deletes nothing there"
  vm_delete
  local item
  for item in snapshots trees cache raw logs tmp host rendered home ansible guard-bin; do
    rm -rf "${WORK:?}/$item"
  done
  rm -f "$WORK/watch-heartbeat" "$WORK/watch-tripped"
  log "deleted the instance, the snapshot and its secrets, the trees, the package cache and the raw logs"
}

# Everything run.sh made: also the results, the work directory, and the image
# in Lima's cache when run.sh's own create downloaded it (recorded at the
# time). Other cached images are left alone.
mode_clean_all() {
  local url entry
  mode_clean
  if [ -f "$WORK/lima-image-downloaded-by-run.sh" ]; then
    url="$(cat "$WORK/lima-image-downloaded-by-run.sh")"
    for entry in "$LIMA_CACHE"/download/by-url-sha256/*; do
      if [ -f "$entry/url" ] && [ "$(cat "$entry/url")" = "$url" ]; then
        log "removing $entry from Lima's cache ($url)"
        rm -rf "${entry:?}"
      fi
    done
  fi
  [ -f "$WORK/$WORK_MARKER" ] || refuse "$WORK has no $WORK_MARKER; run.sh deletes nothing there"
  rm -rf "${WORK:?}"
  log "deleted $WORK"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

case "$mode" in
  clean | clean-all)
    "mode_${mode//-/_}"
    exit 0
    ;;
esac

if [ "$mode" != vm-check ]; then
  COMMIT_SHA="$(git -C "$repo" rev-parse --verify "$commit^{commit}")" || refuse "$commit is not a commit in $repo"
  COMMIT_SUBJECT="$(git -C "$repo" log -1 --format=%s "$COMMIT_SHA")"
  git -C "$repo" rev-parse --verify -q "$BASELINE_REV^{commit}" >/dev/null || refuse "--baseline-commit $BASELINE_REV is not a commit in $repo"
  git -C "$repo" rev-parse --verify -q "$OTHER_REV^{commit}" >/dev/null || refuse "--other-commit $OTHER_REV is not a commit in $repo"
  PIN="$(git -C "$repo" show "$COMMIT_SHA:package.json" | sed -n 's/.*"packageManager": "bun@\([0-9.]*\)".*/\1/p')"
  [ -x "$TOOLS/bun-$PIN/bun" ] || refuse "no Bun $PIN for macOS at $TOOLS/bun-$PIN/bun (the commit under test pins it)"
  [ -x "$TOOLS/bun-linux-x64-$PIN/bun" ] || refuse "no Bun $PIN for Linux x64 (the build's cross-compile runtime) at $TOOLS/bun-linux-x64-$PIN/bun"
  [ -x "$TOOLS/bun-linux-aarch64-$PIN/bun" ] || refuse "no Bun $PIN for Linux aarch64 (the host's Bun) at $TOOLS/bun-linux-aarch64-$PIN/bun"
  # The build's cross-compile target, from the verified copy rather than a
  # download (bun build --compile looks for it under this name).
  cp -c -n "$TOOLS/bun-linux-x64-$PIN/bun" "$CACHE/bun/bun-linux-x64-v$PIN" 2>/dev/null || true
  log "commit under test: ${COMMIT_SHA:0:12} ($COMMIT_SUBJECT); work directory $WORK"
fi
mkdir -p "$CONTROL_DIR"
chmod 0700 "$CONTROL_DIR"
watch_start

case "$mode" in
  vm-check) mode_vm_check ;;
  baseline) mode_baseline ;;
  upgrade) mode_upgrade ;;
  scenario-*) "mode_scenario_${mode#scenario-}" ;;
  fresh) mode_fresh ;;
esac
