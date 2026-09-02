# Changelog

All notable changes to the p2party signaling server are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

`protocolVersion` on the wire is versioned separately from this package. 0.1.1
speaks protocol version 4 and nothing else.

## [Unreleased]

### Fixed

- Documentation. The README described the server `peers` frame as "the room's
  current peer list". It is not a list: `handlePeerAcceptsConnection` emits one
  accepted peer per frame, and the SDK merges those as additive deltas
  (`p2party-js/src/handlers/peerRosterDelta.ts`), so a client that treated one
  as a roster would drop every other member. The README now documents the real
  exchange — challenge, room, introductions, then description/candidate routing
  — and states that the server never signals a departure: the close handler
  releases the routing claim and logs, membership rows survive the disconnect,
  and clients learn a peer is gone from their own transport state.
- Documentation. Added the heartbeat (10 s ping, 5 s pong timeout, socket closed
  on a miss) and Bun's 60 s idle timeout and 1 MiB payload cap; the TURN
  credential lifetime (one hour), its HMAC-SHA1 construction, and that no
  credential is issued without a relay endpoint; which `p2party-js` versions
  this wire serves; what the database actually retains, including that the
  `Challenge` model is never written; and what `deploy/` provisions. Three
  source line references in the README had gone stale and are corrected.
- Documentation. `deploy/ansible/templates/signaling.env.j2` claimed the process
  refuses to start without `COTURN_SECRET`. `assertSecureTurnSecret` rejects a
  secret shorter than 32 bytes but accepts its absence: unset, the server starts
  and issues no TURN credentials, leaving clients STUN-only. Comment only; no
  rendered value changes.

## [0.1.1] — 2026-07-28

Signaling correctness under socket replacement, cross-instance routing, and a
deploy that can prove what it shipped. Coordinated with `p2party-js` 0.14.4:
the room wire is exact-shape and breaking, with no fallback for older clients.

### Added

- Protocol-v4 room correlation. Every `room` request carries a mandatory UUIDv4
  `roomRequestId` that the `roomId` response echoes with the exact `roomUrl`, so
  a delayed response cannot configure the wrong room.
- `leaveRoom`/`roomLeft`: an exact-shape, capability-bound, idempotent room
  leave with its own UUIDv4 correlation id. It works before a server room UUID
  exists, and leaving a room that is absent returns the same acknowledgement, so
  it is retry-safe and exposes no room-existence bit.
- TURN credentials that are usable. The server previously derived a coturn REST
  HMAC on every successful challenge, sent it with no relay URL, on a frame the
  client did not read it from. Credentials now carry their endpoints from
  `COTURN_URLS`, ride the `roomId` response, and are withheld entirely when no
  endpoint is configured rather than handed out as a bare HMAC. Non-`turn:`/
  `turns:` values are dropped instead of being forwarded to a browser's ICE
  stack.
- Cross-instance signal routing. Each process claims a `SERVER_ID`, records it
  on the `Peer` row it holds a socket for, and delivers to peers it does not
  hold by writing a `PendingSignal` row and issuing `NOTIFY` on the owner's
  channel, with a 5 s safety poll for a lost notification. All five delivery
  sites route: `description`, `candidate`, `peerConnection`, peer acceptance,
  and `peers`.
- A bounded per-socket signaling FIFO: at most 64 queued frames and 2 MiB of
  their serialized bytes, closing with code `1013` on overflow. Bun accepts
  async WebSocket message handlers but does not promise per-socket await
  ordering, so the queue owns ordering explicitly. Only an exact `pong` from the
  proved current socket owner bypasses it.
- A same-process room-mutation queue keyed by stable peer identity, so an old
  in-flight join cannot race its successor across socket replacement.
- `GET /health`, returning `status`, the wire `protocolVersion`, the `version`
  read from `package.json` at compile time, and a per-process `serverId` — and
  no peer counts, room counts, or identities. Every other path still answers
  `426 Upgrade required`, which is why verifying a rollout previously required a
  valid Ed25519 key.
- The deployment tree itself: `deploy/terraform` (four Hetzner hosts on a
  private subnet, Cloudflare DNS) and `deploy/ansible` (Postgres, coturn,
  WireGuard, Caddy, systemd units, migrations, health verification).

### Changed

