import { PrismaClient } from "@prisma/client";

import { wsClients } from "../wsServer";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  WebSocketMessagePeersResponse,
} from "../utils/interfaces";
import findRoomPeers from "./findRoomPeers";

const prisma = new PrismaClient();

const handlePeerAcceptsConnection = async (
  fromPeerId: string,
  toPeerId: string,
  roomId: string,
  ws: P2PartyWSClient,
) => {
  try {
    const allGood = await findRoomPeers(
      ws,
      roomId,
      fromPeerId,
      toPeerId,
      false,
    );

    if (!allGood) {
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
      const fromPeer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
        include: {
          challenges: true,
        },
      });

      await prisma.$disconnect();

      if (!fromPeer) {
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

      if (
        !fromPeer.challenges ||
        fromPeer.challenges.length === 0 ||
        !fromPeer.challenges[0].signature ||
        // fromPeer.challenges[0].signature.length !== 1024
        fromPeer.challenges[0].signature.length !== 128
      ) {
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

      const peerWsClient = wsClients.get(toPeerId);
      if (peerWsClient && peerWsClient.data.isAlive) {
        console.log(toPeerId);
        console.log(fromPeerId);
        console.log(fromPeer.publicKey);
        peerWsClient.send(
          JSON.stringify({
            type: "peers",
            roomId,
            peers: [{ id: fromPeerId, publicKey: fromPeer.publicKey }],
          } as WebSocketMessagePeersResponse),
        );
      }

      return;
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

export default handlePeerAcceptsConnection;
