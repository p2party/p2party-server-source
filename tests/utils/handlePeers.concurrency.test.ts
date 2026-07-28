import { afterEach, describe, expect, test } from "bun:test";

import { wsClients } from "../../src/wsServer";
import { createHandlePeers } from "../../src/utils/handlePeers";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const PEER_A_ID = "00000000-0000-4000-8000-000000000002";
const PEER_B_ID = "00000000-0000-4000-8000-000000000003";
const PEER_C_ID = "00000000-0000-4000-8000-000000000004";
const PEER_A_KEY = "aa".repeat(32);
const PEER_B_KEY = "bb".repeat(32);

afterEach(() => {
  wsClients.clear();
});

describe("concurrent peer discovery", () => {
  test("one completed request never disconnects an overlapping query", async () => {
    const peers = new Map([
      [PEER_A_ID, { id: PEER_A_ID, publicKey: PEER_A_KEY }],
      [PEER_B_ID, { id: PEER_B_ID, publicKey: PEER_B_KEY }],
    ]);
    let queryCount = 0;
    let disconnected = false;
    let disconnectCalls = 0;
    let markSecondQueryStarted = () => {};
    const secondQueryStarted = new Promise<void>((resolve) => {
      markSecondQueryStarted = resolve;
    });

    const database = {
      peer: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          queryCount += 1;
          if (queryCount === 1) {
            await secondQueryStarted;
          } else {
            markSecondQueryStarted();
            await Bun.sleep(10);
          }
          if (disconnected)
            throw new Error("query interrupted by request-local disconnect");
          return peers.get(where.id) ?? null;
        },
      },
      room: {
        findUnique: async () => ({
          id: ROOM_ID,
          peers: [...peers.values()],
        }),
      },
      $disconnect: async () => {
        disconnectCalls += 1;
        disconnected = true;
      },
    } as unknown as Parameters<typeof createHandlePeers>[0];

    const closed: string[] = [];
    const socket = (peerId: string, publicKey: string) => {
      const ws = {
        data: {
          peerId,
          publicKey,
          challengeNonce: "",
          challengeId: "",
          isVerified: true,
          isAuthenticating: false,
          isAlive: true,
        } satisfies P2PartyWSData,
        readyState: 1,
        send: () => {},
        close: () => {
          closed.push(peerId);
        },
      } as unknown as P2PartyWSClient;
      wsClients.set(peerId, ws);
      return ws;
    };

    const handlePeers = createHandlePeers(database);
    await Promise.all([
      handlePeers(PEER_A_ID, socket(PEER_A_ID, PEER_A_KEY), ROOM_ID),
      handlePeers(PEER_B_ID, socket(PEER_B_ID, PEER_B_KEY), ROOM_ID),
    ]);

    expect(disconnectCalls).toBe(0);
    expect(closed).toEqual([]);
  });

  test("replacement during remote delivery prevents every later introduction", async () => {
    const source = {
      id: PEER_A_ID,
      publicKey: PEER_A_KEY,
    };
    const peers = [
      source,
      { id: PEER_B_ID, publicKey: PEER_B_KEY },
      { id: PEER_C_ID, publicKey: "cc".repeat(32) },
    ];
    const database = {
      peer: {
        findUnique: async () => source,
      },
      room: {
        findUnique: async () => ({ id: ROOM_ID, peers }),
      },
    } as unknown as Parameters<typeof createHandlePeers>[0];
    const staleFrames: string[] = [];
    const makeSocket = (sent?: string[]) =>
      ({
        data: {
          peerId: PEER_A_ID,
          publicKey: PEER_A_KEY,
          challengeNonce: "",
          challengeId: "",
          isVerified: true,
          isAuthenticating: false,
          isAlive: true,
        } satisfies P2PartyWSData,
        readyState: 1,
        send: (frame: string) => {
          sent?.push(frame);
          return 1;
        },
        close: () => {},
      }) as unknown as P2PartyWSClient;
    const predecessor = makeSocket(staleFrames);
    const successor = makeSocket();
    const clients = new Map<string, P2PartyWSClient>([
      [PEER_A_ID, predecessor],
    ]);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const delivered: string[] = [];
    const handlePeers = createHandlePeers(database, {
      clients,
      sendToPeer: async (peerId) => {
        delivered.push(peerId);
        if (delivered.length === 1) {
          markFirstStarted();
          await firstGate;
        }
        return true;
      },
    });

    const pending = handlePeers(PEER_A_ID, predecessor, ROOM_ID);
    await firstStarted;
    predecessor.data.isVerified = false;
    clients.set(PEER_A_ID, successor);
    releaseFirst();
    await pending;

    expect(delivered).toEqual([PEER_B_ID]);
    expect(staleFrames).toEqual([]);
  });
});
