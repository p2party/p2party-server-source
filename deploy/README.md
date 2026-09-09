# Deploying p2party-server

The reference deployment uses one signaling worker, PostgreSQL, Caddy and
coturn. Copy the tracked example inventory and vault files to their ignored
operational paths, encrypt the vault, and configure SSH access before deploying.
Never commit the resulting credentials, inventory, Terraform state or logs.

Run a release from the repository root:

```bash
bun install --frozen-lockfile
bun run check
bun run format:check
./deploy/deploy.sh
```

The wrapper builds this repository's Linux binary, provisions verified database
TLS, copies the binary and environment, installs migration tooling from this
release's `package.json` and `bun.lockb`, applies pending migrations, restarts the
desired worker, and verifies its version through Caddy. The migration CLI lives
in a separate `migration-tooling` directory; it uses the same audited dependency
overrides as the release rather than fetching an independent CLI dependency tree.
Its working directory remains the server directory containing `prisma.config.ts`
and `prisma/`. No schema migration is added by release 0.1.4.

## Relay capacity

**The default TURN budget permits about ten ordinary concurrent allocations.**
The aggregate budget is 30,000,000 bytes/second and the per-allocation budget is
3,000,000 bytes/second. Ordinary clients reserve the per-allocation maximum even
when idle; input and output are counted separately. Set the Ansible variable
`coturn_bps_capacity` higher for larger relay-heavy rooms and apply
`playbooks/setup-coturn.yml`. Both bandwidth settings must be positive. Allocation
quotas remain 1,200 total and 12 per credential username.

This is a capacity and cost guard, not proof of unique users. See the root
[README](../README.md#admission-and-database-security) for signaling admission
defaults, trusted proxy handling and their operator overrides.

## Database trust

`playbooks/postgres-tls.yml` creates a private database CA and a server certificate
with the configured private IP in its SAN. Only the public CA certificate is
copied to signaling hosts over SSH. PostgreSQL rejects plaintext private-network
connections before legacy HBA rules; clients use `verify-full` and the pinned CA.
The playbook checks certificate chain, IP, private-key match and expiry before
restarting services. Run provisioning monthly for leaf renewal. CA rotation is
explicit and requires protected operational backups of the CA key.

The first rollout changes database TLS configuration and may restart PostgreSQL.
Schedule that rollout accordingly. Local development uses the explicit
`sslmode=disable` URL in `.env.example`; production must retain verified TLS.

## Frontend response headers

[`terraform/p2party_frontend_headers.tf`](terraform/p2party_frontend_headers.tf)
manages the five response headers documented by the frontend: CSP,
Permissions-Policy, Referrer-Policy, HSTS and X-Content-Type-Options. The rule
matches only `p2party.com`; signaling continues to set its own headers in Caddy.
Both management and activation default to `false`, so an ordinary server deploy
does not change the frontend edge policy. The apex DNS record must be proxied
through Cloudflare for the rule to run.

Terraform 1.2+ is required for the ownership precondition. With Terraform 1.7+,
run `terraform -chdir=deploy/terraform test` for the offline provider-mock plans
covering the default-off behavior, disabled initial rule, and existing-rule
preservation.

The CSP permits same-origin scripts and WebAssembly compilation, without
allowing inline JavaScript. **Deploy and test a CSP-compatible frontend before
activating it.** Earlier prerenders contained inline React hydration scripts
that this policy blocks. Do not weaken `script-src` to make an older build pass.
Inline styles remain permitted for the frontend's existing React style usage.

Cloudflare has one zone entrypoint ruleset for
`http_response_headers_transform`; this Terraform resource owns its complete
rule list. Before enabling management:

1. Give the existing zone-scoped token **Zone → Transform Rules → Edit** in
   addition to its DNS permissions. The corresponding API permission is
   `Zone Transform Rules Write`; read access is required to inspect the phase.
   Keep the token in ignored `deploy/.env`, never a tracked Terraform file.
2. Inspect the response-header phase in Cloudflare and every Terraform state
   that might own it. The opt-in data source reads existing rules and refuses a
   differently named ruleset or any additional rule references. A 403 is an
   unresolved ownership check, not evidence that no rules exist.
3. If the phase is absent, set `manage_frontend_response_headers = true` in
   ignored `terraform.tfvars` while keeping `frontend_response_headers_enabled
= false`. If it exists, preserve its rules and reconcile ownership first.
   Importing a populated phase into this single-rule configuration and applying
   would otherwise remove its other rules; the precondition refuses that case.
   A phase already created from this exact configuration may be imported with
   `./deploy/tf import 'cloudflare_ruleset.frontend_response_headers[0]'
'zone/<zone-id>/<ruleset-id>'` after checking its contents.
4. Run `./deploy/tf init -lockfile=readonly`, `./deploy/tf validate`, then
   `./deploy/tf plan -out=tfplan`. Review the entire plan, including unrelated
   infrastructure drift, before applying it. Plan files and JSON plan output can
   contain credentials or infrastructure details; retain them only in ignored,
   private local storage. A newly created rule is disabled until activation.
5. Deploy the frontend build whose browser checks pass with these exact headers.
   Then set `frontend_response_headers_enabled = true`, review a fresh plan, and
   apply that reviewed plan. Verify all five headers on `/`, `/r`, and a blog
   route, then test a room join, text/file delivery and reload recovery against
   the public frontend.

For rollback, set `frontend_response_headers_enabled = false` and review/apply
the resulting rule update. Keep management enabled; `prevent_destroy` protects
the entire phase ruleset against accidental removal. A browser that already
received HSTS retains it until expiry, so disabling the rule does not undo that
browser policy immediately.

On 2026-09-09, after updating the token permissions, the response-header phase
was confirmed empty and frontend `deploy-2026-09-09.2` was verified live with
CSP-compatible prerenders. The reviewed full plan created the enabled ruleset:
one resource added, none changed or destroyed. Both flags are now enabled in
the deployment's ignored `terraform.tfvars`; the full post-apply plan reported
no changes and both checks passed.

Public browser checks confirmed all five headers on 15 pages and their assets,
with no CSP violations or uncaught page errors. Separate room checks passed
WebRTC text and byte-exact file delivery, reload recovery with the received
file retained, and same-identity tab replacement under the actual edge policy.

See Cloudflare's [response-transform API workflow](https://developers.cloudflare.com/rules/transform/response-header-modification/create-api/)
and the [version 4 provider ruleset schema](https://registry.terraform.io/providers/cloudflare/cloudflare/4.52.0/docs/resources/ruleset).
