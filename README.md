# p2party-server

The protocol-v4 signaling server for p2party WebRTC room meshes. It
authenticates each WebSocket with a fresh Ed25519 challenge, coordinates room
membership, and forwards bounded WebRTC descriptions and ICE candidates only
between authenticated peers in the same room.

Application messages and files do not pass through this server. Their
end-to-end encryption and per-message DataChannels live in
[`p2party-js`](https://github.com/p2party/p2party-js).

## Requirements

- Bun 1.3 or newer
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
authority: the row remains authoritative if a notification is missed. This
cross-instance delivery path does not by itself provide the distributed
same-identity fencing required for supported multi-worker operation.

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
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Configuration

| Variable        | Required | Meaning                                                                                                                                                                                                                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`  | yes      | Prisma `postgresql://` URL. A `file:` URL is rejected at startup.                                                                                                                                                                                                              |
| `PORT`          | no       | WebSocket listener port; defaults to `3001`.                                                                                                                                                                                                                                   |
| `COTURN_SECRET` | for TURN | TURN REST shared secret (minimum 32 bytes). Credentials are issued only when this and `COTURN_URLS` are both configured.                                                                                                                                                       |
| `COTURN_URLS`   | for TURN | Comma-separated `turn:` or `turns:` relay URLs. Values are trimmed, deduplicated, limited to the first 16 unique URLs, and limited to 2,048 characters each. Credentials are issued only when this and `COTURN_SECRET` are both configured and at least one URL remains valid. |

There is no built-in TURN secret and no development authentication bypass.

## Admission and database security

Release 0.1.4 preserves protocol v4 and the mesh-repair behavior of 0.1.3.
Unproved sockets perform a bounded identity lookup but cannot create durable
peer records. A successful signature is followed by a serializable database
transaction before routing activation. Existing identity IDs do not change;
a concurrent old-server bootstrap that assigned another ID fails retryably.

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
whose client address cannot be parsed (for example an IPv6 zone id). Socket
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
24 hours ago, least recently seen first, and refuses the new identity only if
the cap is still reached. These are resource limits, not proof of unique humans
or a complete Sybil defense.

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
runtime dependency. Exact security overrides patch Prisma CLI transitive
packages. The `deepmerge-ts` 8 override is covered by plain-object configuration,
recursive-input and actual Prisma configuration-loader tests; its changed Map
and custom-merger behavior is not used by this repository. Run `bun audit`
alongside the release checks and revisit overrides when Prisma updates its pins.
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
  "protocolVersion": 4,
  "version": "0.1.4",
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
experimental until distributed same-identity fencing is implemented; the deploy
still probes every configured process directly and rejects duplicate process
ids before checking the public route.

The response carries no peer counts, room counts, or identities. It says which
build is running and nothing about who is using it.

## WebSocket API

The reference client uses `/ws`, so a local connection starts with:

```text
ws://localhost:3001/ws?publickey=<64 lowercase hex>
```

The public key is the client's Ed25519 identity public key, not a secret. The
server currently accepts a WebSocket upgrade on any path; `/ws` is the stable
deployment convention. A non-upgrade HTTP request receives `426`, and a missing
or malformed `publickey` receives `403`.

After the server's initial `peerId` challenge, signaling is JSON. The
`challenge` proof is the only client message accepted before authentication.
Every message other than `pong` must use exact protocol version `4`, and every
message must repeat the socket's bound `fromPeerId`.

| Client message   | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `challenge`      | Prove possession of the Ed25519 identity key for this socket.          |
| `room`           | Create or join the room represented by a 64-hex room token.            |
| `leaveRoom`      | Idempotently remove this authenticated peer from one room.             |
| `peers`          | Request introductions and optionally a correlated membership snapshot. |
| `peerConnection` | Accept a room peer introduction.                                       |
| `connection`     | Request signaling for the listed DataChannel labels.                   |
| `description`    | Forward a bounded WebRTC session description to a room peer.           |
| `candidate`      | Forward a bounded ICE candidate to a room peer.                        |
| `pong`           | Answer the server heartbeat.                                           |

### Server messages

The server emits these. Every one except `ping` carries `protocolVersion: 4`.

| Server message   | Sent when                                                            |
| ---------------- | -------------------------------------------------------------------- |
| `peerId`         | A socket connects and receives its bound peer ID and challenge.      |
| `challenge`      | The challenge signature verified; authentication is complete.        |
| `roomId`         | A `room` request created or joined a room.                           |
| `roomLeft`       | The requested membership is absent after an idempotent leave.        |
| `peers`          | An acceptance delta, or an explicitly requested membership snapshot. |
| `peerConnection` | Another peer asked to be introduced to you.                          |
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

1. **`peerId`** (server → client), immediately on open: the socket's peer id and
   a fresh 32-byte challenge nonce.
2. **`challenge`** (client → server): the Ed25519 signature over that exact
   nonce. This is the only frame accepted before authentication.
3. **`challenge`** (server → client): `challengeId` and nothing else. The socket
   is now the current verified socket for its peer id.
4. **`room`** (client → server) with a 64-hex room token and a UUIDv4
   `roomRequestId`; **`roomId`** (server → client) echoes both and carries the
   room's server-side UUID, plus `turnCredentials` when TURN is configured.
5. **`peers`** (client → server) with that room UUID. If it includes a UUIDv4
   `rosterRequestId`, the server first answers with **`peers`** carrying
   `rosterKind: "snapshot"`, that request ID, the room UUID and every _other_
   member. It then sends **`peerConnection`** introductions naming the requester
   — `{ id, publicKey }` — to the selected room members. Without the optional
   request ID, the requester receives no direct snapshot reply.
6. **`peerConnection`** (existing member → server) accepts the introduction; the
   server sends the joiner a **`peers`** frame with `rosterKind: "delta"` whose
   array holds exactly one entry, the accepting peer. One accepted peer per
   frame, one frame per acceptance.
7. **`connection`**, **`description`** and **`candidate`** are relayed to
   `toPeerId` after `findRoomPeers` re-checks that both peers exist and both are
   members of that room. The relayed copy drops `toPeerId` and carries the
   sender's `fromPeerId`.

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
  "protocolVersion": 4
}
```

The snapshot contains the room's complete membership except the requester,
including offline members. It is not proof that a listed peer is online or
accepted a connection. A member's optional `socketGeneration` is included only
when this process holds its current verified socket with the matching public
key. The server sends the snapshot immediately after its room lookup and
ownership check, before awaiting introduction routing.

`targetPeerIds` and `excludedPeerIds` are optional UUID arrays, each limited to
64 entries. They filter introductions only; neither changes snapshot contents.
An omitted target list selects all other room members; an empty list selects
none. Otherwise only listed room members receive introductions, and exclusions
always win. IDs outside the room receive nothing. A client can therefore repair
specific missing edges while excluding peers whose PIN or policy failure awaits
an explicit retry, without causing every healthy room edge to dial again.

The requester must still own the exact current verified socket and remain a
member in the room lookup. Ownership is rechecked after database awaits and
before each introduction, so a displaced request cannot reply or continue
introducing its predecessor. A snapshot describes one database read, not a
globally ordered membership revision: it has no revision counter, lease or
cross-process ordering guarantee. Clients must correlate responses and request
a fresh snapshot to discover later membership changes.

**The server never signals a departure.** Its close handler releases the peer's
routing claim and logs (`src/wsServer.ts`, `src/index.ts`); it sends nothing to
the room. There is no `peerLeft` frame in the protocol, and a `leaveRoom` is
acknowledged only to the peer that sent it. The membership row survives the
disconnect too — only an explicit `leaveRoom` removes one. Clients learn
transport loss from their own edge state; a later correlated snapshot can
discover an explicit membership departure. An offline member remains listed.

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
[`src/utils/protocolV4.ts`](src/utils/protocolV4.ts): 524,288 characters per
signaling message, 262,144 characters in the SDP string, 4,096 characters in
the ICE candidate string, 256 characters each in `sdpMid` and
`usernameFragment`, and at most 64 DataChannel labels of 193 characters each.
Peer requests additionally limit each target/exclusion list to 64 UUIDs and
require UUIDv4 when the optional `rosterRequestId` is present.
Malformed, downgraded, cross-room, or cross-identity signaling fails closed.

A frame that fails validation in `handleMessage` closes the socket from that
function's `catch` without sending an `error` frame; the `error` frames listed
above come from individual handlers, most of which also close or terminate the
socket after sending one.

### Room correlation and TURN credentials

Every `room` request carries a mandatory UUIDv4 `roomRequestId`. The
corresponding `roomId` response repeats the exact `roomUrl` and
`roomRequestId`, so clients can reject unsolicited or stale responses. A
missing or malformed request ID is rejected; there is no alternate legacy
shape or server-generated fallback. This nonce provides response correlation,
not room privacy: the server still sees the room token and membership
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
per-username allocation quota per tag, so per identity per hour. It checks the
expiry only when a TURN session first authenticates, so an allocation made with
a credential stays usable after the credential expires for as long as it is
refreshed; "Relay bound" under Deployment gives the limit this leaves. URL
normalization follows the `COTURN_URLS` limits above.

When `COTURN_SECRET` or `COTURN_URLS` is missing, or no URL survives
normalization, `turnCredentials` is omitted from the `roomId` response entirely
and clients stay STUN-only. The server never issues a credential without a
relay endpoint to use it against.

A protocol-v4 room leave is an exact-shape request with `type` equal to
`"leaveRoom"`, the socket-bound `fromPeerId`, the same 64-hex `roomUrl` used
to join, a fresh UUIDv4
`roomLeaveId`, and `protocolVersion: 4`. The server removes the authenticated
peer's membership before returning the same `roomUrl` and `roomLeaveId` in an
exact `roomLeft` acknowledgement. This works even before the client has
received a server-assigned `roomId`. Leaving a room that is already absent or
does not exist returns the same acknowledgement, so the operation is
retry-safe and does not expose room existence.

## Protocol-v4 authentication

Every WebSocket receives a new, socket-local nonce—even when its public key
already has a stable peer ID:

```json
{
  "type": "peerId",
  "peerId": "<uuid>",
  "challenge": "<64 lowercase hex>",
  "protocolVersion": 4,
  "message": "..."
}
```

The client signs that exact nonce with its Ed25519 identity key and replies:

```json
{
  "type": "challenge",
  "fromPeerId": "<same uuid>",
  "challenge": "<same 64 lowercase hex>",
  "signature": "<128 lowercase hex>",
  "protocolVersion": 4
}
```

After successful proof verification, the server registers the candidate
socket, commits its cross-instance routing claim, and rechecks that the exact
socket still owns the process-local registry entry. Only then does it return:

```json
{
  "type": "challenge",
  "challengeId": "<fresh uuid>",
  "protocolVersion": 4
}
```

This challenge-success object always has exactly those three fields. TURN
configuration does not alter authentication. When both `COTURN_SECRET` and
`COTURN_URLS` are configured, short-lived credentials arrive later in the
`roomId` response as a nested `turnCredentials` object containing `urls`,
`username`, `credential`, and `expiresAtUnixSeconds`. Historical challenge
signatures are not accepted as reconnect credentials.

When the same identity authenticates twice on one server process, the new
socket synchronously deauthorizes and closes its predecessor. Every later
frame must come from the exact socket currently held in that process's
registry. This is deliberately a process-local guarantee: `Peer.serverId` is
routing metadata, not a distributed session lease. Two sockets for the same
identity on different workers are not yet mutually fenced, so shared
cross-instance session fencing remains an explicit nonclaim. The bounded
message FIFO is per socket, and same-process room mutations are additionally
serialized by stable peer identity across socket replacement. That membership
ordering is not distributed across workers: there is no database generation
or advisory-lock fence yet, so cross-instance same-identity room mutation
ordering is also an explicit nonclaim. Supported production therefore runs one
worker. Multiple `signaling_ports` are an experimental operator opt-in until
both distributed fences exist.

Each socket retains at most 64 queued signaling frames and at most 2 MiB of
their serialized bytes; exceeding either bound closes it with overload code
`1013`. This explicit FIFO is required because Bun accepts asynchronous
WebSocket message handlers but does not promise per-socket await ordering.
Only an exact `pong` from the cryptographically proved current socket owner
bypasses that FIFO; malformed, unproved, or replaced-socket pongs do not.

## Client compatibility

This build speaks protocol version 4 only, in the exact shapes above. There is
no negotiation and no fallback for an older client: a frame carrying any other
`protocolVersion`, or a `room`/`leaveRoom` request whose key set is not exactly
the one documented, closes the socket.

Protocol v4 itself shipped in `p2party-js` 0.13.0, but the correlated room wire
this server requires — `roomRequestId`, `roomLeaveId`, and TURN credentials with
an absolute expiry — shipped in `p2party-js` 0.14.4, whose changelog names
`p2party-server` 0.1.1 as the matching server. A v4 client older than 0.14.4
sends a `room` request with no `roomRequestId`, fails the exact-shape check in
`handleMessage.ts`, and has its socket closed. So: `p2party-js` 0.14.4 or newer.

Server 0.1.2 added optional per-socket generations to introductions. SDK 0.14.8
uses them to distinguish a replacement tab from the previous transport for
the same peer identity; earlier clients ignore the fields. Deploy both builds
to obtain that recovery behavior. SDK 0.14.8 can still use a 0.1.1 server, but
the server cannot identify a replacement socket and the client's bounded
watchdog does not guarantee convergence in that case.

Server 0.1.3 adds opt-in correlated membership snapshots and bounded
target/exclusion lists for introductions. Existing SDK 0.14.4–0.14.8 clients
keep their legacy flow: without `rosterRequestId` they receive acceptance deltas
and no unsolicited snapshot; `rosterKind: "delta"` is additive metadata.
SDK 0.14.9 requires server 0.1.3 for its membership-driven mesh repair and
targeted redial behavior. Older servers do not provide this contract; matching
protocol version 4 alone does not establish support for these repair features.

This release issues TURN usernames of the form `<expiry>:<tag>` (see "Room
correlation and TURN credentials"). `p2party-js` 0.14.10 and earlier accept
only `<expiry>:<their own public key>` and reject every `roomId` response that
carries TURN credentials, so while TURN is configured they cannot join a room
on this server. They need a client release that accepts the tag.

## What the server stores

The Postgres schema is [`prisma/schema.prisma`](prisma/schema.prisma): four
models plus the implicit `PeerRooms` join table. The running server writes all
of them except `Challenge`.

- **`Peer`** — one row per Ed25519 identity public key, holding that key, a
  stable peer id, `lastPing`, and `serverId`: which process currently holds the
  socket, or null. A process that exits without shutting down leaves its
  claims behind; the next process to start clears them (see `PendingSignal`). Created only after a valid socket-bound signature and before
  routing activation. Existing peer IDs are preserved; previously unseen keys
  receive a domain-separated deterministic UUID candidate without an initial
  database write. Verified identity rows are retained to preserve stable IDs.
- **`Room`** — one row per room, keyed by `identifier`, the SHA-512 of the
  64-hex room token ([`src/utils/roomIdentifier.ts`](src/utils/roomIdentifier.ts)).
  The token itself is not stored, though the operator sees it on the wire when a
  client joins. Empty room records not updated for 24 hours are removed in batches of at
  most 1,000 per minute, rechecking emptiness at deletion. Occupied rooms and
  offline membership are retained.
- **`Peer`↔`Room` membership** — added by a `room` request, removed only by a
  `leaveRoom` request. A socket close clears `Peer.serverId` and nothing else,
  so membership outlives the connection.
- **`PendingSignal`** — a serialized frame written only when the target peer's
  socket belongs to another instance. Deleted on delivery, when the target is no
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
`deploy/deploy.sh`). A deploy builds `p2party_linux_x64` from this repo with
`bun run build:linux` and refuses to continue if the binary is missing; copies
it with a rendered environment file and one systemd unit per entry in
`signaling_ports`; installs the audited manifest and frozen lockfile into isolated
migration tooling; runs its Prisma CLI on the host and fails the play
if it errors, so a binary is never restarted against a schema it does not match;
narrows the Caddy upstream list before restarting; verifies the version,
protocol version and per-process `serverId` on every instance directly; retires
obsolete units; and only then checks that public Caddy answers with one of those
exact `serverId`s. [`tests/deploy.contract.test.ts`](tests/deploy.contract.test.ts)
pins that ordering.

Production sets `signaling_ports: [3001]` — one process — for the fencing
reasons above. Where several workers share a database, stop every worker of an
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

What this bounds, read from coturn's source (release 4.6.1 and master, November
2026): coturn counts `user-quota` per username part after
`<digits>:`, here the tag, and checks a username's expiry only when a TURN
session first authenticates. Refresh, CreatePermission and ChannelBind on that
session reuse the cached key and are not re-checked, and coturn does not end a
session when its credential expires.

- One credential username can reserve at most 12 × 625,000 = 7,500,000
  bytes/second, a quarter of the capacity. The playbook refuses overrides where
  `coturn_user_quota` × `coturn_max_bps` exceeds half of `coturn_bps_capacity`.
- One identity has no bound of its own over time. A client that keeps
  refreshing its allocations keeps them after the credential expires, and each
  hour it joins a room it receives a new tag with a fresh quota. Without
  refreshes past expiry, one identity holds reservations under at most three
  tags at once. A credential is issued at most two lifetimes L (one hour each)
  before it expires, and an unrefreshed allocation outlives it by at most
  A = `coturn_max_allocate_lifetime`. The tags live at one moment therefore
  expire within (now − A, now + 2L), which holds at most ⌈(2L + A)/L⌉ = 3 of
  them for 0 < A ≤ L.
- The relay as a whole is bounded by `total-quota` and `bps-capacity` only.
  This is a capacity and cost guard, not proof of unique users: a handful of
  identities can reserve the whole capacity.

The units and reservation semantics follow the [coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
and [bandwidth implementation notes](https://github.com/coturn/coturn/wiki/diff2projects).

## Privacy boundary

The server sees each client's Ed25519 identity public key, the room token a
client joins with, which peer ids share a room, the WebRTC descriptions and ICE
candidates it relays — which carry IP addresses — and the timing of all of it.

Its operator logs name a peer only by an eight-hex-digit tag: an HMAC of the
peer id under a key drawn at each process start and never stored. A tag links
log lines within one process lifetime; it is not the peer id or public key.

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
