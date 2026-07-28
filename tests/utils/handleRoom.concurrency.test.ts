import { describe, expect, test } from "bun:test";

import { createHandleRoom } from "../../src/utils/handleRoom";
import { PROTOCOL_VERSION } from "../../src/utils/protocolV4";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const ROOM_TOKEN = "cc".repeat(32);
const PEERS = [
  {
    id: "00000000-0000-4000-8000-000000000002",
    publicKey: "aa".repeat(32),
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    publicKey: "bb".repeat(32),
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    publicKey: "dd".repeat(32),
  },
];

describe("concurrent room joins", () => {
  test("three first joiners receive the same room without a unique-key failure", async () => {
    let room:
      | {
          id: string;
          identifier: string;
          peers: typeof PEERS;
        }
      | undefined;
    let lookupCount = 0;
    let releaseLookups = () => {};
    const allLookupsStarted = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });

    const uniqueConflict = () =>
      Object.assign(new Error("Unique constraint failed on Room.identifier"), {
        code: "P2002",
      });
    const database = {
      peer: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const peer = PEERS.find(({ id }) => id === where.id);
          return peer
            ? {
                ...peer,
                createdAt: new Date(0),
                updatedAt: new Date(0),
                lastPing: 0n,
              }
            : null;
        },
      },
      room: {
        findUnique: async () => {
          lookupCount += 1;
          if (lookupCount === PEERS.length) releaseLookups();
          await allLookupsStarted;
          return null;
        },
        create: async ({ data }: { data: { identifier: string } }) => {
          if (room) throw uniqueConflict();
          room = {
            id: ROOM_ID,
            identifier: data.identifier,
            peers: [],
          };
          return room;
        },
        upsert: async ({ create }: { create: { identifier: string } }) => {
          room ??= {
            id: ROOM_ID,
            identifier: create.identifier,
            peers: [],
          };
          return room;
        },
        update: async ({
          data,
        }: {
          data: { peers: { connect: { id: string } } };
        }) => {
          if (!room) throw new Error("room must exist before connecting peers");
          const peer = PEERS.find(({ id }) => id === data.peers.connect.id);
          if (peer && !room.peers.some(({ id }) => id === peer.id))
            room.peers.push(peer);
          return room;
        },
      },
    } as unknown as Parameters<typeof createHandleRoom>[0];

    const responses: Array<{ type: string; roomId?: string }> = [];
    const terminated: string[] = [];
    const socket = (peer: (typeof PEERS)[number]) =>
      ({
        data: {
          peerId: peer.id,
          publicKey: peer.publicKey,
          challengeNonce: "",
          challengeId: "",
          isVerified: true,
          isAuthenticating: false,
          isAlive: true,
        } satisfies P2PartyWSData,
        send: (serialized: string) => {
          responses.push(JSON.parse(serialized));
        },
        terminate: () => {
          terminated.push(peer.id);
        },
      }) as unknown as P2PartyWSClient;

    const handleRoom = createHandleRoom(database);
    await Promise.all(
      PEERS.map((peer) => handleRoom(peer.id, socket(peer), ROOM_TOKEN)),
    );

    expect(terminated).toEqual([]);
    expect(responses.filter(({ type }) => type === "error")).toEqual([]);
    expect(
      responses
        .filter(({ type }) => type === "roomId")
        .map(({ roomId }) => roomId),
    ).toEqual([ROOM_ID, ROOM_ID, ROOM_ID]);
    expect(room?.peers.map(({ id }) => id).sort()).toEqual(
      PEERS.map(({ id }) => id).sort(),
    );
  });

  test("configured TURN credentials are nested only in the room response", async () => {
    const peer = PEERS[0];
    const previousTurnSecret = process.env.COTURN_SECRET;
    const previousTurnUrls = process.env.COTURN_URLS;
    process.env.COTURN_SECRET = "s".repeat(32);
    process.env.COTURN_URLS =
      "turns:turn.example.com:443?transport=tcp,turn:turn.example.com:3478";

    const database = {
      peer: {
        findUnique: async () => ({
          ...peer,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          lastPing: 0n,
        }),
      },
      room: {
        upsert: async () => ({ id: ROOM_ID, identifier: ROOM_TOKEN }),
        update: async () => ({ id: ROOM_ID, identifier: ROOM_TOKEN }),
      },
    } as unknown as Parameters<typeof createHandleRoom>[0];
    const responses: unknown[] = [];
    const socket = {
      data: {
        peerId: peer.id,
        publicKey: peer.publicKey,
        challengeNonce: "",
        challengeId: "",
        isVerified: true,
        isAuthenticating: false,
        isAlive: true,
      } satisfies P2PartyWSData,
      send: (serialized: string) => {
        responses.push(JSON.parse(serialized));
      },
      terminate: () => {
        throw new Error("valid room request must not terminate the socket");
      },
    } as unknown as P2PartyWSClient;

    try {
      await createHandleRoom(database)(peer.id, socket, ROOM_TOKEN);

      expect(responses).toHaveLength(1);
      const response = responses[0] as Record<string, unknown>;
      expect(Object.keys(response).sort()).toEqual([
        "protocolVersion",
        "roomId",
        "roomUrl",
        "turnCredentials",
        "type",
      ]);
      expect(response.type).toBe("roomId");
      expect(response.roomId).toBe(ROOM_ID);
      expect(response.roomUrl).toBe(ROOM_TOKEN);
      expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
      expect("urls" in response).toBe(false);
      expect("username" in response).toBe(false);
      expect("credential" in response).toBe(false);

      const turnCredentials = response.turnCredentials as Record<
        string,
        unknown
      >;
      expect(Object.keys(turnCredentials).sort()).toEqual([
        "credential",
        "urls",
        "username",
      ]);
      expect(turnCredentials.urls).toEqual([
        "turns:turn.example.com:443?transport=tcp",
        "turn:turn.example.com:3478",
      ]);
      expect(turnCredentials.username).toEndWith(`:${peer.publicKey}`);
      expect(typeof turnCredentials.credential).toBe("string");
    } finally {
      if (previousTurnSecret === undefined) delete process.env.COTURN_SECRET;
      else process.env.COTURN_SECRET = previousTurnSecret;
      if (previousTurnUrls === undefined) delete process.env.COTURN_URLS;
      else process.env.COTURN_URLS = previousTurnUrls;
    }
  });
});
