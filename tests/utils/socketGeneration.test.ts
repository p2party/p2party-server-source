import { afterEach, describe, expect, test } from "bun:test";

import { wsClients } from "../../src/wsServer";
import {
  consumeSocketChallenge,
  createFreshSocketChallenge,
  registerVerifiedSocket,
} from "../../src/utils/socketAuth";
import { createHandlePeerAcceptsConnection } from "../../src/utils/handlePeerAcceptsConnection";
import { createHandlePeerConnection } from "../../src/utils/handlePeerConnection";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const PEER_A_ID = "00000000-0000-4000-8000-000000000002";
const PEER_B_ID = "00000000-0000-4000-8000-000000000003";
const PEER_A_KEY = "aa".repeat(32);
const PEER_B_KEY = "bb".repeat(32);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const emptyState = (): P2PartyWSData =>
  ({
    publicKey: "",
    peerId: "",
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: false,
    isAuthenticating: false,
    isAlive: true,
  }) as P2PartyWSData;

const client = (
  peerId: string,
  publicKey: string,
  socketGeneration: string,
): P2PartyWSClient & { sent: string[] } => {
  const sent: string[] = [];
  return {
    readyState: 1,
    data: {
      ...emptyState(),
      peerId,
      publicKey,
      socketGeneration,
      isVerified: true,
    },
    sent,
    send: (payload: string) => sent.push(payload),
    close: () => undefined,
    terminate: () => undefined,
  } as unknown as P2PartyWSClient & { sent: string[] };
};

afterEach(() => {
  wsClients.clear();
});

