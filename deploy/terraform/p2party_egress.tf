# ============================================================================
# Baseline egress
# ============================================================================
# Every host previously allowed unrestricted outbound TCP, UDP and ICMP to the
# whole internet. That is the difference between "an attacker got a shell" and
# "an attacker got a shell and can reach anything from it": unrestricted egress
# is what turns a foothold into exfiltration, a reverse shell, and a pivot.
#
# Hetzner Cloud firewalls are stateful, so replies to inbound connections are
# always allowed and are NOT affected by these rules. What is restricted here
# is only traffic the host itself originates.
#
# Defined once and consumed by each firewall through a dynamic block, so the
# set cannot drift between roles.

locals {
  # The minimum a Debian/Ubuntu host needs to stay patched, resolve names, keep
  # its clock, and talk to its own private network.
  p2party_baseline_egress = [
    # apt mirrors and Let's Encrypt ACME.
    { protocol = "tcp", port = "80", destination_ips = ["0.0.0.0/0", "::/0"] },
    { protocol = "tcp", port = "443", destination_ips = ["0.0.0.0/0", "::/0"] },

    # DNS. TCP as well as UDP: a response larger than 512 bytes, or any DNSSEC
    # answer, falls back to TCP, and a UDP-only rule fails intermittently in a
    # way that looks like a name-server problem rather than a firewall one.
    { protocol = "udp", port = "53", destination_ips = ["0.0.0.0/0", "::/0"] },
    { protocol = "tcp", port = "53", destination_ips = ["0.0.0.0/0", "::/0"] },

    # NTP. Drift breaks TLS certificate validation and the freshness window on
    # the signed signaling challenge, so this is correctness, not housekeeping.
    { protocol = "udp", port = "123", destination_ips = ["0.0.0.0/0", "::/0"] },

    # The private network. Hosts talk to Postgres, to each other, and to the
    # WireGuard gateway over this.
    { protocol = "tcp", port = "any", destination_ips = [var.p2party_subnet] },
    { protocol = "udp", port = "any", destination_ips = [var.p2party_subnet] },

    # ICMP carries "fragmentation needed". Drop it and path-MTU discovery
    # blackholes: small packets work, large ones vanish with no error. ICMP has
    # no port, hence null.
    { protocol = "icmp", port = null, destination_ips = ["0.0.0.0/0", "::/0"] },
  ]
}
