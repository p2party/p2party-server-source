import { PrismaClient } from "@prisma/client";

import { wsClients } from "../wsServer";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  WebSocketMessagePeersResponse,
} from "../utils/interfaces";

const prisma = new PrismaClient();

const handlePeers = async (
  fromPeerId: string,
  ws: P2PartyWSClient,
  roomId: string,
) => {
  try {
    try {
      const fromPeer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
        include: {
          challenges: true,
        },
      });

      if (
        !fromPeer.challenges ||
        fromPeer.challenges.length === 0 ||
        !fromPeer.challenges[0].signature ||
        fromPeer.challenges[0].signature.length !== 1024
      ) {
        await prisma.$disconnect();

        ws.send(
          JSON.stringify({
            type: "error",
            fromAction: "requestPeers",
            error: {
              message: "Peers request was sent from an unverified peer",
            },
          } as WebSocketMessageError),
        );

        ws.close();

        return;
      }
    } catch (error) {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestPeers",
          error: {
            message:
              "Peers' request was sent from peer with id " +
              fromPeerId +
              " who does not exist",
          },
        } as WebSocketMessageError),
      );

      ws.close();

      return;
    }

    try {
      const room = await prisma.room.findUnique({
        where: { id: roomId },
        include: {
          peers: {
            include: {
              challenges: true,
            },
          },
        },
      });

      const peers: { id: string; publicKey: string }[] = [];
      const len = room.peers.length;
      for (let i = 0; i < len; i++) {
        const peer = room.peers[i];
        const challenges = peer.challenges;
        const peerWsClient = wsClients.get(peer.id);

        if (
          peer.id !== fromPeerId &&
          challenges &&
          challenges.length > 0 &&
          challenges[0].signature &&
          challenges[0].signature.length === 1024 &&
          peerWsClient &&
          peerWsClient.data.isAlive
        ) {
          peers.push({
            id: peer.id,
            publicKey: peer.publicKey,
          });
        }
      }

      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "peers",
          roomId: room.id,
          peers,
        } as WebSocketMessagePeersResponse),
      );

      return;
    } catch (error) {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestPeers",
          error: {
            message:
              "Peers request refers to room with id " +
              roomId +
              " which does not exist",
          },
        } as WebSocketMessageError),
      );

      ws.close();

      return;
    }
  } catch (error) {
    await prisma.$disconnect();

    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeers",
        error,
      } as WebSocketMessageError),
    );

    ws.close();

    return;
  }
};

export default handlePeers;
