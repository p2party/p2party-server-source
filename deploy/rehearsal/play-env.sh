#!/bin/bash
# ============================================================================
# The environment every Ansible command of the rehearsal runs in
# ============================================================================
#   play-env.sh --work DIR --tools DIR --cfg FILE --control DIR --guard-bin DIR
#               --ssh-port N --bun-dir DIR -- COMMAND [ARGUMENT...]
#
# Runs COMMAND under `env -i` with only the variables below: nothing from the
# caller's environment reaches Ansible (run.sh also refuses to start when the
# caller's environment holds any ANSIBLE_* variable). PATH starts with the
# SSH guard (ssh-guard.sh as ssh, scp and sftp), so every connection is
# checked where it is made. Every value comes from run.sh's arguments.
# ============================================================================
set -euo pipefail

work="" tools="" cfg="" control="" guard_bin="" ssh_port="" bun_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --work) work="$2"; shift 2 ;;
    --tools) tools="$2"; shift 2 ;;
    --cfg) cfg="$2"; shift 2 ;;
    --control) control="$2"; shift 2 ;;
    --guard-bin) guard_bin="$2"; shift 2 ;;
    --ssh-port) ssh_port="$2"; shift 2 ;;
    --bun-dir) bun_dir="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "play-env.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
for value in "$work" "$tools" "$cfg" "$control" "$guard_bin" "$ssh_port" "$bun_dir"; do
  [ -n "$value" ] || { echo "play-env.sh: every option is required" >&2; exit 2; }
done
[ $# -gt 0 ] || { echo "play-env.sh: no command" >&2; exit 2; }

# Expand HOME on the connection target. The fictitious USER has no macOS
# home entry, so Ansible's default "~rehearsal" becomes a path in the checkout.
exec env -i \
  HOME="$work/home" USER=rehearsal LANG=C.UTF-8 LC_ALL=C.UTF-8 TMPDIR="$work/tmp" \
  PATH="$guard_bin:$bun_dir:$tools/venv/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  ANSIBLE_CONFIG="$cfg" ANSIBLE_HOME="$work/ansible/home" \
  ANSIBLE_REMOTE_TEMP='$HOME/.ansible/tmp' ANSIBLE_LOCAL_TEMP="$work/ansible/tmp" ANSIBLE_SSH_CONTROL_PATH_DIR="$control" \
  ANSIBLE_COLLECTIONS_PATH="$tools/collections" ANSIBLE_PRIVATE_KEY_FILE="$work/secrets/id_ed25519" \
  ANSIBLE_SSH_COMMON_ARGS="-o UserKnownHostsFile=$work/secrets/known_hosts -o StrictHostKeyChecking=accept-new" \
  ANSIBLE_NOCOLOR=1 ANSIBLE_FORCE_COLOR=0 \
  BUN_INSTALL_CACHE_DIR="$work/cache/bun" CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
  REHEARSAL_GUARD_PORT="$ssh_port" REHEARSAL_GUARD_REAL_DIR=/usr/bin \
  REHEARSAL_GUARD_LOG="$work/logs/ssh-guard.log" \
  "$@"
