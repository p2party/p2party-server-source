# Operator SSH public keys

`terraform/p2party_ssh_keys.tf` reads the `.pub` files in this directory and
registers them as `hcloud_ssh_key` resources, which cloud-init then installs on
every server. Terraform's `file()` fails at validate time if a referenced file
is absent, so these must exist before `terraform plan`.

The `.pub` files themselves are gitignored. They are not secrets, but they name
the individuals who hold root on the production hosts, and that list should not
be part of a public repository.

To deploy, place your own public keys here and make sure the filenames match
the ones referenced in `terraform/p2party_ssh_keys.tf`:

```
operator_key_3.pub
operator_key_2.pub
operator_key_1.pub
```

Generate one with:

```sh
ssh-keygen -t ed25519 -C "you@example.com" -f ~/.ssh/your_ed25519
cp ~/.ssh/your_ed25519.pub deploy/ssh_public_keys/
```

If you use different filenames, update `terraform/p2party_ssh_keys.tf` to
match. Renaming an `hcloud_ssh_key` **resource address** (the second label,
e.g. `operator_key_1`) makes Terraform destroy and recreate the key; use
`terraform state mv` instead if you only want to rename the address.
