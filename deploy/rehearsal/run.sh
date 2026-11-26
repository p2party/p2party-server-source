#!/usr/bin/env bash
# ============================================================================
# p2party release rehearsal
# ============================================================================
# Runs the production playbooks against one local Lima VM, p2party-rehearsal,
# reached only on 127.0.0.1 (deploy/rehearsal/README.md).
#
#   run.sh [--inventory PATH] [--repo DIR] [--commit REV] [--keep] MODE
#
#   check      check the inventory and stop (contacts nothing)
#   baseline   a new VM brought to production's state: the signaling host's
#              cloud-init, then release 0.1.4 installed by its own playbooks
#              from a `git archive` of ecf691a, rows in every table; saved
#              as the snapshot every other mode starts from
#   upgrade    from the baseline, the commit under test deployed over 0.1.4
#   scenario-1 ... scenario-8
#              the fault scenarios of deploy/rehearsal/README.md, each from
#              the baseline (scenario-6 from the upgrade); each ends with the
#              README's next step and a second run (scenario 7)
#   fresh      a new VM provisioned by the commit's own site.yml (with
#              install-postgres, setup-coturn and initial-setup), then
#              deploy.yml, then initial-setup.yml again
#   clean      delete the instance, the snapshots and the work trees
#
# --commit names the commit under test (default: the repository's HEAD);
# --keep leaves the instance running at the end instead of deleting it.
#
# Environment: REHEARSAL_REPO (or --repo) the repository to archive from;
# REHEARSAL_TOOLS the tool directory (README, "Tools"); REHEARSAL_WORK_DIR
# (default $TMPDIR/p2party-rehearsal) for trees, secrets, snapshots, logs and
# results, outside any repository; LIMACTL (default /opt/homebrew/bin/limactl).
#
# Before anything else, every mode refuses an inventory other than this
# directory's tracked inventory.yml (the production inventory path is refused
# by name, without being opened) and an inventory with any host that is not
# 127.0.0.1 on the instance's SSH port (inventory-check.ts).
# ============================================================================
set -euo pipefail

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
keep=false
mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    --inventory) [ $# -ge 2 ] || die "--inventory needs a path"; inventory="$2"; shift 2 ;;
    --inventory=*) inventory="${1#*=}"; shift ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a directory"; repo="$2"; shift 2 ;;
    --repo=*) repo="${1#*=}"; shift ;;
    --commit) [ $# -ge 2 ] || die "--commit needs a revision"; commit="$2"; shift 2 ;;
    --commit=*) commit="${1#*=}"; shift ;;
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
# 1. The inventory, before anything else
# ---------------------------------------------------------------------------
# By name first, so that the production inventory is refused without being
# opened, read or even stat'ed through a link.
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

command -v bun >/dev/null 2>&1 || die "bun is not on PATH (it runs the inventory check)"
# Exits 2 with one "refusing to start" line per problem.
inventory_summary="$(bun "$SCRIPT_DIR/inventory-check.ts" "$inventory" "$SCRIPT_DIR/lima.yaml")"

# The repository the rehearsal archives from. When it is known, the inventory
# must be the one committed at its HEAD, byte for byte.
if [ -z "$repo" ] && git -C "$SCRIPT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  repo="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
fi
if [ -n "$repo" ]; then
  repo="$(builtin cd -- "$repo" 2>/dev/null && pwd -P)" || refuse "--repo $repo is not a directory"
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null || refuse "$repo is not a git repository"
  git -C "$repo" cat-file -p HEAD:deploy/rehearsal/inventory.yml 2>/dev/null | cmp -s - "$inventory" ||
    refuse "$inventory differs from deploy/rehearsal/inventory.yml at $repo's HEAD (or is not tracked there)"
fi

echo "$inventory_summary"
if [ "$mode" = check ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. The repository, the tools and the work directory
# ---------------------------------------------------------------------------
case "$mode" in
  baseline | upgrade | scenario-[1234568] | fresh | clean) ;;
  *) die "unknown mode $mode (see --help)" ;;
esac
[ -n "$repo" ] || refuse "no repository: give --repo DIR or set REHEARSAL_REPO (the commit under test is archived from it)"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || refuse "this rehearsal is written for an Apple Silicon Mac (lima.yaml: vz, aarch64)"

