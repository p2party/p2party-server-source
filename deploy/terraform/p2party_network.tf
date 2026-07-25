# ============================================================================
# P2Party Network Configuration
# ============================================================================
#
#   ┌─────────────────────────────────────────────────────────────────────┐
#   │                         NETWORK TOPOLOGY                            │
#   │                                                                     │
#   │   All servers on: 10.231.0.0/24 (Private Network)                   │
#   │                                                                     │
#   │   10.231.0.2  - PostgreSQL (database)                                │
#   │   10.231.0.3  - Coturn (TURN/STUN - turn.p2party.com)               │
#   │   10.231.0.4  - Caddy + Signaling (signaling.p2party.com)           │
#   │   10.231.0.5  - WireGuard (vpn.p2party.com)                          │
#   │                                                                     │
#   │   Security: UFW rules restrict which servers can talk to each other │
#   │                                                                     │
#   └─────────────────────────────────────────────────────────────────────┘
#
# ============================================================================

# ============================================================================
# Private Network
# ============================================================================

resource "hcloud_network" "p2party" {
  name     = "p2party-network"
  ip_range = "10.231.0.0/16"

  labels = {
    project     = "p2party"
    environment = "production"
  }
}

resource "hcloud_network_subnet" "p2party" {
  type         = "cloud"
  network_id   = hcloud_network.p2party.id
  network_zone = "eu-central"
  ip_range     = "10.231.0.0/24"
}

# ============================================================================
# Outputs
# ============================================================================

output "p2party_network_id" {
  description = "Private network ID"
  value       = hcloud_network.p2party.id
}

output "network_ips" {
  description = "All server IPs on private network"
  value = {
    postgres  = "10.231.0.2"
    coturn    = "10.231.0.3"
    signaling = "10.231.0.4"
    wireguard = "10.231.0.5"
  }
}
