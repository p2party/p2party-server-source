import { describe, expect, test } from "bun:test";

import { createHandleRoom } from "../../src/utils/handleRoom";
import { SIGNALING_PROTOCOL_VERSION } from "../../src/utils/signalingProtocol";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
// UTF-8 SHA-512 of the lowercase capability "ab".repeat(32), shared with the SDK.
const ROOM_LOCATOR =
  "99d606e763d446b3009e635dd74b32340c9b8bd8eaf580ad481af7c9b154d5521630c569a8d055bceac34296504ec852b4eca15384774b9bca1f10cd7d047f94";
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
          socketGeneration: "",
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
        handleRoom(peer.id, socket(peer), ROOM_LOCATOR, ROOM_REQUEST_ID),
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
    expect(room?.identifier).toBe(ROOM_LOCATOR);
    expect(room?.peers.map(({ id }) => id).sort()).toEqual(
      PEERS.map(({ id }) => id).sort(),
    );
  });

  test("nine simultaneous rejoins succeed", async () => {
    const members = Array.from({ length: 9 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${(0x100 + i).toString(16).padStart(12, "0")}`,
      publicKey: (0x10 + i).toString(16).repeat(32),
    }));
    let releaseRoom = () => {};
    const roomHeld = new Promise<void>((resolve) => {
      releaseRoom = resolve;
    });
    let upserts = 0;
    const database = {
      peer: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const member = members.find(({ id }) => id === where.id);
          // Every requester is already a member: a pure rejoin after restart.
          return member
            ? { ...member, rooms: [{ id: ROOM_ID }], _count: { rooms: 1 } }
            : null;
        },
      },
      room: {
        upsert: async () => {
          upserts++;
          // The first holder keeps the room lock until every rejoin queued.
          await roomHeld;
          return { id: ROOM_ID, _count: { peers: members.length } };
        },
        update: async () => ({ id: ROOM_ID }),
      },
    } as unknown as Parameters<typeof createHandleRoom>[0];

    const frames: Array<{ type: string; roomRequestId?: string }> = [];
    const clients = new Map<string, P2PartyWSClient>();
    const sockets = members.map((member) => {
      const ws = {
        data: {
          peerId: member.id,
          publicKey: member.publicKey,
          challengeNonce: "",
          challengeId: "",
          socketGeneration: "",
          isVerified: true,
          isAuthenticating: false,
          isAlive: true,
        } satisfies P2PartyWSData,
        readyState: 1,
        send: (serialized: string) => {
          frames.push(JSON.parse(serialized));
        },
        terminate: () => {
          throw new Error("healthy rejoin terminated");
        },
      } as unknown as P2PartyWSClient;
      clients.set(member.id, ws);
      return ws;
    });

    const handleRoom = createHandleRoom(database, clients);
    const consoleError = console.error;
    const errors: unknown[] = [];
    console.error = (error: unknown) => errors.push(error);
    try {
      const rejoins = sockets.map((ws, i) =>
        handleRoom(
          ws.data.peerId,
          ws,
          ROOM_LOCATOR,
          `00000000-0000-4000-8000-${(0x200 + i).toString(16).padStart(12, "0")}`,
        ),
      );
      // Let every request reach the room lock while the first one holds it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(upserts).toBe(1);
      releaseRoom();
      await Promise.all(rejoins);
    } finally {
      console.error = consoleError;
    }

    expect(errors).toEqual([]);
    expect(frames.filter(({ type }) => type === "error")).toEqual([]);
    expect(frames.filter(({ type }) => type === "roomId")).toHaveLength(9);
    expect(upserts).toBe(9);
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
        upsert: async () => ({ id: ROOM_ID, identifier: ROOM_LOCATOR }),
        update: async () => ({ id: ROOM_ID, identifier: ROOM_LOCATOR }),
      },
    } as unknown as Parameters<typeof createHandleRoom>[0];
    const responses: unknown[] = [];
    const socket = {
      data: {
        peerId: peer.id,
        publicKey: peer.publicKey,
        challengeNonce: "",
        challengeId: "",
        socketGeneration: "",
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
        ROOM_LOCATOR,
        ROOM_REQUEST_ID,
      );

      expect(responses).toHaveLength(1);
      const response = responses[0] as Record<string, unknown>;
      expect(Object.keys(response).sort()).toEqual([
        "protocolVersion",
        "roomId",
        "roomLocator",
        "roomRequestId",
        "turnCredentials",
        "type",
      ]);
      expect(response.type).toBe("roomId");
      expect(response.roomId).toBe(ROOM_ID);
      expect(response.roomRequestId).toBe(ROOM_REQUEST_ID);
      expect(response.roomLocator).toBe(ROOM_LOCATOR);
      expect(response.protocolVersion).toBe(SIGNALING_PROTOCOL_VERSION);
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
      // `<expiry>:<22-character tag>`: the identity key is not in it.
      expect(turnCredentials.username).toMatch(
        /^[1-9][0-9]{0,10}:[A-Za-z0-9_-]{22}$/,
      );
      expect(turnCredentials.username).not.toContain(peer.publicKey);
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
