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

**The default TURN budget permits 48 ordinary concurrent allocations.**
The aggregate budget is 30,000,000 bytes/second and the per-allocation budget is
625,000 bytes/second. Ordinary clients reserve the per-allocation maximum even
when idle; input and output are counted separately. Set the Ansible variable
`coturn_bps_capacity` higher for larger relay-heavy rooms and apply
`playbooks/setup-coturn.yml`. Both bandwidth settings must be positive. Allocation
quotas remain 1,200 total and 12 per credential username, and an allocation
that is not refreshed is released within `coturn_max_allocate_lifetime` (600 s
by default). The playbook refuses settings where `coturn_user_quota` ×
`coturn_max_bps`, what one credential username can reserve, exceeds half of
`coturn_bps_capacity`.

coturn counts the quota per username, here the hourly tag, and checks a
username's expiry only on a session's first request (`check_stun_auth` in
`src/server/ns_turn_server.c`, coturn 4.6.1 and master `44fa529`). One identity
therefore holds at most three tags' quota at once if it stops refreshing, and
gains one more tag's quota every lifetime for as long as it keeps refreshing its
old allocations. The quota guards against one client's runaway use; it is not a
bound on an adversary, who can also simply use several identities. See "Relay
bound" in the root [README](../README.md#relay-bound), and its
[admission section](../README.md#admission-and-database-security) for
signaling admission defaults, trusted proxy handling and their overrides.

### Relay exhaustion

The relay's total capacity is the only hard limit: `total-quota` (1,200
allocations) and `coturn_bps_capacity` (30,000,000 bytes/second, 48 reserved
allocations at the default `coturn_max_bps`). Four identities with a full quota
each reserve all of it. Once it is reached, coturn answers new Allocate requests
with 486 ("Allocation Quota Reached" or "Allocation Bandwidth Quota Reached"),
and clients that need the relay cannot connect.

With this template an operator sees no sign of exhaustion on the TURN host: the
log goes to `/dev/null`, the telnet CLI is off (`no-cli`), and neither coturn's
`prometheus` exporter nor its `redis-statsdb` statistics are configured.
Diagnosing it means enabling one of them for the occasion, for example running
`turnserver` by hand with `--log-file=stdout`, or `--prometheus` without
username labels if the installed package was built with it. Clients report
relay failures before the host does.

Two mitigations were considered and not built:

- **Per-source-address limits at the TURN host's firewall**, for example
  nftables connection or rate limits on ports 3478 and 443. They cap what one
  address can open, but everyone behind one carrier-grade NAT or campus address
  shares the limit, and an adversary with many addresses is not slowed.
- **A stable per-identity tag with TLS-only TURN** (no plain `turn:` URL).
  coturn would pool the quota per identity and the pseudonym would cross the
  network only inside TLS. But the TURN host would hold a permanent pseudonym
  per identity, every relayed connection would move to TLS over TCP with its
  head-of-line blocking and connectivity cost, and an adversary with several
  identities would still not be bounded.

## Upgrading to 0.1.5

