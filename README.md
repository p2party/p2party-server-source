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

Postgres rather than SQLite because signaling is the one component that has to
tolerate more than one process. The schema carries `Peer.serverId` and a
`PendingSignal` table so an instance can hand a signal to the instance that
actually holds the target peer's socket, over `LISTEN`/`NOTIFY`.

For an Internet-facing deployment, terminate TLS in front of this process and
expose the WebSocket over `wss://`. The server does not configure TLS or launch
a TURN service. `COTURN_SECRET` only lets it issue short-lived credentials for
an independently operated TURN server.

Run the release checks with:

```bash
bun run check
bun run format:check
```

## Configuration

| Variable        | Required | Meaning                                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`  | yes      | Prisma `postgresql://` URL. A `file:` URL is rejected at startup.                                       |
| `PORT`          | no       | WebSocket listener port; defaults to `3001`.                                                            |
| `COTURN_SECRET` | no       | TURN REST shared secret (minimum 32 bytes). If absent, the server emits no TURN username or credential. |

There is no built-in TURN secret and no development authentication bypass.

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
| `challenge`      | A socket connects, or a challenge is re-issued.                  |
| `peerId`         | The challenge signature verified; this is your bound peer ID.    |
| `roomId`         | A `room` request created or joined a room.                       |
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
signaling message, 262,144 serialized characters per description, 4,096
serialized characters per ICE candidate, and at most 64 DataChannel labels of
256 characters each. Malformed, downgraded, cross-room, or cross-identity
signaling fails closed.

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

Only after successful verification does the server register the socket and
return:

```json
{
  "type": "challenge",
  "challengeId": "<fresh uuid>",
  "protocolVersion": 4
}
```

When `COTURN_SECRET` is configured, the final object additionally contains
both `username` and `credential`. Historical challenge signatures are not
accepted as reconnect credentials.

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
