import { describe, expect, test } from "bun:test";

import { createFindRoomPeers } from "../../src/utils/findRoomPeers";

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
  let terminated = false;
  const ws = {
    data: {
      peerId: SOURCE_ID,
      publicKey: SOURCE_KEY,
      challengeNonce: "",
      challengeId: "",
      isVerified: true,
      isAuthenticating: false,
      isAlive: true,
    } satisfies P2PartyWSData,
    readyState: 1,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    terminate: () => {
      terminated = true;
    },
  } as unknown as P2PartyWSClient;
  return { ws, sent, wasTerminated: () => terminated };
};

describe("room peer validation source fencing", () => {
  test("a displaced source receives no delayed room error", async () => {
    const queryStarted = deferred();
    const queryGate = deferred();
    const database = {
      room: {
        findUnique: async () => {
          queryStarted.resolve();
          await queryGate.promise;
          return null;
        },
      },
      peer: {
        findUnique: async () => null,
      },
    } as unknown as Parameters<typeof createFindRoomPeers>[0];
    const predecessor = socket();
    const successor = socket();
    const clients = new Map<string, P2PartyWSClient>([
      [SOURCE_ID, predecessor.ws],
    ]);
    const findRoomPeers = createFindRoomPeers(database, clients);

    const pending = findRoomPeers(
      predecessor.ws,
      ROOM_ID,
      SOURCE_ID,
      TARGET_ID,
      false,
    );
    await queryStarted.promise;
    clients.set(SOURCE_ID, successor.ws);
    queryGate.resolve();

    expect(await pending).toBe(false);
    expect(predecessor.sent).toEqual([]);
    expect(predecessor.wasTerminated()).toBe(false);
  });
});
