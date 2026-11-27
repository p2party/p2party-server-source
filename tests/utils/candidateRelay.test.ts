import { describe, expect, spyOn, test } from "bun:test";

import { createHandleCandidate } from "../../src/utils/handleCandidate";
import { createHandleDescription } from "../../src/utils/handleDescription";
import { createFindRoomTarget } from "../../src/utils/findRoomPeers";
import { sendToPeerOnServer } from "../../src/pubsub";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";
import type {
  WebSocketMessageCandidateSend,
  WebSocketMessageDescriptionSend,
} from "../../src/utils/interfaces";

const ROOM_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ROOM_ID = "00000000-0000-4000-8000-0000000000a2";
const MISSING_ROOM_ID = "00000000-0000-4000-8000-0000000000a3";
const SENDER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const OUTSIDER_ID = "00000000-0000-4000-8000-000000000003";
const MISSING_PEER_ID = "00000000-0000-4000-8000-000000000004";
const SENDER_KEY = "aa".repeat(32);
const OTHER_SERVER_ID = "9b2f6c1e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const ROOM_SIZE = 128;

const memberId = (index: number) =>
  `00000000-0000-4000-8000-${(0x100 + index).toString(16).padStart(12, "0")}`;

interface PeerFilter {
  id?: string;
  publicKey?: string;
  rooms?: { some: RoomFilter };
}
interface RoomFilter {
  id?: string;
  peers?: { some: PeerFilter };
}

/**
 * A Peer/Room store that records every query at the database boundary and
 * how many peer rows each one loads. It evaluates exactly the relational
 * filters the relay uses and fails the test on any other key, so a relay
 * that passes is one those filters really allow.
 */
const roomStore = () => {
  const peers = new Map<string, { publicKey: string; serverId: string | null }>(
    [
      [SENDER_ID, { publicKey: SENDER_KEY, serverId: OTHER_SERVER_ID }],
      [TARGET_ID, { publicKey: "bb".repeat(32), serverId: OTHER_SERVER_ID }],
      [OUTSIDER_ID, { publicKey: "cc".repeat(32), serverId: OTHER_SERVER_ID }],
    ],
  );
  const rooms = new Map<string, Set<string>>([
    [ROOM_ID, new Set([SENDER_ID, TARGET_ID])],
    [OTHER_ROOM_ID, new Set([OUTSIDER_ID])],
  ]);
  for (let index = 0; index < ROOM_SIZE - 2; index++) {
    peers.set(memberId(index), {
      publicKey: index.toString(16).padStart(64, "0"),
      serverId: OTHER_SERVER_ID,
    });
    rooms.get(ROOM_ID)!.add(memberId(index));
  }
  const queries: string[] = [];
  let rowsLoaded = 0;

  const onlyKeys = (filter: object, allowed: string[]) => {
    for (const key of Object.keys(filter))
      if (!allowed.includes(key)) throw new Error(`unsupported filter ${key}`);
  };
  const peerMatches = (id: string, filter: PeerFilter): boolean => {
    onlyKeys(filter, ["id", "publicKey", "rooms"]);
    const row = peers.get(id);
    if (!row) return false;
    if (filter.id !== undefined && filter.id !== id) return false;
    if (filter.publicKey !== undefined && filter.publicKey !== row.publicKey)
      return false;
    if (filter.rooms === undefined) return true;
    onlyKeys(filter.rooms, ["some"]);
    return [...rooms].some(
      ([roomId, members]) =>
        members.has(id) && roomMatches(roomId, filter.rooms!.some),
    );
  };
  const roomMatches = (roomId: string, filter: RoomFilter): boolean => {
    onlyKeys(filter, ["id", "peers"]);
    if (filter.id !== undefined && filter.id !== roomId) return false;
    if (filter.peers === undefined) return true;
    onlyKeys(filter.peers, ["some"]);
    return [...rooms.get(roomId)!].some((id) =>
      peerMatches(id, filter.peers!.some),
    );
  };

  const database = {
    peer: {
      findFirst: async (query: {
        where: PeerFilter;
        select: { serverId: true };
      }) => {
        queries.push("peer.findFirst");
        expect(query.select).toEqual({ serverId: true });
        const match = [...peers.keys()].find((id) =>
          peerMatches(id, query.where),
        );
        if (!match) return null;
        rowsLoaded += 1;
        return { serverId: peers.get(match)!.serverId };
      },
      findUnique: async () => {
        queries.push("peer.findUnique");
        throw new Error("the relay must not look peers up one by one");
      },
    },
    room: {
      findUnique: async () => {
        queries.push("room.findUnique");
        throw new Error("the relay must not load a room's membership");
      },
    },
    pendingSignal: {
      create: async (query: {
        data: { targetServerId: string; targetPeerId: string };
      }) => {
        queries.push(
          `pendingSignal.create(${query.data.targetServerId}, ${query.data.targetPeerId})`,
        );
        return query.data;
      },
    },
  };
  const notifier = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
  return {
    database,
    notifier,
    peers,
    rooms,
    queries,
    rowsLoaded: () => rowsLoaded,
  };
};

