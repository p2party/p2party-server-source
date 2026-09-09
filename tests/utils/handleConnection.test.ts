import { describe, expect, test } from "bun:test";

import { createHandleConnection } from "../../src/utils/handleConnection";

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

describe("the identity-bootstrap socket survives a server-side fault", () => {
  test("a peer-lookup fault closes with 1011 (retryable), not a bare terminate", async () => {
    // Pool exhaustion or a replica hiccup is a server fault, not evidence the
    // public key is bad. The old catch called ws.terminate(): no close code
    // at all, so the client's reconnect ladder could not tell this apart
    // from a permanent refusal, and terminate() also risks dropping the
    // error frame ws.send() just queued.
    const ws = socket();
    const handleConnection = createHandleConnection({
      peer: {
        findUnique: async () => {
          throw new Error("connection pool exhausted");
        },
      },
    } as never);

    const peerId = await handleConnection(PUBLIC_KEY, ws);

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

  test("a successful lookup never closes the socket", async () => {
    const ws = socket();
    const handleConnection = createHandleConnection({
      peer: {
        findUnique: async () => ({
          id: "00000000-0000-4000-8000-000000000001",
          publicKey: PUBLIC_KEY,
        }),
      },
    } as never);

    const peerId = await handleConnection(PUBLIC_KEY, ws);

    expect(peerId).toBe("00000000-0000-4000-8000-000000000001");
    expect(ws.wasTerminated()).toBe(false);
    expect(ws.closeArgs).toEqual([]);
  });
});
