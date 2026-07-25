#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# P2Party Set Single Environment Variable
# ============================================================================
# Set a single environment variable securely without printing to console.
#
# Usage: ./set-env-var.sh VAR_NAME
# Example: ./set-env-var.sh TF_VAR_hcloud_token
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 VAR_NAME"
    echo "Example: $0 TF_VAR_hcloud_token"
    exit 1
fi

VAR_NAME="$1"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Creating .env file..."
    touch "$ENV_FILE"
fi

current_value=$(grep "^export ${VAR_NAME}=" "$ENV_FILE" 2>/dev/null | sed 's/^export [^=]*="//' | sed 's/"$//' || echo "")

if [[ -n "$current_value" ]]; then
    echo "Enter new value for $VAR_NAME (current: [hidden], press Enter to keep):"
else
    echo "Enter value for $VAR_NAME:"
fi

read -s value
echo ""

if [[ -z "$value" && -n "$current_value" ]]; then
    echo "Kept existing value"
    exit 0
fi

if [[ -z "$value" ]]; then
    echo "No value entered"
    exit 1
fi

if grep -q "^export ${VAR_NAME}=" "$ENV_FILE"; then
    sed -i.bak "s@^export ${VAR_NAME}=.*@export ${VAR_NAME}=\"${value}\"@" "$ENV_FILE"
else
    echo "export ${VAR_NAME}=\"${value}\"" >> "$ENV_FILE"
fi

rm -f "$ENV_FILE.bak"
echo "Updated $VAR_NAME"
echo ""
echo "Run 'source $ENV_FILE' to load the new value"
