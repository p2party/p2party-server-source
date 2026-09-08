import { describe, expect, test } from "bun:test";

import { createHandleRoom } from "../../src/utils/handleRoom";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const ROOM_TOKEN = "cc".repeat(32);
const ROOM_REQUEST_ID = "00000000-0000-4000-8000-000000000099";
const PEER_ID = "00000000-0000-4000-8000-000000000002";
const PEER_KEY = "aa".repeat(32);

const rawClient = (): P2PartyWSClient & {
  sent: string[];
  closeArgs: { code?: number; reason?: string }[];
  wasTerminated: () => boolean;
} => {
  const sent: string[] = [];
  const closeArgs: { code?: number; reason?: string }[] = [];
  let terminated = false;
  const state = {
    peerId: PEER_ID,
    publicKey: PEER_KEY,
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: true,
    isAuthenticating: false,
    isAlive: true,
  } as P2PartyWSData;
  return {
    readyState: 1,
    data: state,
    sent,
    closeArgs,
    send: (payload: string) => {
      sent.push(payload);
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
};

const client = (clients: Map<string, P2PartyWSClient>) => {
  const ws = rawClient();
  clients.set(PEER_ID, ws);
  return ws;
};

const errorFrame = (raw: string) =>
  JSON.parse(raw) as { type: string; fromAction: string; error: unknown };

describe("the room requester's socket survives a server-side fault", () => {
  test("a database fault while the socket is still current does not terminate it", async () => {
    // room.upsert throwing is a database/server fault -- the same class
    // 15af423/d502ac0/ee91b95 already fixed in three sibling functions.
    // Nothing here races the registry, so isCurrent() stays true throughout;
    // terminating this socket strands a live, innocent member (C4).
    const clients = new Map<string, P2PartyWSClient>();
    const ws = client(clients);
    const handleRoom = createHandleRoom(
      {
        peer: {
          findUnique: async () => ({
            id: PEER_ID,
            publicKey: PEER_KEY,
            rooms: [],
          }),
        },
        room: {
          upsert: async () => {
            throw new Error("connection pool exhausted");
          },
        },
      } as never,
      clients,
    );

    await handleRoom(PEER_ID, ws, ROOM_TOKEN, ROOM_REQUEST_ID);

    expect(ws.wasTerminated()).toBe(false);
    expect(ws.closeArgs).toEqual([]);
    expect(ws.sent).toHaveLength(1);
    const frame = errorFrame(ws.sent[0]!);
    expect(frame.type).toBe("error");
    expect(frame.fromAction).toBe("requestRoomId");
  });

  test("a socket already superseded before membership is terminated without a frame", async () => {
    // room.upsert resolves, but by the time handleRoomWithClient re-checks
    // isCurrent() afterwards, the registry now points at a different (the
    // successor's) socket object -- a pure race, not a server fault. No
    // frame was sent (isCurrent() gates the send), so terminate() here drops
    // nothing, and this branch is intentionally left unchanged.
    const clients = new Map<string, P2PartyWSClient>();
    const ws = client(clients);
    const successor = rawClient();
    const handleRoom = createHandleRoom(
      {
        peer: {
          findUnique: async () => ({
            id: PEER_ID,
            publicKey: PEER_KEY,
            rooms: [],
          }),
        },
        room: {
          upsert: async () => {
            // Simulate a successor replacing this socket mid-mutation.
            clients.set(PEER_ID, successor);
            return { id: ROOM_ID, identifier: ROOM_TOKEN };
          },
          update: async () => ({ id: ROOM_ID, identifier: ROOM_TOKEN }),
        },
      } as never,
      clients,
    );

    await handleRoom(PEER_ID, ws, ROOM_TOKEN, ROOM_REQUEST_ID);

    expect(ws.sent).toEqual([]);
    expect(ws.wasTerminated()).toBe(true);
    expect(ws.closeArgs).toEqual([]);
  });
});
