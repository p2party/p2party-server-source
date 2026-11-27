# Provider mocks and explicit inventory outputs keep these plans offline.
# The two real phase inventories return rulesets and their rule refs.
mock_provider "cloudflare" {}

override_module {
  target  = module.frontend_response_headers_inventory
  outputs = { rulesets = [] }
}

override_module {
  target  = module.frontend_redirects_inventory
  outputs = { rulesets = [] }
}

mock_provider "hcloud" {}

variables {
  hcloud_token               = "test-only-placeholder"
  cloudflare_api_token       = "test-only-placeholder"
  cloudflare_zone_id_p2party = "00000000000000000000000000000000"
  p2party_ssh_admin_ips      = ["203.0.113.4/32"]
}

run "existing_server_operation_does_not_manage_edge_tls_or_redirects" {
  command = plan

  assert {
    condition     = length(cloudflare_zone_setting.frontend_tls) == 0
    error_message = "Default server operations must not take ownership of zone TLS settings."
  }

  assert {
    condition     = length(cloudflare_ruleset.frontend_redirects) == 0
    error_message = "Default server operations must not opt into the redirect phase."
  }
}

run "managed_tls_settings_enforce_https_and_tls12_only" {
  command = plan

  variables {
    manage_frontend_response_headers  = true
    frontend_response_headers_enabled = true
    manage_frontend_tls_settings      = true
    frontend_tls_previous_settings    = { always_use_https = "off", min_tls_version = "1.0" }
  }

  assert {
    condition     = cloudflare_zone_setting.frontend_tls["always_use_https"].value == "on"
    error_message = "Plain HTTP must be redirected to HTTPS at the edge."
  }

  assert {
    condition     = cloudflare_zone_setting.frontend_tls["min_tls_version"].value == "1.2"
    error_message = "The edge must refuse TLS 1.0 and 1.1."
  }

  assert {
    condition     = !contains(keys(cloudflare_zone_setting.frontend_tls), "security_header")
    error_message = "HSTS has one source, the response-header rule; the zone HSTS setting must stay unmanaged."
  }

  assert {
    condition     = length(cloudflare_ruleset.frontend_redirects) == 0
    error_message = "The TLS opt-in must not also take over the redirect phase."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].expression == "(http.host eq \"p2party.com\")"
    error_message = "The TLS opt-in must not extend the live header rule to other hosts."
  }
}

run "new_redirect_phase_starts_disabled" {
  command = plan

  variables {
    manage_frontend_response_headers  = true
    frontend_response_headers_enabled = true
    manage_frontend_www_redirect      = true
  }

  assert {
    condition     = alltrue([for r in cloudflare_ruleset.frontend_redirects[0].rules : r.enabled == false])
    error_message = "Provisioning the redirect ruleset must not activate the redirect before review."
  }

  assert {
    condition     = length(cloudflare_zone_setting.frontend_tls) == 0
    error_message = "The redirect opt-in must not also change zone TLS settings."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].expression == "(http.host eq \"p2party.com\")"
    error_message = "The redirect opt-in must not extend the live header rule to other hosts."
  }
}

run "website_redirects_to_https_apex_keeping_path_and_query" {
  command = plan

  variables {
    manage_frontend_response_headers  = true
    frontend_response_headers_enabled = true
    manage_frontend_www_redirect      = true
    frontend_www_redirect_enabled     = true
  }

  override_module {
    target = module.frontend_redirects_inventory[0]
    outputs = {
      rulesets = [{
        name = "p2party frontend redirects"
        rules = [{
          ref = "p2party_frontend_www_to_https_apex"
        }]
      }]
    }
  }

  assert {
    condition     = cloudflare_ruleset.frontend_redirects[0].phase == "http_request_dynamic_redirect"
    error_message = "The www redirect belongs in the single-redirect phase, ahead of the S3 origin's own redirect."
  }

  assert {
    condition = (
      length(cloudflare_ruleset.frontend_redirects[0].rules) == 2 &&
      cloudflare_ruleset.frontend_redirects[0].rules[1].expression == "(http.host eq \"www.p2party.com\" or (http.host eq \"p2party.com\" and not ssl))" &&
      cloudflare_ruleset.frontend_redirects[0].rules[1].action_parameters.from_value.target_url.expression == "concat(\"https://p2party.com\", http.request.uri.path)"
    )
    error_message = "Canonical HTTPS pages must remain accessible while www and the HTTP apex upgrade to HTTPS."
  }

  assert {
    condition = (
      startswith(cloudflare_ruleset.frontend_redirects[0].rules[0].expression, "(http.host in {\"p2party.com\" \"www.p2party.com\"}") &&
      alltrue([for path in ["/r", "/explorer/testnet", "/wallet/snapshot"] : strcontains(cloudflare_ruleset.frontend_redirects[0].rules[0].expression, jsonencode(path))]) &&
      !strcontains(cloudflare_ruleset.frontend_redirects[0].rules[0].expression, "/.well-known") &&
      cloudflare_ruleset.frontend_redirects[0].rules[0].action_parameters.from_value.target_url.expression == "concat(\"https://p2party.com\", http.request.uri.path, \"/\")"
    )
    error_message = "Invite, explorer and wallet links must reach the correct directory before the origin drops the query."
  }

  assert {
    condition = alltrue([for r in cloudflare_ruleset.frontend_redirects[0].rules :
      r.enabled && r.action_parameters.from_value.status_code == 301 && r.action_parameters.from_value.preserve_query_string
    ])
    error_message = "Both managed rules must activate as permanent redirects that preserve query strings."
  }

  assert {
    condition     = length(cloudflare_zone_setting.frontend_tls) == 0
    error_message = "Activating the redirect must not also change zone TLS settings."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].expression == "(http.host eq \"p2party.com\")"
    error_message = "Activating the redirect must not extend the live header rule to other hosts."
  }
}

run "existing_foreign_redirect_phase_is_not_replaced" {
  command = plan

  variables {
    manage_frontend_www_redirect = true
  }

  override_module {
    target = module.frontend_redirects_inventory[0]
    outputs = {
      rulesets = [{
        name  = "Existing redirect policy"
        rules = []
      }]
    }
  }

  expect_failures = [cloudflare_ruleset.frontend_redirects[0]]
}

run "dashboard_added_redirect_rule_is_not_deleted" {
  command = plan

  variables {
    manage_frontend_www_redirect = true
  }

  override_module {
    target = module.frontend_redirects_inventory[0]
    outputs = {
      rulesets = [{
        name = "p2party frontend redirects"
        rules = [{
          ref = "additional_dashboard_redirect"
        }]
      }]
    }
  }

  expect_failures = [cloudflare_ruleset.frontend_redirects[0]]
}

run "disabling_tls_restores_both_recorded_values" {
  command = plan
  variables {
    manage_frontend_tls_settings   = false
    frontend_tls_previous_settings = { always_use_https = "off", min_tls_version = "1.1" }
  }
  assert {
    condition     = cloudflare_zone_setting.frontend_tls["always_use_https"].value == "off" && cloudflare_zone_setting.frontend_tls["min_tls_version"].value == "1.1"
    error_message = "Opting out must actively restore both original values."
  }
}

run "missing_tls_rollback_values_refuse_management" {
  command = plan
  variables { manage_frontend_tls_settings = true }
  expect_failures = [cloudflare_zone_setting.frontend_tls["always_use_https"], cloudflare_zone_setting.frontend_tls["min_tls_version"]]
}
