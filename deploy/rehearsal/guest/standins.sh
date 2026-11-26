#!/bin/bash
# ============================================================================
# What stands in, inside the rehearsal VM, for what a local VM cannot have
# ============================================================================
# Run as root inside the VM by run.sh, one step at a time:
#   standins.sh <step> [arguments]
# Each step is listed in deploy/rehearsal/README.md ("What stands in for
# what"), with the production state it replaces.
# ============================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

step="${1:?step}"
shift

case "$step" in
  # The operator reaches production over WireGuard into 10.231.0.0/24, and the
  # signaling cloud-init allows SSH only from there. Lima's SSH arrives from
  # the user-mode network's gateway; this rule stands in for that path. It is
  # added before the cloud-init firewall is enabled.
  lima-ssh-firewall)
    source_net="${1:?source network}"
    ufw allow from "$source_net" to any port 22 proto tcp comment 'rehearsal: Lima SSH, stands in for the private network'
    ;;

  # The private network: the two addresses production's playbooks use for the
  # PostgreSQL host (10.231.0.2) and the signaling host (10.231.0.4), on a dummy
  # interface of this one VM. Traffic between them never leaves the VM.
  private-network)
    cat >/etc/systemd/network/10-p2party0.netdev <<'UNIT'
[NetDev]
Name=p2party0
Kind=dummy
UNIT
    cat >/etc/systemd/network/10-p2party0.network <<'UNIT'
[Match]
Name=p2party0

[Network]
Address=10.231.0.2/24
Address=10.231.0.4/24
ConfigureWithoutCarrier=yes
UNIT
    networkctl reload
    for _ in $(seq 1 30); do
      ip -4 addr show p2party0 2>/dev/null | grep -q 10.231.0.4 && break
      sleep 1
    done
    ip -4 -br addr show p2party0
    ;;

  # PostgreSQL 17 comes from apt.postgresql.org in production (cloud-init and
  # install-postgres.yml); the rehearsal may use Ubuntu's mirrors only, whose
  # 24.04 release ships PostgreSQL 16. With psql present, install-postgres.yml
  # skips its own install block and configures this one. python3-psycopg2 is
  # in the PostgreSQL host's cloud-init package list; the signaling host's
  # (applied here) does not have it, and community.postgresql needs it.
  postgresql-from-ubuntu)
    apt-get update -q
    apt-get install -y -q postgresql-16 python3-psycopg2
    psql --version
    ;;

  # Caddy comes from Caddy's Cloudsmith repository in production
  # (initial-setup.yml); the rehearsal installs Ubuntu's caddy package
  # instead. The playbook adds the repository only when these two files are
  # missing (`creates:`), so they are created here: an empty keyring and a
  # source list with no source.
  caddy-from-ubuntu)
    install -m 0644 /dev/null /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    printf '# rehearsal: Caddy comes from Ubuntu, not Cloudsmith\n' \
      >/etc/apt/sources.list.d/caddy-stable.list
    ;;

  # The production hosts are x86-64. Rosetta runs x86-64 programs in this
  # aarch64 VM, but the x86-64 Bun, the release binary (built by `bun build
  # --compile`) and Prisma's x86-64 schema engine are linked against the
  # x86-64 C runtime and OpenSSL, which come from Ubuntu's amd64 archive
  # (multiarch); the arm64 mirror stays the source for everything else.
  amd64-runtime)
    dpkg --add-architecture amd64
    "$0" amd64-sources
    cat >/etc/apt/sources.list.d/ubuntu-amd64.sources <<'SOURCES'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-security
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
    apt-get update -q
    apt-get install -y -q libc6:amd64 libgcc-s1:amd64 libssl3t64:amd64 zlib1g:amd64
    dpkg-query -W -f '${Package}:${Architecture} ${Version}\n' libc6:amd64 libssl3t64:amd64
    ;;

  # The arm64 mirror serves no amd64 indexes, so its entries are limited to
  # arm64. cloud-init rewrites this file when it runs its apt module again,
  # which it does on every Lima start; run.sh repeats this step after a start.
  amd64-sources)
    sources=/etc/apt/sources.list.d/ubuntu.sources
    grep -q '^Architectures:' "$sources" || sed -i 's/^Types: deb$/Types: deb\nArchitectures: arm64/' "$sources"
    ;;

  # The host's Bun: production's initial-setup.yml runs Bun's online installer
  # (bun.sh) when ~p2party/.bun/bin/bun is missing. The rehearsal puts a
  # checksum-verified release there instead (run.sh copies it into the VM).
  host-bun)
    source_binary="${1:?bun binary}"
    install -D -o p2party -g p2party -m 0755 "$source_binary" /home/p2party/.bun/bin/bun
    chown p2party:p2party /home/p2party/.bun /home/p2party/.bun/bin
    sudo -u p2party /home/p2party/.bun/bin/bun --version
    ;;

  # The migrate task runs Prisma's CLI, which reports usage to
  # checkpoint.prisma.io unless CHECKPOINT_DISABLE is set; the playbook does
  # not set it. The rehearsal sets it for every session and also points the
  # name at nothing, so no such report leaves the VM.
  no-prisma-checkpoint)
    grep -q '^CHECKPOINT_DISABLE=' /etc/environment || echo 'CHECKPOINT_DISABLE=1' >>/etc/environment
    grep -q 'checkpoint.prisma.io' /etc/hosts || echo '0.0.0.0 checkpoint.prisma.io' >>/etc/hosts
    ;;

  # Public certificates: Caddy gets one for a *.localhost name from its own
  # local CA. deploy.yml reads https://<signaling name>/health with
  # certificate validation, so the VM trusts that CA.
  trust-caddy-ca)
    root=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
    for _ in $(seq 1 30); do
      [ -s "$root" ] && break
      sleep 1
    done
    [ -s "$root" ] || { echo "Caddy's local CA has not been created ($root)" >&2; exit 1; }
    install -m 0644 "$root" /usr/local/share/ca-certificates/p2party-rehearsal-caddy-local.crt
    update-ca-certificates >/dev/null
    openssl x509 -in "$root" -noout -subject -fingerprint -sha256
    ;;

  # setup-coturn.yml asks Let's Encrypt for a certificate (certbot
  # standalone) when /etc/letsencrypt/live/<realm>/fullchain.pem is missing.
  # Without a public address that cannot work, and the names must not reach a
  # public CA; a self-signed pair in that place makes the play skip certbot.
  coturn-certificate)
    realm="${1:?realm}"
    stun="${2:?stun name}"
    live="/etc/letsencrypt/live/$realm"
    mkdir -p "$live"
    # certbot creates its hook directories on its first run, which is skipped
    # here; the play writes its deploy hook into one of them.
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$realm" \
      -addext "subjectAltName=DNS:$realm,DNS:$stun" \
      -keyout "$live/privkey.pem" -out "$live/fullchain.pem" 2>/dev/null
    chmod 0600 "$live/privkey.pem"
    openssl x509 -in "$live/fullchain.pem" -noout -subject
    ;;

  *)
    echo "unknown step $step" >&2
    exit 2
    ;;
esac
