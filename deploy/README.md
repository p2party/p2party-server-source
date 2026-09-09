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
