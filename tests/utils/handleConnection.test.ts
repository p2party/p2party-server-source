import { describe, expect, spyOn, test } from "bun:test";

import handleConnection from "../../src/utils/handleConnection";
import { provisionalPeerId } from "../../src/utils/peerIdentity";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const PUBLIC_KEY = "ab".repeat(32);

const socket = (): P2PartyWSClient & {
  sent: string[];
  closeArgs: { code?: number; reason?: string }[];
  wasTerminated: () => boolean;
} => {
  const sent: string[] = [];
  const closeArgs: { code?: number; reason?: string }[] = [];
  let terminated = false;
  const data: P2PartyWSData = {
    peerId: "",
    publicKey: PUBLIC_KEY,
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: false,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    data,
    sent,
    closeArgs,
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
    wasTerminated: () => terminated,
  } as unknown as P2PartyWSClient & {
    sent: string[];
    closeArgs: { code?: number; reason?: string }[];
    wasTerminated: () => boolean;
  };
  return ws;
};

const errorFrame = (raw: string) =>
  JSON.parse(raw) as {
    type: string;
    fromAction: string;
    error: { message: string };
  };

describe("identity bootstrap", () => {
  test("a key that cannot be bound closes with 1011 (retryable), not a bare terminate", async () => {
    // The upgrade handler admits only 64 lowercase hex characters, so this is
    // a server-side invariant failing, not evidence about the client: a
    // generic error frame, then a graceful close the client may retry.
    const ws = socket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    let peerId: string;
    try {
      peerId = await handleConnection("AB".repeat(32), ws);
    } finally {
      consoleError.mockRestore();
    }

    expect(peerId).toBe("");
    expect(ws.wasTerminated()).toBe(false);
    expect(ws.closeArgs).toEqual([
      { code: 1011, reason: "Could not initialize WebSocket identity" },
    ]);
    expect(ws.sent).toHaveLength(1);
    const frame = errorFrame(ws.sent[0]!);
    expect(frame.type).toBe("error");
    expect(frame.fromAction).toBe("requestPeerId");
  });

  test("a valid key is bound to its derived id and never closed", async () => {
    const ws = socket();

    const peerId = await handleConnection(PUBLIC_KEY, ws);

    expect(peerId).toBe(provisionalPeerId(PUBLIC_KEY));
    expect(ws.data.peerId).toBe(peerId);
    expect(ws.wasTerminated()).toBe(false);
    expect(ws.closeArgs).toEqual([]);
  });
});
