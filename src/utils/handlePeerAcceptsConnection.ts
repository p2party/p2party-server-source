// import { PrismaClient } from "@prisma/client";
import { PrismaClient } from "../prismaClient";
// import { db } from "../db/db";

import { wsClients } from "../wsServer";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  WebSocketMessagePeersResponse,
} from "../utils/interfaces";
import findRoomPeers from "./findRoomPeers";
import { PROTOCOL_VERSION } from "./protocolV3";

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
      });

      await prisma.$disconnect();

      if (
        !fromPeer ||
        !ws.data.isVerified ||
        ws.data.peerId !== fromPeerId ||
        ws.data.publicKey !== fromPeer.publicKey
      ) {
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

      const peerWsClient = wsClients.get(toPeerId);
      if (
        peerWsClient &&
        peerWsClient.data.isAlive &&
        peerWsClient.data.isVerified &&
        peerWsClient.data.peerId === toPeerId
      ) {
        peerWsClient.send(
          JSON.stringify({
            type: "peers",
            roomId,
            peers: [{ id: fromPeerId, publicKey: fromPeer.publicKey }],
            protocolVersion: PROTOCOL_VERSION,
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
