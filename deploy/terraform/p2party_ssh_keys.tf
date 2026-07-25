# ============================================================================
# P2Party SSH Keys
# ============================================================================

resource "hcloud_ssh_key" "operator_key_1" {
  name       = "operator_key_1"
  public_key = file("../ssh_public_keys/operator_key_1.pub")
}

resource "hcloud_ssh_key" "operator_key_2" {
  name       = "operator_key_2"
  public_key = file("../ssh_public_keys/operator_key_2.pub")
}

resource "hcloud_ssh_key" "operator_key_3" {
  name       = "operator_key_3"
  public_key = file("../ssh_public_keys/operator_key_3.pub")
}

# Local variable to collect all SSH public keys for cloud-init
locals {
  ssh_public_keys = [
    file("../ssh_public_keys/operator_key_1.pub"),
    file("../ssh_public_keys/operator_key_2.pub"),
    file("../ssh_public_keys/operator_key_3.pub"),
  ]
}
