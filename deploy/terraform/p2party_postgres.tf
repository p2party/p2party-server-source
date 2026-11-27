# ============================================================================
# P2Party PostgreSQL Database Server
# ============================================================================
# Private network only for DB connections.
# Public IP for initial setup (apt-get, PostgreSQL install).
# ============================================================================

resource "hcloud_server" "p2party_postgres" {
  count = var.deploy_postgres ? 1 : 0

  name        = "p2party-postgres"
  image       = "ubuntu-24.04"
  server_type = "cpx22" # 3 vCPU, 4GB RAM (shared arm64)
  location    = "nbg1"  # Nuremberg, Germany

  delete_protection  = false
  rebuild_protection = false

  public_net {
    # Temporarily enable for initial setup (apt-get, PostgreSQL install).
    # After provisioning completes, set to false and re-apply.
    ipv4_enabled = true
    ipv6_enabled = false
  }

  network {
    network_id = hcloud_network.p2party.id
    ip         = var.p2party_postgres_ip
  }

  ssh_keys = [
    hcloud_ssh_key.operator_key_1.id,
    hcloud_ssh_key.operator_key_2.id,
    hcloud_ssh_key.operator_key_3.id,
  ]

  labels = {
    project     = "p2party"
    role        = "database"
    environment = "production"
  }

  user_data = templatefile("${path.module}/templates/postgres_cloud_init.yaml.tpl", {
    ssh_port                  = var.p2party_postgres_ssh_port
    ansible_user              = var.p2party_ansible_user
    db_subnet                 = var.p2party_subnet
    postgresql_install_script = indent(6, trimspace(file("${path.module}/../ansible/files/install-postgresql.sh")))
    ssh_keys                  = "- ${join("\n      - ", [for k in local.ssh_public_keys : trimspace(k)])}"
  })


  # user_data is ForceNew in the hcloud provider, and cloud-init only ever runs
  # on first boot — so an edit to the template cannot reach this server anyway,
  # it can only destroy and recreate it. Matches hcloud_server.p2party_signaling.
  lifecycle {
    ignore_changes = [user_data]
  }
  depends_on = [
    hcloud_network_subnet.p2party,
  ]
}

# ============================================================================
# Firewall
# ============================================================================

resource "hcloud_firewall" "p2party_postgres" {
  count = var.deploy_postgres && var.p2party_postgres_enable_hcloud_firewall ? 1 : 0

  name = "p2party-postgres-firewall"

  # SSH from the private network only: reachable through WireGuard, never from
  # the internet.
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = var.p2party_postgres_ssh_port
    source_ips = [var.p2party_subnet]
  }

  # PostgreSQL from the private network only.
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "5432"
    source_ips = [var.p2party_subnet]
  }

  # Egress. This host holds every peer identity, room membership and challenge
  # signature in the system, so it is the one machine whose outbound traffic
  # matters most: with unrestricted egress, a compromise can stream the whole
  # database anywhere. It needs to patch itself and nothing else.
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

resource "hcloud_firewall_attachment" "p2party_postgres" {
  count       = var.deploy_postgres && var.p2party_postgres_enable_hcloud_firewall ? 1 : 0
  firewall_id = hcloud_firewall.p2party_postgres[0].id
  server_ids  = [hcloud_server.p2party_postgres[0].id]
}

# ============================================================================
# Outputs
# ============================================================================

output "p2party_postgres_public_ip" {
  description = "PostgreSQL server public IP (for initial setup only)"
  value       = var.deploy_postgres ? hcloud_server.p2party_postgres[0].ipv4_address : null
}

output "p2party_postgres_private_ip" {
  description = "PostgreSQL server private network IP"
  value       = var.p2party_postgres_ip
}
