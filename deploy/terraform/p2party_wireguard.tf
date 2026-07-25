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

  depends_on = [
    hcloud_network_subnet.p2party,
  ]
}

resource "hcloud_firewall" "p2party_wireguard" {
  name = "p2party-wireguard-firewall"

  # SSH from anywhere (this is the VPN entry point)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = var.p2party_wireguard_ssh_port
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # WireGuard UDP
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = tostring(var.p2party_wireguard_port)
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Allow all outbound
  rule {
    direction       = "out"
    protocol        = "tcp"
    port            = "any"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "udp"
    port            = "any"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "icmp"
    destination_ips = ["0.0.0.0/0", "::/0"]
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
