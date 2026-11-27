import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import handleMessage from "../../src/utils/handleMessage";
import { wsClients } from "../../src/wsServer";
import {
  MAX_SIGNALING_MESSAGE_CHARS,
  SIGNALING_PROTOCOL_VERSION,
} from "../../src/utils/signalingProtocol";

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
 * it alone earns 1003 with its own reason. A frame declaring another protocol
 * version is the other build mismatch and also earns 1003, with the version
 * reason (see "version mismatch" below). Every other cause the same catch can
 * see -- a stale identity and an oversized frame -- must keep closing bare,
 * exactly as before, or a healthy/recoverable client gets stranded.
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
    expect(ws.closeArgs[0]!.reason).toContain("Malformed protocol-v5");
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
          roomLocator: "ab".repeat(64),
          roomRequestId: "00000000-0000-4000-8000-000000000004",
          protocolVersion: 5,
          extraField: "not part of the wire shape",
        }),
        noopEvents,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(ws.closeArgs).toEqual([{ code: 1003, reason: expect.any(String) }]);
  });

  test("server refuses a frame carrying roomUrl before dispatch", async () => {
    const ws = verifiedSocket();
    await handleMessage(
      ws,
      JSON.stringify({
        type: "extension",
        protocolVersion: 5,
        fromPeerId: PEER_ID,
        roomUrl: "ab".repeat(32),
      }),
      noopEvents,
    );
    expect(ws.closeArgs).toEqual([
      { code: 1003, reason: "Malformed protocol-v5 room locator" },
    ]);
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
          protocolVersion: 5,
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

/**
 * The server speaks one protocol version and there is no negotiation, so a
 * frame declaring any other version is refused for good: the same build asks
 * the same question on the next socket. The client's reconnect ladder treats
 * 1003 from the server as final and reports it, where a bare close was
 * retried forever. The reason names only the server's own version, never
 * anything the client sent.
 */
describe("version mismatch", () => {
  const REASON = `Unsupported signaling protocol version; this server speaks version ${String(SIGNALING_PROTOCOL_VERSION)}`;

  const unauthenticatedSocket = (): P2PartyWSClient & {
    closeArgs: { code?: number; reason?: string }[];
  } => {
    const closeArgs: { code?: number; reason?: string }[] = [];
    const ws = {
      data: {
        peerId: PEER_ID,
        publicKey: "ab".repeat(32),
        challengeNonce: "cd".repeat(32),
        challengeId: "00000000-0000-4000-8000-000000000004",
        socketGeneration: "",
        isVerified: false,
        isAuthenticating: false,
        isAlive: true,
      } satisfies P2PartyWSData,
      readyState: 1,
      closeArgs,
      close: (code?: number, reason?: string) => {
        closeArgs.push({ code, reason });
      },
    };
    return ws as unknown as P2PartyWSClient & {
      closeArgs: { code?: number; reason?: string }[];
    };
  };

  const send = async (ws: P2PartyWSClient, frame: unknown) => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMessage(ws, JSON.stringify(frame), {
        ...noopEvents,
        open: () => {
          throw new Error("a mismatched socket was activated");
        },
      });
    } finally {
      consoleError.mockRestore();
    }
  };

  test("version mismatch closes with the contract code", async () => {
    const frames: [
      string,
      () => P2PartyWSClient & {
        closeArgs: { code?: number; reason?: string }[];
      },
      Record<string, unknown>,
    ][] = [
      [
        "an older client's room request",
        verifiedSocket,
        {
          type: "room",
          fromPeerId: PEER_ID,
          roomLocator: "ab".repeat(64),
          roomRequestId: "00000000-0000-4000-8000-000000000004",
          protocolVersion: SIGNALING_PROTOCOL_VERSION - 1,
        },
      ],
      [
        "a newer client's challenge response, before authentication",
        unauthenticatedSocket,
        {
          type: "challenge",
          fromPeerId: PEER_ID,
          challenge: "cd".repeat(32),
          signature: "ef".repeat(64),
          protocolVersion: SIGNALING_PROTOCOL_VERSION + 1,
        },
      ],
      [
        "a frame with no protocolVersion",
        verifiedSocket,
        { type: "peers", fromPeerId: PEER_ID, roomId: ROOM_ID },
      ],
      [
        "a client that does not send the bound peer id either",
        unauthenticatedSocket,
        { type: "challenge", publicKey: "ab".repeat(32), protocolVersion: 1 },
      ],
      [
        "a version the client chose to make the reason echo it",
        verifiedSocket,
        {
          type: "candidate",
          fromPeerId: PEER_ID,
          toPeerId: OTHER_PEER_ID,
          roomId: ROOM_ID,
          candidate: { candidate: "candidate:1" },
          protocolVersion: "4; drop table Peer",
        },
      ],
    ];

    for (const [label, makeSocket, frame] of frames) {
      wsClients.clear();
      const ws = makeSocket();
      await send(ws, frame);
      expect(ws.closeArgs, label).toEqual([{ code: 1003, reason: REASON }]);
      expect(ws.closeArgs[0]!.reason!, label).not.toContain("drop table");
      expect(Buffer.byteLength(REASON), label).toBeLessThanOrEqual(123);
    }
  });

  test("an unauthenticated mismatched socket never becomes verified", async () => {
    const ws = unauthenticatedSocket();
    await send(ws, {
      type: "challenge",
      fromPeerId: PEER_ID,
      challenge: "cd".repeat(32),
      signature: "ef".repeat(64),
      protocolVersion: SIGNALING_PROTOCOL_VERSION + 1,
    });
    expect(ws.data.isVerified).toBe(false);
    expect(ws.data.isAuthenticating).toBe(false);
    expect(wsClients.has(PEER_ID)).toBe(false);
  });

  test("the README documents the code and the exact reason", () => {
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(readme).toContain(`\`1003\` and the reason \`${REASON}\``);
  });
});