LIMACTL="${LIMACTL:-/opt/homebrew/bin/limactl}"
LIMA_HOME="${LIMA_HOME:-$HOME/.lima}"
INSTANCE_DIR="$LIMA_HOME/$INSTANCE"
[ -x "$LIMACTL" ] || refuse "no limactl at $LIMACTL"

WORK="${REHEARSAL_WORK_DIR:-${TMPDIR:-/tmp}/p2party-rehearsal}"
mkdir -p "$WORK"
WORK="$(builtin cd -- "$WORK" && pwd -P)"
case "$WORK/" in
  "$repo"/*) refuse "the work directory $WORK is inside the repository; put it outside (REHEARSAL_WORK_DIR)" ;;
esac
SECRETS="$WORK/secrets"
TREES="$WORK/trees"
SNAPSHOTS="$WORK/snapshots"
LOGS="$WORK/logs"
RAW="$WORK/raw"
RESULTS="${REHEARSAL_RESULTS_DIR:-$WORK/results}"
CACHE="$WORK/cache"
mkdir -p "$TREES" "$SNAPSHOTS" "$LOGS" "$RAW" "$RESULTS" "$CACHE/bun" "$WORK/tmp" "$WORK/host" \
  "$WORK/ansible/home" "$WORK/ansible/tmp" "$WORK/rendered"

RELEASE_014=ecf691a
SSH_PORT="$(awk '/^ssh:/ { s = 1 } s && /localPort:/ { print $2; exit }' "$SCRIPT_DIR/lima.yaml")"
SIGNALING_HOST_PORT=56443
SIGNALING_NAME="$(awk '/^domains:/ { d = 1 } d && /signaling:/ { print $2; exit }' "$SCRIPT_DIR/vars.yml")"
TURN_NAME="$(awk '/^domains:/ { d = 1 } d && /turn:/ { print $2; exit }' "$SCRIPT_DIR/vars.yml")"
STUN_NAME="$(awk '/^domains:/ { d = 1 } d && /stun:/ { print $2; exit }' "$SCRIPT_DIR/vars.yml")"
# Free space on the host's volume: needed to create or start the instance,
# and the level below which the instance is deleted at once.
START_MIN_FREE_GIB="${REHEARSAL_START_MIN_FREE_GIB:-15}"
ABORT_FREE_GIB="${REHEARSAL_ABORT_FREE_GIB:-8}"

# Ansible's SSH control socket is <dir>/<40-character hash>, and a Unix socket
# path is limited to 104 bytes on macOS.
CONTROL_DIR="${REHEARSAL_CONTROL_DIR:-${TMPDIR:-/tmp}}"
CONTROL_DIR="${CONTROL_DIR%/}/p2r"
mkdir -p "$CONTROL_DIR"
chmod 0700 "$CONTROL_DIR"
[ $((${#CONTROL_DIR} + 41)) -lt 104 ] || refuse "the SSH control directory $CONTROL_DIR is too long for a socket path; set REHEARSAL_CONTROL_DIR"

log() { printf '[run.sh %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

if [ "$mode" != clean ]; then
  TOOLS="${REHEARSAL_TOOLS:-}"
  [ -n "$TOOLS" ] && [ -d "$TOOLS" ] || refuse "REHEARSAL_TOOLS is not a directory (README, \"Tools\")"
  TOOLS="$(builtin cd -- "$TOOLS" && pwd -P)"
  (builtin cd "$TOOLS" && shasum -a 256 -c --quiet "$SCRIPT_DIR/tools.sha256") ||
    refuse "a tool in $TOOLS does not match $SCRIPT_DIR/tools.sha256"
  ansible_version="$("$TOOLS/venv/bin/ansible-playbook" --version | awk 'NR == 1 { gsub(/[^0-9.]/, "", $3); print $3 }')"
  [ "$ansible_version" = 2.22.0 ] || refuse "$TOOLS/venv has ansible-core $ansible_version, not 2.22.0"
  grep -q '"version": "5.1.1"' "$TOOLS/collections/ansible_collections/community/postgresql/MANIFEST.json" ||
    refuse "$TOOLS/collections has no community.postgresql 5.1.1"
fi

# ---------------------------------------------------------------------------
# Host-side helpers
# ---------------------------------------------------------------------------
host_free_gib() { df -k "$WORK" | awk 'NR == 2 { print int($4 / 1048576) }'; }

# What the host looks like at a point of the run: TCP listeners, free disk
# space and the Lima instances.
record_host() {
  local label="$1"
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $1, $2, $9 }' | sort -u >"$WORK/host/$label-listen.txt" || true
  df -h "$WORK" >"$WORK/host/$label-df.txt"
  "$LIMACTL" list 2>&1 >"$WORK/host/$label-limactl.txt" | grep -v 'No instance found' || true
  log "host at $label: $(host_free_gib) GiB free, $(wc -l <"$WORK/host/$label-listen.txt" | tr -d ' ') TCP listeners"
}

# Before every create or start of the instance.
require_free_disk() {
  local free
  free="$(host_free_gib)"
  [ "$free" -ge "$START_MIN_FREE_GIB" ] ||
    die "only $free GiB free on the host; the instance is created or started only with at least $START_MIN_FREE_GIB GiB free"
}

# While the instance exists: below ABORT_FREE_GIB, the instance is stopped
# and deleted at once, from a background loop so that a long playbook run
# cannot outlast it. The snapshots are kept.
DISK_GUARD_PID=""
# The same loop also stops and deletes the instance if Lima listens on any
# host port below 5000 (lima.yaml's rules should make that impossible).
lima_low_ports() {
  lsof -nP -a -c limactl -iTCP -sTCP:LISTEN 2>/dev/null |
    awk 'NR > 1 { n = split($9, a, ":"); if (a[n] + 0 < 5000) print $9 }'
}
disk_guard_start() {
  (
    while :; do
      free="$(host_free_gib)"
      low="$(lima_low_ports | tr '\n' ' ')"
      if [ "$free" -lt "$ABORT_FREE_GIB" ] || [ -n "$low" ]; then
        printf '%s: %s GiB free (floor %s); Lima listening below 5000: [%s]: stopping and deleting %s\n' \
          "$(date -u +%H:%M:%S)" "$free" "$ABORT_FREE_GIB" "$low" "$INSTANCE" | tee "$WORK/disk-guard-tripped"
        "$LIMACTL" stop --force "$INSTANCE" || true
        "$LIMACTL" delete --force "$INSTANCE" || true
        exit 0
      fi
      sleep 10
    done
  ) >>"$LOGS/disk-guard.log" 2>&1 &
  DISK_GUARD_PID=$!
  disown "$DISK_GUARD_PID"
}
disk_guard_stop() {
  if [ -n "$DISK_GUARD_PID" ]; then
    kill "$DISK_GUARD_PID" 2>/dev/null || true
    DISK_GUARD_PID=""
  fi
  if [ -f "$WORK/disk-guard-tripped" ]; then
    log "the disk guard deleted the instance: $(cat "$WORK/disk-guard-tripped")"
  fi
}

ensure_secrets() {
  mkdir -p "$SECRETS"
  chmod 0700 "$SECRETS"
  (
    umask 077
    builtin cd "$SECRETS"
    [ -f id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C p2party-rehearsal -f id_ed25519
    [ -f vault-pass ] || openssl rand -hex 32 >vault-pass
    if [ ! -f vault.plain.yml ]; then
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
    fi
    if [ ! -f vault.yml ]; then
      "$TOOLS/venv/bin/ansible-vault" encrypt --vault-password-file vault-pass \
        --output vault.yml vault.plain.yml >/dev/null
    fi
    touch known_hosts
  )
}

# Every value a result file must never contain.
secret_values() {
  cat "$SECRETS/vault-pass"
  sed -n 's/^vault_[a-z_]*: "\([0-9a-f]\{16,\}\)"$/\1/p' "$SECRETS/vault.plain.yml"
}

# Result files are written without secrets and without this machine's paths.
sanitize() {
  local args=() value
  while IFS= read -r value; do
    [ "${#value}" -ge 16 ] && args+=(-e "s/$value/<redacted>/g")
  done < <(secret_values)
  args+=(-e "s#$WORK#<work>#g" -e "s#${WORK#/private}#<work>#g")
  [ -n "${TOOLS:-}" ] && args+=(-e "s#$TOOLS#<tools>#g" -e "s#${TOOLS#/private}#<tools>#g")
  args+=(-e "s#$repo#<repo>#g" -e "s#$CONTROL_DIR#<control-dir>#g" -e "s#$HOME#~#g")
  sed "${args[@]}" | perl -pe 's/\e\[[0-9;]*[A-Za-z]//g'
}

# ---------------------------------------------------------------------------
# Result files
# ---------------------------------------------------------------------------
# One markdown file per mode: what ran, against which commit, the playbook
# output verbatim, the README paragraph it is checked against, and the state
# of the machine afterwards. Written raw under $RAW and sanitized into
# $RESULTS/<date>/ at the end.
RESULT=""
RESULT_NAME=""
result_open() {
  RESULT_NAME="$1"
  RESULT="$RAW/$RESULT_NAME.md"
  {
    printf '# %s\n\n' "$2"
    printf -- '- Commit under test: `%s` (%s)\n' "${COMMIT_SHA:-none}" "${COMMIT_SUBJECT:-}"
    printf -- '- Release before it: `%s` (0.1.4, `master`)\n' "$(git -C "$repo" rev-parse --short=12 "$RELEASE_014")"
    printf -- '- Harness: `deploy/rehearsal/run.sh %s` from the tree at `%s`\n' "$mode" "$(git -C "$repo" rev-parse --short=12 HEAD)"
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
# The vault is a link to this run's generated one, at the path the
# playbooks' vars_files name. Prints the tree's path.
prepare_tree() {
  local rev="$1" flavour="${2:-git}" sha dir
  sha="$(git -C "$repo" rev-parse --verify "$rev^{commit}")"
  dir="$TREES/${sha:0:12}"
  if [ ! -f "$dir.ready" ]; then
    log "preparing a tree of ${sha:0:12}"
    rm -rf "$dir"
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
      rm -rf "$plain/.git"
    fi
    dir="$plain"
  fi
  printf '%s\n' "$dir"
}

# The Bun a tree's package.json pins, for building it. Release 0.1.4 pins
# 1.3.14, of which the rehearsal has no macOS build: it is built with the
# Bun of the commit under test (README, "What stands in for what").
tree_bun_pin() {
  local pin
  pin="$(sed -n 's/.*"packageManager": "bun@\([0-9.]*\)".*/\1/p' "$1/package.json")"
  if [ -x "$TOOLS/bun-$pin/bun" ]; then printf '%s\n' "$pin"; else printf '%s\n' "$PIN"; fi
}

