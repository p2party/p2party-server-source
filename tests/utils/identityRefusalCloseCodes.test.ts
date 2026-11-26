import { describe, expect, spyOn, test } from "bun:test";

import { createHandlePeers } from "../../src/utils/handlePeers";
import { createHandlePeerAcceptsConnection } from "../../src/utils/handlePeerAcceptsConnection";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const PEER_A_ID = "00000000-0000-4000-8000-000000000002";
const PEER_A_KEY = "aa".repeat(32);

const client = (
  peerId: string,
  publicKey: string,
): P2PartyWSClient & {
  sent: string[];
  closeArgs: { code?: number; reason?: string }[];
} => {
  const sent: string[] = [];
  const closeArgs: { code?: number; reason?: string }[] = [];
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
  return {
    readyState: 1,
    data: state,
    sent,
    closeArgs,
    send: (payload: string) => sent.push(payload),
    close: (code?: number, reason?: string) => {
      closeArgs.push({ code, reason });
    },
    terminate: () => undefined,
  } as unknown as P2PartyWSClient & {
    sent: string[];
    closeArgs: { code?: number; reason?: string }[];
  };
};

/**
 * The client's reconnect ladder treats codes 1003/1008/1010 as permanent
 * ONLY when the server chose them; every other close (including the bare
 * ws.close() -> 1005 the server used to send everywhere) is retried forever
 * at a 30 s ceiling. A refusal that can never succeed on retry -- a claimed
 * peer id whose record has no row, or whose public key no longer matches
 * the socket that already proved ownership of a DIFFERENT key -- must
 * therefore close with 1008, or the client retries against a server that
 * will never accept it.
 */
describe("identity-refusal closes carry a permanent close code", () => {
  test("handlePeers closes a socket whose identity no longer matches its record with 1008", async () => {
    const requester = client(PEER_A_ID, PEER_A_KEY);
    const clients = new Map([[PEER_A_ID, requester as P2PartyWSClient]]);
    const handlePeers = createHandlePeers(
      {
        peer: {
          // A row exists for this id, but its public key does not match the
          // key this socket already proved ownership of via the challenge.
          findUnique: async () => ({
            id: PEER_A_ID,
            publicKey: "bb".repeat(32),
          }),
        },
        room: { findUnique: async () => null },
      } as never,
      { clients, sendToPeer: async () => false },
    );

    await handlePeers(PEER_A_ID, requester as P2PartyWSClient, ROOM_ID);

    expect(requester.closeArgs).toEqual([
      { code: 1008, reason: expect.any(String) },
    ]);
    expect(requester.closeArgs[0]!.reason!.length).toBeGreaterThan(0);
  });
});

/**
 * The last-resort catch of a handler must answer with a fixed message. The
 * value it catches can be anything thrown below it, a database driver error
 * with its version, codes and table names included.
 */
describe("a handler's last-resort error frame", () => {
  const PEER_B_ID = "00000000-0000-4000-8000-000000000003";
  const internals = {
    code: "P2024",
    meta: { modelName: "Room", table: "_PeerRooms" },
    clientVersion: "7.9.0",
  };
  /** A socket whose first send throws, so the inner catch's reply fails. */
  const flakySocket = () => {
    const ws = client(PEER_A_ID, PEER_A_KEY);
    let sends = 0;
    const record = ws.send.bind(ws);
    ws.send = ((payload: string) => {
      if (sends++ === 0) throw internals;
      return record(payload);
    }) as typeof ws.send;
    return ws;
  };
  const lastResortFrame = (sent: string[]) => {
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("clientVersion");
    expect(sent[0]).not.toContain("_PeerRooms");
    return JSON.parse(sent[0]!) as unknown;
  };

  test("handlePeers sends a fixed message, not the raw error", async () => {
    const requester = flakySocket();
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
      {
        clients: new Map([[PEER_A_ID, requester as P2PartyWSClient]]),
        sendToPeer: async () => false,
      },
    );
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handlePeers(PEER_A_ID, requester as P2PartyWSClient, ROOM_ID);
    } finally {
      consoleError.mockRestore();
    }

    expect(lastResortFrame(requester.sent)).toEqual({
      type: "error",
      fromAction: "requestPeers",
      error: { message: "Peers request could not be served" },
    });
  });

  test("handlePeerAcceptsConnection sends a fixed message, not the raw error", async () => {
    const acceptor = flakySocket();
    const handle = createHandlePeerAcceptsConnection(
      {
        peer: {
          findUnique: async () => {
            throw new Error("connection pool exhausted");
          },
        },
      } as never,
      {
        clients: new Map([[PEER_A_ID, acceptor as P2PartyWSClient]]),
        findRoomPeers: async () => true,
        sendToPeer: async () => false,
      },
    );
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handle(PEER_A_ID, PEER_B_ID, ROOM_ID, acceptor as P2PartyWSClient);
    } finally {
      consoleError.mockRestore();
    }

    expect(lastResortFrame(acceptor.sent)).toEqual({
      type: "error",
      fromAction: "requestPeers",
      error: { message: "Peers request could not be served" },
    });
  });
});
