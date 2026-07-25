import { afterEach, describe, expect, spyOn, test } from "bun:test";

import handleMessage from "./handleMessage";
import { wsClients } from "../wsServer";

import type {
  P2PartyWSClient,
  P2PartyWSData,
  P2PartyWSEvents,
} from "../wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  wsClients.clear();
});

describe("protocol-v4 authentication boundary", () => {
  test("a versionless or downgraded challenge cannot enter the verified registry", async () => {
    let closed = false;
    const data: P2PartyWSData = {
      peerId: PEER_ID,
      publicKey: "ab".repeat(32),
      challengeNonce: "cd".repeat(32),
      challengeId: "00000000-0000-4000-8000-000000000002",
      isVerified: false,
      isAuthenticating: false,
      isAlive: true,
    };
    const ws = {
      data,
      close: () => {
        closed = true;
      },
    } as unknown as P2PartyWSClient;
    const events: P2PartyWSEvents = {
      open: () => {
        throw new Error("downgraded socket was activated");
      },
      message: () => {},
      close: () => {},
    };

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "challenge",
          fromPeerId: PEER_ID,
          challenge: data.challengeNonce,
          signature: "ef".repeat(64),
          protocolVersion: 2,
        }),
        events,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(closed).toBe(true);
    expect(data.isVerified).toBe(false);
    expect(wsClients.has(PEER_ID)).toBe(false);
  });

  test("legacy bearer fields make an otherwise v3 proof fail closed", async () => {
    let closed = false;
    const data: P2PartyWSData = {
      peerId: PEER_ID,
      publicKey: "ab".repeat(32),
      challengeNonce: "cd".repeat(32),
      challengeId: "00000000-0000-4000-8000-000000000002",
      isVerified: false,
      isAuthenticating: false,
      isAlive: true,
    };
    const ws = {
      data,
      close: () => {
        closed = true;
      },
    } as unknown as P2PartyWSClient;
    const events: P2PartyWSEvents = {
      open: () => {
        throw new Error("legacy bearer socket was activated");
      },
      message: () => {},
      close: () => {},
    };

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "challenge",
          fromPeerId: PEER_ID,
          challenge: data.challengeNonce,
          signature: "ef".repeat(64),
          protocolVersion: 4,
          challengeId: data.challengeId,
        }),
        events,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(closed).toBe(true);
    expect(data.isVerified).toBe(false);
    expect(wsClients.has(PEER_ID)).toBe(false);
  });
});
