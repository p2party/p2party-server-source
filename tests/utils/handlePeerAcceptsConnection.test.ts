import { describe, expect, test } from "bun:test";

import { createHandlePeerAcceptsConnection } from "../../src/utils/handlePeerAcceptsConnection";

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
