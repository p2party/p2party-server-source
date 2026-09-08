import { describe, expect, test } from "bun:test";

import { createHandlePeers } from "../../src/utils/handlePeers";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const PEER_A_ID = "00000000-0000-4000-8000-000000000002";
const PEER_B_ID = "00000000-0000-4000-8000-000000000003";
const PEER_A_KEY = "aa".repeat(32);
const PEER_B_KEY = "bb".repeat(32);

const client = (
  peerId: string,
  publicKey: string,
): P2PartyWSClient & { sent: string[]; closes: number } => {
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
  } as P2PartyWSData;
  const ws = {
    readyState: 1,
    data: state,
    sent,
    closes: 0,
    send: (payload: string) => sent.push(payload),
    close: () => {
      (ws as { closes: number }).closes += 1;
    },
    terminate: () => undefined,
  };
  return ws as unknown as P2PartyWSClient & { sent: string[]; closes: number };
};

const errorFrame = (raw: string) =>
  JSON.parse(raw) as {
    type: string;
    fromAction: string;
    error: { message: string };
  };

describe("the requester's socket survives a server-side fault", () => {
  test("a peer-query fault does not close the requester's socket", async () => {
    // Pool exhaustion or a replica hiccup is a server fault. The old catch
    // told the requester it "does not exist" and closed its socket, which on
    // the client is terminal (C4) — for a peer that did nothing wrong.
    const requester = client(PEER_A_ID, PEER_A_KEY);
    const clients = new Map([[PEER_A_ID, requester as P2PartyWSClient]]);
    const handlePeers = createHandlePeers(
      {
        peer: {
          findUnique: async () => {
            throw new Error("connection pool exhausted");
          },
        },
        room: { findUnique: async () => null },
      } as never,
      { clients, sendToPeer: async () => false },
    );

    await handlePeers(PEER_A_ID, requester as P2PartyWSClient, ROOM_ID);

    expect(requester.closes).toBe(0);
    // The request still failed, so the client is still told, and told the
    // truth: a server fault, not a verdict on its own identity.
    expect(requester.sent).toHaveLength(1);
    const frame = errorFrame(requester.sent[0]);
    expect(frame.type).toBe("error");
    expect(frame.fromAction).toBe("requestPeers");
    // The old text asserted the peer did not exist, which was false: this is
    // a database fault, not an identity verdict.
    expect(frame.error.message).toBe(
      "Peers request from peer with id " + PEER_A_ID + " could not be served",
    );
  });

  test("a room-query fault does not close the requester's socket", async () => {
    const requester = client(PEER_A_ID, PEER_A_KEY);
    const clients = new Map([[PEER_A_ID, requester as P2PartyWSClient]]);
    const handlePeers = createHandlePeers(
      {
        peer: {
          findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
        },
        room: {
          findUnique: async () => {
            throw new Error("connection pool exhausted");
          },
        },
      } as never,
      { clients, sendToPeer: async () => false },
    );

    await handlePeers(PEER_A_ID, requester as P2PartyWSClient, ROOM_ID);

    expect(requester.closes).toBe(0);
    expect(requester.sent).toHaveLength(1);
    const frame = errorFrame(requester.sent[0]);
    expect(frame.type).toBe("error");
    // The old text asserted the room did not exist, which was false: this is
    // a database fault, not a room-existence verdict.
    expect(frame.error.message).toBe(
      "Peers request for room with id " + ROOM_ID + " could not be served",
    );
  });

  test("a leave-and-rejoin race does not close the requester's socket", async () => {
    // The membership check throws into the same catch. A requestPeers already
    // in flight when this peer leaves and rejoins observes a roster it is not
    // in yet — a pure race, on a healthy authenticated socket.
    const requester = client(PEER_A_ID, PEER_A_KEY);
    const clients = new Map([[PEER_A_ID, requester as P2PartyWSClient]]);
    const handlePeers = createHandlePeers(
      {
        peer: {
          findUnique: async () => ({ id: PEER_A_ID, publicKey: PEER_A_KEY }),
        },
        room: {
          findUnique: async () => ({
            id: ROOM_ID,
            peers: [{ id: PEER_B_ID, publicKey: PEER_B_KEY }],
          }),
        },
      } as never,
      { clients, sendToPeer: async () => false },
    );

    await handlePeers(PEER_A_ID, requester as P2PartyWSClient, ROOM_ID);

    expect(requester.closes).toBe(0);
    expect(requester.sent).toHaveLength(1);
    const frame = errorFrame(requester.sent[0]);
    expect(frame.type).toBe("error");
    // Same catch, same honest text, for a membership race as for a database
    // fault: neither is evidence the room does not exist.
    expect(frame.error.message).toBe(
      "Peers request for room with id " + ROOM_ID + " could not be served",
    );
  });
});