describe("per-socket generation", () => {
  test("verification preserves the challenge id as the socket generation", () => {
    const state = emptyState();
    createFreshSocketChallenge(state, PEER_A_ID, PEER_A_KEY);
    expect(state.socketGeneration).toBe("");
    const challengeId = consumeSocketChallenge(state);
    expect(challengeId).toMatch(UUID_V4);
    expect(state.challengeId).toBe("");
    expect(state.socketGeneration).toBe(challengeId);
  });

  test("a second socket for the same identity gets a different generation", () => {
    const first = emptyState();
    const second = emptyState();
    createFreshSocketChallenge(first, PEER_A_ID, PEER_A_KEY);
    createFreshSocketChallenge(second, PEER_A_ID, PEER_A_KEY);
    consumeSocketChallenge(first);
    consumeSocketChallenge(second);
    expect(second.socketGeneration).not.toBe(first.socketGeneration);
    expect(second.socketGeneration).toMatch(UUID_V4);
  });

  test("a fresh challenge on the same socket clears the old generation", () => {
    const state = emptyState();
    createFreshSocketChallenge(state, PEER_A_ID, PEER_A_KEY);
    consumeSocketChallenge(state);
    createFreshSocketChallenge(state, PEER_A_ID, PEER_A_KEY);
    expect(state.socketGeneration).toBe("");
  });

  test("the peers introduction carries the accepting socket's generation", async () => {
    const acceptor = client(
      PEER_A_ID,
      PEER_A_KEY,
      "11111111-1111-4111-8111-111111111111",
    );
    const joiner = client(
      PEER_B_ID,
      PEER_B_KEY,
      "22222222-2222-4222-8222-222222222222",
    );
    const clients = new Map([
      [PEER_A_ID, acceptor as P2PartyWSClient],
      [PEER_B_ID, joiner as P2PartyWSClient],
    ]);
    const routed: string[] = [];
    const handle = createHandlePeerAcceptsConnection(
      {
        peer: {
          findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
        },
      } as never,
      {
        clients,
        findRoomPeers: async () => true,
        sendToPeer: async (peerId: string) => {
          routed.push(peerId);
          return true;
        },
      },
    );
    await handle(PEER_A_ID, PEER_B_ID, ROOM_ID, acceptor as P2PartyWSClient);

    expect(routed).toEqual([]);
    expect(joiner.sent).toHaveLength(1);
    const frame = JSON.parse(joiner.sent[0]!) as {
      peers: { id: string; publicKey: string; socketGeneration?: string }[];
      protocolVersion: number;
    };
    expect(frame.protocolVersion).toBe(4);
    expect(frame.peers[0]!.socketGeneration).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(frame.peers[0]!.id).toBe(PEER_A_ID);
    expect(frame.peers[0]!.publicKey).toBe(PEER_A_KEY);
  });

  test("the connection frame carries the dialling socket's generation", async () => {
    const dialer = client(
      PEER_A_ID,
      PEER_A_KEY,
      "33333333-3333-4333-8333-333333333333",
    );
    const target = client(
      PEER_B_ID,
      PEER_B_KEY,
      "44444444-4444-4444-8444-444444444444",
    );
    const clients = new Map([
      [PEER_A_ID, dialer as P2PartyWSClient],
      [PEER_B_ID, target as P2PartyWSClient],
    ]);
    const handle = createHandlePeerConnection(
      {
        peer: {
          findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
        },
      } as never,
      {
        clients,
        findRoomPeers: async () => true,
        sendToPeer: async () => true,
      },
    );
    await handle(
      dialer as P2PartyWSClient,
      {
        type: "connection",
        roomId: ROOM_ID,
        fromPeerId: PEER_A_ID,
        toPeerId: PEER_B_ID,
        labels: ["main"],
        protocolVersion: 4,
      } as never,
    );

    expect(target.sent).toHaveLength(1);
    const frame = JSON.parse(target.sent[0]!) as {
      type: string;
      fromPeerId: string;
      fromPeerPublicKey: string;
      fromPeerSocketGeneration?: string;
    };
    expect(frame.type).toBe("connection");
    expect(frame.fromPeerId).toBe(PEER_A_ID);
    expect(frame.fromPeerPublicKey).toBe(PEER_A_KEY);
    expect(frame.fromPeerSocketGeneration).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  /**
   * SocketAuthState.socketGeneration is "" (not undefined) before a socket
   * proves ownership and again right after a fresh challenge is issued on it
   * (socketAuth.ts's doc comment on that field). That is a real runtime value
   * of the field, not just a type-level possibility, and the wire contract
   * for both RoomPeer.socketGeneration and
   * WebSocketMessagePeerConnectionResponse.fromPeerSocketGeneration
   * (interfaces.ts) documents only `undefined` as "no information". A client
   * implementing the natural `if (seen !== incoming) retire()` would treat an
   * observed "" as a real, different generation from any UUID it already
   * holds and retire a perfectly healthy edge -- reintroducing the exact
   * class of bug (C1/C4) this whole feature exists to fix. The server must
   * therefore never put "" on the wire where a generation is expected: the
   * field must be omitted entirely, exactly as it already is for a
   * pre-generation server.
   */
  test("an empty socket generation never reaches the wire as a value", async () => {
    const dialer = client(PEER_A_ID, PEER_A_KEY, "");
    const target = client(
      PEER_B_ID,
      PEER_B_KEY,
      "88888888-8888-4888-8888-888888888888",
    );
    const clients = new Map([
      [PEER_A_ID, dialer as P2PartyWSClient],
      [PEER_B_ID, target as P2PartyWSClient],
    ]);
    const handle = createHandlePeerConnection(
      {
        peer: {
          findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
        },
      } as never,
      {
        clients,
        findRoomPeers: async () => true,
        sendToPeer: async () => true,
      },
    );
    await handle(
      dialer as P2PartyWSClient,
      {
        type: "connection",
        roomId: ROOM_ID,
        fromPeerId: PEER_A_ID,
        toPeerId: PEER_B_ID,
        labels: ["main"],
        protocolVersion: 4,
      } as never,
    );

    expect(target.sent).toHaveLength(1);
    const raw = target.sent[0]!;
    // Byte-level check first: the key must not appear on the wire at all,
    // not merely parse back to undefined.
    expect(raw.includes("fromPeerSocketGeneration")).toBe(false);
    const frame = JSON.parse(raw) as { fromPeerSocketGeneration?: string };
    expect(frame.fromPeerSocketGeneration).toBeUndefined();
  });

  /**
   * Same defect as above, at the OTHER emit site: handlePeerAcceptsConnection
   * builds the `peers` introduction's RoomPeer entry directly from
   * `ws.data.socketGeneration` (handlePeerAcceptsConnection.ts). An acceptor
   * whose socket has not yet proved ownership of its key -- or whose
   * challenge was just refreshed -- holds "" there, and RoomPeer.socketGeneration
   * documents `undefined` as the only "no information" value. Without routing
   * through wireSocketGeneration(), this site would put "" on the wire and a
   * `seen !== incoming` client would retire a healthy edge (C1/C4).
   */
  test("an empty socket generation never reaches the wire via the peers introduction", async () => {
    const acceptor = client(PEER_A_ID, PEER_A_KEY, "");
    const joiner = client(
      PEER_B_ID,
      PEER_B_KEY,
      "99999999-9999-4999-8999-999999999999",
    );
    const clients = new Map([
      [PEER_A_ID, acceptor as P2PartyWSClient],
      [PEER_B_ID, joiner as P2PartyWSClient],
    ]);
    const handle = createHandlePeerAcceptsConnection(
      {
        peer: {
          findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
        },
      } as never,
      {
        clients,
        findRoomPeers: async () => true,
        sendToPeer: async () => true,
      },
    );
    await handle(PEER_A_ID, PEER_B_ID, ROOM_ID, acceptor as P2PartyWSClient);

    expect(joiner.sent).toHaveLength(1);
    const raw = joiner.sent[0]!;
    // Byte-level check first: the key must not appear on the wire at all,
    // not merely parse back to undefined.
    expect(raw.includes("socketGeneration")).toBe(false);
    const frame = JSON.parse(raw) as {
      peers: { id: string; publicKey: string; socketGeneration?: string }[];
    };
    expect(frame.peers[0]!.socketGeneration).toBeUndefined();
  });

  /**
   * C1 itself: the same identity on a second tab reconnects as the SAME
   * peerId (handleConnection upserts Peer by publicKey), the registry entry is
   * replaced and the predecessor closed with nothing on the wire. The peer on
   * the other side must be able to see, from the introduction alone, that the
   * session behind that peerId changed.
   */
  test("a second socket for one identity dials with its own generation", async () => {
    const firstTab = client(
      PEER_A_ID,
      PEER_A_KEY,
      "55555555-5555-4555-8555-555555555555",
    );
    const secondTab = client(
      PEER_A_ID,
      PEER_A_KEY,
      "66666666-6666-4666-8666-666666666666",
    );
    const target = client(
      PEER_B_ID,
      PEER_B_KEY,
      "77777777-7777-4777-8777-777777777777",
    );
    const clients = new Map<string, P2PartyWSClient>([
      [PEER_B_ID, target as P2PartyWSClient],
    ]);
    expect(registerVerifiedSocket(clients, firstTab as P2PartyWSClient)).toBe(
      true,
    );
    expect(registerVerifiedSocket(clients, secondTab as P2PartyWSClient)).toBe(
      true,
    );
    expect(clients.get(PEER_A_ID)).toBe(secondTab as P2PartyWSClient);

    const handle = createHandlePeerConnection(
      {
        peer: {
          findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
        },
      } as never,
      {
        clients,
        findRoomPeers: async () => true,
        sendToPeer: async () => true,
      },
    );
    await handle(
      secondTab as P2PartyWSClient,
      {
        type: "connection",
        roomId: ROOM_ID,
        fromPeerId: PEER_A_ID,
        toPeerId: PEER_B_ID,
        labels: ["main"],
        protocolVersion: 4,
      } as never,
    );

    expect(target.sent).toHaveLength(1);
    const frame = JSON.parse(target.sent[0]!) as {
      fromPeerId: string;
      fromPeerSocketGeneration?: string;
    };
    expect(frame.fromPeerId).toBe(PEER_A_ID);
    expect(frame.fromPeerSocketGeneration).toBe(
      "66666666-6666-4666-8666-666666666666",
    );
    expect(frame.fromPeerSocketGeneration).not.toBe(
      firstTab.data.socketGeneration,
    );
  });

  test("the protocol version is not bumped by the new field", async () => {
    const { PROTOCOL_VERSION } = await import("../../src/utils/protocolV4");
    expect(PROTOCOL_VERSION).toBe(4);
  });
});
