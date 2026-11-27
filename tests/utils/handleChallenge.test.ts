import { generateKeyPairSync, sign } from "node:crypto";
import { provisionalPeerId } from "../../src/utils/peerIdentity";
import { describe, expect, spyOn, test } from "bun:test";

import handleChallenge from "../../src/utils/handleChallenge";
import { createFreshSocketChallenge } from "../../src/utils/socketAuth";
import { SIGNALING_PROTOCOL_VERSION } from "../../src/utils/signalingProtocol";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const KEY = "ab".repeat(32);
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000002";

const fakeSocket = () => {
  const sent: string[] = [];
  let terminated = false;
  const closeArgs: { code?: number; reason?: string }[] = [];
  const data: P2PartyWSData = {
    peerId: "",
    publicKey: "",
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: false,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    data,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    close: (code?: number, reason?: string) => {
      closeArgs.push({ code, reason });
    },
    terminate: () => {
      terminated = true;
    },
  } as unknown as P2PartyWSClient;

  return {
    ws,
    sent,
    closeArgs,
    wasTerminated: () => terminated,
  };
};

describe("WebSocket-bound challenge verification", () => {
  test("valid proof yields the exact challenge-success shape without emitting before the routing claim", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    const publicKey = "ab".repeat(32);
    const signature = "ef".repeat(64);
    const previousTurnSecret = process.env.COTURN_SECRET;
    const previousTurnUrls = process.env.COTURN_URLS;
    process.env.COTURN_SECRET = "s".repeat(32);
    process.env.COTURN_URLS = "turns:turn.example.com:443?transport=tcp";
    createFreshSocketChallenge(socket.ws.data, challenge, CHALLENGE_ID);
    let verifiedBytes:
      | {
          message: Uint8Array;
          signature: Uint8Array;
          publicKey: Uint8Array;
        }
      | undefined;

    try {
      const authenticated = await handleChallenge(
        KEY,
        socket.ws,
        challenge,
        signature,
        {
          signalingHost: "example.org",
          verifySignature: async (message, sig, pk) => {
            verifiedBytes = { message, signature: sig, publicKey: pk };
            return true;
          },
        },
      );

      expect(authenticated).toEqual({
        type: "challenge",
        challengeId: CHALLENGE_ID,
        peerId: provisionalPeerId(KEY),
        protocolVersion: SIGNALING_PROTOCOL_VERSION,
      });
      expect(verifiedBytes?.message).toEqual(
        new Uint8Array(
          Buffer.concat([
            Buffer.from("p2party-signaling-auth-v2\0example.org\0"),
            Buffer.alloc(32, 0xcd),
          ]),
        ),
      );
      expect(verifiedBytes?.signature).toEqual(new Uint8Array(64).fill(0xef));
      expect(verifiedBytes?.publicKey).toEqual(new Uint8Array(32).fill(0xab));
      expect(socket.ws.data.isVerified).toBe(true);
      expect(socket.ws.data.challengeNonce).toBe("");
      expect(socket.ws.data.challengeId).toBe("");
      // This is the production seam the whole per-socket-generation feature
      // rides on: consumeSocketChallenge must actually write the consumed
      // challenge id into ws.data.socketGeneration, through the real
      // handleChallenge() call above -- not a hand-constructed fixture. See
      // socketAuth.ts's SocketAuthState.socketGeneration doc comment.
      expect(socket.ws.data.socketGeneration).toBe(CHALLENGE_ID);
      expect(socket.sent).toEqual([]);
      expect(socket.wasTerminated()).toBe(false);
    } finally {
      if (previousTurnSecret === undefined) delete process.env.COTURN_SECRET;
      else process.env.COTURN_SECRET = previousTurnSecret;
      if (previousTurnUrls === undefined) delete process.env.COTURN_URLS;
      else process.env.COTURN_URLS = previousTurnUrls;
    }
  });

  test("a proof for another nonce is rejected before signature verification", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    createFreshSocketChallenge(socket.ws.data, challenge, CHALLENGE_ID);
    let verifierCalled = false;

    const authenticated = await handleChallenge(
      KEY,
      socket.ws,
      "cc".repeat(32),
      "ef".repeat(64),
      {
        signalingHost: "example.org",
        verifySignature: async () => {
          verifierCalled = true;
          return true;
        },
      },
    );

    expect(authenticated).toBe(false);
    expect(verifierCalled).toBe(false);
    expect(socket.ws.data.isVerified).toBe(false);
    // A stale/mismatched challenge is not proof the credentials are bad --
    // on a live, already-verified socket the identical branch fires for a
    // duplicate/late "challenge" frame, so this must stay retryable (a bare
    // close, no code) rather than the permanent 1008 code. It must still be
    // close(), not terminate(): terminate() can drop the error frame sent
    // just above it.
    expect(socket.wasTerminated()).toBe(false);
    expect(socket.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
  });

  test("a signature that fails verification closes permanently with 1008, after the error frame is delivered", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    createFreshSocketChallenge(socket.ws.data, challenge, CHALLENGE_ID);

    const authenticated = await handleChallenge(
      KEY,
      socket.ws,
      challenge,
      "ef".repeat(64),
      {
        signalingHost: "example.org",
        verifySignature: async () => false,
      },
    );

    expect(authenticated).toBe(false);
    expect(socket.ws.data.isVerified).toBe(false);
    // The client proved it does not hold the key. Retrying with the same
    // credentials can never succeed, so this is the one branch that must
    // carry the permanent code -- and terminate() would risk dropping the
    // error frame ws.send() just queued, so this must be close(), not
    // terminate().
    expect(socket.wasTerminated()).toBe(false);
    expect(socket.closeArgs).toEqual([
      { code: 1008, reason: expect.any(String) },
    ]);
    expect(socket.closeArgs[0]!.reason!.length).toBeGreaterThan(0);
    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!) as {
      type: string;
      fromAction: string;
      error: { message: string };
    };
    expect(frame.type).toBe("error");
    expect(frame.fromAction).toBe("sendChallengeResponse");
    expect(frame.error.message).toBe(
      "Challenge response signature cannot be verified",
    );
  });

  test("a malformed signature encoding closes without a permanent code", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    createFreshSocketChallenge(socket.ws.data, challenge, CHALLENGE_ID);
    let verifierCalled = false;

    // Uppercase hex is syntactically 128 characters but fails handleChallenge's
    // own canonical-lowercase-hex check -- an encoding bug a corrected client
    // could fix, not proof the key is wrong.
    const authenticated = await handleChallenge(
      KEY,
      socket.ws,
      challenge,
      "EF".repeat(64),
      {
        signalingHost: "example.org",
        verifySignature: async () => {
          verifierCalled = true;
          return true;
        },
      },
    );

    expect(authenticated).toBe(false);
    expect(verifierCalled).toBe(false);
    expect(socket.wasTerminated()).toBe(false);
    expect(socket.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
  });

  test("an exception from the verification library itself closes without a permanent code", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    createFreshSocketChallenge(socket.ws.data, challenge, CHALLENGE_ID);

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    let authenticated: Awaited<ReturnType<typeof handleChallenge>>;
    try {
      authenticated = await handleChallenge(
        KEY,
        socket.ws,
        challenge,
        "ef".repeat(64),
        {
          signalingHost: "example.org",
          verifySignature: async () => {
            throw new Error("verifier crashed");
          },
        },
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(authenticated).toBe(false);
    // A thrown exception from the verification library is not evidence the
    // key is bad -- it could be transient. Leave it retryable.
    expect(socket.wasTerminated()).toBe(false);
    expect(socket.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
    expect(socket.ws.data.isAuthenticating).toBe(false);
  });

  test("a verification-library exception's text never reaches the client", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    createFreshSocketChallenge(socket.ws.data, challenge, CHALLENGE_ID);

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleChallenge(KEY, socket.ws, challenge, "ef".repeat(64), {
        signalingHost: "example.org",
        verifySignature: async () => {
          throw new Error("libsodium: sodium_init failed at 0x7ffd");
        },
      });
      // The operator log keeps the cause.
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }

    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!) as {
      type: string;
      fromAction: string;
      error: { message: string };
    };
    expect(frame).toEqual({
      type: "error",
      fromAction: "sendChallengeResponse",
      error: { message: "Challenge response could not be verified" },
    });
    expect(socket.sent[0]).not.toContain("libsodium");
    expect(socket.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
  });
});

test.each(["raw nonce", "another host"])(
  "server refuses a proof signed for %s",
  async (variant) => {
    const socket = fakeSocket();
    const challenge = createFreshSocketChallenge(socket.ws.data).challenge;
    const bytes = Buffer.from(challenge, "hex");
    const signed =
      variant === "raw nonce"
        ? bytes
        : Buffer.concat([
            Buffer.from("p2party-signaling-auth-v2\0elsewhere.example\0"),
            bytes,
          ]);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(
      keys.publicKey.export({ format: "jwk" }).x!,
      "base64url",
    ).toString("hex");
    const signature = sign(
      null,
      new Uint8Array(signed),
      keys.privateKey,
    ).toString("hex");
    expect(
      await handleChallenge(publicKey, socket.ws, challenge, signature, {
        signalingHost: "signaling.example",
      }),
    ).toBe(false);
    expect(socket.ws.data.peerId).toBe("");
    expect(socket.ws.data.publicKey).toBe("");
    expect(socket.closeArgs[0]?.code).toBe(1008);
  },
);
