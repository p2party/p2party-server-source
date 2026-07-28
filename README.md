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
  "version": "0.1.1",
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
| `peers`          | The room's current peer list, in response to `peerConnection`.   |
| `peerConnection` | Another peer asked to be introduced to you.                      |
| `connection`     | A peer requested DataChannel signaling with you.                 |
| `description`    | A relayed WebRTC session description.                            |
| `candidate`      | A relayed ICE candidate.                                         |
| `ping`           | Heartbeat. **Carries no `protocolVersion` and no `fromPeerId`.** |
| `error`          | Any rejection; the socket may or may not be closed.              |

> The interfaces in [`src/utils/interfaces.ts`](src/utils/interfaces.ts) are the
> starting point, not a complete schema. Handlers construct responses with an
> `as` cast, which bypasses TypeScript's excess-property check, so a frame can
> carry fields the interface does not declare — for example the human-readable
> `message` string on relayed `description` and `candidate` frames
> (`handleDescription.ts:40`, `handleCandidate.ts:39`). Read the handler
> alongside the interface before writing a client. Note also that the peer list
> is emitted by the `peerConnection` handler; the `peers` handler's own send is
> currently commented out (`handlePeers.ts:114-120`).

Enforced bounds live in
[`src/utils/protocolV4.ts`](src/utils/protocolV4.ts): 524,288 characters per
signaling message, 262,144 characters in the SDP string, 4,096 characters in
the ICE candidate string, 256 characters each in `sdpMid` and
`usernameFragment`, and at most 64 DataChannel labels of 193 characters each.
Malformed, downgraded, cross-room, or cross-identity signaling fails closed.

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
socket public key suffix. URL normalization follows the `COTURN_URLS` limits
above.

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

## Privacy boundary

The server learns stable signaling public keys, peer IDs, room membership, and
network metadata needed to establish WebRTC. It does **not** currently
implement blind rendezvous, hide room membership from the signaling operator,
or make TURN traffic peer-to-peer. Do not describe it as doing so until the L2
blind-meeting-point design is implemented and reviewed.

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting. Protocol
changes should include adversarial tests and must preserve exact version and
socket-identity binding.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. See [LICENSE.md](LICENSE.md).