const socket = (peerId: string, publicKey: string) => {
  const sent: string[] = [];
  let closed = 0;
  let terminated = 0;
  const data: P2PartyWSData = {
    peerId,
    publicKey,
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
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    close: () => {
      closed++;
    },
    terminate: () => {
      terminated++;
    },
  } as unknown as P2PartyWSClient;
  return { ws, sent, observed: () => ({ sent, closed, terminated }) };
};

const candidate = (
  roomId: string,
  toPeerId: string,
): WebSocketMessageCandidateSend => ({
  type: "candidate",
  fromPeerId: SENDER_ID,
  toPeerId,
  roomId,
  candidate: {
    candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host",
  },
  protocolVersion: 5,
});

/** A relay wired to `store` at the database boundary, with real modules above it. */
const relay = (
  store: ReturnType<typeof roomStore>,
  clients: Map<string, P2PartyWSClient>,
) => {
  const dependencies = {
    clients,
    findRoomTarget: createFindRoomTarget(store.database as never, clients),
    sendToPeerOnServer: (toPeerId: string, serverId: string, payload: string) =>
      sendToPeerOnServer(
        toPeerId,
        serverId,
        payload,
        store.database as never,
        store.notifier as never,
      ),
  };
  return {
    candidate: createHandleCandidate(dependencies),
    description: createHandleDescription(dependencies),
  };
};

