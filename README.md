# p2party-server

The protocol-v3 signaling server for p2party WebRTC room meshes. It
authenticates each WebSocket with a fresh Ed25519 challenge, coordinates room
membership, and forwards bounded WebRTC descriptions and ICE candidates only
between authenticated peers in the same room.

Application messages and files do not pass through this server. Their
end-to-end encryption and per-message DataChannels live in
[`p2party-js`](https://github.com/p2party/p2party-js).

## Requirements

- Bun 1.3 or newer
- A Prisma-supported database configured by `DATABASE_URL`

## Local setup

```bash
bun install
cp .env.example .env
bunx prisma generate
bun run start
```

The example environment uses `prisma/dev.db`. Database files, sidecars,
environment files, and compiled server binaries are ignored and must never be
committed.

Run the release checks with:

```bash
bun run check
bun run format:check
```

## Configuration

| Variable        | Required | Meaning                                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`  | yes      | Prisma connection URL.                                                                                  |
| `PORT`          | no       | WebSocket listener port; defaults to `3001`.                                                            |
| `COTURN_SECRET` | no       | TURN REST shared secret (minimum 32 bytes). If absent, the server emits no TURN username or credential. |

There is no built-in TURN secret and no development authentication bypass.

## Protocol-v3 authentication

Every WebSocket receives a new, socket-local nonce—even when its public key
already has a stable peer ID:

```json
{
  "type": "peerId",
  "peerId": "<uuid>",
  "challenge": "<64 lowercase hex>",
  "protocolVersion": 3,
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
  "protocolVersion": 3
}
```

Only after successful verification does the server register the socket and
return:

```json
{
  "type": "challenge",
  "challengeId": "<fresh uuid>",
  "protocolVersion": 3
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

## License

Apache License 2.0. See [LICENSE.md](LICENSE.md).
