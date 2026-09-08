import { describe, expect, test } from "bun:test";

import { createHandlePeers } from "../../src/utils/handlePeers";

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
