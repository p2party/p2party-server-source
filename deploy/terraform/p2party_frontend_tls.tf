# Edge HTTPS policy for the Cloudflare-proxied frontend hostnames: p2party.com,
# www, dev and cdn. Signaling, TURN and STUN are DNS-only records that Caddy and
# coturn terminate themselves, so these zone settings never reach them.
#
# Both resources default to unmanaged, like the response-header rule. See
# deploy/README.md#frontend-https-and-tls for permissions and rollout order.
# None of this authenticates the hop from Cloudflare to the S3 website origin,
# which speaks HTTP only; the README says what that requires.
locals {
  frontend_redirect_ruleset_name  = "p2party frontend redirects"
  frontend_www_redirect_rule_ref  = "p2party_frontend_www_to_https_apex"
  frontend_directory_redirect_ref = "p2party_frontend_directory_to_https"
  # The S3 website service drops the query when it adds a trailing slash.
  # These are the application's prerendered directories. Static assets and
  # the native association endpoints retain their exact paths.
  frontend_page_dirs = [
    "/blog", "/explorer", "/explorer/mainnet", "/explorer/testnet", "/privacy-policy",
    "/protocol", "/r", "/roadmap", "/rooms", "/session-lab", "/terms-of-service",
    "/wallet", "/wallet/snapshot", "/whitepaper",
  ]
  frontend_directory_match = format(
    "(http.host in {\"p2party.com\" \"www.p2party.com\"} and (http.request.uri.path in {%s} or (starts_with(http.request.uri.path, \"/blog/\") and not ends_with(http.request.uri.path, \"/\") and not (http.request.uri.path contains \".\"))))",
    join(" ", [for dir in local.frontend_page_dirs : jsonencode(dir)]),
  )
  frontend_www_redirect_target = "concat(\"https://p2party.com\", http.request.uri.path)"
}

# v5 manages each setting separately. Its delete operation leaves the live
# value in place, so disabling the policy must write back the recorded values.
locals {
  frontend_tls_values = var.manage_frontend_tls_settings ? {
    always_use_https = "on"
    min_tls_version  = "1.2"
  } : var.frontend_tls_previous_settings
}

resource "cloudflare_zone_setting" "frontend_tls" {
  for_each   = local.frontend_tls_values == null ? {} : local.frontend_tls_values
  zone_id    = var.cloudflare_zone_id_p2party
  setting_id = each.key
  value      = each.value

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.frontend_tls_previous_settings != null
      error_message = "Record the zone's previous always_use_https and min_tls_version values before managing TLS."
    }
  }
}

# Same ownership guard as the response-header phase: an unmanaged ruleset or
# a dashboard-added rule in this phase stops the plan instead of being deleted.
module "frontend_redirects_inventory" {
  count   = var.manage_frontend_www_redirect ? 1 : 0
  source  = "./modules/ruleset-inventory"
  zone_id = var.cloudflare_zone_id_p2party
  phase   = "http_request_dynamic_redirect"
}

# Runs at the edge before the request reaches the www S3 bucket, whose own
# redirect points at http://p2party.com/. Browsers keep the URL fragment across
# the redirect, so an invitation's capability stays in the fragment.
resource "cloudflare_ruleset" "frontend_redirects" {
  count = var.manage_frontend_www_redirect ? 1 : 0

  zone_id     = var.cloudflare_zone_id_p2party
  name        = local.frontend_redirect_ruleset_name
  description = "Canonical HTTPS redirects for the P2Party website"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [{
    ref         = local.frontend_directory_redirect_ref
    description = "Canonical HTTPS page directory with original query"
    expression  = local.frontend_directory_match
    action      = "redirect"
    enabled     = var.frontend_www_redirect_enabled
    action_parameters = {
      from_value = {
        status_code           = 301
        preserve_query_string = true
        target_url            = { expression = "concat(\"https://p2party.com\", http.request.uri.path, \"/\")" }
      }
    }
    }, {
    ref         = local.frontend_www_redirect_rule_ref
    description = "Upgrade HTTP and canonicalize www on the website hostnames"
    expression  = "(http.host eq \"www.p2party.com\" or (http.host eq \"p2party.com\" and not ssl))"
    action      = "redirect"
    enabled     = var.frontend_www_redirect_enabled
    action_parameters = {
      from_value = {
        status_code           = 301
        preserve_query_string = true
        target_url            = { expression = local.frontend_www_redirect_target }
      }
    }
  }]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = alltrue([
        for ruleset in module.frontend_redirects_inventory[0].rulesets :
        ruleset.name == local.frontend_redirect_ruleset_name && alltrue([
          for rule in ruleset.rules : contains([local.frontend_directory_redirect_ref, local.frontend_www_redirect_rule_ref], rule.ref)
        ])
      ])
      error_message = "The single-redirect phase contains an unmanaged ruleset or additional rules. Preserve that existing configuration and reconcile Terraform ownership before enabling this resource; do not replace the phase with only the website redirects."
    }
  }
}
