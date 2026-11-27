# ============================================================================
# P2Party Cloudflare DNS Configuration
# ============================================================================
# DNS records for p2party.com subdomains.
# proxied=false because Caddy/Coturn handle TLS directly.
# ============================================================================

# ============================================================================
# Coturn: turn.p2party.com + stun.p2party.com (same server)
# ============================================================================

resource "cloudflare_dns_record" "turn_a" {
  count = var.deploy_coturn ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party
  name    = "turn.p2party.com"
  content = hcloud_server.p2party_coturn[0].ipv4_address
  type    = "A"
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "turn_aaaa" {
  count = var.deploy_coturn ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party
  name    = "turn.p2party.com"
  content = hcloud_server.p2party_coturn[0].ipv6_address
  type    = "AAAA"
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "stun_a" {
  count = var.deploy_coturn ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party
  name    = "stun.p2party.com"
  content = hcloud_server.p2party_coturn[0].ipv4_address
  type    = "A"
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "stun_aaaa" {
  count = var.deploy_coturn ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party
  name    = "stun.p2party.com"
  content = hcloud_server.p2party_coturn[0].ipv6_address
  type    = "AAAA"
  ttl     = 1
  proxied = false
}

# ============================================================================
# Signaling: signaling.p2party.com
# ============================================================================

resource "cloudflare_dns_record" "signaling_a" {
  count = var.deploy_signaling ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party
  name    = "signaling.p2party.com"
  content = hcloud_server.p2party_signaling[0].ipv4_address
  type    = "A"
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "signaling_aaaa" {
  count = var.deploy_signaling ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party
  name    = "signaling.p2party.com"
  content = hcloud_server.p2party_signaling[0].ipv6_address
  type    = "AAAA"
  ttl     = 1
  proxied = false
}

# ============================================================================
# Outputs
# ============================================================================

output "dns_records" {
  description = "DNS records created"
  value = {
    turn = var.deploy_coturn ? {
      a    = "turn.p2party.com → ${hcloud_server.p2party_coturn[0].ipv4_address}"
      aaaa = "turn.p2party.com → ${hcloud_server.p2party_coturn[0].ipv6_address}"
    } : null
    stun = var.deploy_coturn ? {
      a    = "stun.p2party.com → ${hcloud_server.p2party_coturn[0].ipv4_address}"
      aaaa = "stun.p2party.com → ${hcloud_server.p2party_coturn[0].ipv6_address}"
    } : null
    signaling = var.deploy_signaling ? {
      a    = "signaling.p2party.com → ${hcloud_server.p2party_signaling[0].ipv4_address}"
      aaaa = "signaling.p2party.com → ${hcloud_server.p2party_signaling[0].ipv6_address}"
    } : null
  }
}

# Cloudflare v5 migrates the existing record state at these addresses.
moved {
  from = cloudflare_record.turn_a
  to   = cloudflare_dns_record.turn_a
}

moved {
  from = cloudflare_record.turn_aaaa
  to   = cloudflare_dns_record.turn_aaaa
}

moved {
  from = cloudflare_record.stun_a
  to   = cloudflare_dns_record.stun_a
}

moved {
  from = cloudflare_record.stun_aaaa
  to   = cloudflare_dns_record.stun_aaaa
}

moved {
  from = cloudflare_record.signaling_a
  to   = cloudflare_dns_record.signaling_a
}

moved {
  from = cloudflare_record.signaling_aaaa
  to   = cloudflare_dns_record.signaling_aaaa
}
