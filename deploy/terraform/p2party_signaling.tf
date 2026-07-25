# ============================================================================
# P2Party Signaling Server (Caddy + Bun)
# ============================================================================
# Public IP for WebSocket connections.
# DNS: signaling.p2party.com → this server
# Caddy handles TLS termination and reverse proxies to the Bun signaling server.
# ============================================================================

resource "hcloud_server" "p2party_signaling" {
  count = var.deploy_signaling ? 1 : 0

  name        = "p2party-signaling"
  image       = "ubuntu-24.04"
  server_type = "ccx23" # 8 vCPU, 16GB RAM (dedicated)
  location    = "nbg1"  # Nuremberg, Germany

  delete_protection  = false
  rebuild_protection = false

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.p2party.id
    ip         = var.p2party_signaling_ip
  }

  ssh_keys = [
    hcloud_ssh_key.operator_key_1.id,
    hcloud_ssh_key.operator_key_2.id,
    hcloud_ssh_key.operator_key_3.id,
  ]

  labels = {
    project     = "p2party"
    role        = "signaling"
    environment = "production"
  }

  user_data = templatefile("${path.module}/templates/signaling_cloud_init.yaml.tpl", {
    ssh_port     = var.p2party_signaling_ssh_port
    ansible_user = var.p2party_ansible_user
    app_port     = var.p2party_signaling_port
    ssh_keys     = "- ${join("\n      - ", [for k in local.ssh_public_keys : trimspace(k)])}"
  })

  depends_on = [
    hcloud_network_subnet.p2party,
  ]

  lifecycle {
    ignore_changes = [user_data]
  }
}

# ============================================================================
# Firewall
# ============================================================================

resource "hcloud_firewall" "p2party_signaling" {
  name = "p2party-signaling-firewall"

  # SSH from private network
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = var.p2party_signaling_ssh_port
    source_ips = [var.p2party_subnet]
  }

  # HTTP (for Let's Encrypt ACME challenges)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS (Caddy TLS termination)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Egress. Restricted to the baseline: this host serves inbound traffic and
  # talks to Postgres over the private network. Hetzner firewalls are stateful,
  # so replies to inbound WebSocket and HTTPS connections are unaffected.
  dynamic "rule" {
    for_each = local.p2party_baseline_egress
    content {
      direction       = "out"
      protocol        = rule.value.protocol
      port            = rule.value.port
      destination_ips = rule.value.destination_ips
    }
  }
}

resource "hcloud_firewall_attachment" "p2party_signaling" {
  count       = var.deploy_signaling ? 1 : 0
  firewall_id = hcloud_firewall.p2party_signaling.id
  server_ids  = [hcloud_server.p2party_signaling[0].id]
}

# ============================================================================
# Outputs
# ============================================================================

output "p2party_signaling_public_ipv4" {
  description = "Signaling server public IPv4"
  value       = var.deploy_signaling ? hcloud_server.p2party_signaling[0].ipv4_address : null
}

output "p2party_signaling_public_ipv6" {
  description = "Signaling server public IPv6"
  value       = var.deploy_signaling ? hcloud_server.p2party_signaling[0].ipv6_address : null
}
