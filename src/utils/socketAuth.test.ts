import { describe, expect, test } from "bun:test";

import {
  consumeSocketChallenge,
  createFreshSocketChallenge,
  createTurnCredentials,
  isSocketChallengeBound,
  registerVerifiedSocket,
  unregisterSocketIfCurrent,
} from "./socketAuth";
import { PROTOCOL_VERSION } from "./protocolV4";

import type { SocketAuthClient, SocketAuthState } from "./socketAuth";

const PEER_ID = "00000000-0000-4000-8000-000000000001";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000002";

const state = (): SocketAuthState => ({
  peerId: "",
  publicKey: "",
  challengeNonce: "",
  challengeId: "",
  isVerified: false,
  isAuthenticating: false,
});

describe("fresh per-WebSocket authentication state", () => {
  test("a new challenge replaces prior socket auth and exposes no bearer signature", () => {
    const auth = state();
    auth.isVerified = true;
    auth.challengeNonce = "old";
    auth.challengeId = "old";

    const request = createFreshSocketChallenge(
      auth,
      PEER_ID,
      "ab".repeat(32),
      "cd".repeat(32),
      CHALLENGE_ID,
    );

    expect(request).toEqual({
      type: "peerId",
      peerId: PEER_ID,
      challenge: "cd".repeat(32),
      protocolVersion: PROTOCOL_VERSION,
      message: `Connected to WebSocket server. Your client id is ${PEER_ID}`,
    });
    expect("signature" in request).toBe(false);
    expect("credential" in request).toBe(false);
    expect(auth.isVerified).toBe(false);
    expect(isSocketChallengeBound(auth, PEER_ID, "cd".repeat(32))).toBe(true);
  });

  test("successful proof consumes the nonce so it cannot be replayed", () => {
    const auth = state();
    createFreshSocketChallenge(
      auth,
      PEER_ID,
      "ab".repeat(32),
      "cd".repeat(32),
      CHALLENGE_ID,
    );

    expect(consumeSocketChallenge(auth)).toBe(CHALLENGE_ID);
    expect(auth.isVerified).toBe(true);
    expect(auth.challengeNonce).toBe("");
    expect(auth.challengeId).toBe("");
    expect(isSocketChallengeBound(auth, PEER_ID, "cd".repeat(32))).toBe(false);
  });
});

describe("verified socket registry", () => {
  test("registers only verified sockets and stale close cannot evict a replacement", () => {
    const clients = new Map<string, SocketAuthClient>();
    const oldSocket = { data: state() };
    const replacement = { data: state() };
    oldSocket.data.peerId = PEER_ID;
    oldSocket.data.publicKey = "ab".repeat(32);
    replacement.data.peerId = PEER_ID;
    replacement.data.publicKey = "ab".repeat(32);

    expect(registerVerifiedSocket(clients, oldSocket)).toBe(false);
    oldSocket.data.isVerified = true;
    replacement.data.isVerified = true;
    expect(registerVerifiedSocket(clients, oldSocket)).toBe(true);
    expect(registerVerifiedSocket(clients, replacement)).toBe(true);
    expect(unregisterSocketIfCurrent(clients, oldSocket)).toBe(false);
    expect(clients.get(PEER_ID)).toBe(replacement);
    expect(unregisterSocketIfCurrent(clients, replacement)).toBe(true);
    expect(clients.has(PEER_ID)).toBe(false);
  });
});

describe("TURN REST credentials", () => {
  test("omits credentials without an operator-provided secret", () => {
    expect(
      createTurnCredentials("ab".repeat(32), undefined, 1_000),
    ).toBeUndefined();
  });

  test("derives credentials only from the supplied secret", () => {
    expect(
      createTurnCredentials("ab".repeat(32), "s".repeat(32), 1_000),
    ).toEqual({
      username: `3601:${"ab".repeat(32)}`,
      credential: "XY6V5LzRrbIFUOH5w0qdZ90iYuQ=",
    });
  });

  test("rejects a weak configured secret instead of silently issuing credentials", () => {
    expect(() =>
      createTurnCredentials("ab".repeat(32), "too-short", 1_000),
    ).toThrow("at least 32 bytes");
  });
});
