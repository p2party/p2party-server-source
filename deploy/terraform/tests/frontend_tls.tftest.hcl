# These plans use provider mocks; they never read or modify infrastructure.
# `terraform test` requires Terraform 1.7+ for provider mocks.
#
# Each opt-in run starts from the deployment's live baseline (header rule
# managed and enabled) and asserts that the other frontend resources stay as
# they were, so a flag wired to a second resource fails here.
#
# "Zone settings stay unmanaged" reads one attribute through try() instead of
# length() over the resource: when that assertion fails, Terraform 1.15.5
# panics while rendering the whole zone-settings object ("value has marks").
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

run "existing_server_operation_does_not_manage_edge_tls_or_redirects" {
  command = plan

  assert {
    condition     = try(cloudflare_zone_settings_override.frontend_tls[0].zone_id, "unmanaged") == "unmanaged"
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
  }

  assert {
    condition     = cloudflare_zone_settings_override.frontend_tls[0].settings[0].always_use_https == "on"
    error_message = "Plain HTTP must be redirected to HTTPS at the edge."
  }

  assert {
    condition     = cloudflare_zone_settings_override.frontend_tls[0].settings[0].min_tls_version == "1.2"
    error_message = "The edge must refuse TLS 1.0 and 1.1."
  }

  assert {
    condition     = length(cloudflare_zone_settings_override.frontend_tls[0].settings[0].security_header) == 0
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
    condition     = cloudflare_ruleset.frontend_redirects[0].rules[0].enabled == false
    error_message = "Provisioning the redirect ruleset must not activate the redirect before review."
  }

  assert {
    condition     = try(cloudflare_zone_settings_override.frontend_tls[0].zone_id, "unmanaged") == "unmanaged"
    error_message = "The redirect opt-in must not also change zone TLS settings."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_response_headers[0].rules[0].expression == "(http.host eq \"p2party.com\")"
    error_message = "The redirect opt-in must not extend the live header rule to other hosts."
  }
}

run "www_redirects_to_https_apex_keeping_path_and_query" {
  command = plan

  variables {
    manage_frontend_response_headers  = true
    frontend_response_headers_enabled = true
    manage_frontend_www_redirect      = true
    frontend_www_redirect_enabled     = true
  }

  override_data {
    target = data.cloudflare_rulesets.frontend_redirects[0]
    values = {
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
    condition     = cloudflare_ruleset.frontend_redirects[0].rules[0].expression == "(http.host eq \"www.p2party.com\")"
    error_message = "Only www may be redirected; the apex must keep serving the app."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_redirects[0].rules[0].action_parameters[0].from_value[0].target_url[0].expression == "concat(\"https://p2party.com\", http.request.uri.path)"
    error_message = "www must redirect to the HTTPS apex with the request path."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_redirects[0].rules[0].action_parameters[0].from_value[0].preserve_query_string
    error_message = "The redirect must keep the query string."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_redirects[0].rules[0].action_parameters[0].from_value[0].status_code == 301
    error_message = "The canonical-host redirect is permanent."
  }

  assert {
    condition     = cloudflare_ruleset.frontend_redirects[0].rules[0].enabled
    error_message = "The reviewed, previously managed redirect must remain updatable."
  }

  assert {
    condition     = try(cloudflare_zone_settings_override.frontend_tls[0].zone_id, "unmanaged") == "unmanaged"
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

  override_data {
    target = data.cloudflare_rulesets.frontend_redirects[0]
    values = {
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

  override_data {
    target = data.cloudflare_rulesets.frontend_redirects[0]
    values = {
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
