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
that have not run yet and never resets anything, so it is safe against a live
database. Environment files and compiled server binaries are gitignored and
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
  "version": "0.1.2",
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

| Client message   | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `challenge`      | Prove possession of the Ed25519 identity key for this socket. |
| `room`           | Create or join the room represented by a 64-hex room token.   |
| `leaveRoom`      | Idempotently remove this authenticated peer from one room.    |
| `peers`          | Ask the server to introduce this peer to existing room peers. |
| `peerConnection` | Accept a room peer introduction.                              |
| `connection`     | Request signaling for the listed DataChannel labels.          |
| `description`    | Forward a bounded WebRTC session description to a room peer.  |
| `candidate`      | Forward a bounded ICE candidate to a room peer.               |
| `pong`           | Answer the server heartbeat.                                  |

### Server messages

The server emits these. Every one except `ping` carries `protocolVersion: 4`.

| Server message   | Sent when                                                        |
| ---------------- | ---------------------------------------------------------------- |
| `peerId`         | A socket connects and receives its bound peer ID and challenge.  |
| `challenge`      | The challenge signature verified; authentication is complete.    |
| `roomId`         | A `room` request created or joined a room.                       |
| `roomLeft`       | The requested membership is absent after an idempotent leave.    |
| `peers`          | One peer that accepted an introduction. A delta, not a snapshot. |
| `peerConnection` | Another peer asked to be introduced to you.                      |
| `connection`     | A peer requested DataChannel signaling with you.                 |
| `description`    | A relayed WebRTC session description.                            |
| `candidate`      | A relayed ICE candidate.                                         |
| `ping`           | Heartbeat. **Carries no `protocolVersion` and no `fromPeerId`.** |
| `error`          | Any rejection; the socket may or may not be closed.              |

> The interfaces in [`src/utils/interfaces.ts`](src/utils/interfaces.ts) are the
> starting point, not a complete schema. Handlers construct responses with an
> `as` cast, which bypasses TypeScript's excess-property check, so a frame can
> carry fields the interface does not declare — the human-readable `message`
> string on relayed `description` and `candidate` frames
> (`handleDescription.ts:36`, `handleCandidate.ts:35`), and `fromPeerPublicKey`
> on a relayed `connection` frame (`handlePeerConnection.ts:59`). Read the
> handler alongside the interface before writing a client. Note also that a
> `peers` frame is emitted by the handler for the client's `peerConnection`
> message, not by the `peers` handler, whose own reply to the requester is
> commented out (`handlePeers.ts:125-131`).

### Message flow

Every frame is an event. Nothing the server sends is a room snapshot.

1. **`peerId`** (server → client), immediately on open: the socket's peer id and
   a fresh 32-byte challenge nonce.
2. **`challenge`** (client → server): the Ed25519 signature over that exact
   nonce. This is the only frame accepted before authentication.
3. **`challenge`** (server → client): `challengeId` and nothing else. The socket
   is now the current verified socket for its peer id.
4. **`room`** (client → server) with a 64-hex room token and a UUIDv4
   `roomRequestId`; **`roomId`** (server → client) echoes both and carries the
   room's server-side UUID, plus `turnCredentials` when TURN is configured.
5. **`peers`** (client → server) with that room UUID. The server does **not**
   answer the requester. It sends a **`peerConnection`** introduction naming the
   requester — `{ id, publicKey }` — to every _other_ member of that room
   (`handlePeers.ts`).
6. **`peerConnection`** (existing member → server) accepts the introduction; the
   server sends the joiner a **`peers`** frame whose array holds exactly one
   entry, the accepting peer (`handlePeerAcceptsConnection.ts:87-92`). One
   accepted peer per frame, one frame per acceptance.
7. **`connection`**, **`description`** and **`candidate`** are relayed to
   `toPeerId` after `findRoomPeers` re-checks that both peers exist and both are
   members of that room. The relayed copy drops `toPeerId` and carries the
   sender's `fromPeerId`.

Because a `peers` frame is one accepted peer, a client that treated it as the
room roster would delete every other member. The SDK merges it as an additive
delta (`p2party-js/src/handlers/peerRosterDelta.ts`).

