# Edge HTTPS policy for the Cloudflare-proxied frontend hostnames: p2party.com,
# www, dev and cdn. Signaling, TURN and STUN are DNS-only records that Caddy and
# coturn terminate themselves, so these zone settings never reach them.
#
# Both resources default to unmanaged, like the response-header rule. See
# deploy/README.md#frontend-https-and-tls for permissions and rollout order.
# None of this authenticates the hop from Cloudflare to the S3 website origin,
# which speaks HTTP only; the README says what that requires.
locals {
  frontend_redirect_ruleset_name = "p2party frontend redirects"
  frontend_www_redirect_rule_ref = "p2party_frontend_www_to_https_apex"
  frontend_www_redirect_target   = "concat(\"https://p2party.com\", http.request.uri.path)"
}

# Records the zone's current values in `initial_settings` when created and
# changes only the settings named here. Removing it restores those values.
#
# HSTS is deliberately not managed here. Its only source is the response-header
# rule in p2party_frontend_headers.tf. Cloudflare's public documentation gives
# no accepted range for the zone setting's max_age, so the rule's 63072000 could
# fail mid-apply. It also does not say what happens when a response already
# carries Strict-Transport-Security, so two values could be sent.
resource "cloudflare_zone_settings_override" "frontend_tls" {
  count = var.manage_frontend_tls_settings ? 1 : 0

  zone_id = var.cloudflare_zone_id_p2party

  settings {
    always_use_https = "on"
    min_tls_version  = "1.2"
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
