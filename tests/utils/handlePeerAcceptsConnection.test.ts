import { describe, expect, test } from "bun:test";

import { createHandlePeerAcceptsConnection } from "../../src/utils/handlePeerAcceptsConnection";
import { peerLogTag } from "../../src/utils/logTag";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const ROOM_ID = "00000000-0000-4000-8000-000000000003";
const SOURCE_KEY = "aa".repeat(32);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const socket = () => {
  const sent: string[] = [];
  let closed = false;
  const ws = {
    data: {
      peerId: SOURCE_ID,
      publicKey: SOURCE_KEY,
      challengeNonce: "",
      challengeId: "",
      socketGeneration: "",
      isVerified: true,
      isAuthenticating: false,
      isAlive: true,
    } satisfies P2PartyWSData,
    readyState: 1,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    close: () => {
      closed = true;
    },
  } as unknown as P2PartyWSClient;
  return { ws, sent, wasClosed: () => closed };
};

describe("accepted connection source fencing", () => {
  test("suppresses a delayed validation error after source replacement", async () => {
    const validationStarted = deferred();
    const validationGate = deferred();
    const predecessor = socket();
    const successor = socket();
    const clients = new Map<string, P2PartyWSClient>([
      [SOURCE_ID, predecessor.ws],
    ]);
    const routed: string[] = [];
    const handle = createHandlePeerAcceptsConnection(
      {
        peer: {
          findUnique: async () => ({
            id: SOURCE_ID,
            publicKey: SOURCE_KEY,
          }),
        },
      } as unknown as Parameters<typeof createHandlePeerAcceptsConnection>[0],
      {
        clients,
        findRoomPeers: async () => {
          validationStarted.resolve();
          await validationGate.promise;
          return false;
        },
        sendToPeer: async (peerId) => {
          routed.push(peerId);
          return true;
        },
      },
    );

    const pending = handle(SOURCE_ID, TARGET_ID, ROOM_ID, predecessor.ws);
    await validationStarted.promise;
    clients.set(SOURCE_ID, successor.ws);
    validationGate.resolve();
    await pending;

    expect(predecessor.sent).toEqual([]);
    expect(predecessor.wasClosed()).toBe(false);
    expect(routed).toEqual([]);
  });

  test("suppresses a delayed database error after source replacement", async () => {
    const queryStarted = deferred();
    const queryGate = deferred();
    const predecessor = socket();
    const successor = socket();
    const clients = new Map<string, P2PartyWSClient>([
      [SOURCE_ID, predecessor.ws],
    ]);
    const handle = createHandlePeerAcceptsConnection(
      {
        peer: {
          findUnique: async () => {
            queryStarted.resolve();
            await queryGate.promise;
            throw new Error("delayed database failure");
          },
        },
      } as unknown as Parameters<typeof createHandlePeerAcceptsConnection>[0],
      {
        clients,
        findRoomPeers: async () => true,
      },
    );

    const pending = handle(SOURCE_ID, TARGET_ID, ROOM_ID, predecessor.ws);
    await queryStarted.promise;
    clients.set(SOURCE_ID, successor.ws);
    queryGate.resolve();
    await pending;

    expect(predecessor.sent).toEqual([]);
    expect(predecessor.wasClosed()).toBe(false);
  });
});

describe("the acceptor's socket survives a server-side fault", () => {
  test("a peer-lookup fault does not close the acceptor's socket", async () => {
    // Pool exhaustion or a replica hiccup is a server fault, not evidence
    // that the acceptor does not exist. The old catch told the acceptor
    // that and closed its socket, which on the client is terminal (C4) --
    // for a peer that did nothing wrong.
    const acceptor = socket();
    const clients = new Map<string, P2PartyWSClient>([
      [SOURCE_ID, acceptor.ws],
    ]);
    const handle = createHandlePeerAcceptsConnection(
      {
        peer: {
          findUnique: async () => {
            throw new Error("connection pool exhausted");
          },
        },
      } as unknown as Parameters<typeof createHandlePeerAcceptsConnection>[0],
      {
        clients,
        findRoomPeers: async () => true,
      },
    );

    await handle(SOURCE_ID, TARGET_ID, ROOM_ID, acceptor.ws);

    expect(acceptor.wasClosed()).toBe(false);
    // The request still failed, so the client is still told, and told the
    // truth: a server fault, not a verdict on its own identity.
    expect(acceptor.sent).toHaveLength(1);
    const frame = JSON.parse(acceptor.sent[0]) as {
      type: string;
      fromAction: string;
      error: { message: string };
    };
    expect(frame.type).toBe("error");
    expect(frame.fromAction).toBe("requestPeers");
    expect(frame.error.message).toBe(
      "Peers request from peer with id " + SOURCE_ID + " could not be served",
    );
  });
});

describe("peer acceptance dropped by a mid-flight leave", () => {
  test("logs the drop and does not close the acceptor's socket", async () => {
    // findRoomPeers returning false here means the joiner left between its
    // introduction and this acceptance -- a race, not a protocol violation.
    // The only visibility into that branch is this console.warn (25e6af2);
    // prove it fires, and prove it never reaches for the socket.
    const acceptor = socket();
    const clients = new Map<string, P2PartyWSClient>([
      [SOURCE_ID, acceptor.ws],
    ]);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const handle = createHandlePeerAcceptsConnection(
        {
          peer: {
            findUnique: async () => ({
              id: SOURCE_ID,
              publicKey: SOURCE_KEY,
            }),
          },
        } as unknown as Parameters<typeof createHandlePeerAcceptsConnection>[0],
        {
          clients,
          findRoomPeers: async () => false,
        },
      );

      await handle(SOURCE_ID, TARGET_ID, ROOM_ID, acceptor.ws);
    } finally {
      console.warn = originalWarn;
    }

    expect(acceptor.wasClosed()).toBe(false);
    expect(acceptor.sent).toEqual([]);
    expect(warnings).toHaveLength(1);
    const [message] = warnings[0];
    expect(String(message)).toContain("peer acceptance dropped");
    // The pair is named by per-boot log tags, never by stable peer id.
    expect(String(message)).toContain(
      `${peerLogTag(SOURCE_ID)} -> ${peerLogTag(TARGET_ID)}`,
    );
    expect(String(message)).not.toContain(SOURCE_ID);
    expect(String(message)).not.toContain(TARGET_ID);
  });
});