# ansible-playbook from a tree, with the rehearsal's inventory, variables,
# vault and configuration, and nothing of this machine's own Ansible or SSH
# setup. PLAY_PATH_PREFIX goes first on PATH (default: the pinned Bun).
run_play() {
  local logfile="$1" tree="$2" playbook="$3" rc
  shift 3
  log "ansible-playbook $playbook (tree ${tree##*/}) -> ${logfile##*/}"
  set +e
  (
    builtin cd "$tree/deploy/ansible" &&
      env -i HOME="$HOME" USER="${USER:-rehearsal}" LANG=C.UTF-8 LC_ALL=C.UTF-8 TMPDIR="$WORK/tmp" \
        PATH="${PLAY_PATH_PREFIX:-$TOOLS/bun-$PIN}:$TOOLS/venv/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
        ANSIBLE_CONFIG="$SCRIPT_DIR/ansible.cfg" ANSIBLE_HOME="$WORK/ansible/home" \
        ANSIBLE_LOCAL_TEMP="$WORK/ansible/tmp" ANSIBLE_SSH_CONTROL_PATH_DIR="$CONTROL_DIR" \
        ANSIBLE_COLLECTIONS_PATH="$TOOLS/collections" ANSIBLE_PRIVATE_KEY_FILE="$SECRETS/id_ed25519" \
        ANSIBLE_SSH_COMMON_ARGS="-o UserKnownHostsFile=$SECRETS/known_hosts -o StrictHostKeyChecking=accept-new" \
        ANSIBLE_NOCOLOR=1 ANSIBLE_FORCE_COLOR=0 \
        BUN_INSTALL_CACHE_DIR="$CACHE/bun" CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
        ansible-playbook -i "$inventory" "playbooks/$playbook" \
        -e "@$SCRIPT_DIR/vars.yml" --vault-password-file "$SECRETS/vault-pass" "$@"
  ) >"$logfile" 2>&1
  rc=$?
  set -e
  log "ansible-playbook $playbook exited $rc"
  return "$rc"
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
  log "starting $INSTANCE"
  "$LIMACTL" start --tty=false --timeout=30m "$INSTANCE" >>"$LOGS/limactl.log" 2>&1 ||
    die "limactl start failed ($LOGS/limactl.log)"
  # cloud-init gives the guest new SSH host keys on every Lima start.
  ssh-keygen -q -R "[127.0.0.1]:$SSH_PORT" -f "$SECRETS/known_hosts" >/dev/null 2>&1 || true
}

