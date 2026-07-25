# ============================================================================
# P2Party WireGuard Server (Private Network Gateway)
# ============================================================================

resource "hcloud_server" "p2party_wireguard" {
  count = var.deploy_wireguard ? 1 : 0

  name        = "p2party-wireguard"
  image       = "ubuntu-24.04"
  server_type = "cax11" # 2 vCPU, 4GB RAM (dedicated arm64)
  location    = "nbg1"  # Nuremberg, Germany

  delete_protection  = false
  rebuild_protection = false

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.p2party.id
    ip         = var.p2party_wireguard_ip
  }

  ssh_keys = [
    hcloud_ssh_key.operator_key_1.id,
    hcloud_ssh_key.operator_key_2.id,
    hcloud_ssh_key.operator_key_3.id,
  ]

  labels = {
    project     = "p2party"
    role        = "wireguard"
    environment = "production"
  }

  user_data = templatefile("${path.module}/templates/wireguard_cloud_init.yaml.tpl", {
    ssh_port       = var.p2party_wireguard_ssh_port
    wireguard_port = var.p2party_wireguard_port
    ansible_user   = var.p2party_ansible_user
    ssh_keys       = "- ${join("\n      - ", [for k in local.ssh_public_keys : trimspace(k)])}"
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

resource "hcloud_firewall" "p2party_wireguard" {
  name = "p2party-wireguard-firewall"

  # SSH, restricted to the operators. This host cannot restrict SSH to the VPN
  # (it *is* the VPN), so it is scoped to explicit admin CIDRs instead. See
  # var.p2party_ssh_admin_ips for the break-glass path.
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = var.p2party_wireguard_ssh_port
    source_ips = var.p2party_ssh_admin_ips
  }

  # WireGuard UDP. Must stay open to the world: clients dial in from arbitrary
  # networks, and the handshake is authenticated by the protocol's own static
  # keys — an unauthenticated packet is dropped without a reply, so an open
  # port here does not expose a login surface the way SSH does.
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = tostring(var.p2party_wireguard_port)
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Egress. This is a split-tunnel gateway: clients route only 10.66.0.0/24 and
  # the private 10.231.0.0/24 through it, so it never needs to NAT arbitrary
  # internet traffic. The baseline is all it requires.
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

resource "hcloud_firewall_attachment" "p2party_wireguard" {
  count       = var.deploy_wireguard ? 1 : 0
  firewall_id = hcloud_firewall.p2party_wireguard.id
  server_ids  = [hcloud_server.p2party_wireguard[0].id]
}

output "p2party_wireguard_public_ipv4" {
  description = "WireGuard server public IPv4"
  value       = var.deploy_wireguard ? hcloud_server.p2party_wireguard[0].ipv4_address : null
}

output "p2party_wireguard_public_ipv6" {
  description = "WireGuard server public IPv6"
  value       = var.deploy_wireguard ? hcloud_server.p2party_wireguard[0].ipv6_address : null
}
