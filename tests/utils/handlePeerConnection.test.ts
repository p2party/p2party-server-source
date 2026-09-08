import { describe, expect, test } from "bun:test";

import { createHandlePeerConnection } from "../../src/utils/handlePeerConnection";

import type { ProcessPrismaClient } from "../../src/prismaClient";
import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";
import type { WebSocketMessagePeerConnectionRequest } from "../../src/utils/interfaces";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const ROOM_ID = "00000000-0000-4000-8000-000000000003";

type PeerPrisma = Pick<ProcessPrismaClient, "peer">;

const socket = (peerId: string, publicKey: string) => {
  const sent: string[] = [];
  const ws = {
    data: {
      peerId,
      publicKey,
      challengeNonce: "",
      challengeId: "",
      socketGeneration: "",
      isVerified: true,
      isAuthenticating: false,
      isAlive: true,
    } satisfies P2PartyWSData,
    readyState: 1,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    close: () => {},
  } as unknown as P2PartyWSClient;
  return { ws, sent };
};

describe("peer connection target fencing", () => {
  test("resolves the exact target after an awaited source query", async () => {
    let releaseQuery!: () => void;
    let markStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const prisma = {
      peer: {
        findUnique: async () => {
          markStarted();
          await queryGate;
          return { id: SOURCE_ID, publicKey: "aa".repeat(32) };
        },
      },
    } as unknown as PeerPrisma;
    const source = socket(SOURCE_ID, "aa".repeat(32));
    const predecessor = socket(TARGET_ID, "bb".repeat(32));
    const successor = socket(TARGET_ID, "bb".repeat(32));
    const clients = new Map<string, P2PartyWSClient>([
      [SOURCE_ID, source.ws],
      [TARGET_ID, predecessor.ws],
    ]);
    const routed: string[] = [];
    const message: WebSocketMessagePeerConnectionRequest = {
      type: "connection",
      roomId: ROOM_ID,
      fromPeerId: SOURCE_ID,
      toPeerId: TARGET_ID,
      labels: ["main"],
      protocolVersion: 4,
    };
    const handle = createHandlePeerConnection(prisma, {
      clients,
      findRoomPeers: async () => true,
      sendToPeer: async (peerId) => {
        routed.push(peerId);
        return true;
      },
    });

    const pending = handle(source.ws, message);
    await queryStarted;
    predecessor.ws.data.isVerified = false;
    clients.set(TARGET_ID, successor.ws);
    releaseQuery();
    await pending;

    expect(predecessor.sent).toEqual([]);
    expect(successor.sent).toHaveLength(1);
    expect(JSON.parse(successor.sent[0]!)).toMatchObject({
      type: "connection",
      roomId: ROOM_ID,
      fromPeerId: SOURCE_ID,
    });
    expect(routed).toEqual([]);
  });
});
