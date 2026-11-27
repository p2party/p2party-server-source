# p2party-server

The protocol-v5 signaling server for p2party WebRTC room meshes. It
authenticates each WebSocket with a fresh Ed25519 challenge, coordinates room
membership, and forwards bounded WebRTC descriptions and ICE candidates only
between authenticated peers in the same room.

Application messages and files do not pass through this server. Their
end-to-end encryption and per-message DataChannels live in
[`p2party-js`](https://github.com/p2party/p2party-js).

## Production and public testnet

On November 27, 2026, two browsers on the public site exchanged a message and verified every byte of a 32 KiB file over a direct connection, then repeated the check with TURN forced. Signaling uses protocol 5. The fleet ran Ubuntu 24.04.5 with kernel 6.8.0-151, Caddy 2.11.9, coturn 4.19.2 and PostgreSQL 19.0. [P2Party app](https://p2party.com) · [Signaling health](https://signaling.p2party.com/health) · [Deployment guide](deploy/README.md)

Release 0.2.1 introduced the live validator in the signaling process. Release 0.2.2 adds expiry for offline signaling memberships. P2Party Testnet 1 started with 128 valueless units and one operator ordering signed transfers. A grant at height 1 funded the same unit that ethers transferred with ML-DSA-65 at height 2 and viem transferred with SLH-DSA-SHA2-192s at height 3. Check the network identity and current height at `GET /rpc/health`. Wallets can query balances with ethers or viem, generate a fresh receive commitment and submit native post-quantum transfers. [Testnet health](https://signaling.p2party.com/rpc/health) · [Public testnet guide](https://github.com/p2party/p2party-js/blob/master/docs/testnet-1.md) · [Request a test unit](https://github.com/p2party/p2party-js/issues/new) · [Wallet package](https://p2party.com/downloads/testnet-1/p2party-ledger-client-0.1.0-testnet.0.tgz) · [RPC methods](src/ledger/README.md)

For the trust assumptions, deployment evidence and work needed for independent validators, see the [roadmap](ROADMAP.md). The validator uses the [libdemos transfer codec](https://github.com/p2party/libdemos/tree/243a5dbbf4cb95507bb1104a47ad46ad3ed1e7a0/ledger).

## Requirements

- Bun 1.4.5 or newer
- PostgreSQL 14+ reachable via a `postgresql://` URL in `DATABASE_URL`

## Local setup

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run db:generate
bun run db:migrate
bun run start
```

`db:migrate` runs `prisma migrate deploy`, which applies only the migrations
that have not run yet and does not reset the database. Use a disposable local
database for development; production migrations belong to a reviewed deploy. Environment files and compiled server binaries are gitignored and
must never be committed.

Postgres rather than SQLite keeps routing state out of any one process. The
schema carries `Peer.serverId` and a durable `PendingSignal` table so an
instance can hand a signal to the instance that currently claims the target
peer's socket. `LISTEN`/`NOTIFY` is the low-latency wake-up, not the durable
authority: the row remains authoritative if a notification is missed. The same
path carries session fencing between workers: a login on one worker closes the
identity's older socket on another (see "Protocol-v5 authentication"). It does
not order one identity's room mutations across workers, which supported
multi-worker operation would also need.

For an Internet-facing deployment, terminate TLS in front of this process and
expose the WebSocket over `wss://`. The server does not configure TLS or launch
a TURN service. `COTURN_SECRET` and `COTURN_URLS` together let it issue
short-lived credentials for an independently operated TURN server.

Run the release checks with:

```bash
bun run check
bun run format:check
```

`check` is `db:generate`, `typecheck` and `bun test`. CI runs the same gates
plus `db:migrate` against a real PostgreSQL
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). `format` and
`format:check` run Prettier on the files Git tracks and refuse to run outside a
Git work tree. Prettier itself reads only the top-level `.gitignore`, so given
`.` it would also read, and `format` would rewrite, the ignored Terraform state,
Ansible vault and inventory under `deploy/` (`tests/formatScripts.test.ts`).

### Testing against PostgreSQL

The tests in `tests/db/*.throwaway.test.ts` need a real PostgreSQL: the
one-time identity re-key migration, routing claims and their owner token,
identity charges, the relay's membership query, and two workers fencing one
identity. They are skipped unless `P2PARTY_TEST_POSTGRES_URL` names a
throwaway server; `DATABASE_URL` is never used for them. The URL must name a
loopback address and a port above 5000 other than 5432, or the tests refuse to
run. Each test file creates its own `p2party_test_<random>` database there,
applies the migrations with the Prisma CLI as a deploy does (no `.env` is read
and the CLI's version check is off), and drops the database afterwards. The
two-worker test also starts two server processes on that database.

No test reaches the database `.env` names, although `bun test` loads `.env`:
`bunfig.toml` preloads `tests/preload.ts` before any test module, and it
replaces `DATABASE_URL` with an address nothing listens on.
`tests/testIsolation.test.ts` checks this in a scratch copy with a sentinel
`.env`. For example:

```bash
initdb -D "$PWD/.pg-test" -U test --auth=trust
pg_ctl -D "$PWD/.pg-test" -l "$PWD/.pg-test.log" \
  -o "-p 55434 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
P2PARTY_TEST_POSTGRES_URL=postgresql://test@127.0.0.1:55434/postgres bun test ./tests
pg_ctl -D "$PWD/.pg-test" stop
```

## Configuration

| Variable         | Required | Meaning                                                                                                                                                                                                                                                                        |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`   | yes      | Prisma `postgresql://` URL. A `file:` URL is rejected at startup.                                                                                                                                                                                                              |
| `PORT`           | no       | WebSocket listener port; defaults to `3001`.                                                                                                                                                                                                                                   |
| `SIGNALING_HOST` | yes      | Public WebSocket URL.host (including a non-default port) for login signatures. Set this to the authority clients actually use.                                                                                                                                                 |
| `COTURN_SECRET`  | for TURN | TURN REST shared secret (minimum 32 bytes). Credentials are issued only when this and `COTURN_URLS` are both configured.                                                                                                                                                       |
| `COTURN_URLS`    | for TURN | Comma-separated `turn:` or `turns:` relay URLs. Values are trimmed, deduplicated, limited to the first 16 unique URLs, and limited to 2,048 characters each. Credentials are issued only when this and `COTURN_SECRET` are both configured and at least one URL remains valid. |

There is no built-in TURN secret and no development authentication bypass.

## Admission and database security

This build speaks signaling protocol 5.
Unproved sockets do no database work and cannot create durable peer records:
the peer id a socket is bound to is derived from its public key alone, so the
answer before the signature verdict is the same whether or not the key has an
identity row. A successful signature is followed by a serializable database
transaction before routing activation.

Every stored row has that derived id. Servers before 0.1.4 stored random ids;
migration `20261127000000_rekey_peers_to_derived_ids` re-keys every such row
once, in one statement, before this release starts (`deploy.yml` stops every
worker, applies the migrations, and only then installs and starts the new
binary). **The peer id of an identity first
stored by an older server therefore changes once, at this upgrade.** Its room
memberships, challenges and queued signals move with it, and peers see it
under the new id from then on, so a client must identify peers by public key,
never by the server-assigned peer id. No code that runs per connection reads
or rewrites a stored id.

The following positive-integer environment variables tune the defaults. Restart
the process after changing them. Limits apply per process except the durable
identity ceiling, which is checked in a serializable database transaction.
Supported production runs one worker; experimental multiple workers do not
provide a global room/member or address-rate guarantee.

| Variable                                 | Default | Bound                                                                                                        |
| ---------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------ |
| `MAX_CONNECTIONS`                        |    2048 | Concurrent WebSockets; one IPv6 /48 holds at most 10%                                                        |
| `MAX_CONNECTIONS_PER_IP`                 |      32 | Concurrent sockets per address key                                                                           |
| `CONNECTION_ATTEMPTS_PER_IP_PER_MINUTE`  |      60 | Upgrade attempts per address key                                                                             |
| `MAX_CONNECTIONS_PER_IDENTITY`           |       4 | Concurrent sockets that proved the same key (minimum 2 for replacement overlap)                              |
| `MESSAGES_PER_IDENTITY_PER_MINUTE`       |    2400 | Frames per proved identity; before proof, per address key                                                    |
| `ROOM_MUTATIONS_PER_IDENTITY_PER_MINUTE` |      60 | Join/leave requests per proved identity                                                                      |
| `NEW_IDENTITIES_PER_MINUTE`              |     120 | New proved identities admitted; one address key gets at most 5% (6 at the default), one IPv6 /48 at most 10% |
| `NEW_MEMBERSHIPS_PER_MINUTE`             |     600 | New room memberships admitted; one address key gets at most 5% (30 at the default), one IPv6 /48 at most 10% |
| `MAX_PERSISTENT_IDENTITIES`              |  100000 | Hard cap on durable peer rows of any age; existing identities can reconnect at capacity                      |
| `MAX_ROOMS_PER_IDENTITY`                 |      64 | Room memberships per identity                                                                                |
| `MAX_PEERS_PER_ROOM`                     |     128 | Members including offline peers; also the room requests that can wait for one room's membership lock         |
| `MAX_TRACKED_ADDRESSES`                  |   10000 | Entries in each address-key, IPv6 /48 and identity accounting table                                          |
| `AUTHENTICATION_TIMEOUT_MS`              |   15000 | Deadline for proof and routing activation                                                                    |

The address key is the IPv4 address, or the /64 prefix of an IPv6 address; an
IPv4-mapped IPv6 address counts as its IPv4 address. Every IPv6 request is also
charged to its /48. Everyone behind one shared IPv4 address (carrier-grade NAT,
a campus network) therefore shares 32 sockets, 60 upgrades, 6 new identities and
30 new memberships per minute at the defaults. That is the accepted cost of
keeping one source from spending a process-wide budget; raising the
process-wide budgets raises the 5% and 10% shares with them. Everyone inside
one IPv6 /48 likewise shares that /48's 204 sockets, 12 new identities and 60
new memberships per minute at the defaults. Upgrade attempts are limited per
/64 only, 60 per minute each, so one /48 can make many attempts.

A rejected upgrade returns HTTP 429 with `Retry-After: 60`, as does an upgrade
whose client address cannot be parsed (for example an IPv6 zone id). Neither
response depends on whether the key has an identity row. Socket
rate and authentication-deadline refusals use retryable close code 1013. Room
capacity refusals return a request error and leave the authenticated socket
open, as does a room request when 8 of the same peer's, or `MAX_PEERS_PER_ROOM`
for the same room, are already waiting. A new membership is charged only once
the room-full check has passed, so a join refused because the room is full
spends none of the membership budget. When an accounting table is full, a newcomer
evicts the least recently used entry without an open socket, which discards
that entry's rate counts; entries with open sockets are never evicted. A full
table therefore neither refuses newcomers nor stops counting them. Accounting
does not scan the peer population.

A new proved identity requires a database count of all peer rows. Within 1,000
rows of `MAX_PERSISTENT_IDENTITIES`, the same transaction first deletes up to
1,000 identities that are offline, belong to no room and were created more than
24 hours ago, least recently seen first. If the cap remains full, admission
can also remove the oldest offline identities in order of last authentication,
including their room memberships. Each such pass frees the required space
plus at most eight spare slots. A live socket claim protects the identity;
an identity disconnected less than ten minutes ago is also protected. A
returning identity can authenticate with its same key and rejoin its rooms.
Capacity pruning logs the count only.

Offline identities and all their memberships expire after `MEMBERSHIP_TTL_DAYS`
days since their last successful authentication (default 90). Cleanup runs at
startup and every minute, up to 1,000 identities per pass. Removing an identity
also removes its obsolete authentication challenges. Messages and files live
on clients; the ledger has independent identities and storage.

`TRUST_LOCAL_PROXY=true` accepts Caddy's overwritten `X-Real-IP` only when the
TCP peer is loopback. It is enabled by the reference deployment and disabled
by default. Do not enable it behind an untrusted local proxy. With a different
proxy topology, configure a corresponding trusted ingress before exposing the
service; never accept arbitrary forwarded-address headers. Shared NATs share
an address budget, so operators may need higher limits for their audience.

Every encrypted PostgreSQL mode verifies the server certificate; unknown
`sslmode` values fail at startup. Supply `sslmode=verify-full` and
`sslrootcert=/absolute/path/to/ca.crt` for a private CA. Conflicting driver URL
knobs cannot disable this check. The example `.env` uses explicit
`sslmode=disable` for a disposable local database only.

The Ansible `postgres-tls.yml` playbook creates a dedicated database CA and a
server certificate whose SAN contains the private database IP. Only the public
CA is distributed to signaling hosts, over authenticated SSH. Private-network
PostgreSQL access requires TLS before older HBA rules are considered. Deploy,
initial setup and PostgreSQL setup all use this playbook. The server certificate
is renewed when fewer than 30 days remain or its SAN changes; run provisioning
at least monthly. CA expiry stops the playbook and requires explicit trust-anchor
rotation. Keep the database CA key in protected operational backups, never Git.

## Dependency policy

The server retains `@ondemos/core` for Ed25519 proof verification and the
PostgreSQL/Prisma libraries for persistence. UUID and hexadecimal checks are
small local functions with boundary tests; `class-validator` is no longer a
runtime dependency. Prisma's CLI packages pin their own dependencies to exact
versions, and none of those packages is in the compiled binary; the host installs
them as migration tooling. `tests/dependencyFloors.test.ts` holds a security
floor, with its advisories, for each Prisma CLI dependency that has had one. It
fails when `bun.lock` resolves a package below its floor, when `bun.lock` and
`package.json` disagree on overrides or dependency ranges, or when an override
has no recorded reason or is no longer needed because its dependent's range
reaches the floor. There is one override: `@prisma/config` 7.10.1 pins `effect`
3.20.0, below the fix for GHSA-7589-6fvf-x4pw (a ReDoS in
`Schema.TemplateLiteral`, fixed in 3.22.1), so `effect` is lifted to 3.22.5, the
newest patch of that line. Remove it once Prisma's pin reaches the fix.
`tests/dependencyCompatibility.test.ts` checks the `deepmerge-ts` that Prisma's
configuration loader uses, and that the loader accepts this repository's
configuration. Run `bun audit` alongside the release checks.
The TLS handshake regressions also require the `openssl` command.

## Health and version

Every path except `/health` requires a WebSocket upgrade and answers `426
Upgrade required`, so a deploy could not be verified without a valid Ed25519
key. `/health` is the exception:

```sh
curl -s https://signaling.p2party.com/health | jq
```

```json
{
  "status": "ok",
  "protocolVersion": 5,
  "version": "0.2.0",
  "serverId": "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
}
```

`protocolVersion` is the wire version this build speaks; a client on a
different one fails closed rather than negotiating. `version` comes from
`package.json` at compile time, so the binary reports what it actually is
rather than what a config file claims.

`serverId` is fresh per process. Supported production pins Caddy to one
signaling process on port `3001`, so repeated calls should report that one
process id until it restarts. The deploy probes the process directly and then
checks the same exact version, protocol, and process id through public Caddy
before succeeding.

The cross-instance `LISTEN`/`NOTIFY` path remains available to self-hosters by
explicitly configuring more than one `signaling_ports` entry. That mode is
experimental until same-identity room mutations are ordered across workers; the deploy
still probes every configured process directly and rejects duplicate process
ids before checking the public route.

The response carries no peer counts, room counts, or identities. It says which
build is running and nothing about who is using it.

## WebSocket API

The reference client uses `/ws`, so a local connection starts with:

```text
ws://localhost:3001/ws
```

The URL carries no identity key. The server sends an `authChallenge` on open.
The client replies with its Ed25519 public key and socket-bound proof. Admitted
upgrades containing the former `publickey` parameter close immediately with
code 1003 and the version refusal. Both reference Caddy loggers drop request URIs.

Every client frame except `pong` carries `protocolVersion: 5`.
Authenticated requests carry the socket-bound `fromPeerId`.

| Client message   | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `challenge`      | Prove possession of the Ed25519 identity key for this socket.          |
| `room`           | Create or join the room represented by a 128-hex room locator.         |
| `leaveRoom`      | Idempotently remove this authenticated peer from one room.             |
| `peers`          | Request introductions and optionally a correlated membership snapshot. |
| `peerConnection` | Accept a room peer introduction.                                       |
| `connection`     | Request signaling for the listed DataChannel labels.                   |
| `description`    | Forward a bounded WebRTC session description to a room peer.           |
| `candidate`      | Forward a bounded ICE candidate to a room peer.                        |
| `pong`           | Answer the server heartbeat.                                           |

### Server messages

The server emits these. Every one except `ping` and `error` carries `protocolVersion: 5`.

| Server message   | Sent when                                                            |
| ---------------- | -------------------------------------------------------------------- |
| `authChallenge`  | A socket connects and receives its fresh nonce.                      |
| `challenge`      | The challenge signature verified; authentication is complete.        |
| `roomId`         | A `room` request created or joined a room.                           |
| `roomLeft`       | The requested membership is absent after an idempotent leave.        |
| `peers`          | An acceptance delta, or an explicitly requested membership snapshot. |
| `peerConnection` | Another peer asked to be introduced to you.                          |
| `peerLeft`       | Another member left a room you are in, or its last socket closed.    |
| `connection`     | A peer requested DataChannel signaling with you.                     |
| `description`    | A relayed WebRTC session description.                                |
| `candidate`      | A relayed ICE candidate.                                             |
| `ping`           | Heartbeat. **Carries no `protocolVersion` and no `fromPeerId`.**     |
| `error`          | Any rejection; the socket may or may not be closed.                  |

> The interfaces in [`src/utils/interfaces.ts`](src/utils/interfaces.ts) are the
> starting point, not a complete schema. Handlers construct responses with an
> `as` cast, which bypasses TypeScript's excess-property check, so a frame can
> carry fields the interface does not declare — the human-readable `message`
> string on relayed `description` and `candidate` frames
> (`handleDescription.ts:36`, `handleCandidate.ts:35`), and `fromPeerPublicKey`
> on a relayed `connection` frame (`handlePeerConnection.ts:59`). Read the
> handler alongside the interface before writing a client. `handlePeers`
> emits explicitly requested snapshots; `handlePeerAcceptsConnection` emits
> acceptance deltas. Clients must distinguish the two by `rosterKind`.

### Message flow

Membership snapshots are opt-in. Requests without `rosterRequestId` retain
the earlier introduction-and-acceptance flow.

1. **`authChallenge`** (server → client) carries a fresh 32-byte nonce.
2. **`challenge`** (client → server) carries the identity public key and the
   signature over the host-bound login message below.
3. **`challenge`** (server → client) returns the proved peer id and challenge id
   after the routing claim commits.
4. **`room`** (client → server) with a 128-hex room locator and a UUIDv4
   `roomRequestId`; **`roomId`** (server → client) echoes both and carries the
   room's server-side UUID, plus `turnCredentials` when TURN is configured.
5. **`peers`** (client → server) with that room UUID. If it includes a UUIDv4
   `rosterRequestId`, the server first answers with **`peers`** carrying
   `rosterKind: "snapshot"`, that request ID, the room UUID and every _other_
   member. It then sends **`peerConnection`** introductions naming the requester
   — `{ id, publicKey, socketGeneration }` — to the selected room members.
   Without the optional request ID, the requester receives no direct snapshot
   reply.
6. **`peerConnection`** (existing member → server) accepts the introduction; the
   server sends the joiner a **`peers`** frame with `rosterKind: "delta"` whose
   array holds exactly one entry, the accepting peer. One accepted peer per
   frame, one frame per acceptance.
7. **`connection`**, **`description`** and **`candidate`** are relayed to
   `toPeerId` after one query (`findRoomPeers.ts`) finds the target's row as a
   member of that room, with the sender's peer id and proved key a member of
   the same room. It loads only the target's routing claim, never the room's
   membership; for a `description` or `candidate` that claim also routes the
   frame to another worker without a second lookup. A frame that fails the
   check is dropped with no reply and the socket stays open, whether the room
   is missing, the target is missing, or either peer is not a member, so a
   sender cannot use a relay to learn whether a key ever registered. The
   relayed copy drops `toPeerId` and carries the sender's `fromPeerId`.

An acceptance delta is additive; treating it as the whole roster would delete
every other member. A snapshot can replace the membership view only after the
client verifies its current socket, room UUID and outstanding
`rosterRequestId`. An empty snapshot means the database read found no other
members; an empty delta is not a departure signal.

### Membership snapshots and targeted repair

An authenticated room member can request a snapshot without introducing itself
to anyone:

```json
{
  "type": "peers",
  "fromPeerId": "<socket-bound peer UUID>",
  "roomId": "<joined room UUID>",
  "rosterRequestId": "<fresh UUIDv4>",
  "targetPeerIds": [],
  "protocolVersion": 5
}
```

The snapshot contains the room's complete membership except the requester,
including offline members. It is not proof that a listed peer is online or
accepted a connection. A member's optional `socketGeneration` is included only
when this process holds its current verified socket with the matching public
key. The server sends the snapshot immediately after its room lookup and
ownership check, before awaiting introduction routing.

`targetPeerIds` is an optional UUID array with at most 64 entries. Omit it to
introduce the requester to every other room member, or send an empty array to
request only the snapshot. Clients keep PIN and policy failures locally.
Targeting introductions does not change the returned membership snapshot.

The requester must still own the exact current verified socket and remain a
member in the room lookup. Ownership is rechecked after database awaits and
before each introduction, so a displaced request cannot reply or continue
introducing its predecessor. A snapshot describes one database read, not a
globally ordered membership revision: it has no revision counter, lease or
cross-process ordering guarantee. Clients must correlate responses and request
a fresh snapshot to discover later membership changes.

### Departures

The server tells a room's other members when a member leaves it or goes
offline, in one frame per room:

```json
{
  "type": "peerLeft",
  "roomId": "<room UUID>",
  "peerId": "<the departing member's peer UUID>",
  "reason": "left",
  "socketGeneration": "<UUIDv4 of the socket that left or closed>",
  "protocolVersion": 5
}
```

- **`reason: "left"`**: the member's `leaveRoom` removed its membership. Sent
  after the membership row is gone and after the leaver's `roomLeft`, from
  inside that peer's membership lock and its socket's message queue
  (`src/utils/handleLeaveRoom.ts`). A leave of a room the peer is not in, and
  the second of two concurrent identical leaves, send nothing.
- **`reason: "offline"`**: the identity's last socket closed. The close
  handler (`src/wsServer.ts`, `createRetireClosedSocket` in
  `src/utils/handlePeers.ts`) announces only when the closing socket was the
  identity's current one on this process and its routing-claim release cleared
  the claim, so no other socket of the identity holds it on any process. One
  identity has at most one current socket: a newer session replaces the older
  one. The membership is then read together with the claim, and nothing is
  sent if a successor socket has committed a claim by that read. Any close of
  the current socket announces, whatever closed it (the client, a lost
  connection, the heartbeat, a rate or queue limit, a malformed frame). A
  socket that never authenticated, was refused admission, failed or lost its
  activation, or was replaced by a newer session (`1008` "Replaced by a newer
  session", on this process or by an eviction from another) announces nothing;
  neither does an identity in no room, nor a shutdown, whose claims
  `shutdownPubSub` clears first.

Recipients are the room's other members whose rows hold a routing claim when
the membership is read, which is how the server knows they are online. A
recipient's socket on this process gets the frame directly; one on another
process gets it through that process's `PendingSignal` queue, the path relayed
`description` and `candidate` frames take. Offline members get nothing, then
or later.

Cost: a leave sends at most `MAX_PEERS_PER_ROOM` - 1 frames (127 at the
default) and counts against `ROOM_MUTATIONS_PER_IDENTITY_PER_MINUTE`; a leave
announces only a membership it removed, so after the first minute each one
also costs a join. An offline announcement sends at most
`MAX_FRAMES_PER_OFFLINE_ANNOUNCEMENT` = `MAX_ROOMS_PER_IDENTITY` ×
(`MAX_PEERS_PER_ROOM` - 1) frames (8,128 at the defaults). Three bounds, in
[`src/utils/admission.ts`](src/utils/admission.ts), each per process:

- `MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE` (6): closes of one
  identity announced per minute, checked before the membership read.
- `MAX_DEPARTURE_FRAMES_PER_SOURCE_PER_MINUTE` (6 × 8,128 = 48,768): the
  departure frames, `left` and `offline` together, that all identities of one
  source key may cause per minute. The source key is the one the connection
  limits use: an IPv4 address (an IPv4-mapped IPv6 address counts as its IPv4
  address) or an IPv6 /64. It is what one identity may cause with its offline
  announcements; without it, an address would cause more the more identities
  it holds (6 new ones a minute, kept), up to its 60 connection attempts a
  minute: 60 × 8,128 = 487,680 frames.
- `MAX_DEPARTURE_FRAMES_PER_IPV6_48_PER_MINUTE` (97,536): the same for all
  65,536 /64s of an IPv6 /48 together, twice a source key's, the ratio of the
  /48 and per-source creation shares.

An announcement is charged whole, after the membership read and before any
frame is handed on. One a budget cannot hold is skipped whole and nothing else
changes: the leave is still acknowledged, the socket is still retired and its
claim released, and members learn of the departure only from their own edges,
as before this frame existed. Skips are counted and reported at warn level at
most once a minute (`p2party: skipped N departure announcement(s) of M
frame(s) over the per-source departure budget`), with no identifiers.

Worst sustained departure frames per minute per process, at the defaults:

| Sender           | Frames per minute | Bound                                                                                                                                                                           |
| ---------------- | ----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One identity     |            52,578 | 6 offline × 8,128 = 48,768, plus 30 leave-and-rejoin cycles × 127 = 3,810, from a second source (from one source both fit in its 48,768); 60 leaves, 7,620, in the first minute |
| One IPv4 address |            48,768 | Its source budget, however many identities and sockets it uses                                                                                                                  |
| One IPv6 /64     |            48,768 | Its source budget                                                                                                                                                               |
| One IPv6 /48     |            97,536 | Its /48 budget, across all of its /64s; each /64 at most 48,768                                                                                                                 |

Each worker process keeps its own counts, so with several workers these
multiply by their number.

A source's budget is shared by every identity behind it: everyone behind one
NAT address or in one /64 shares the source budget, and everyone in one /48
the /48 budget. One member there that uses it up, by leaving many rooms or by
going offline repeatedly from rooms with many members, stops the others'
departure pushes for the rest of that minute. What they lose is the advisory
push only: their room-mates still see each departure in the next snapshot
they request (a missing member; on one process, a missing socket generation)
and on their own edges, which close when a member really goes.

A `peerLeft` frame is a report from the signaling server, which clients cannot
verify. The reference client never closes a connected WebRTC edge because of
one: it removes a departed member it holds no connected edge to, keeps a
connected edge, and stops asking for introductions to a departed member until
the server names that member again (see the `p2party-js` protocol notes).

**Ordering.** A departure and the member's quick return can reach a recipient
in either order: the `offline` announcement is sent after the claim release
and a membership read, while a new socket of the same identity, here or on
another process, may already be introducing itself; and frames of different
processes travel through different queues. `socketGeneration` orders them. A
return on a new socket reaches members in frames that name the new socket's
generation (`peerConnection` introductions, acceptance deltas, `connection`),
so a departure that names an older generation is recognised as stale. A leave
and a rejoin on the same socket carry the same generation; they are ordered
because the leave's frames are handed on inside that socket's message queue,
before the rejoin is processed, and because each process delivers its queue
in order and once: `createPendingSignalDrain` (`src/pubsub.ts`) runs one pass
at a time (a NOTIFY, a safety poll or a socket becoming current during a pass
asks for exactly one more), keeps a recipient's later rows behind one of its
rows that could not be delivered yet, and does not deliver again a row whose
delete failed. A pass that has not ended after
`PENDING_SIGNAL_PASS_DEADLINE_MS` (10 seconds, twice the safety poll) is
abandoned, with one error line, and the next wake-up starts a fresh one: the
Prisma pool has no query timeout, and a statement hung on a half-open
connection would otherwise stop the drain until restart. The abandoned pass
sends and deletes nothing more. Rows kept for a socket that is still
activating are delivered as soon as it becomes current, because becoming
current wakes the drain (`activateVerifiedSocket` in
`src/utils/socketAuth.ts`); a frame sent straight to that socket during the
one pass that follows can still arrive before them. Frames
queued by different processes are delivered in `createdAt` order, a
millisecond timestamp taken at insert; rows of the same millisecond have no
defined order, and a row whose insert commits after a pass has read the queue
reaches the next pass even if its timestamp is earlier. Those reorderings,
and a frame sent straight to a socket on its own process overtaking queued
ones, remain: `socketGeneration` makes one harmless when the two frames name
different sockets, not when they name the same one.

The membership row survives a disconnect. An offline member remains listed until
an explicit leave, expiry, or capacity eviction.

### Heartbeat and timeouts

Once a socket has a peer id, the server sends `{"type":"ping"}` every 10 seconds
and marks the socket not-alive. A `pong` clears the mark. If it is still unset
5 seconds later, or still unset when the next ping is due, the server closes the
socket ([`src/utils/handleInterval.ts`](src/utils/handleInterval.ts)).

Bun's own socket limits sit behind that: `idleTimeout` 60 seconds and
`maxPayloadLength` 1 MiB (`src/wsServer.ts:88-89`). The 60-second idle timer is
the backstop for a connection that sends nothing at all; in practice the
10-second ping loop closes a dead socket first.

The ping loop starts before authentication, and a `pong` is accepted only from a
socket that already holds the proof — the fast path checks current process-local
ownership (`handlePong.ts`), the queued path requires a current verified socket
(`handleMessage.ts`). A socket that has not completed the challenge therefore
cannot answer its first ping, and is closed roughly 10 to 15 seconds after
connecting.

### Enforced bounds

Enforced bounds live in
[`src/utils/signalingProtocol.ts`](src/utils/signalingProtocol.ts): 524,288 characters per
signaling message, 262,144 characters in the SDP string, 4,096 characters in
the ICE candidate string, 256 characters each in `sdpMid` and
`usernameFragment`, and at most 64 DataChannel labels of 193 characters each.
Peer requests additionally limit the target list to 64 UUIDs and
require UUIDv4 when the optional `rosterRequestId` is present.
Malformed, downgraded, cross-room, or cross-identity signaling fails closed.

A frame that fails validation in `handleMessage` closes the socket from that
function's `catch` without sending an `error` frame; the `error` frames listed
above come from individual handlers, most of which also close or terminate the
socket after sending one. Their `error.message` is fixed text chosen by the
server, never a library's error text or a caught error object. The close codes
are:

| Code   | Reason sent                                                            | Meaning                                                                                                                                                                            | Client retries |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `1003` | `Unsupported signaling protocol version; this server speaks version 5` | The frame declares another `protocolVersion`, or none (only `pong` carries none)                                                                                                   | no             |
| `1003` | `Malformed protocol-v5 <message>`                                      | The frame breaks the exact protocol-v5 shape for its `type`                                                                                                                        | no             |
| `1008` | `Challenge response signature cannot be verified`                      | The signature does not verify for the socket's key                                                                                                                                 | no             |
| `1008` | `Replaced by a newer session for this identity`                        | A newer socket of the same identity committed its authentication                                                                                                                   | no             |
| `1008` | `Peer identity does not match this socket`                             | A proved socket's identity row no longer matches its key                                                                                                                           | no             |
| `1011` | `Could not initialize WebSocket identity`, `Signaling handler failed`  | A server-side fault                                                                                                                                                                | yes            |
| `1013` | rate, queue, admission and authentication-deadline reasons             | A limit in "Admission and database security"                                                                                                                                       | yes            |
| none   |                                                                        | A stale challenge, a malformed signature encoding or a verifier exception; a stale or replaced socket's frame; an oversized frame; a failed authentication commit; a handler fault | yes            |

The SDK's reconnect ladder stops on 1003, 1008 and 1010 from the server and
retries every other close. The constants are in
[`src/utils/socketAuth.ts`](src/utils/socketAuth.ts) and, for the version
mismatch, beside `SIGNALING_PROTOCOL_VERSION` in
[`src/utils/signalingProtocol.ts`](src/utils/signalingProtocol.ts).

### Room correlation and TURN credentials

Every `room` request carries a mandatory UUIDv4 `roomRequestId`. The
corresponding `roomId` response repeats the exact `roomLocator` and
`roomRequestId`, so clients can reject unsolicited or stale responses. A
missing or malformed request ID is rejected; there is no alternate legacy
shape or server-generated fallback. This nonce provides response correlation,
not room privacy: the server still sees the locator and membership
described in the privacy boundary below.

When TURN is configured, the `roomId` response includes:

```json
{
  "turnCredentials": {
    "urls": ["turns:turn.example.com:443?transport=tcp"],
    "username": "<expiresAtUnixSeconds>:<22-character tag>",
    "credential": "<TURN REST HMAC>",
    "expiresAtUnixSeconds": 1785258000
  }
}
```

The numeric username prefix equals `expiresAtUnixSeconds`. The tag is the
first 22 base64url characters of HMAC-SHA256 under `COTURN_SECRET` of the fixed
label `p2party turn username tag v1`, the authenticated socket's 32-byte identity
public key and the expiry as an unsigned 64-bit big-endian integer. The identity
key therefore never appears in the username, and usernames from different hours
cannot be linked without the secret. The TURN host holds `COTURN_SECRET` too, so
whoever controls it can test a tag against public keys it already knows (room
rosters disclose members' keys); the server has no other configured secret that
every worker shares and the TURN host lacks. `credential` is the base64
HMAC-SHA1 of `username` under `COTURN_SECRET` — the coturn REST convention; the
label keeps the two HMAC inputs distinct. The expiry is the current time plus
one hour (`TURN_CREDENTIAL_CONTRACT.lifetimeSeconds` in
[`src/utils/socketAuth.ts`](src/utils/socketAuth.ts)), rounded up to a whole
hour, so a credential is valid for at least one hour and less than two. A
bundle comes with every successful room join, and every join by one identity
within one such hour receives the identical bundle. coturn counts its
per-username allocation quota per tag, so per identity per hour, and checks the
expiry only on a session's first request, so an allocation stays usable after
its credential expires for as long as it is refreshed. "Relay bound" under
Deployment states what this limits and what it does not. URL normalization
follows the `COTURN_URLS` limits above.

When `COTURN_SECRET` or `COTURN_URLS` is missing, or no URL survives
normalization, `turnCredentials` is omitted from the `roomId` response entirely
and clients stay STUN-only. The server never issues a credential without a
relay endpoint to use it against.

A protocol-v5 room leave is an exact-shape request with `type` equal to
`"leaveRoom"`, the socket-bound `fromPeerId`, the same 128-hex `roomLocator` used
to join, a fresh UUIDv4
`roomLeaveId`, and `protocolVersion: 5`. The server removes the authenticated
peer's membership before returning the same `roomLocator` and `roomLeaveId` in an
exact `roomLeft` acknowledgement. This works even before the client has
received a server-assigned `roomId`. Leaving a room that is already absent or
does not exist returns the same acknowledgement, so the operation is
retry-safe and does not expose room existence.

## Protocol-v5 authentication

The server sends a fresh 32-byte nonce on each admitted socket.

```json
{
  "type": "authChallenge",
  "challenge": "<64 lowercase hex>",
  "protocolVersion": 5
}
```

The client signs the UTF-8 bytes of `p2party-signaling-auth-v2`, one zero byte,
the UTF-8 bytes of its lowercased WebSocket URL.host (including any non-default
port), one zero byte, then the 32 raw nonce bytes. The server verifies the
Ed25519 signature for its configured `SIGNALING_HOST`.

```json
{
  "type": "challenge",
  "publicKey": "<64 lowercase hex>",
  "challenge": "<same 64 lowercase hex>",
  "signature": "<128 lowercase hex>",
  "protocolVersion": 5
}
```

After proof, the server derives the peer id, charges the identity's socket
budget, commits the routing claim and registers the socket. It replies with

```json
{
  "type": "challenge",
  "peerId": "<derived uuid>",
  "challengeId": "<fresh uuid>",
  "protocolVersion": 5
}
```

The heartbeat starts on verified sockets. TURN credentials are issued in the
room response when a relay is configured.

When the same identity authenticates twice on one server process, the new
socket deauthorizes and closes its predecessor with `1008` and the reason
`Replaced by a newer session for this identity`, synchronously, once its own
identity row and routing claim have committed. Until then the predecessor
keeps working, and if the new socket fails at any step (signature, admission,
identity row and claim, or its own close) the predecessor is not touched and
the new socket closes bare, so its client may retry. The heartbeat begins after the new socket receives its success frame.
If two new sockets of one identity commit around the same time, exactly one
becomes current and the other closes with the same `1008`. Usually that is the
one that began activating later. But when their commits conflict, the earlier
socket's retried commit can be processed first: it registers, and closing the
socket whose claim it replaced then closes the later socket while that one is
still committing.

The identity row and the routing claim are written by one statement in one
serializable transaction, and the claim names its owner: the process
(`Peer.serverId`) and the socket (`Peer.socketGeneration`). A socket releases
or restores only a claim that carries its own owner token, compared in the
same statement, so a late release from a replaced socket cannot clear a
successor's claim on any worker. A socket that committed but does not become
current takes back what it wrote: a row it created is deleted and its creation
charge refunded; otherwise the claim it replaced is put back. If that undo
itself fails (the database unreachable, say), the claim and any row the socket
created stay: the claim still names this instance, so frames for the identity
still reach it, and the failure is logged by peer tag and error class. A new identity
is charged once: two first-time sockets of one key both charge before they
insert, the loser's insert conflicts, its retry finds the winner's row, and
its charge is refunded.

When a new socket's claim replaces one held by another worker, that worker is
told through the same queue as relayed frames (a `PendingSignal` row of kind
`evict` naming the replaced socket's generation, then `NOTIFY`) and closes the
older socket with the same `1008` and reason, so one socket per identity is
live across workers. If the `NOTIFY` is lost, the owner's 5-second safety poll
reads the row. If the row is never read (it is swept after 120 seconds, or the
owner could not reach PostgreSQL), every worker's claim reconciliation, run
every 30 seconds, closes each current socket whose row another worker now
claims. A replaced socket on a worker that can reach PostgreSQL therefore
closes within about 30 seconds at most. A worker that cannot reach PostgreSQL
closes nothing; its sockets cannot route to other workers either. A dead
worker's sockets are gone with it, and the next startup clears its claims and
rows.

Every later frame must come from the exact socket currently held in that
process's registry. The bounded message FIFO is per socket, and same-process
room mutations are additionally serialized by stable peer identity across
socket replacement. That membership ordering is not distributed across
workers: there is no database generation or advisory-lock fence yet, so
cross-instance same-identity room mutation ordering is an explicit nonclaim.
Supported production therefore runs one worker. Multiple `signaling_ports`
are an experimental operator opt-in until that fence exists.

Each socket retains at most 64 queued signaling frames and at most 2 MiB of
their serialized bytes; exceeding either bound closes it with overload code
`1013`. This explicit FIFO is required because Bun accepts asynchronous
WebSocket message handlers but does not promise per-socket await ordering.
Only an exact `pong` from the cryptographically proved current socket owner
bypasses that FIFO; malformed, unproved, or replaced-socket pongs do not.

## Client compatibility

This build speaks protocol version 5 only, in the exact shapes above. There is
no negotiation and no fallback for an older or newer client. A frame carrying
any other `protocolVersion`, or none, closes the socket with code
`1003` and the reason `Unsupported signaling protocol version; this server speaks version 5`,
before the frame's identity is checked, so a client of another version learns
that is the cause whatever else it sends. The reason names only the server's
version. A `room`/`leaveRoom` request whose key set is not exactly the one
documented closes the socket with `1003` and a `Malformed protocol-v5` reason.

Deploy server 0.2.0 before SDK 0.15.0. The previous server returns HTTP
403 for a keyless upgrade, which browsers expose as an abnormal closure.
The v5 server returns the explicit version refusal to earlier clients.

## What the server stores

The Postgres schema is [`prisma/schema.prisma`](prisma/schema.prisma): four
models plus the implicit `PeerRooms` join table. The running server writes all
of them except `Challenge`.

- **`Peer`** — one row per Ed25519 identity public key, holding that key, a
  stable peer id, `lastPing`, and the routing claim: `serverId`, which process
  currently holds the socket, and `socketGeneration`, which of its sockets
  does, or both null. A process that exits without shutting down leaves its
  claims behind; the next process to start clears them (see `PendingSignal`). Created only after a valid socket-bound signature and before
  routing activation. The peer id is a domain-separated UUID derived from the
  public key. Rows a server before 0.1.4 stored with random ids are re-keyed to
  the derived id once, by a migration, at the upgrade (see "Admission and
  database security"); a row whose key is not 64 lowercase hex characters,
  which no client can present, is deleted there. Verified identities can authenticate again with the same derived ID after expiry.
- **`Room`** — one row per room, keyed by `identifier`, the SHA-512 of the
  64-hex room token ([`src/utils/roomIdentifier.ts`](src/utils/roomIdentifier.ts)).
  The client hashes the lowercase capability hex string as UTF-8 and sends
  its 128-hex digest as `roomLocator`. Existing rows keep the same identifier.
  A frame carrying `roomUrl` is refused. Empty room records not updated for 24 hours are removed in batches of at
  most 1,000 per minute, rechecking emptiness at deletion. Offline memberships have the authentication TTL described above.
- **`Peer`↔`Room` membership** — added by a `room` request, removed by a
  `leaveRoom` request or deletion of its expired or evicted identity. A socket close clears `Peer.serverId` and nothing else,
  so membership outlives the connection.
- **`PendingSignal`** — a serialized frame written only when the target peer's
  socket belongs to another instance, or (kind `evict`) the generation of a
  socket there that a newer session of its identity replaced. Deleted on delivery, when the target is no
  longer here, and at shutdown. Every 30 seconds, rows older than 120 seconds
  are deleted wherever they are addressed, oldest first through an index on
  `createdAt`, in statements of at most 1,000 rows and at most 10,000 rows per
  run. No row therefore lives longer than about 150 seconds unless more than
  10,000 rows age out within one 30-second period. At startup a process runs
  that sweep first, then clears the rows and `Peer.serverId` claims of every
  other server id whose PostgreSQL LISTEN session is gone, grouping the server
  ids in SQL rather than reading every row. Each
  process names that session `p2party-signaling:<serverId>` in
  `pg_stat_activity` before it claims a peer, and sets TCP keepalives so
  PostgreSQL ends the session of a vanished host within about a minute.
- **`Challenge`** — declared in the schema, but the running server never writes
  it. Challenge nonces live on the socket
  ([`src/utils/socketAuth.ts`](src/utils/socketAuth.ts)) and are discarded when
  consumed.

## Deployment

[`deploy/`](deploy/README.md) provisions and updates the reference deployment. None of it is
required to run the server; a self-hoster needs only Bun, Postgres, and a TLS
terminator in front.

[`deploy/terraform`](deploy/terraform) (Hetzner Cloud + Cloudflare) declares
four servers on one private `10.231.0.0/24` network — PostgreSQL, coturn,
signaling behind Caddy, and a WireGuard gateway — with per-host firewalls
(Postgres accepts 5432 and SSH from the subnet only), a shared egress allowlist,
and the DNS records for the signaling, TURN and STUN names. Run it through
`deploy/tf`, which loads credentials from `deploy/.env`.

[`deploy/ansible`](deploy/ansible) configures those hosts
(`playbooks/site.yml`) and ships releases (`playbooks/deploy.yml`, wrapped by
`deploy/deploy.sh`). Every playbook first requires, on the control machine
and before contacting any host, the ansible-core the playbooks were tested with
and the Bun `package.json` pins. A deploy then builds `p2party_linux_x64` from
this repo with `bun run build:linux`, on the control machine, and refuses to
continue unless the binary exists and its build record matches it and names
that Bun, and unless the signaling host's own Bun is that pin, all before it
changes anything on a host. While the old release keeps serving, it installs
the audited manifest and frozen lockfile into isolated migration tooling,
copies the schema and migrations, stages the new binary (byte for byte the one
built), environment file and units, and validates a candidate
Caddy configuration; a failure there leaves production untouched. Only then does
it stop and disable every signaling worker, run the Prisma CLI on the host and,
if that errors, end the play with the recovery steps (deploy/README.md, "A
failed or interrupted migration"), Prisma's output in a root-only log, the
workers stopped and the previous binary in place. After the migration it
installs the staged files, narrows the Caddy upstream list, enables and starts
the workers, verifies the version, protocol version and per-process `serverId`
on every instance directly, retires obsolete units, and only then checks that
public Caddy answers with one of those exact `serverId`s.
[`tests/deploy.contract.test.ts`](tests/deploy.contract.test.ts) pins that
ordering.

Systemd therefore never starts a binary against a schema it was not built for
during a deploy: the old binary is stopped and disabled before the schema
changes, and the new one is installed only after. From the stop until the new
binary is installed, and after a failure in between, a marker file makes
`initial-setup.yml` refuse to start a unit. The binary also refuses by itself.
Before opening its listener it reads the migration history on its own
connection, within 8 seconds, and exits with one `p2party: refusing to start`
line, naming what it found and what to run, when the database does not answer
or cannot be reached, is empty, lacks a migration the build ships, has one it
does not ship, or holds a failed migration; systemd retries after 5 seconds while the refusal persists. It then re-runs the identity re-key statement within its own 60-second
bound; the statement changes nothing unless an unsupported writer left a row
with another id, and one that runs past the bound is cancelled, changes nothing,
and ends the start the same way. The Prisma pool that serves requests keeps no
connect or statement timeout, as before. A 0.1.4 binary has no such check; never
start one on a database past `20261127000000_rekey_peers_to_derived_ids`.

Production sets `signaling_ports: [3001]` — one process — for the
membership-ordering reason above. Where several workers share a database, stop every worker of an
older release before the first worker of this release starts, and run all
workers under one database role: a worker counts as live only through its named
PostgreSQL session, which older releases do not open, so a new worker would
clear an older worker's routing claims. Caddy terminates TLS, proxies the WebSocket, sets HSTS and a
content-security policy, and logs with client IPs masked to /24 and /48.
Request URIs, headers and the duplicate raw `client_ip` field are removed from
access logs and from Caddy's default logger, which records upstream errors, so
the public-key query parameter is retained in neither. coturn is configured by
`playbooks/setup-coturn.yml`; this server only issues credentials for it. coturn
writes no log (`log-file=/dev/null`, nothing to stdout): its log lines would
pair each username with a client address, and whoever holds `COTURN_SECRET` can
link a username to its identity key. The playbook deletes the log directory and
rotation config of earlier provisioning.

Both playbooks that provision the signaling host install a journald drop-in
(`templates/journald-retention.conf.j2`, `MaxRetentionSec=7day` and
`MaxFileSec=1day`) and restart journald. journald deletes only archived journal
files, and the active file is archived at least daily, so a journal entry is
kept for about eight days at most. The drop-in applies to every unit on the
host, not only the workers and Caddy. Caddy's access log is not in the journal:
it is a file under `/var/log/caddy` kept for `logging.log_retention_days` days
(14 by default, 30 in the production group variables). Nothing in this
repository configures rsyslog: if the host also copies the journal into syslog
files, their retention follows that host's logrotate settings, is not covered
by this change, and must be checked on the host.

A rendered configuration is checked before it replaces a running one, and a
failed check fails the play with the running service untouched. Caddyfiles go
through `caddy validate` (a candidate file in `deploy.yml`, the template's
`validate` in `initial-setup.yml`). Validation runs as root and opens every log
file the Caddyfile names, so the playbooks create those files owned by the
`caddy` user before validating and enforce that ownership again afterwards.
coturn has no configuration check mode, so `setup-coturn.yml` renders a
candidate and asserts that it has no unrendered template text, a shared secret
of at least 32 characters, a realm, positive quotas, bandwidth limits and
allocation lifetime, and that it logs nowhere, before installing it; the
candidate, which holds the secret, is removed whether or not the checks pass.
The playbook also fails, naming the flag, if the coturn unit or
`/etc/default/coturn` passes `-l`/`--log-file`, `--syslog`, `-n` or a `-c`
other than `/etc/turnserver.conf`, any of which would override the template.

### Relay bound

The coturn template sets `coturn_bps_capacity` to 30,000,000 bytes/second,
`coturn_max_bps` to 625,000 bytes/second per allocation and
`coturn_max_allocate_lifetime` to 600 seconds (coturn's own default is 3,600).
Input and output are counted separately. These Ansible variables are
operator-overridable and must remain positive. Ordinary clients without a
bandwidth request reserve the per-allocation maximum, so the defaults permit 48
simultaneous such allocations; raise aggregate capacity for larger relay-heavy
rooms. Allocation quotas remain 1,200 total and 12 per credential username.

What holds, read from coturn's source (release 4.6.1 and master `44fa529`,
November 2026):

- coturn counts `user-quota` per username, the part after `<digits>:`, here the
  hourly tag (`get_real_username` and `check_new_allocation_quota` in
  `src/apps/relay/userdb.c`). One username reserves at most 12 × 625,000 =
  7,500,000 bytes/second, a quarter of the capacity. The playbook computes that
  share from the template's own variables and refuses overrides where
  `coturn_user_quota` × `coturn_max_bps` exceeds half of `coturn_bps_capacity`.
- coturn checks a username's expiry only on a session's first request:
  `check_stun_auth` in `src/server/ns_turn_server.c` looks the key up, and so
  checks the expiry in `get_user_key`, only while the session has none cached.
  Refresh, CreatePermission and ChannelBind reuse the cached key, and coturn
  does not end a session when its credential expires.
- One identity therefore holds at most three tags' quota at once if it stops
  refreshing: a credential is issued at most two lifetimes L (one hour each)
  before it expires, and an unrefreshed allocation outlives it by at most
  A = `coturn_max_allocate_lifetime`, so the live tags expire within
  (now − A, now + 2L), at most ⌈(2L + A)/L⌉ = 3 of them for 0 < A ≤ L. It gains
  one more tag's quota every lifetime for as long as it keeps refreshing its old
  allocations.
- The quota guards against one client's runaway use. It is not a bound on an
  adversary, who can also simply use several identities: at the defaults four
  identities with a full quota each reserve the whole relay. `total-quota` and
  `bps-capacity` are the only hard limits; see "Relay exhaustion" in
  [`deploy/README.md`](deploy/README.md#relay-exhaustion).

The tag is hourly on purpose. A stable tag would let coturn pool the quota per
identity, but it would put a permanent pseudonym on the path of every plain
`turn:` request, linkable across days and networks, which is what the opaque
username exists to remove. The earlier `<expiry>:<identity key>` username
already pooled the quota per identity, because coturn strips the `<digits>:`
prefix; what one username can reserve fell only because `coturn_max_bps` went
from 3,000,000 to 625,000.

The units and reservation semantics follow the [coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
and [bandwidth implementation notes](https://github.com/coturn/coturn/wiki/diff2projects).

## Privacy boundary

The server sees each client's Ed25519 identity public key, the room locator a
client joins with, which peer ids share a room, the WebRTC descriptions and ICE
candidates it relays — which carry IP addresses — and the timing of all of it.

What room members learn from each other through the server: the membership
and some online state from snapshots, which any member can request at any
time (a snapshot lists offline members too, and names a member's
`socketGeneration` exactly when this process holds that member's current
socket, so on a one-process deployment a missing generation means offline and
a missing member means it left); when a member asks for peers or accepts or
dials (introductions, deltas, `connection`); and, through `peerLeft`, when a
member leaves a room and when its last signaling socket closes. What
`peerLeft` adds is a real-time push, unrequested, to every online member of
every room an identity is in, of the transitions a snapshot already showed on
request: a member that polled snapshots could find them out at the polling
interval, and now every member is told within the server's delivery time,
whether or not it holds an edge to that identity and whether or not it would
accept one. On several processes it also tells members what a snapshot could
not: the offline transition of a member whose socket is on another process.
Departures over the bounds in "Departures" are not announced. Together with
the introductions a returning member sends, the pushes give room-mates the
start and end of each of a member's signaling sessions. When the server notices a
close depends on how the socket ended: a clean close at once, a lost
connection when the heartbeat goes unanswered (within about 15 seconds) or at
the 60-second idle timeout. The frame carries nothing a room-mate was not already shown: the room
UUID, the member's peer id, and the socket generation that introductions and
deltas already carry.

Its operator logs name a peer only by an eight-hex-digit tag: an HMAC of the
peer id under a key drawn at each process start and never stored. A tag links
log lines within one process lifetime; it is not the peer id or public key. A
caught error is logged by its class and, for a database error, its code, never
its message or fields: a Prisma error's message can quote the query's
arguments, peer and room ids included. Refusals the server raises itself log
their fixed sentence.

It does not see application message or file content. No frame type carries an
application payload and no handler forwards one: messages and files travel over
the peers' DataChannels, end-to-end encrypted by
[`p2party-js`](https://github.com/p2party/p2party-js).

It does **not** currently implement blind rendezvous, hide room membership from
the signaling operator, or make TURN traffic peer-to-peer. Do not describe it as
doing so until the L2 blind-meeting-point design is implemented and reviewed.
There has been no independent third-party security audit of this server.

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting. Protocol
changes should include adversarial tests and must preserve exact version and
socket-identity binding.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. See [LICENSE.md](LICENSE.md).
