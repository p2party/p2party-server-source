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

run "existing_server_operation_does_not_manage_frontend_headers" {
  command = plan

  assert {
    condition     = length(cloudflare_ruleset.frontend_response_headers) == 0
    error_message = "Default server operations must not opt into frontend header management."
  }
}

run "new_phase_starts_disabled" {
  command = plan

  variables {
    manage_frontend_response_headers = true
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].enabled == false
    error_message = "Provisioning a response-header ruleset must not activate CSP before the frontend is ready."
  }
}

run "existing_foreign_phase_is_not_replaced" {
  command = plan

  variables {
    manage_frontend_response_headers = true
  }

  override_module {
    target = module.frontend_response_headers_inventory[0]
    outputs = {
      rulesets = [{
        name  = "Existing response policy"
        rules = []
      }]
    }
  }

  expect_failures = [cloudflare_ruleset.frontend_response_headers[0]]
}

run "dashboard_added_rule_is_not_deleted" {
  command = plan

  variables {
    manage_frontend_response_headers = true
  }

  override_module {
    target = module.frontend_response_headers_inventory[0]
    outputs = {
      rulesets = [{
        name = "p2party frontend response headers"
        rules = [{
          ref = "additional_dashboard_rule"
        }]
      }]
    }
  }

  expect_failures = [cloudflare_ruleset.frontend_response_headers[0]]
}

run "previously_managed_rule_can_be_enabled" {
  command = plan

  variables {
    manage_frontend_response_headers  = true
    frontend_response_headers_enabled = true
  }

  override_module {
    target = module.frontend_response_headers_inventory[0]
    outputs = {
      rulesets = [{
        name = "p2party frontend response headers"
        rules = [{
          ref = "p2party_frontend_security_headers"
        }]
      }]
    }
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].enabled
    error_message = "The reviewed, previously managed rule must remain updatable."
  }
}

# The rule has been live on the apex since 2026-09-09 with both flags enabled.
# Without a new opt-in, a plan must leave its match and HSTS value unchanged.
run "live_rule_keeps_its_apex_match_and_hsts_value" {
  command = plan

  variables {
    manage_frontend_response_headers  = true
    frontend_response_headers_enabled = true
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].expression == "(http.host eq \"p2party.com\")"
    error_message = "Extending the rule beyond the apex must be an explicit opt-in."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].action_parameters.headers["Strict-Transport-Security"].value == "max-age=63072000; includeSubDomains; preload"
    error_message = "The HSTS value served since 2026-09-09 must not change as a side effect."
  }

  assert {
    condition     = length(cloudflare_zone_setting.frontend_tls) == 0
    error_message = "The live header flags must not also change zone TLS settings."
  }

  assert {
    condition     = length(cloudflare_ruleset.frontend_redirects) == 0
    error_message = "The live header flags must not also take over the redirect phase."
  }
}

run "header_rule_covers_every_app_hostname_after_opt_in" {
  command = plan

  variables {
    manage_frontend_response_headers        = true
    frontend_response_headers_enabled       = true
    frontend_response_headers_all_app_hosts = true
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].expression == "(http.host in {\"p2party.com\" \"www.p2party.com\" \"dev.p2party.com\"})"
    error_message = "The security headers must reach the apex, www and dev, and not the SDK CDN."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].action_parameters.headers["Strict-Transport-Security"].value == "max-age=63072000; includeSubDomains; preload"
    error_message = "The rule is the only source of HSTS, so every app host must get the same value."
  }

  assert {
    condition     = length(cloudflare_zone_setting.frontend_tls) == 0
    error_message = "The host opt-in must not also change zone TLS settings."
  }

  assert {
    condition     = length(cloudflare_ruleset.frontend_redirects) == 0
    error_message = "The host opt-in must not also take over the redirect phase."
  }
}
