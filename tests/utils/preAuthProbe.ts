/**
 * Child process for preAuthUniformity.test.ts; not a test file.
 *
 * It replaces the shared Prisma client with a recording store before any
 * server module loads, so every query any module makes, through any helper,
 * is recorded. It then runs the real server and drives real WebSocket clients
 * through the whole pre-authentication path (upgrade, challenge, a signature
 * that does not verify) for five identity states:
 *
 *   registered    a row with the key's derived id
 *   oldStyle      a row a server before 0.1.4 stored with a random id
 *   unregistered  no row
 *   connected     a row with a live claim, and a live, authenticated socket
 *                 for the key in this process's registry (a real login)
 *   atLimit       a row, and the key's per-identity admission bucket full
 *
 * and prints what each client observed.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { mock } from "bun:test";

const src = new URL("../../src/", import.meta.url).pathname;
const [registered, old, unregistered, atLimit] = ["b2", "c3", "a1", "e5"].map(
  (byte) => byte.repeat(32),
) as [string, string, string, string];
const OLD_STYLE_ID = "0b5e0f2a-7d0c-4c55-9a3e-1f0d2c3b4a59";
const loginKeys = generateKeyPairSync("ed25519");
const connected = Buffer.from(
  loginKeys.publicKey.export({ format: "jwk" }).x!,
  "base64url",
).toString("hex");

const calls: string[] = [];
type Row = {
  id: string;
  serverId: string | null;
  socketGeneration: string | null;
};
const stored = new Map<string, Row>();
const model = (name: string) =>
  new Proxy(
    {},
    {
      get:
        (_, operation) =>
        async (args?: {
          where?: { publicKey?: string };
          update?: Partial<Row>;
        }) => {
          calls.push(`${name}.${String(operation)}`);
          const row = stored.get(args?.where?.publicKey ?? "");
          // A copy, as a database returns: the row itself changes below.
          if (name === "peer" && operation === "findUnique")
            return row ? { ...row } : null;
          // The login's identity commit: write its claim onto the row.
          if (name === "peer" && operation === "upsert" && row)
            Object.assign(row, args?.update);
          return null;
        },
    },
  );
const recordingPrisma = new Proxy(
  {},
  {
    get: (_, property) => {
      if (property === "$transaction")
        return async (run: (tx: unknown) => Promise<unknown>) => {
          calls.push("$transaction");
          return run(recordingPrisma);
        };
      if (String(property).startsWith("$"))
        return async () => {
          calls.push(String(property));
          throw new Error(`the recording store has no ${String(property)}`);
        };
      return model(String(property));
    },
  },
);
mock.module(`${src}prismaClient.ts`, () => ({
  prisma: recordingPrisma,
  PrismaClient: class {},
}));

const { provisionalPeerId } = await import(`${src}utils/peerIdentity.ts`);
const { P2PartyWS, wsClients } = await import(`${src}wsServer.ts`);
const { admission, admissionLimits } = await import(`${src}utils/admission.ts`);
const { isCurrentVerifiedSocket } = await import(`${src}utils/socketAuth.ts`);
const row = (id: string): Row => ({
  id,
  serverId: null,
  socketGeneration: null,
});
stored.set(registered, row(provisionalPeerId(registered)));
stored.set(old, row(OLD_STYLE_ID));
stored.set(connected, row(provisionalPeerId(connected)));
stored.set(atLimit, row(provisionalPeerId(atLimit)));

// A free port from the operating system's ephemeral range (above 5000).
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port!;
probe.stop(true);
new P2PartyWS(port, { open() {}, message() {}, close() {} });
const url = (key: string) => `ws://127.0.0.1:${port}/ws?publickey=${key}`;

// "connected": a real login, so the key has a live claim and a current socket.
const live = await new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url(connected));
  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as {
      type: string;
      peerId?: string;
      challenge?: string;
    };
    if (frame.type === "peerId")
      ws.send(
        JSON.stringify({
          type: "challenge",
          fromPeerId: frame.peerId,
          challenge: frame.challenge,
          signature: sign(
            null,
            new Uint8Array(Buffer.from(frame.challenge!, "hex")),
            loginKeys.privateKey,
          ).toString("hex"),
          protocolVersion: 4,
        }),
      );
    if (frame.type === "challenge") resolve(ws);
  };
  ws.onclose = (event) =>
    reject(new Error(`login closed with ${String(event.code)}`));
});
const liveSocket = wsClients.get(provisionalPeerId(connected));
if (!liveSocket?.data.socketGeneration || !stored.get(connected)!.serverId)
  throw new Error("the connected identity has no live socket and claim");

// "atLimit": every per-identity socket slot of the key taken by proved
// sockets from other addresses.
for (let slot = 0; slot < admissionLimits.connectionsPerIdentity; slot++)
  if (
    !admission.reserve(`192.0.2.${String(slot + 1)}`, atLimit)?.authenticate()
  )
    throw new Error("could not fill the identity's admission bucket");

calls.splice(0);
const observe = (key: string) =>
  new Promise<{
    frames: string[];
    close: { code: number; reason: string };
    queries: string[];
  }>((resolve) => {
    const frames: string[] = [];
    const ws = new WebSocket(url(key));
    ws.onmessage = (event) => {
      const raw = String(event.data);
      frames.push(raw);
      const frame = JSON.parse(raw) as {
        type: string;
        peerId?: string;
        challenge?: string;
      };
      if (frame.type === "peerId")
        ws.send(
          JSON.stringify({
            type: "challenge",
            fromPeerId: frame.peerId,
            challenge: frame.challenge,
            signature: "ef".repeat(64),
            protocolVersion: 4,
          }),
        );
    };
    // A refused upgrade is an observation too: no frames and its close.
    ws.onclose = (event) => {
      const peerId = provisionalPeerId(key);
      resolve({
        // Byte for byte, with only the key's derived id and the nonce blanked.
        frames: frames.map((raw) =>
          raw
            .replaceAll(peerId, "<derived peer id>")
            .replace(/"challenge":"[0-9a-f]{64}"/, '"challenge":"<nonce>"'),
        ),
        close: { code: event.code, reason: event.reason },
        queries: calls.splice(0),
      });
    };
  });

const observations: Record<string, unknown> = {};
for (const [label, key] of [
  ["registered", registered],
  ["oldStyle", old],
  ["unregistered", unregistered],
  ["connected", connected],
  ["atLimit", atLimit],
] as const)
  observations[label] = await observe(key);
// The live session of the connected identity was not disturbed.
observations.connectedSessionUntouched =
  live.readyState === WebSocket.OPEN &&
  wsClients.get(provisionalPeerId(connected)) === liveSocket &&
  isCurrentVerifiedSocket(wsClients, liveSocket) &&
  stored.get(connected)!.socketGeneration === liveSocket.data.socketGeneration;
console.log(JSON.stringify(observations));
process.exit(0);
