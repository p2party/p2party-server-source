# ============================================================================
# P2Party Coturn TURN/STUN Server
# ============================================================================
# Public IP required for TURN relay traffic.
# DNS: turn.p2party.com + stun.p2party.com → this server
# Ports: 443 (TLS), 49152-65535 (UDP relay range)
# ============================================================================

resource "hcloud_server" "p2party_coturn" {
  count = var.deploy_coturn ? 1 : 0

  name        = "p2party-coturn"
  image       = "ubuntu-24.04"
  server_type = "cpx22" # 3 vCPU, 4GB RAM (shared arm64)
  location    = "nbg1"  # Nuremberg, Germany

  delete_protection  = false
  rebuild_protection = false

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.p2party.id
    ip         = var.p2party_coturn_ip
  }

  ssh_keys = [
    hcloud_ssh_key.operator_key_1.id,
    hcloud_ssh_key.operator_key_2.id,
    hcloud_ssh_key.operator_key_3.id,
  ]

  labels = {
    project     = "p2party"
    role        = "turn"
    environment = "production"
  }

  user_data = templatefile("${path.module}/templates/coturn_cloud_init.yaml.tpl", {
    ssh_port     = var.p2party_coturn_ssh_port
    ansible_user = var.p2party_ansible_user
    coturn_port  = var.p2party_coturn_port
    min_port     = var.p2party_coturn_min_port
    max_port     = var.p2party_coturn_max_port
    ssh_keys     = "- ${join("\n      - ", [for k in local.ssh_public_keys : trimspace(k)])}"
  })

  depends_on = [
    hcloud_network_subnet.p2party,
  ]
}

# ============================================================================
# Firewall
# ============================================================================

resource "hcloud_firewall" "p2party_coturn" {
  name = "p2party-coturn-firewall"

  # SSH from private network
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = var.p2party_coturn_ssh_port
    source_ips = ["10.231.0.0/24"]
  }

  # TURN/STUN TLS (TCP)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # TURN/STUN (UDP on 443)
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # STUN classic port (UDP 3478)
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "3478"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # STUN classic port (TCP 3478)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "3478"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTP for ACME/Let's Encrypt certificate challenges
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # TURN relay range (UDP)
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "${var.p2party_coturn_min_port}-${var.p2party_coturn_max_port}"
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

resource "hcloud_firewall_attachment" "p2party_coturn" {
  count       = var.deploy_coturn ? 1 : 0
  firewall_id = hcloud_firewall.p2party_coturn.id
  server_ids  = [hcloud_server.p2party_coturn[0].id]
}

# ============================================================================
# Outputs
# ============================================================================

output "p2party_coturn_public_ipv4" {
  description = "Coturn server public IPv4"
  value       = var.deploy_coturn ? hcloud_server.p2party_coturn[0].ipv4_address : null
}

output "p2party_coturn_public_ipv6" {
  description = "Coturn server public IPv6"
  value       = var.deploy_coturn ? hcloud_server.p2party_coturn[0].ipv6_address : null
}
