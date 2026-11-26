/**
 * Child process for preAuthUniformity.test.ts; not a test file.
 *
 * It replaces the shared Prisma client with a recording store before any
 * server module loads, so every query any module makes, through any helper,
 * is recorded. The store holds three identity states: a key registered with
 * its derived id, a key a server before 0.1.4 stored with a random id, and a
 * key never seen. It then runs the real server and drives real WebSocket
 * clients through the whole pre-authentication path (upgrade, challenge, a
 * signature that does not verify) and prints what each client observed.
 */
import { mock } from "bun:test";

const src = new URL("../../src/", import.meta.url).pathname;
const [registered, old, unregistered] = ["b2", "c3", "a1"].map((byte) =>
  byte.repeat(32),
) as [string, string, string];
const OLD_STYLE_ID = "0b5e0f2a-7d0c-4c55-9a3e-1f0d2c3b4a59";

const calls: string[] = [];
const stored = new Map<string, { id: string }>();
const model = (name: string) =>
  new Proxy(
    {},
    {
      get:
        (_, operation) => async (args?: { where?: { publicKey?: string } }) => {
          calls.push(`${name}.${String(operation)}`);
          return name === "peer" && operation === "findUnique"
            ? (stored.get(args?.where?.publicKey ?? "") ?? null)
            : null;
        },
    },
  );
const recordingPrisma = new Proxy(
  {},
  {
    get: (_, property) =>
      String(property).startsWith("$")
        ? async () => {
            calls.push(String(property));
            throw new Error("the recording store holds no transactions");
          }
        : model(String(property)),
  },
);
mock.module(`${src}prismaClient.ts`, () => ({
  prisma: recordingPrisma,
  PrismaClient: class {},
}));

const { provisionalPeerId } = await import(`${src}utils/peerIdentity.ts`);
const { P2PartyWS } = await import(`${src}wsServer.ts`);
stored.set(registered, { id: provisionalPeerId(registered) });
stored.set(old, { id: OLD_STYLE_ID });

// A free port from the operating system's ephemeral range (above 5000).
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port!;
probe.stop(true);
new P2PartyWS(port, { open() {}, message() {}, close() {} });

const observe = (key: string) =>
  new Promise<{
    frames: string[];
    close: { code: number; reason: string };
    queries: string[];
  }>((resolve, reject) => {
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?publickey=${key}`);
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
    ws.onerror = () => reject(new Error(`socket error for ${key}`));
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
] as const)
  observations[label] = await observe(key);
console.log(JSON.stringify(observations));
process.exit(0);
