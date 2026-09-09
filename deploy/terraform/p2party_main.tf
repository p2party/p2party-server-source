# ============================================================================
# P2Party Terraform Configuration
# ============================================================================
# Infrastructure for the P2Party signaling server.
# 4 servers:
#   1. PostgreSQL database
#   2. Coturn TURN/STUN server (turn.p2party.com)
#   3. Caddy reverse proxy + signaling server (signaling.p2party.com)
#   4. WireGuard VPN gateway (vpn.p2party.com)
# ============================================================================

terraform {
  required_version = ">= 1.2.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.60"
    }

    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }

    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

# ============================================================================
# Provider Configuration
# ============================================================================

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ============================================================================
# Variables
# ============================================================================

variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}