vm_stop() {
  if vm_exists && [ "$(vm_status)" = Running ]; then
    log "stopping $INSTANCE"
    "$LIMACTL" stop "$INSTANCE" >>"$LOGS/limactl.log" 2>&1
    # The host agent's log names every port it forwarded or ignored.
    cp "$INSTANCE_DIR/ha.stderr.log" "$LOGS/ha-$(date -u +%Y%m%dT%H%M%S).log" 2>/dev/null || true
  fi
}

vm_delete() {
  if vm_exists; then
    vm_stop || true
    log "deleting $INSTANCE"
    "$LIMACTL" delete --force "$INSTANCE" >>"$LOGS/limactl.log" 2>&1
  fi
}

# A new instance from lima.yaml. Lima merges $LIMA_HOME/_config/default.yaml,
# override.yaml and base.yaml into every instance, which could add mounts or
# port forwards, so their presence is refused.
vm_create() {
  local file
  for file in default.yaml override.yaml base.yaml; do
    [ ! -e "$LIMA_HOME/_config/$file" ] || refuse "$LIMA_HOME/_config/$file exists and would change the instance"
  done
  if vm_exists; then
    log "$INSTANCE exists from an earlier run; it is replaced"
    vm_delete
  fi
  for port in "$SSH_PORT" "$SIGNALING_HOST_PORT"; do
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || refuse "host port $port is in use"
  done
  require_free_disk
  record_host before-create
  log "creating $INSTANCE from lima.yaml"
  "$LIMACTL" create --name="$INSTANCE" --tty=false "$SCRIPT_DIR/lima.yaml" >>"$LOGS/limactl.log" 2>&1 ||
    die "limactl create failed ($LOGS/limactl.log)"
  vm_start
  record_host after-first-start
}