Where several workers share a database, stop every 0.1.4 worker before the first
0.1.5 worker starts and run all workers under one database role: a 0.1.5 worker
counts another as live only through its named PostgreSQL session, which 0.1.4
does not open, so it would clear a running 0.1.4 worker's routing claims.

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
matches only `p2party.com` until `frontend_response_headers_all_app_hosts` is
set (see [Frontend HTTPS and TLS](#frontend-https-and-tls)); signaling continues
to set its own headers in Caddy. Both management and activation default to
`false`, so an ordinary server deploy does not change the frontend edge policy.
The apex DNS record must be proxied through Cloudflare for the rule to run. This
rule is the only source of HSTS that Terraform manages; the zone HSTS setting
is left unmanaged on purpose (see [Frontend HTTPS and TLS](#frontend-https-and-tls)).

Terraform 1.2+ is required for the ownership precondition. Terraform 1.7+ runs
the offline provider-mock plans covering the default-off behavior, disabled
initial rules, existing-rule preservation, and that each opt-in changes only its
own resource. Run them from a clean copy of the committed tree. In
`deploy/terraform` itself, `terraform test` loads the ignored `terraform.tfvars`,
whose rollout flags make the default-off tests fail. From the repository root,
after `./deploy/tf init` has installed the providers:

```bash
tf_test_dir="$(mktemp -d)"
git archive HEAD deploy/terraform deploy/ssh_public_keys | tar -x -C "$tf_test_dir"
cp deploy/ssh_public_keys/*.pub "$tf_test_dir/deploy/ssh_public_keys/"
terraform -chdir="$tf_test_dir/deploy/terraform" init -backend=false \
  -plugin-dir="$PWD/deploy/terraform/.terraform/providers"
terraform -chdir="$tf_test_dir/deploy/terraform" test
rm -rf "$tf_test_dir"
```

The copy holds no state, variables file or credentials, and every provider is
mocked, so nothing contacts Cloudflare or Hetzner.

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

## Frontend HTTPS and TLS

On 2026-09-09 the apex and dev answered 200 over plain HTTP, www redirected
both HTTP and HTTPS requests to `http://p2party.com/`, and apex, www, cdn and dev
accepted TLS 1.0 and 1.1. On 2026-11-26 the apex still answered 200 over HTTP
and `https://www.p2party.com/` still redirected to `http://p2party.com/`. The www
redirect comes from the www S3 bucket, not from Cloudflare.
[`terraform/p2party_frontend_tls.tf`](terraform/p2party_frontend_tls.tf) and
the header rule above declare the fix in three opt-ins, each defaulting to
`false` so an ordinary server deploy changes none of it:

- `manage_frontend_www_redirect`, then `frontend_www_redirect_enabled`: a
  single-redirect rule sends every `www.p2party.com` request to
  `https://p2party.com` with the same path and query (301), at the edge, before
  the request reaches the bucket. Browsers keep the URL fragment, so an
  invitation's capability survives the redirect. The rule is created disabled;
  the second flag activates it.
- `manage_frontend_tls_settings`: Always Use HTTPS on and minimum TLS 1.2, as
  zone settings, so they apply to every proxied record in the zone, including
  any added after 2026-09-09 (then: apex, www, dev, cdn). Takes effect on apply.
- `frontend_response_headers_all_app_hosts`: the existing header rule matches
  `p2party.com`, `www.p2party.com` and `dev.p2party.com` instead of the apex
  only. cdn is excluded: it serves SDK files to other sites.

**HSTS has one source, the header rule.** The zone HSTS setting is not managed
here and should stay off in the dashboard. Cloudflare's public documentation
gives no accepted range for that setting's max-age, so the rule's two-year value
could fail part-way through an apply. It also does not say what happens when a
response already carries `Strict-Transport-Security`, so two values could be
sent. As a result cdn sends no HSTS header of its own. Browsers that have
visited the apex over HTTPS apply its `includeSubDomains` to cdn as well.

**What this does not fix.** The four proxied hostnames are CNAMEs to S3 website
endpoints, which serve HTTP only and do not listen on port 443. Cloudflare
therefore fetches every page and script from S3 over unauthenticated HTTP across
the internet. Anyone on that path can read or replace the app's JavaScript
before Cloudflare serves it over HTTPS. These settings protect only the hop
between the visitor and Cloudflare. Closing the other hop needs an origin that
terminates TLS with a certificate Cloudflare verifies, and then the zone SSL
mode set to Full (strict). One option is a TLS-terminating CDN in front of the
bucket, for example CloudFront with origin access. That requires the S3 REST
endpoint instead of the website endpoint, which loses the website endpoint's
index documents and redirect rules, so `/r`, directory indexes and the www
redirect must then be handled by CloudFront or Cloudflare rules. The other is
serving the files from Cloudflare itself, for example Pages, so that no public
origin hop remains. This Terraform does not manage the SSL mode. Do not switch
it to Full or Full (strict) while the origin is an S3 website endpoint: with
nothing on port 443, both modes fail.

Before enabling any of them:

1. Give the existing zone-scoped token **Zone → Zone Settings → Edit** and
   **Zone → Single Redirect → Edit**. On 2026-09-09 the token returned 403 for
   zone settings and Page Rules. Keep the token in ignored `deploy/.env`.
2. Inspect the `http_request_dynamic_redirect` phase (Rules → Redirect Rules)
   and every Terraform state that might own it. On 2026-09-09 the zone had no
   ruleset in that phase. As with the header rule, the opt-in data source
   refuses a differently named ruleset or any additional rule, and a 403 is an
   unresolved ownership check. Also look for a Page Rule that forwards www; it
   was unreadable on 2026-09-09.
3. Deploy a CSP-compatible build to dev, or remove the dev record and bucket,
   before step 8. The dev page recorded on 2026-09-09 was a January 2025 build.

Roll out one opt-in per reviewed plan, from the repository root, after
`./deploy/tf init -lockfile=readonly` and `./deploy/tf validate`. Each plan
must show only the change named, apart from drift you have reviewed:

4. Set `manage_frontend_www_redirect = true` in ignored `terraform.tfvars`, then
   `./deploy/tf plan -out=tfplan` and `./deploy/tf apply tfplan`. One ruleset
   is added with its rule disabled.
5. Set `frontend_www_redirect_enabled = true`, plan, apply (one ruleset updated
   in place). Check that `https://www.p2party.com/r?x=1` and
   `http://www.p2party.com/r?x=1` answer 301 with
   `location: https://p2party.com/r?x=1`.
6. Before the zone settings, take stock, because they reach every proxied
   record and not only the four above. In the dashboard, list the DNS records
   whose proxy status is Proxied and confirm each one can serve HTTPS at the
   edge. In the zone's analytics, check which TLS versions clients of
   `cdn.p2party.com` use: other sites load the SDK from there, and TLS 1.0 and
   1.1 clients lose access in step 7. Write down the current Always Use HTTPS
   and Minimum TLS Version values (SSL/TLS → Edge Certificates); confirm the
   HSTS setting there is off.
7. Set `manage_frontend_tls_settings = true`, plan, apply (one
   `cloudflare_zone_settings_override` added). Check that
   `http://p2party.com/`, `http://dev.p2party.com/` and `http://cdn.p2party.com/`
   answer 301 to HTTPS; that a TLS 1.1 handshake to each of the four hostnames
   is refused (allow legacy ciphers locally, for example
   `openssl s_client -tls1_1 -cipher 'DEFAULT:@SECLEVEL=0'`, so a local refusal
   is not mistaken for the server's); and that HTTPS responses on the apex still
   carry exactly one
   `strict-transport-security: max-age=63072000; includeSubDomains; preload`.
8. Set `frontend_response_headers_all_app_hosts = true`, plan, apply (the header
   ruleset updated in place). Verify all five headers, including that single
   HSTS value, on dev pages; record which headers the edge-generated www
   redirect carries; then repeat the header rule's browser checks on dev.

If the apply in step 7 fails part-way:

- See what Cloudflare now has: SSL/TLS → Edge Certificates shows Always Use
  HTTPS and Minimum TLS Version. Compare them with the values written down in
  step 6.
- See what Terraform recorded: `./deploy/tf state list | grep frontend_tls`.
  If the resource is listed,
  `./deploy/tf state show 'cloudflare_zone_settings_override.frontend_tls[0]'`
  shows whether it is tainted, and its `initial_settings` holds the values read
  before the change.
- Get back to a clean state: fix the cause (for example the token permission).
  If the resource is in state with `initial_settings` filled in, either apply a
  fresh plan with the flag still `true` (a tainted resource is destroyed, which
  restores `initial_settings`, then created again), or set
  `manage_frontend_tls_settings = false` and apply, which destroys it and
  restores those values. If `initial_settings` is empty, or the resource is not
  in state, run
  `./deploy/tf state rm 'cloudflare_zone_settings_override.frontend_tls[0]'`
  (when listed), set any changed value back by hand to what step 6 recorded,
  and start step 7 again.

For rollback, set `frontend_www_redirect_enabled = false` or
`frontend_response_headers_all_app_hosts = false` and apply the reviewed plan;
`prevent_destroy` protects the redirect phase as it does the header phase.
Browsers cache the 301. Setting `manage_frontend_tls_settings = false` destroys
the override, which restores the values the provider recorded when it was
created; read them first with
`./deploy/tf state show 'cloudflare_zone_settings_override.frontend_tls[0]'`.
Browsers that received HSTS keep it until it expires. Fix the www bucket's own
redirect to `https` as well, so disabling the edge rule does not bring the
downgrade back.

The offline tests in [Frontend response headers](#frontend-response-headers)
also cover these defaults, the disabled first redirect, the redirect phase
ownership checks, the unmanaged zone HSTS setting, the host list, and that each
flag changes only its own resource. Run them from a clean copy as shown there.
