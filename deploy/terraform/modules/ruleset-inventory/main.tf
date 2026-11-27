terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "zone_id" { type = string }
variable "phase" { type = string }

# The v5 list response contains metadata only. Read every matching phase
# ruleset by ID so a rule added in the dashboard reaches the ownership guard.
data "cloudflare_rulesets" "zone" {
  zone_id   = var.zone_id
  max_items = 1000
  lifecycle {
    postcondition {
      condition     = length(self.rulesets) < 1000
      error_message = "The zone ruleset listing reached its limit. Confirm the complete phase inventory before changing this zone."
    }
  }
}

data "cloudflare_ruleset" "phase" {
  for_each = toset([
    for ruleset in data.cloudflare_rulesets.zone.rulesets : ruleset.id
    if ruleset.phase == var.phase && ruleset.kind == "zone"
  ])
  zone_id = var.zone_id
  id      = each.value
}

output "rulesets" {
  value = [for ruleset in data.cloudflare_ruleset.phase : {
    name  = ruleset.name
    rules = [for rule in ruleset.rules : { ref = rule.ref }]
  }]
}
