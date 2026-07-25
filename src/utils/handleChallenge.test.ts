import { describe, expect, test } from "bun:test";

import handleChallenge from "./handleChallenge";
import { createFreshSocketChallenge } from "./socketAuth";
import { PROTOCOL_VERSION } from "./protocolV4";

import type { P2PartyWSClient, P2PartyWSData } from "../wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_PEER_ID = "00000000-0000-4000-8000-000000000003";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000002";

const fakeSocket = () => {
  const sent: string[] = [];
  let terminated = false;
  const data: P2PartyWSData = {
    peerId: "",
    publicKey: "",
    challengeNonce: "",
    challengeId: "",
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
    terminate: () => {
      terminated = true;
    },
  } as unknown as P2PartyWSClient;

  return {
    ws,
    sent,
    wasTerminated: () => terminated,
  };
};

describe("WebSocket-bound challenge verification", () => {
  test("valid proof verifies bound bytes, consumes the nonce, and omits TURN when unconfigured", async () => {
    const socket = fakeSocket();
    const challenge = "cd".repeat(32);
    const publicKey = "ab".repeat(32);
    const signature = "ef".repeat(64);
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
        turnSecret: null,
      },
    );

    expect(authenticated).toBe(true);
    expect(verifiedBytes?.message).toEqual(new Uint8Array(32).fill(0xcd));
    expect(verifiedBytes?.signature).toEqual(new Uint8Array(64).fill(0xef));
    expect(verifiedBytes?.publicKey).toEqual(new Uint8Array(32).fill(0xab));
    expect(socket.ws.data.isVerified).toBe(true);
    expect(socket.ws.data.challengeNonce).toBe("");
    expect(socket.ws.data.challengeId).toBe("");
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "challenge",
      challengeId: CHALLENGE_ID,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(socket.wasTerminated()).toBe(false);
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
        turnSecret: null,
      },
    );

    expect(authenticated).toBe(false);
    expect(verifierCalled).toBe(false);
    expect(socket.ws.data.isVerified).toBe(false);
    expect(socket.wasTerminated()).toBe(true);
  });
});
