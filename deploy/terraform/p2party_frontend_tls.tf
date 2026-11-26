# Edge HTTPS policy for the Cloudflare-proxied frontend hostnames: p2party.com,
# www, dev and cdn. Signaling, TURN and STUN are DNS-only records that Caddy and
# coturn terminate themselves, so these zone settings never reach them.
#
# Both resources default to unmanaged, like the response-header rule. See
# deploy/README.md#frontend-https-and-tls for permissions and rollout order.
# None of this authenticates the hop from Cloudflare to the S3 website origin,
# which speaks HTTP only; the README says what that requires.
locals {
  # One HSTS policy for the zone setting and the response-header rule, so the
  # two Cloudflare features never send different values. It renders to the
  # header the rule has served on the apex since 2026-09-09.
  frontend_hsts = {
    max_age            = 63072000
    include_subdomains = true
    preload            = true
  }
  frontend_hsts_header = join("; ", compact([
    "max-age=${local.frontend_hsts.max_age}",
    local.frontend_hsts.include_subdomains ? "includeSubDomains" : "",
    local.frontend_hsts.preload ? "preload" : "",
  ]))

  frontend_redirect_ruleset_name = "p2party frontend redirects"
  frontend_www_redirect_rule_ref = "p2party_frontend_www_to_https_apex"
  frontend_www_redirect_target   = "concat(\"https://p2party.com\", http.request.uri.path)"
}

# Records the zone's current values in `initial_settings` when created and
# changes only the settings named here. Removing it restores those values.
resource "cloudflare_zone_settings_override" "frontend_tls" {
  count = var.manage_frontend_tls_settings ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party

  settings {
    always_use_https = "on"
    min_tls_version  = "1.2"

    security_header {
      enabled            = true
      max_age            = local.frontend_hsts.max_age
      include_subdomains = local.frontend_hsts.include_subdomains
      preload            = local.frontend_hsts.preload
      # X-Content-Type-Options stays with the response-header rule, which sets it
      # on app hostnames only; cdn serves SDK artifacts and keeps its behavior.
      nosniff = false
    }
  }
}

# Same ownership guard as the response-header phase: an unmanaged ruleset or
# a dashboard-added rule in this phase stops the plan instead of being deleted.
data "cloudflare_rulesets" "frontend_redirects" {
  count = var.manage_frontend_www_redirect ? 1 : 0

  zone_id       = var.cloudflare_zone_id_p2party
  include_rules = true

  filter {
    kind  = "zone"
    phase = "http_request_dynamic_redirect"
  }
}

# Runs at the edge before the request reaches the www S3 bucket, whose own
# redirect points at http://p2party.com/. Browsers keep the URL fragment across
# the redirect, so an invitation's capability stays in the fragment.
resource "cloudflare_ruleset" "frontend_redirects" {
  count = var.manage_frontend_www_redirect ? 1 : 0

  zone_id     = var.cloudflare_zone_id_p2party
  name        = local.frontend_redirect_ruleset_name
  description = "Canonical HTTPS redirect for www.p2party.com"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules {
    ref         = local.frontend_www_redirect_rule_ref
    description = "www.p2party.com to https://p2party.com with path and query"
    expression  = "(http.host eq \"www.p2party.com\")"
    action      = "redirect"
    enabled     = var.frontend_www_redirect_enabled

    action_parameters {
      from_value {
        status_code           = 301
        preserve_query_string = true

        target_url {
          expression = local.frontend_www_redirect_target
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = alltrue([
        for ruleset in data.cloudflare_rulesets.frontend_redirects[0].rulesets :
        ruleset.name == local.frontend_redirect_ruleset_name && alltrue([
          for rule in ruleset.rules : rule.ref == local.frontend_www_redirect_rule_ref
        ])
      ])
      error_message = "The single-redirect phase contains an unmanaged ruleset or additional rules. Preserve that existing configuration and reconcile Terraform ownership before enabling this resource; do not replace the phase with only the www redirect."
    }
  }
}
