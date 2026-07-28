import { describe, expect, test } from "bun:test";

import { createHandleRoom } from "../../src/utils/handleRoom";
import { PROTOCOL_VERSION } from "../../src/utils/protocolV4";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const ROOM_TOKEN = "cc".repeat(32);
const ROOM_REQUEST_ID = "00000000-0000-4000-8000-000000000099";
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
                rooms: [],
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

    const responses: Array<{
      type: string;
      roomId?: string;
      roomRequestId?: string;
    }> = [];
    const terminated: string[] = [];
    const clients = new Map<string, P2PartyWSClient>();
    const socket = (peer: (typeof PEERS)[number]) => {
      const ws = {
        data: {
          peerId: peer.id,
          publicKey: peer.publicKey,
          challengeNonce: "",
          challengeId: "",
          isVerified: true,
          isAuthenticating: false,
          isAlive: true,
        } satisfies P2PartyWSData,
        readyState: 1,
        send: (serialized: string) => {
          responses.push(JSON.parse(serialized));
        },
        terminate: () => {
          terminated.push(peer.id);
        },
      } as unknown as P2PartyWSClient;
      clients.set(peer.id, ws);
      return ws;
    };

    const handleRoom = createHandleRoom(database, clients);
    await Promise.all(
      PEERS.map((peer) =>
        handleRoom(peer.id, socket(peer), ROOM_TOKEN, ROOM_REQUEST_ID),
      ),
    );

    expect(terminated).toEqual([]);
    expect(responses.filter(({ type }) => type === "error")).toEqual([]);
    expect(
      responses
        .filter(({ type }) => type === "roomId")
        .map(({ roomId }) => roomId),
    ).toEqual([ROOM_ID, ROOM_ID, ROOM_ID]);
    expect(
      responses
        .filter(({ type }) => type === "roomId")
        .every(({ roomRequestId }) => roomRequestId === ROOM_REQUEST_ID),
    ).toBe(true);
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
          rooms: [],
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
      readyState: 1,
      send: (serialized: string) => {
        responses.push(JSON.parse(serialized));
      },
      terminate: () => {
        throw new Error("valid room request must not terminate the socket");
      },
    } as unknown as P2PartyWSClient;
    const clients = new Map<string, P2PartyWSClient>([[peer.id, socket]]);

    try {
      await createHandleRoom(database, clients)(
        peer.id,
        socket,
        ROOM_TOKEN,
        ROOM_REQUEST_ID,
      );

      expect(responses).toHaveLength(1);
      const response = responses[0] as Record<string, unknown>;
      expect(Object.keys(response).sort()).toEqual([
        "protocolVersion",
        "roomId",
        "roomRequestId",
        "roomUrl",
        "turnCredentials",
        "type",
      ]);
      expect(response.type).toBe("roomId");
      expect(response.roomId).toBe(ROOM_ID);
      expect(response.roomRequestId).toBe(ROOM_REQUEST_ID);
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
        "expiresAtUnixSeconds",
        "urls",
        "username",
      ]);
      expect(turnCredentials.urls).toEqual([
        "turns:turn.example.com:443?transport=tcp",
        "turn:turn.example.com:3478",
      ]);
      expect(turnCredentials.username).toEndWith(`:${peer.publicKey}`);
      expect(
        String(turnCredentials.username).startsWith(
          `${String(turnCredentials.expiresAtUnixSeconds)}:`,
        ),
      ).toBe(true);
      expect(typeof turnCredentials.credential).toBe("string");
    } finally {
      if (previousTurnSecret === undefined) delete process.env.COTURN_SECRET;
      else process.env.COTURN_SECRET = previousTurnSecret;
      if (previousTurnUrls === undefined) delete process.env.COTURN_URLS;
      else process.env.COTURN_URLS = previousTurnUrls;
    }
  });
});
