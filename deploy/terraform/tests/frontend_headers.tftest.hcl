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