**The server never signals a departure.** Its close handler releases the peer's
routing claim and logs (`src/wsServer.ts`, `src/index.ts`); it sends nothing to
the room. There is no `peerLeft` frame in the protocol, and a `leaveRoom` is
acknowledged only to the peer that sent it. The membership row survives the
disconnect too — only an explicit `leaveRoom` removes one. Clients therefore
learn that a peer is gone from their own transport state, not from this server.

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
    "username": "<expiresAtUnixSeconds>:<socket Ed25519 public key>",
    "credential": "<TURN REST HMAC>",
    "expiresAtUnixSeconds": 1785258000
  }
}
```

The expiry is bound to both the numeric username prefix and the authenticated
socket public key suffix. `credential` is the base64 HMAC-SHA1 of `username`
under `COTURN_SECRET` — the coturn REST convention — and the lifetime is one
hour (`TURN_CREDENTIAL_CONTRACT.lifetimeSeconds` in
[`src/utils/socketAuth.ts`](src/utils/socketAuth.ts)). A fresh bundle is minted
on every successful room join, not once per socket. URL normalization follows
the `COTURN_URLS` limits above.

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

Server 0.1.2 adds optional per-socket generations to introductions. SDK 0.14.8
uses them to distinguish a replacement tab from the previous transport for
the same peer identity; earlier clients ignore the fields. Deploy both builds
to obtain that recovery behavior. SDK 0.14.8 can still use a 0.1.1 server, but
the server cannot identify a replacement socket and the client's bounded
watchdog does not guarantee convergence in that case.

## What the server stores

The Postgres schema is [`prisma/schema.prisma`](prisma/schema.prisma): four
models plus the implicit `PeerRooms` join table. The running server writes all
of them except `Challenge`.

- **`Peer`** — one row per Ed25519 identity public key, holding that key, a
  stable peer id, `lastPing`, and `serverId`: which process currently holds the
  socket, or null. Created on connect (`handleConnection.ts`) and never deleted.
- **`Room`** — one row per room, keyed by `identifier`, the SHA-512 of the
  64-hex room token ([`src/utils/roomIdentifier.ts`](src/utils/roomIdentifier.ts)).
  The token itself is not stored, though the operator sees it on the wire when a
  client joins. Rooms are never deleted, including when the last member leaves.
- **`Peer`↔`Room` membership** — added by a `room` request, removed only by a
  `leaveRoom` request. A socket close clears `Peer.serverId` and nothing else,
  so membership outlives the connection.
- **`PendingSignal`** — a serialized frame written only when the target peer's
  socket belongs to another instance. Deleted on delivery, when the target is no
  longer here, at shutdown, and by a startup sweep of rows addressed to server
  ids no connected peer claims.
- **`Challenge`** — declared in the schema, but the running server never writes
  it. Challenge nonces live on the socket
  ([`src/utils/socketAuth.ts`](src/utils/socketAuth.ts)) and are discarded when
  consumed.

## Deployment

`deploy/` provisions and updates the reference deployment. None of it is
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
`signaling_ports`; runs `prisma migrate deploy` on the host and fails the play
if it errors, so a binary is never restarted against a schema it does not match;
narrows the Caddy upstream list before restarting; verifies the version,
protocol version and per-process `serverId` on every instance directly; retires
obsolete units; and only then checks that public Caddy answers with one of those
exact `serverId`s. [`tests/deploy.contract.test.ts`](tests/deploy.contract.test.ts)
pins that ordering.

Production sets `signaling_ports: [3001]` — one process — for the fencing
reasons above. Caddy terminates TLS, proxies the WebSocket, sets HSTS and a
content-security policy, and logs with client IPs masked to /24 and /48. coturn
is configured by `playbooks/setup-coturn.yml`; this server only issues
credentials for it.

## Privacy boundary

The server sees each client's Ed25519 identity public key, the room token a
client joins with, which peer ids share a room, the WebRTC descriptions and ICE
candidates it relays — which carry IP addresses — and the timing of all of it.

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
