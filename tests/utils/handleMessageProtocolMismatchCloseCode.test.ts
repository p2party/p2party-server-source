import { afterEach, describe, expect, spyOn, test } from "bun:test";

import handleMessage from "../../src/utils/handleMessage";
import { wsClients } from "../../src/wsServer";
import { MAX_SIGNALING_MESSAGE_CHARS } from "../../src/utils/protocolV4";

import type {
  P2PartyWSClient,
  P2PartyWSData,
  P2PartyWSEvents,
} from "../../src/wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";
const ROOM_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_PEER_ID = "00000000-0000-4000-8000-000000000003";

const noopEvents: P2PartyWSEvents = {
  open: () => {},
  message: () => {},
  close: () => {},
};

const verifiedSocket = (): P2PartyWSClient & {
  closeArgs: { code?: number; reason?: string }[];
} => {
  const closeArgs: { code?: number; reason?: string }[] = [];
  const data: P2PartyWSData = {
    peerId: PEER_ID,
    publicKey: "ab".repeat(32),
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "generation-1",
    isVerified: true,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    data,
    readyState: 1,
    close: (code?: number, reason?: string) => {
      closeArgs.push({ code, reason });
    },
  } as unknown as P2PartyWSClient & {
    closeArgs: { code?: number; reason?: string }[];
  };
  Object.defineProperty(ws, "closeArgs", { value: closeArgs });
  wsClients.set(PEER_ID, ws);
  return ws;
};

afterEach(() => {
  wsClients.clear();
});

/**
 * These pin the split the catch in handleMessage.ts must make: a message
 * that matches the declared protocol version but violates the exact wire
 * shape for its type is a client-build bug that retrying can never fix, so
 * it alone earns 1003. Every other cause the same catch can see -- a stale
 * identity, a version mismatch (which a rolling deploy can make transient),
 * and an oversized frame -- must keep closing bare, exactly as before, or a
 * healthy/recoverable client gets stranded.
 */
describe("handleMessage malformed-shape closes carry 1003", () => {
  test("a structurally malformed pong (matching protocol version) closes with 1003", async () => {
    const ws = verifiedSocket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await handleMessage(
        ws,
        JSON.stringify({ type: "pong", fromPeerId: PEER_ID, extra: true }),
        noopEvents,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(ws.closeArgs).toEqual([{ code: 1003, reason: expect.any(String) }]);
    expect(ws.closeArgs[0]!.reason).toContain("Malformed protocol-v4");
  });

  test("a structurally malformed room request closes with 1003", async () => {
    const ws = verifiedSocket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "room",
          fromPeerId: PEER_ID,
          roomUrl: "ab".repeat(32),
          roomRequestId: "00000000-0000-4000-8000-000000000004",
          protocolVersion: 4,
          extraField: "not part of the wire shape",
        }),
        noopEvents,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(ws.closeArgs).toEqual([{ code: 1003, reason: expect.any(String) }]);
  });

  test("a description with an out-of-enum type closes with 1003", async () => {
    const ws = verifiedSocket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "description",
          fromPeerId: PEER_ID,
          fromPeerPublicKey: "ab".repeat(32),
          toPeerId: OTHER_PEER_ID,
          roomId: ROOM_ID,
          protocolVersion: 4,
          description: { type: "not-a-real-sdp-type", sdp: "v=0" },
        }),
        noopEvents,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(ws.closeArgs).toEqual([{ code: 1003, reason: expect.any(String) }]);
  });
});

describe("handleMessage keeps every other cause of the same catch bare", () => {
  test("a spoofed fromPeerId (identity check) still closes with no code", async () => {
    const ws = verifiedSocket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "pong",
          fromPeerId: OTHER_PEER_ID, // does not match ws.data.peerId
        }),
        noopEvents,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(ws.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
  });

  test("a protocol-version mismatch still closes with no code (rollout skew is not a client bug)", async () => {
    const ws = verifiedSocket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "room",
          fromPeerId: PEER_ID,
          roomUrl: "ab".repeat(32),
          roomRequestId: "00000000-0000-4000-8000-000000000004",
          protocolVersion: 3,
        }),
        noopEvents,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(ws.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
  });

  test("an oversized frame still closes with no code", async () => {
    const ws = verifiedSocket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const oversized = "a".repeat(MAX_SIGNALING_MESSAGE_CHARS + 1);

    try {
      await handleMessage(ws, oversized, noopEvents);
    } finally {
      consoleError.mockRestore();
    }

    expect(ws.closeArgs).toEqual([{ code: undefined, reason: undefined }]);
  });
});
