import { describe, expect, test } from "bun:test";

import handleChallenge from "../../src/utils/handleChallenge";
import { createFreshSocketChallenge } from "../../src/utils/socketAuth";
import { PROTOCOL_VERSION } from "../../src/utils/protocolV4";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_PEER_ID = "00000000-0000-4000-8000-000000000003";
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
    createFreshSocketChallenge(
      socket.ws.data,
      PEER_ID,
      publicKey,
      challenge,
      CHALLENGE_ID,
    );
    let verifiedBytes:
      | {
          message: Uint8Array;
          signature: Uint8Array;
          publicKey: Uint8Array;
        }
      | undefined;

    try {
      const authenticated = await handleChallenge(
        PEER_ID,
        socket.ws,
        challenge,
        signature,
        {
          verifySignature: async (message, sig, pk) => {
            verifiedBytes = { message, signature: sig, publicKey: pk };
            return true;
          },
        },
      );

      expect(authenticated).toEqual({
        type: "challenge",
        challengeId: CHALLENGE_ID,
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(verifiedBytes?.message).toEqual(new Uint8Array(32).fill(0xcd));
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

  test("a proof for another socket identity is rejected before signature verification", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    createFreshSocketChallenge(
      socket.ws.data,
      PEER_ID,
      "ab".repeat(32),
      challenge,
      CHALLENGE_ID,
    );
    let verifierCalled = false;

    const authenticated = await handleChallenge(
      OTHER_PEER_ID,
      socket.ws,
      challenge,
      "ef".repeat(64),
      {
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
    createFreshSocketChallenge(
      socket.ws.data,
      PEER_ID,
      "ab".repeat(32),
      challenge,
      CHALLENGE_ID,
    );

    const authenticated = await handleChallenge(
      PEER_ID,
      socket.ws,
      challenge,
      "ef".repeat(64),
      {
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
    createFreshSocketChallenge(
      socket.ws.data,
      PEER_ID,
      "ab".repeat(32),
      challenge,
      CHALLENGE_ID,
    );
    let verifierCalled = false;

    // Uppercase hex is syntactically 128 characters but fails handleChallenge's
    // own canonical-lowercase-hex check -- an encoding bug a corrected client
    // could fix, not proof the key is wrong.
    const authenticated = await handleChallenge(
      PEER_ID,
      socket.ws,
      challenge,
      "EF".repeat(64),
      {
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
    createFreshSocketChallenge(
      socket.ws.data,
      PEER_ID,
      "ab".repeat(32),
      challenge,
      CHALLENGE_ID,
    );

    const authenticated = await handleChallenge(
      PEER_ID,
      socket.ws,
      challenge,
      "ef".repeat(64),
      {
        verifySignature: async () => {
          throw new Error("verifier crashed");
        },
      },
    );

    expect(authenticated).toBe(false);
    // A thrown exception from the verification library is not evidence the
    // key is bad -- it could be transient. Leave it retryable.
    expect(socket.wasTerminated()).toBe(false);
    expect(socket.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
    expect(socket.ws.data.isAuthenticating).toBe(false);
  });
});
