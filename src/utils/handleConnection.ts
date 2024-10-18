import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageChallengeRequest,
  WebSocketMessageError,
} from "./interfaces";

const prisma = new PrismaClient();

const handleConnection = async (
  publicKey: string,
  ws: P2PartyWSClient,
): Promise<string> => {
  try {
    try {
      const existingPeer = await prisma.peer.findUnique({
        where: { publicKey },
      });

      await prisma.$disconnect();

      return existingPeer.id;
    } catch (error) {
      const randomBytes = crypto.randomBytes(32);
      const challengeNonce = Array.from(randomBytes, (i: number) =>
        i.toString(16).padStart(2, "0"),
      ).join("");

      const peer = await prisma.peer.create({
        data: {
          lastPing: Date.now(),
          publicKey,
          challenges: {
            create: {
              nonce: challengeNonce,
            },
          },
        },
      });

      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "peerId",
          peerId: peer.id,
          challenge: challengeNonce,
          message: `Connected to WebSocket server. Your client id is ${peer.id}`,
        } as WebSocketMessageChallengeRequest),
      );

      return peer.id;
    }
  } catch (error) {
    await prisma.$disconnect();

    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeerId",
        error,
      } as WebSocketMessageError),
    );

    ws.terminate();

    return "";
  }
};

export default handleConnection;
