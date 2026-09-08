import { afterEach, describe, expect, test } from "bun:test";

import { wsClients } from "../../src/wsServer";
import { createHandlePeers } from "../../src/utils/handlePeers";
import { createHandlePeerAcceptsConnection } from "../../src/utils/handlePeerAcceptsConnection";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const PEER_A_ID = "00000000-0000-4000-8000-000000000002";
const PEER_B_ID = "00000000-0000-4000-8000-000000000003";
const PEER_A_KEY = "aa".repeat(32);
const PEER_B_KEY = "bb".repeat(32);

const client = (
  peerId: string,
  publicKey: string,
  overrides: Partial<P2PartyWSData> = {},
): P2PartyWSClient & { sent: string[]; closes: number; terminates: number } => {
  const sent: string[] = [];
  const state = {
    peerId,
    publicKey,
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: true,
    isAuthenticating: false,
    isAlive: true,
    ...overrides,
  } as P2PartyWSData;
  const ws = {
    readyState: 1,
    data: state,
    sent,
    closes: 0,
    terminates: 0,
    send: (payload: string) => sent.push(payload),
    close: () => {
      (ws as { closes: number }).closes += 1;
    },
    terminate: () => {
      (ws as { terminates: number }).terminates += 1;
    },
  };
  return ws as unknown as P2PartyWSClient & {
    sent: string[];
    closes: number;
    terminates: number;
  };
};

afterEach(() => {
  wsClients.clear();
});

describe("introduction delivery through the ping window", () => {
  test("handlePeers introduces a member whose pong is still in flight", async () => {
    // isAlive is false for the whole round trip of every 10 s ping. Dropping
    // introductions for that window is why an n>=3 room silently fails to mesh.
    const requester = client(PEER_A_ID, PEER_A_KEY);
    const member = client(PEER_B_ID, PEER_B_KEY, { isAlive: false });
    const clients = new Map([
      [PEER_A_ID, requester as P2PartyWSClient],
      [PEER_B_ID, member as P2PartyWSClient],
    ]);
    const prisma = {
      peer: {
        findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
      },
      room: {
        findUnique: async () => ({
          id: ROOM_ID,
          peers: [
            { id: PEER_A_ID, publicKey: PEER_A_KEY },
            { id: PEER_B_ID, publicKey: PEER_B_KEY },
          ],
        }),
      },
    };
    const handlePeers = createHandlePeers(prisma as never, {
      clients,
      sendToPeer: async () => false,
    });
    await handlePeers(PEER_A_ID, requester as P2PartyWSClient, ROOM_ID);

    expect(member.sent).toHaveLength(1);
    const intro = JSON.parse(member.sent[0]) as {
      type: string;
      peer: { id: string };
    };
    expect(intro.type).toBe("peerConnection");
    expect(intro.peer.id).toBe(PEER_A_ID);
  });

  test("handlePeerAcceptsConnection introduces through the ping window too", async () => {
    const acceptor = client(PEER_A_ID, PEER_A_KEY);
    const joiner = client(PEER_B_ID, PEER_B_KEY, { isAlive: false });
    const clients = new Map([
      [PEER_A_ID, acceptor as P2PartyWSClient],
      [PEER_B_ID, joiner as P2PartyWSClient],
    ]);
    const prisma = {
      peer: {
        findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
      },
    };
    const handle = createHandlePeerAcceptsConnection(prisma as never, {
      clients,
      findRoomPeers: async () => true,
      sendToPeer: async () => false,
    });
    await handle(PEER_A_ID, PEER_B_ID, ROOM_ID, acceptor as P2PartyWSClient);

    expect(joiner.sent).toHaveLength(1);
    expect(
      (JSON.parse(joiner.sent[0]) as { type: string; peers: { id: string }[] })
        .peers[0].id,
    ).toBe(PEER_A_ID);
  });

  test("a joiner that already left does not cost the acceptor its socket", async () => {
    // handlePeerConnection drops the identical condition silently; closing the
    // acceptor's socket here manufactures exactly the terminal disconnect C4
    // describes, on a peer that did nothing wrong.
    const acceptor = client(PEER_A_ID, PEER_A_KEY);
    const clients = new Map([[PEER_A_ID, acceptor as P2PartyWSClient]]);
    const prisma = {
      peer: { findUnique: async () => null },
    };
    const handle = createHandlePeerAcceptsConnection(prisma as never, {
      clients,
      findRoomPeers: async () => false,
      sendToPeer: async () => false,
    });
    await handle(PEER_A_ID, PEER_B_ID, ROOM_ID, acceptor as P2PartyWSClient);

    expect(acceptor.closes).toBe(0);
    expect(acceptor.sent).toEqual([]);
  });

  test("a database fault does not terminate the requester's socket", async () => {
    const requester = client(PEER_A_ID, PEER_A_KEY);
    const clients = new Map([[PEER_A_ID, requester as P2PartyWSClient]]);
    const { createFindRoomPeers } =
      await import("../../src/utils/findRoomPeers");
    const findRoomPeers = createFindRoomPeers(
      {
        room: {
          findUnique: async () => {
            throw new Error("connection pool exhausted");
          },
        },
      } as never,
      clients,
    );
    const allGood = await findRoomPeers(
      requester as P2PartyWSClient,
      ROOM_ID,
      PEER_A_ID,
      PEER_B_ID,
      false,
    );
    expect(allGood).toBe(false);
    expect(requester.terminates).toBe(0);
  });
});
