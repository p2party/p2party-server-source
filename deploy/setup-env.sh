#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# P2Party Environment Setup Script
# ============================================================================
# Interactive script to securely set environment variables in .env
# Values are NOT printed to console or saved in shell history.
# Can auto-generate strong passwords using OpenSSL.
#
# Usage: ./setup-env.sh
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Password generation settings
PASSWORD_LENGTH=48  # 48 bytes = 64 base64 characters

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}P2Party Environment Setup${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "This script will securely set environment variables in ${YELLOW}$ENV_FILE${NC}"
echo -e "Values will ${GREEN}NOT${NC} be printed to console or saved in shell history."
echo ""

# Check if .env exists, create from example if not
if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$SCRIPT_DIR/.env.example" ]]; then
        cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
        echo -e "${GREEN}Created .env from .env.example${NC}"
    else
        echo "# P2Party Deploy Environment" > "$ENV_FILE"
        echo -e "${GREEN}Created new .env file${NC}"
    fi
fi

# Function to generate a strong password using OpenSSL
generate_password() {
    openssl rand -base64 $PASSWORD_LENGTH | tr -d '/+=' | head -c 64
}

# Function to update a variable in the .env file
update_env_var() {
    local var_name="$1"
    local value="$2"
    if grep -q "^export ${var_name}=" "$ENV_FILE"; then
        sed -i.bak "s@^export ${var_name}=.*@export ${var_name}=\"${value}\"@" "$ENV_FILE"
    else
        echo "export ${var_name}=\"${value}\"" >> "$ENV_FILE"
    fi
}

# Function to securely read or generate a password
read_or_generate_secret() {
    local prompt="$1"
    local var_name="$2"
    local current_value=""
    current_value=$(grep "^export ${var_name}=" "$ENV_FILE" 2>/dev/null | sed 's/^export [^=]*="//' | sed 's/"$//' || echo "")
    echo -e "${YELLOW}$prompt${NC}"
    if [[ -n "$current_value" ]]; then
        echo -e "  Current: ${CYAN}[hidden, ${#current_value} chars]${NC}"
        echo -e "  Options: ${GREEN}[G]${NC}enerate new | ${BLUE}[E]${NC}nter manually | ${YELLOW}[K]${NC}eep current | ${RED}[S]${NC}kip"
    else
        echo -e "  Options: ${GREEN}[G]${NC}enerate new | ${BLUE}[E]${NC}nter manually | ${RED}[S]${NC}kip"
    fi
    echo -n "  Choice: "
    read -n 1 choice
    echo ""
    case "${choice,,}" in
        g)
            local new_password
            new_password=$(generate_password)
            update_env_var "$var_name" "$new_password"
            echo -e "  ${GREEN}Generated strong password (64 chars)${NC}"
            ;;
        e)
            echo -n "  Enter value: "
            read -s value
            echo ""
            if [[ -n "$value" ]]; then
                update_env_var "$var_name" "$value"
                echo -e "  ${GREEN}Updated${NC}"
            else
                echo -e "  ${YELLOW}Skipped (no value entered)${NC}"
            fi
            ;;
        k)
            if [[ -n "$current_value" ]]; then
                echo -e "  ${GREEN}Keeping existing value${NC}"
            else
                echo -e "  ${YELLOW}No existing value to keep${NC}"
            fi
            ;;
        *)
            echo -e "  ${YELLOW}Skipped${NC}"
            ;;
    esac
}

# Function to read non-secret value (can be shown)
read_value() {
    local prompt="$1"
    local var_name="$2"
    local current_value=""
    current_value=$(grep "^export ${var_name}=" "$ENV_FILE" 2>/dev/null | sed 's/^export [^=]*="//' | sed 's/"$//' || echo "")
    if [[ -n "$current_value" ]]; then
        echo -e "${YELLOW}$prompt${NC} (current: ${current_value}):"
    else
        echo -e "${YELLOW}$prompt${NC}:"
    fi
    read value
    if [[ -z "$value" && -n "$current_value" ]]; then
        echo -e "  ${GREEN}Keeping existing value${NC}"
        return
    fi
    if [[ -z "$value" ]]; then
        echo -e "  ${YELLOW}Skipped (no value entered)${NC}"
        return
    fi
    update_env_var "$var_name" "$value"
    echo -e "  ${GREEN}Updated${NC}"
}

echo -e "${BLUE}--- Vault Password (for Ansible vault encryption) ---${NC}"
echo -e "${CYAN}Tip: Press 'G' to auto-generate a strong 64-character password${NC}"
echo ""
read_or_generate_secret "Production vault password" "P2PARTY_VAULT_PASSWORD_PRODUCTION"

echo ""
echo -e "${BLUE}--- Hetzner API Token ---${NC}"
echo ""
read_or_generate_secret "Hetzner Cloud API token" "TF_VAR_hcloud_token"

echo ""
echo -e "${BLUE}--- Cloudflare ---${NC}"
echo ""
read_or_generate_secret "Cloudflare API token" "TF_VAR_cloudflare_api_token"
read_value "Cloudflare Zone ID (for p2party.com)" "TF_VAR_cloudflare_zone_id_p2party"

# Clean up backup file
rm -f "$ENV_FILE.bak"

echo ""
echo -e "${GREEN}============================================================================${NC}"
echo -e "${GREEN}Setup complete!${NC}"
echo -e "${GREEN}============================================================================${NC}"
echo ""
echo -e "To load these variables, run:"
echo -e "  ${YELLOW}source $ENV_FILE${NC}"
echo ""
echo -e "Or add to your shell profile:"
echo -e "  ${YELLOW}echo 'source $ENV_FILE' >> ~/.zshrc${NC}"
echo ""
