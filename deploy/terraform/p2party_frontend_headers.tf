# Cloudflare owns the complete zone ruleset for this response-transform phase.
# Opt in only after inspecting existing rules; do not import a populated phase
# into this single-rule resource without first preserving its other rules.
locals {
  frontend_response_ruleset_name = "p2party frontend response headers"
  frontend_response_rule_ref     = "p2party_frontend_security_headers"
  frontend_response_headers = {
    "Content-Security-Policy" = join("; ", [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src 'self' https: wss:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
    ])
    "Permissions-Policy"        = "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)"
    "Referrer-Policy"           = "no-referrer"
    "Strict-Transport-Security" = "max-age=63072000; includeSubDomains; preload" # only HSTS source; see p2party_frontend_tls.tf
    "X-Content-Type-Options"    = "nosniff"
  }

  # Every hostname that serves the app or redirects to it. cdn is left out: it
  # serves SDK files to other sites, where nosniff and this CSP do not belong.
  frontend_app_hosts = ["p2party.com", "www.p2party.com", "dev.p2party.com"]

  # Until the opt-in, the expression stays byte-identical to the live rule.
  frontend_response_headers_expression = (
    var.frontend_response_headers_all_app_hosts
    ? "(http.host in {${join(" ", [for host in local.frontend_app_hosts : jsonencode(host)])}})"
    : "(http.host eq \"p2party.com\")"
  )
}

# A permission failure stops an opted-in plan. Missing API access must never be
# interpreted as an empty phase, and dashboard-added rules must not be removed
# silently by a later Terraform update.
module "frontend_response_headers_inventory" {
  count   = var.manage_frontend_response_headers ? 1 : 0
  source  = "./modules/ruleset-inventory"
  zone_id = var.cloudflare_zone_id_p2party
  phase   = "http_response_headers_transform"
}

resource "cloudflare_ruleset" "frontend_response_headers" {
  count = var.manage_frontend_response_headers ? 1 : 0

  zone_id     = var.cloudflare_zone_id_p2party
  name        = local.frontend_response_ruleset_name
  description = "Security response headers for p2party.com only"
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = [{
    ref         = local.frontend_response_rule_ref
    description = "p2party.com frontend security headers"
    expression  = local.frontend_response_headers_expression
    action      = "rewrite"
    enabled     = var.frontend_response_headers_enabled
    action_parameters = {
      headers = { for name, value in local.frontend_response_headers : name => {
        operation = "set"
        value     = value
      } }
    }
  }]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = alltrue([
        for ruleset in module.frontend_response_headers_inventory[0].rulesets :
        ruleset.name == local.frontend_response_ruleset_name && alltrue([
          for rule in ruleset.rules : rule.ref == local.frontend_response_rule_ref
        ])
      ])
      error_message = "The response-header phase contains an unmanaged ruleset or additional rules. Preserve that existing configuration and reconcile Terraform ownership before enabling this resource; do not replace the phase with only the frontend rule."
    }
  }
}
