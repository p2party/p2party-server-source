#!/bin/bash
# ============================================================================
# Deploy the p2party signaling server
# ============================================================================
# Builds the Linux binary from THIS repo and ships it to the signaling host.
#
# Usage:
#   ./deploy.sh                     # build + deploy + restart
#   ./deploy.sh --skip-build        # deploy the binary already built
#
# Requires: bun, ansible, SSH access to the signaling host, and
# ansible/group_vars/all/vault.yml (see vault.yml.example).
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$SCRIPT_DIR/ansible"
EXTRA_VARS=()

for arg in "$@"; do
  case "$arg" in
    --skip-build) EXTRA_VARS+=(-e "skip_build=true") ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--skip-build]" >&2
      exit 2
      ;;
  esac
done

VAULT_FILE="$ANSIBLE_DIR/group_vars/all/vault.yml"
if [ ! -f "$VAULT_FILE" ]; then
  echo "Missing $VAULT_FILE" >&2
  echo "Copy group_vars/all/vault.yml.example to vault.yml and encrypt it." >&2
  exit 1
fi

VAULT_ARGS=()
for candidate in "$ANSIBLE_DIR/vault_pass_production.sh" "$ANSIBLE_DIR/vault_pass.sh"; do
  if [ -x "$candidate" ]; then
    VAULT_ARGS=(--vault-password-file "$candidate")
    break
  fi
done
if [ ${#VAULT_ARGS[@]} -eq 0 ]; then
  echo "No vault password script found; ansible will prompt." >&2
  VAULT_ARGS=(--ask-vault-pass)
fi

cd "$ANSIBLE_DIR"
exec ansible-playbook \
  -i inventory/production.yml \
  playbooks/deploy.yml \
  "${VAULT_ARGS[@]}" \
  ${EXTRA_VARS[@]+"${EXTRA_VARS[@]}"}