# The instance's disk and firmware state, copied as APFS clones (no space is
# used until the instance's copy diverges). A snapshot also outlives the
# instance: restoring creates the instance again and puts the files back.
SNAPSHOT_FILES=(diffdisk vz-efi vz-identifier)
snapshot_save() {
  local name="$1" file
  vm_stop
  rm -rf "${SNAPSHOTS:?}/$name"
  mkdir -p "$SNAPSHOTS/$name"
  for file in "${SNAPSHOT_FILES[@]}"; do
    [ -e "$INSTANCE_DIR/$file" ] && cp -c "$INSTANCE_DIR/$file" "$SNAPSHOTS/$name/$file"
  done
  log "snapshot $name saved"
}

snapshot_restore() {
  local name="$1" file
  [ -d "$SNAPSHOTS/$name" ] || die "no snapshot $name"
  if vm_exists; then
    vm_stop
  else
    "$LIMACTL" create --name="$INSTANCE" --tty=false "$SCRIPT_DIR/lima.yaml" >>"$LOGS/limactl.log" 2>&1
  fi
  for file in "${SNAPSHOT_FILES[@]}"; do
    if [ -e "$SNAPSHOTS/$name/$file" ]; then
      rm -f "$INSTANCE_DIR/$file"
      cp -c "$SNAPSHOTS/$name/$file" "$INSTANCE_DIR/$file"
    fi
  done
  log "snapshot $name restored"
  vm_start
}

cleanup() {
  local rc=$?
  result_close || true
  disk_guard_stop
  if ! $keep && [ "$mode" != clean ]; then
    vm_delete || true
    record_host after-delete || true
  fi
  exit "$rc"
}

# Guest commands as root, over Lima's own channel (not the rehearsal key).
guest_cmd() { "$LIMACTL" shell --workdir / "$INSTANCE" sudo bash -c "$1"; }
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
  guest_cmd "sudo -u postgres psql -X -q -A -t -d p2party -f /tmp/dump.sql" >"$dump"
  bun "$SCRIPT_DIR/seed.ts" check "$dump" >"$out" 2>&1 || rc=$?
  res_block "Seeded rows against the migration's intent $1 (exit $rc):" "$out"
  return "$rc"
}

