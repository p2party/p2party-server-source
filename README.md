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
- SQLite configured with a Prisma `file:` URL in `DATABASE_URL`

## Local setup

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run db:generate
bun run db:migrate
bun run start
```

The migration command creates the example `prisma/dev.db` on a fresh clone and
applies every checked-in migration. Prisma resolves relative SQLite paths from
`prisma/schema.prisma`. Database files, sidecars, environment files, and
compiled server binaries are ignored and must never be committed.

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
| `DATABASE_URL`  | yes      | Prisma SQLite `file:` URL; relative paths resolve from `prisma/schema.prisma`.                          |
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

The complete wire shapes live in
[`src/utils/interfaces.ts`](src/utils/interfaces.ts). Enforced bounds live in
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