- The datastore moves from SQLite to PostgreSQL. The Prisma provider had been
  `sqlite` since 2024 while the stack ran a Postgres host and the environment
  template wrote a `postgresql://` URL Prisma would have rejected at query time.
  Native `@db.Uuid`/`@db.VarChar` types, an explicit `PeerRooms` relation,
  `onDelete: Cascade` on `Challenge`, and the `Peer.serverId` and
  `PendingSignal` routing columns come with it; two Postgres migrations replace
  the four SQLite ones.
- Prisma 6 → 7, with queries going through the `@prisma/adapter-pg` driver
  adapter instead of the native query engine, and the client generated as ESM
  into `src/generated`. Both are what make `bun build --compile` produce a
  working single-file binary.
- One TLS decision for Postgres, in `src/db/ssl.ts`, used by both the Prisma
  adapter and the `LISTEN` client. `sslmode`, `sslrootcert`, `sslcert` and
  `sslkey` are stripped from the URL, because `pg-connection-string` parses them
  inside the `Client` constructor and its result overrides an explicit `ssl`
  option. `sslrootcert` verifies against that CA; otherwise the link is
  encrypted but unverified — a bounded, documented compromise that stops passive
  capture on the private network and not an active in-path attacker.
- Production runs one signaling worker (`signaling_ports: [3001]`). Multiple
  workers remain an explicit operator opt-in: same-identity fencing and
  membership ordering are process-local, and distributed fences do not exist
  yet.
- The deploy narrows Caddy's upstream list before restarting, verifies version,
  protocol and distinct per-process `serverId`s on every instance directly,
  retires obsolete units, and only then verifies the public route.
  `tests/deploy.contract.test.ts` pins that ordering.
- Compiled binaries are emitted into `deploy/ansible/builds/` rather than the
  repository root, beside the playbook that ships them.
- coturn no longer sets `external-ip`. The host owns its public addresses
  directly rather than through NAT, and `external-ip` is single-valued, so
  emitting a bare IPv4 and a bare IPv6 directive misadvertised one family.

### Fixed

- Authentication is per socket. Every connection receives a fresh in-memory
  nonce; historical challenge rows are never read or accepted as reconnect
  credentials. A second socket for the same identity synchronously deauthorizes
  and closes its predecessor, and every later frame must come from the exact
  socket the process registry holds. Source and target ownership is rechecked
  after each awaited database or routing boundary.
- A compiled binary could not load Prisma and crash-looped from the first
  deploy with `Cannot find module '@prisma/client' from '/$bunfs/root/…'`, then
  with a query engine built for the wrong platform.
- An unreachable database hung startup forever. `initPubSub` is awaited before
  the listener binds, and `node-postgres` defaults `connectionTimeoutMillis` to
  0, so a firewall that DROPs left the process silent with no port and no log.
  Connect and query timeouts are 10 s and the failure names the host.
- Every signaling instance bound port 3001. A `PORT` added to the shared
  environment file was read after the per-instance `Environment=` line in the
  systemd unit, so the shared value won; `PORT` is now absent from that file.
- `deploy.yml` did not ship the environment file it requires, `bunx` was not on
  the migration task's `PATH`, the Prisma CLI fetched on the host was unpinned,
  `initial-setup.yml` started services whose binary it had never shipped, and
  the local build tasks prompted for sudo.
- Concurrent first joins to the same room raced on the unique constraint; room
  creation is a single atomic upsert.
- A cross-instance routing lookup opened a real database connection in unit
  tests; the no-listener guard now runs before the query.
- Security: PostgreSQL was reachable from the internet — its Hetzner firewall
  was gated behind a variable that defaulted to false, with
  `listen_addresses = '*'`. The firewall is enabled and `listen_addresses` is
  narrowed to localhost and the private IP. Separately, coturn's cloud-init
  enabled the service before Ansible configured it, so a freshly provisioned
  host was an open relay from first boot; it now starts from a fail-closed
  placeholder configuration, and coturn gains quotas and bandwidth ceilings.
  WireGuard SSH is scoped to an explicit admin CIDR that rejects `0.0.0.0/0`,
  and egress is an allowlist.

### Removed

- `handleMessageSend.ts`, an unwired 49-line relay that would have forwarded
  message bodies through the signaling server. It had no callers, and its
  presence contradicted the one thing this server does not do.
- Leftover RSA/PEM helpers from the pre-Ed25519 authentication path.

Releases before 0.1.1 predate this changelog; see `git log`.