# Health from the host, through the one forwarded port, with the guest's
# Caddy CA: what Task Z1's end-to-end run would reach.
record_host_health() {
  local ca="$WORK/tmp/caddy-local-ca.crt" out="$WORK/tmp/host-health.txt"
  guest_cmd "cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt" >"$ca" 2>/dev/null || true
  curl -s -m 10 --cacert "$ca" --resolve "$SIGNALING_NAME:$SIGNALING_HOST_PORT:127.0.0.1" \
    "https://$SIGNALING_NAME:$SIGNALING_HOST_PORT/health" >"$out" 2>&1 || echo "(no answer: curl exit $?)" >>"$out"
  echo >>"$out"
  res_block "From the host, https://$SIGNALING_NAME:$SIGNALING_HOST_PORT/health (127.0.0.1, the guest's Caddy CA):" "$out"
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
# Release 0.1.4, as production runs it, from a `git archive` of ecf691a with
# that tree's own playbooks, in the order its deploy/README.md gives
# (install-postgres, initial-setup, deploy), then rows in every table.
mode_baseline() {
  local tree014 rc
  result_open 01-baseline-0.1.4 "Baseline: release 0.1.4 installed by its own playbooks"
  vm_create
  tree014="$(prepare_tree "$RELEASE_014")"
  res ""
  res "Release 0.1.4's tree: \`git archive $RELEASE_014\`; its package.json pins Bun $(sed -n 's/.*"packageManager": "bun@\([0-9.]*\)".*/\1/p' "$tree014/package.json"); it is built with Bun $(tree_bun_pin "$tree014")."
  apply_signaling_cloud_init "$tree014"
  apply_standins
  guest_bun 1.3.14
  rc=0
  play_recorded "install-postgres.yml at $RELEASE_014" "$LOGS/014-install-postgres.log" "$tree014" install-postgres.yml || rc=$?
  [ "$rc" -eq 0 ] || die "release 0.1.4's install-postgres.yml failed"
  rc=0
  play_recorded "initial-setup.yml at $RELEASE_014" "$LOGS/014-initial-setup.log" "$tree014" initial-setup.yml || rc=$?
  standin trust-caddy-ca
  rc=0
  PLAY_PATH_PREFIX="$TOOLS/bun-$(tree_bun_pin "$tree014")" \
    play_recorded "deploy.yml at $RELEASE_014 (builds 0.1.4)" "$LOGS/014-deploy.log" "$tree014" deploy.yml || rc=$?
  [ "$rc" -eq 0 ] || die "release 0.1.4's deploy.yml failed"
  record_host_health
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
  if [ -d "$SNAPSHOTS/baseline" ]; then
    snapshot_restore baseline
  else
    mode_baseline
    snapshot_restore baseline
  fi
  guest_install_helpers
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

  res ""
  res "## 2. From the archive with the commit's git metadata"
  rc=0
  play_recorded "deploy.yml" "$LOGS/upgrade-deploy.log" "$tree" deploy.yml || rc=$?
  record_state "after the upgrade"
  record_rows "after the upgrade" || true
  record_host_health
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
  snapshot_save upgraded
  result_close
  [ "$rc" -eq 0 ] || die "the upgrade's deploy.yml failed (exit $rc)"
}

# ---------------------------------------------------------------------------
# Scenario helpers
# ---------------------------------------------------------------------------
# SQL in the guest's database as the postgres user, from stdin.
guest_sql() {
  printf '%s\n' "$1" | "$LIMACTL" shell --workdir / "$INSTANCE" sudo -u postgres psql -X -q -A -t -d p2party
}

# A session that holds a lock in an open transaction, detached in the guest,
# until lock_holder_end. $1 is the statement that takes the lock.
lock_holder_start() {
  printf 'BEGIN;\n%s\nSELECT pg_sleep(900);\n' "$1" >"$WORK/tmp/lock-holder.sql"
  guest_copy "$WORK/tmp/lock-holder.sql" /tmp/lock-holder.sql
  guest_cmd "chmod 0644 /tmp/lock-holder.sql && setsid -f bash -c 'sudo -u postgres psql -X -q -d p2party -f /tmp/lock-holder.sql >/tmp/lock-holder.log 2>&1'"
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
  while [ "$SECONDS" -lt "$deadline" ]; do
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

# A blocked migration, observed and then ended: deploy.yml runs in the
# background; once its migration waits on the holder's lock, the wait is
# observed for $3 seconds (longer than any 60-second bound), then the waiting
# backend is terminated, which fails the migration.
deploy_with_blocked_migration() {
  local logfile="$1" tree="$2" observe="$3" pattern="$4" play_pid pid rc=0
  shift 4
  run_play "$logfile" "$tree" deploy.yml "$@" &
  play_pid=$!
  if pid="$(wait_for_lock_wait "$pattern" 900)"; then
    res "- The migration's statement waits on the lock: $(backend_line "$pid")"
    sleep "$observe"
    res "- ${observe} s later it still waits (nothing in the migration path sets a statement or lock timeout): $(backend_line "$pid")"
    res "- Terminated the waiting backend: $(guest_sql "SELECT pg_terminate_backend($pid);")"
  else
    res "- No migration statement matching \`$pattern\` waited on a lock within 900 s."
  fi
  wait "$play_pid" || rc=$?
  res_block "deploy.yml (exit $rc):" "$logfile"
  return "$rc"
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

# The failed migration named by `migrate status`, if any.
failed_migration_name() {
  sed -n 's/^The `\([0-9a-z_]*\)` migration started at .* failed$/\1/p' "$WORK/tmp/readme-prisma.txt" | head -1
}

record_failure_log() {
  local out="$WORK/tmp/failure-log.txt"
  guest_cmd "if [ -e /var/log/p2party-migration-failure.log ]; then cat /var/log/p2party-migration-failure.log; else echo '(absent)'; fi" >"$out" 2>&1 || true
  res_block "\`sudo cat /var/log/p2party-migration-failure.log\` (step 1 of the README's recovery):" "$out"
}

# Step 3 of the README's recovery, then step 4.
readme_recover_and_rerun() {
  local tree="$1" logprefix="$2" name rc=0
  readme_prisma migrate status || true
  name="$(failed_migration_name)"
  if [ -n "$name" ]; then
    res "- \`migrate status\` names \`$name\`; the README says to mark it rolled back by that name."
    readme_prisma migrate resolve --rolled-back "$name" || true
  else
    res "- \`migrate status\` names no failed migration; the README says there is nothing to resolve."
  fi
  res ""
  res "### Step 4: run the deploy again"
  play_recorded "deploy.yml, second run" "$LOGS/$logprefix-second-run.log" "$tree" deploy.yml || rc=$?
  record_state "after the second run"
  return "$rc"
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
  PLAY_PATH_PREFIX="$other" play_recorded "deploy.yml with that Bun first on PATH" "$LOGS/s1-deploy.log" "$scenario_tree" deploy.yml || rc=$?
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
  local rc=0
  scenario_start 05-scenario-3-migration-fails-before-rekey "Scenario 3: a migration that fails before the re-key" \
    "$README_MIGRATION_FAILED" "$README_RECOVERY_STEPS" "$README_MARKER" "$README_SCHEMA_CHECK"
  host_bun_to_pin
  lock_holder_start 'LOCK TABLE "PendingSignal" IN ROW EXCLUSIVE MODE;'
  deploy_with_blocked_migration "$LOGS/s3-deploy.log" "$scenario_tree" 75 'CREATE INDEX%' || rc=$?
  lock_holder_end
  record_state "after the failed migration"
  record_failure_log
  res ""
  res "### The README's recovery (the cause, the lock, is gone: step 2)"
  readme_recover_and_rerun "$scenario_tree" s3 || true
  record_rows "after the recovery" || true
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
  deploy_with_blocked_migration "$LOGS/s4-deploy.log" "$scenario_tree" 75 'ALTER TABLE%' || rc=$?
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
  readme_recover_and_rerun "$scenario_tree" s4 || true
  record_rows "after the recovery" || true
}

# (5) A new binary that will not start: COTURN_SECRET below the server's
# 32-byte floor in the rendered environment file.
mode_scenario_5() {
  local rc=0
  scenario_start 07-scenario-5-binary-will-not-start "Scenario 5: a new binary that will not start (a bad value in its environment file)" \
    "$README_DEPLOY_ORDER" "$README_SCHEMA_CHECK" "COTURN_SECRET"
  host_bun_to_pin
  res "- The deploy renders COTURN_SECRET from \`vault_coturn_auth_secret\`, given here as an extra variable of 21 bytes (\`too-short-turn-secret\`); the server refuses one under 32 bytes."
  play_recorded "deploy.yml with the short secret" "$LOGS/s5-deploy.log" "$scenario_tree" deploy.yml \
    -e vault_coturn_auth_secret=too-short-turn-secret || rc=$?
  record_state "after the failed start"
  res ""
  res "### Next step: the value fixed (the vault's own secret), the deploy again"
  rc=0
  play_recorded "deploy.yml, second run" "$LOGS/s5-second-run.log" "$scenario_tree" deploy.yml || rc=$?
  record_state "after the second run"
}

# (6) A second run after a success.
mode_scenario_6() {
  local rc=0 before after
  if [ -d "$SNAPSHOTS/upgraded" ]; then
    snapshot_restore upgraded
    guest_install_helpers
  else
    mode_upgrade
    vm_start || true
  fi
  result_open 09-scenario-6-second-run-after-success "Scenario 6: a second run after a success"
  scenario_tree="$(prepare_tree "$COMMIT_SHA")"
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
  tree014="$(prepare_tree "$RELEASE_014")"
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
  other_sha="$(git -C "$repo" rev-parse --verify "${REHEARSAL_OTHER_COMMIT:-35d94c8}^{commit}")"
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
  fi
}

# A new host provisioned by the commit's own playbooks, as far as they run
# without a public address. Stand-ins as in the baseline, plus the TURN
# certificate (README, "What stands in for what"); the host's Bun is the pin,
# in place of the online installer initial-setup.yml runs when it is absent.
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
  play_recorded "site.yml" "$LOGS/fresh-site.log" "$tree" site.yml || rc=$?
  record_state "after site.yml"
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
  res ""
  res "## initial-setup.yml again, with a binary deployed"
  rc=0
  play_recorded "initial-setup.yml" "$LOGS/fresh-initial-setup.log" "$tree" initial-setup.yml || rc=$?
  record_state "after initial-setup.yml"
  record_host after-fresh
}

mode_clean() {
  vm_delete
  rm -rf "${SNAPSHOTS:?}"/* "${TREES:?}"/*
  log "deleted the instance, the snapshots and the trees (secrets, logs and results are kept in $WORK)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [ "$mode" = clean ]; then
  mode_clean
  exit 0
fi

COMMIT_SHA="$(git -C "$repo" rev-parse --verify "$commit^{commit}")" || refuse "$commit is not a commit in $repo"
COMMIT_SUBJECT="$(git -C "$repo" log -1 --format=%s "$COMMIT_SHA")"
PIN="$(git -C "$repo" show "$COMMIT_SHA:package.json" | sed -n 's/.*"packageManager": "bun@\([0-9.]*\)".*/\1/p')"
[ -x "$TOOLS/bun-$PIN/bun" ] || refuse "no Bun $PIN for macOS at $TOOLS/bun-$PIN/bun (the commit under test pins it)"
[ -x "$TOOLS/bun-linux-x64-$PIN/bun" ] || refuse "no Bun $PIN for Linux x64 (the build's cross-compile runtime) at $TOOLS/bun-linux-x64-$PIN/bun"
[ -x "$TOOLS/bun-linux-aarch64-$PIN/bun" ] || refuse "no Bun $PIN for Linux aarch64 (the host's Bun) at $TOOLS/bun-linux-aarch64-$PIN/bun"
ensure_secrets
# The build's cross-compile target, from the verified copy rather than a
# download (bun build --compile looks for it under this name).
cp -c -n "$TOOLS/bun-linux-x64-$PIN/bun" "$CACHE/bun/bun-linux-x64-v$PIN" 2>/dev/null || true
trap cleanup EXIT
rm -f "$WORK/disk-guard-tripped"
disk_guard_start
log "commit under test: ${COMMIT_SHA:0:12} ($COMMIT_SUBJECT); work directory $WORK"

case "$mode" in
  baseline) mode_baseline ;;
  upgrade) mode_upgrade ;;
  scenario-*) "mode_scenario_${mode#scenario-}" ;;
  fresh) mode_fresh ;;
esac
