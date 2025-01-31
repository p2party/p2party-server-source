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
    const existingPeer = await prisma.peer.findUnique({
      where: { publicKey },
      include: {
        challenges: true,
      },
    });

    if (!existingPeer) {
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

    await prisma.$disconnect();

    const secret = process.env.COTURN_SECRET || "north";
    const date = Date.now();
    const unixTimeStamp = parseInt(String(date / 1000)) + 1 * 60 * 60; // two hours
    const username = [unixTimeStamp, publicKey].join(":");
    const hmac = crypto.createHmac("sha1", secret);

    hmac.setEncoding("base64");
    hmac.write(username);
    hmac.end();
    const credential = hmac.read();

    ws.send(
      JSON.stringify({
        type: "peerId",
        peerId: existingPeer?.id,
        challenge: existingPeer?.challenges[0].nonce ?? "",
        signature: existingPeer?.challenges[0].signature ?? "",
        challengeId: existingPeer?.challenges[0].id ?? "",
        username,
        credential,
        message: `Connected to WebSocket server. Your client id is ${existingPeer?.id}`,
      } as WebSocketMessageChallengeRequest),
    );

    return existingPeer?.id ?? "";
  } catch (error) {
    try {
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
  }
};

export default handleConnection;
