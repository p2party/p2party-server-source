import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import handleConnection from "../../src/utils/handleConnection";
import handleChallenge from "../../src/utils/handleChallenge";
import { provisionalPeerId } from "../../src/utils/peerIdentity";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

/**
 * Before the signature is checked, a socket must learn nothing about whether
 * its key has an identity row: the same frames, the same close, and the same
 * database work. Rows written by servers before 0.1.4 carry a random id, and
 * the server used to look the key up and send that id, which marked the key
 * as known to anyone holding it. The path now reads nothing before the
 * verdict (second test), so whatever the store holds for these keys cannot
 * shape the answer; the first test checks the answer itself.
 */
const IDENTITIES = [
  // Never seen.
  "a1".repeat(32),
  // Seen, stored under the key's derived id.
  "b2".repeat(32),
  // Seen by a server before 0.1.4, stored under a random id.
  "c3".repeat(32),
] as const;

const socket = (publicKey: string) => {
  const sent: string[] = [];
  const closeArgs: { code?: number; reason?: string }[] = [];
  const data: P2PartyWSData = {
    peerId: "",
    publicKey,
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: false,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    data,
    readyState: 1,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    close: (code?: number, reason?: string) => {
      closeArgs.push({ code, reason });
    },
  } as unknown as P2PartyWSClient;
  return { ws, sent, closeArgs };
};

/** A frame with the per-key peer id and the per-socket nonce blanked out. */
const normalized = (raw: string, peerId: string) =>
  JSON.parse(
    raw.replaceAll(peerId, "<peer id>").replace(/[0-9a-f]{64}/, "<nonce>"),
  ) as unknown;

describe("pre-authentication responses", () => {
  test("unknown and known identities get the same pre-auth response", async () => {
    const observed: {
      peerIdIsTheKeysDerivedId: boolean;
      frames: unknown[];
      closes: { code?: number; reason?: string }[];
    }[] = [];
    for (const key of IDENTITIES) {
      const { ws, sent, closeArgs } = socket(key);

      const peerId = await handleConnection(key, ws);
      const hello = JSON.parse(sent[0]!) as {
        peerId: string;
        challenge: string;
      };
      // An answer whose signature does not verify: the last pre-auth step.
      expect(
        await handleChallenge(
          hello.peerId,
          ws,
          hello.challenge,
          "ef".repeat(64),
          { verifySignature: async () => false },
        ),
      ).toBe(false);

      observed.push({
        peerIdIsTheKeysDerivedId:
          peerId === provisionalPeerId(key) && hello.peerId === peerId,
        frames: sent.map((raw) => normalized(raw, peerId)),
        closes: closeArgs,
      });
    }

    expect(observed).toEqual(IDENTITIES.map(() => observed[0]!));
    expect(observed[0]).toEqual({
      peerIdIsTheKeysDerivedId: true,
      frames: [
        {
          type: "peerId",
          peerId: "<peer id>",
          challenge: "<nonce>",
          protocolVersion: 4,
          message: "Connected to WebSocket server. Your client id is <peer id>",
        },
        {
          type: "error",
          fromAction: "sendChallengeResponse",
          error: { message: "Challenge response signature cannot be verified" },
        },
      ],
      closes: [
        {
          code: 1008,
          reason: "Challenge response signature cannot be verified",
        },
      ],
    });
  });

  test("the pre-authentication path has no database client to query", () => {
    // Neither module of the path up to the signature verdict imports the
    // Prisma client or calls one, so both kinds of key cost the same: no
    // query at all. The upgrade handler in wsServer.ts reads no identity
    // state either; its admission buckets are keyed by address.
    const utils = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "utils",
    );
    for (const file of ["handleConnection.ts", "handleChallenge.ts"]) {
      const source = readFileSync(join(utils, file), "utf8");
      expect(source, file).not.toContain("prismaClient");
      expect(source, file).not.toMatch(/\bprisma\b/);
      expect(source, file).not.toContain("$transaction");
    }
  });
});
