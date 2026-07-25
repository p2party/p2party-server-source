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
  description = "Cloudflare API token with Zone:Edit and DNS:Edit permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id_p2party" {
  description = "Cloudflare Zone ID for p2party.com"
  type        = string
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
