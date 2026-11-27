# ============================================================================
# P2Party Infrastructure Variables
# ============================================================================

# ============================================================================
# Deployment Control
# ============================================================================

variable "deploy_postgres" {
  description = "Deploy PostgreSQL server"
  type        = bool
  default     = true
}

variable "deploy_coturn" {
  description = "Deploy Coturn TURN/STUN server"
  type        = bool
  default     = true
}

variable "deploy_signaling" {
  description = "Deploy Caddy + signaling server"
  type        = bool
  default     = true
}

variable "deploy_wireguard" {
  description = "Deploy WireGuard private-network gateway"
  type        = bool
  default     = true
}

# ============================================================================
# Cloudflare Configuration
# ============================================================================

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:Edit and DNS:Edit; frontend response headers also require Zone Transform Rules:Edit, edge TLS settings Zone Settings:Edit, and the www redirect Single Redirect:Edit"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id_p2party" {
  description = "Cloudflare Zone ID for p2party.com"
  type        = string
}

variable "manage_frontend_response_headers" {
  description = "Manage the frontend response-transform ruleset after checking existing phase ownership; see deploy/README.md"
  type        = bool
  default     = false
}

variable "frontend_response_headers_enabled" {
  description = "Activate frontend headers only after the CSP-compatible frontend build is deployed and tested"
  type        = bool
  default     = false
}

variable "frontend_response_headers_all_app_hosts" {
  description = "Extend the frontend header rule from p2party.com to www and dev only after dev serves a CSP-compatible build; see deploy/README.md"
  type        = bool
  default     = false
}

variable "manage_frontend_tls_settings" {
  description = "Enforce Always Use HTTPS and minimum TLS 1.2 on every proxied hostname in the zone; HSTS stays with the header rule; see deploy/README.md"
  type        = bool
  default     = false
}

variable "frontend_tls_previous_settings" {
  description = "Record these original zone values before enabling TLS management. Disabling it restores them; null leaves a never-managed zone alone."
  type        = object({ always_use_https = string, min_tls_version = string })
  default     = null

  validation {
    condition = var.frontend_tls_previous_settings == null ? true : (
      contains(["on", "off"], var.frontend_tls_previous_settings.always_use_https) &&
      contains(["1.0", "1.1", "1.2", "1.3"], var.frontend_tls_previous_settings.min_tls_version)
    )
    error_message = "Record an on/off HTTPS setting and the existing minimum TLS version."
  }
}

variable "manage_frontend_www_redirect" {
  description = "Manage the single-redirect ruleset for www after checking existing phase ownership; see deploy/README.md"
  type        = bool
  default     = false
}

variable "frontend_www_redirect_enabled" {
  description = "Activate the www to https://p2party.com redirect only after the disabled rule has been created and reviewed"
  type        = bool
  default     = false
}

# ============================================================================
# Network
# ============================================================================

variable "p2party_subnet" {
  description = "Private network subnet"
  type        = string
  default     = "10.231.0.0/24"
}

# ============================================================================
# Server IPs - Private Network (10.231.0.x)
# ============================================================================

variable "p2party_postgres_ip" {
  description = "PostgreSQL server IP on private network"
  type        = string
  default     = "10.231.0.2"
}

variable "p2party_coturn_ip" {
  description = "Coturn server IP on private network"
  type        = string
  default     = "10.231.0.3"
}

variable "p2party_signaling_ip" {
  description = "Signaling server IP on private network"
  type        = string
  default     = "10.231.0.4"
}

variable "p2party_wireguard_ip" {
  description = "WireGuard server IP on private network"
  type        = string
  default     = "10.231.0.5"
}

# ============================================================================
# SSH Ports (non-standard for security)
# ============================================================================

variable "p2party_postgres_ssh_port" {
  description = "SSH port for PostgreSQL server"
  type        = number
  default     = 22211
  sensitive   = true
}

variable "p2party_coturn_ssh_port" {
  description = "SSH port for Coturn server"
  type        = number
  default     = 22212
  sensitive   = true
}

variable "p2party_signaling_ssh_port" {
  description = "SSH port for signaling server"
  type        = number
  default     = 22213
  sensitive   = true
}

variable "p2party_wireguard_ssh_port" {
  description = "SSH port for WireGuard server"
  type        = number
  default     = 22214
  sensitive   = true
}

# ============================================================================
# Service Ports
# ============================================================================

variable "p2party_postgres_port" {
  description = "PostgreSQL service port"
  type        = number
  default     = 5432
}

variable "p2party_postgres_enable_hcloud_firewall" {
  description = "Attach Hetzner Cloud Firewall to PostgreSQL server (requires a public network interface)"
  type        = bool
  default     = false
}

variable "p2party_signaling_port" {
  description = "Signaling server Bun port (behind Caddy)"
  type        = number
  default     = 3001
}

variable "p2party_coturn_port" {
  description = "Coturn listening port (TLS)"
  type        = number
  default     = 443
}

variable "p2party_coturn_min_port" {
  description = "Coturn relay port range start"
  type        = number
  default     = 49152
}

variable "p2party_coturn_max_port" {
  description = "Coturn relay port range end"
  type        = number
  default     = 65535
}

variable "p2party_wireguard_port" {
  description = "WireGuard UDP listening port"
  type        = number
  default     = 51820
}

# ============================================================================
# Domain Configuration
# ============================================================================

variable "p2party_domain" {
  description = "Main domain for P2Party"
  type        = string
  default     = "p2party.com"
}

# ============================================================================
# User Configuration
# ============================================================================

variable "p2party_ansible_user" {
  description = "User for Ansible deployments and SSH"
  type        = string
  default     = "p2party"
}

variable "p2party_admin_email" {
  description = "Admin email for alerts and certificates"
  type        = string
  default     = "admin@p2party.com"
}

# ============================================================================
# Administrative access
# ============================================================================

# Deliberately has NO default. The WireGuard host is the only box with SSH
# reachable from the public internet — it is the VPN entry point, so it cannot
# be restricted to the VPN itself without a chicken-and-egg. Leaving it open to
# 0.0.0.0/0 is the one remaining hole in this stack, so the CIDRs are made an
# explicit, per-operator decision: `terraform plan` fails until they are set,
# rather than quietly falling back to "the whole internet".
#
# Break-glass if you lock yourself out: the Hetzner Cloud Console provides a
# web VNC session that bypasses the cloud firewall entirely, so a wrong value
# here is recoverable and never bricks the host.
variable "p2party_ssh_admin_ips" {
  description = "CIDRs allowed to reach SSH on the public-facing WireGuard host, e.g. [\"203.0.113.4/32\"]"
  type        = list(string)

  validation {
    condition     = length(var.p2party_ssh_admin_ips) > 0
    error_message = "Set p2party_ssh_admin_ips in terraform.tfvars to your admin IP(s)."
  }

  validation {
    condition     = length([for cidr in var.p2party_ssh_admin_ips : cidr if cidr == "0.0.0.0/0" || cidr == "::/0"]) == 0
    error_message = "Refusing 0.0.0.0/0 or ::/0 for admin SSH. Use a specific CIDR; recover via the Hetzner Cloud Console if locked out."
  }
}
