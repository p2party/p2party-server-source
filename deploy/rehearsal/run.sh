#!/usr/bin/env bash
# ============================================================================
# p2party release rehearsal
# ============================================================================
# Runs the production playbooks against one local Lima VM, p2party-rehearsal,
# reached only on 127.0.0.1 (deploy/rehearsal/README.md).
#
#   run.sh [--inventory PATH] [--repo DIR] [--commit REV] [--keep] MODE
#
#   check     check the inventory and stop (contacts nothing)
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
  sed -n '2,/^# =====*$/{/^# =====*$/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}" | sed -n '1,/^$/!p' >&2
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

die "unknown mode $mode (see --help)"
