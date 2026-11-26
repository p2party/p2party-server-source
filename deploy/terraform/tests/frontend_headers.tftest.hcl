# These plans use provider mocks; they never read or modify infrastructure.
# `terraform test` requires Terraform 1.7+ for provider mocks.
mock_provider "cloudflare" {
  mock_data "cloudflare_rulesets" {
    defaults = {
      rulesets = []
    }
  }
}

mock_provider "hcloud" {}
mock_provider "null" {}

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

  override_data {
    target = data.cloudflare_rulesets.frontend_response_headers[0]
    values = {
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

  override_data {
    target = data.cloudflare_rulesets.frontend_response_headers[0]
    values = {
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

  override_data {
    target = data.cloudflare_rulesets.frontend_response_headers[0]
    values = {
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
    condition = one([
      for header in cloudflare_ruleset.frontend_response_headers[0].rules[0].action_parameters[0].headers :
      header.value if header.name == "Strict-Transport-Security"
    ]) == "max-age=63072000; includeSubDomains; preload"
    error_message = "The HSTS value served since 2026-09-09 must not change as a side effect."
  }
}

run "header_rule_covers_every_app_hostname_after_opt_in" {
  command = plan

  variables {
    manage_frontend_response_headers        = true
    frontend_response_headers_all_app_hosts = true
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].expression == "(http.host in {\"p2party.com\" \"www.p2party.com\" \"dev.p2party.com\"})"
    error_message = "The security headers must reach the apex, www and dev, and not the SDK CDN."
  }
}