describe("candidate relay database work", () => {
  test("candidate relay issues one targeted query", async () => {
    // Same worker: the target's socket is here.
    {
      const store = roomStore();
      const source = socket(SENDER_ID, SENDER_KEY);
      const target = socket(TARGET_ID, "bb".repeat(32));
      const clients = new Map([
        [SENDER_ID, source.ws],
        [TARGET_ID, target.ws],
      ]);

      await relay(store, clients).candidate(
        source.ws,
        candidate(ROOM_ID, TARGET_ID),
      );

      // One query, loading the target's row only, in a full room.
      expect(store.queries).toEqual(["peer.findFirst"]);
      expect(store.rowsLoaded()).toBe(1);
      expect(target.sent).toHaveLength(1);
      expect(JSON.parse(target.sent[0]!)).toMatchObject({
        type: "candidate",
        fromPeerId: SENDER_ID,
        roomId: ROOM_ID,
      });
    }

    // Another worker holds the target: the same query read its claim, so
    // routing adds only the queued row and the wake-up.
    {
      const store = roomStore();
      const source = socket(SENDER_ID, SENDER_KEY);
      const clients = new Map([[SENDER_ID, source.ws]]);

      await relay(store, clients).candidate(
        source.ws,
        candidate(ROOM_ID, TARGET_ID),
      );

      expect(store.queries).toEqual([
        "peer.findFirst",
        `pendingSignal.create(${OTHER_SERVER_ID}, ${TARGET_ID})`,
        `NOTIFY "server_${OTHER_SERVER_ID}"`,
      ]);
      expect(store.rowsLoaded()).toBe(1);
    }

    // A target no process holds is neither queued nor announced.
    {
      const store = roomStore();
      store.peers.get(TARGET_ID)!.serverId = null;
      const source = socket(SENDER_ID, SENDER_KEY);
      const clients = new Map([[SENDER_ID, source.ws]]);

      await relay(store, clients).candidate(
        source.ws,
        candidate(ROOM_ID, TARGET_ID),
      );

      expect(store.queries).toEqual(["peer.findFirst"]);
    }
  });

  test("a description relay issues the same one targeted query", async () => {
    const store = roomStore();
    const source = socket(SENDER_ID, SENDER_KEY);
    const target = socket(TARGET_ID, "bb".repeat(32));
    const clients = new Map([
      [SENDER_ID, source.ws],
      [TARGET_ID, target.ws],
    ]);
    const description: WebSocketMessageDescriptionSend = {
      type: "description",
      fromPeerId: SENDER_ID,
      toPeerId: TARGET_ID,
      roomId: ROOM_ID,
      fromPeerPublicKey: SENDER_KEY,
      description: { type: "offer", sdp: "v=0" },
      protocolVersion: 5,
    };

    await relay(store, clients).description(source.ws, description);

    expect(store.queries).toEqual(["peer.findFirst"]);
    expect(store.rowsLoaded()).toBe(1);
    expect(JSON.parse(target.sent[0]!)).toMatchObject({
      type: "description",
      fromPeerId: SENDER_ID,
      fromPeerPublicKey: SENDER_KEY,
    });
  });
});

describe("candidate relay authorization", () => {
  test("a sender learns nothing about a target it shares no room with", async () => {
    const outcomes = [];
    for (const [label, roomId, toPeerId, senderKey] of [
      ["target in another room", ROOM_ID, OUTSIDER_ID, SENDER_KEY],
      ["target does not exist", ROOM_ID, MISSING_PEER_ID, SENDER_KEY],
      ["room does not exist", MISSING_ROOM_ID, TARGET_ID, SENDER_KEY],
      ["sender not in the room", OTHER_ROOM_ID, OUTSIDER_ID, SENDER_KEY],
      ["sender's key is not the member's", ROOM_ID, TARGET_ID, "dd".repeat(32)],
    ] as const) {
      const store = roomStore();
      const source = socket(SENDER_ID, senderKey);
      const everyone = [TARGET_ID, OUTSIDER_ID, MISSING_PEER_ID].map((id) =>
        socket(id, "ee".repeat(32)),
      );
      const clients = new Map([
        [SENDER_ID, source.ws],
        ...everyone.map(({ ws }) => [ws.data.peerId, ws] as const),
      ]);

      await relay(store, clients).candidate(
        source.ws,
        candidate(roomId, toPeerId),
      );
      outcomes.push({
        label,
        delivered: everyone.some(({ sent }) => sent.length > 0),
        ...source.observed(),
        queries: store.queries,
      });
    }

    // Every case looks the same to the sender: no relay, no frame, no close,
    // and the same single query.
    expect(outcomes).toEqual(
      outcomes.map(({ label }) => ({
        label,
        delivered: false,
        sent: [],
        closed: 0,
        terminated: 0,
        queries: ["peer.findFirst"],
      })),
    );
  });

  test("a database fault refuses the frame and leaves the sender's socket up", async () => {
    const store = roomStore();
    store.database.peer.findFirst = async () => {
      throw new Error("connection pool exhausted");
    };
    const source = socket(SENDER_ID, SENDER_KEY);
    const clients = new Map([[SENDER_ID, source.ws]]);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await relay(store, clients).candidate(
        source.ws,
        candidate(ROOM_ID, TARGET_ID),
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(source.observed()).toEqual({ sent: [], closed: 0, terminated: 0 });
  });
});
