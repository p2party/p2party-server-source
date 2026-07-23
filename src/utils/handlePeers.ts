// import { PrismaClient } from "@prisma/client";
import { PrismaClient } from "../prismaClient";
// import { db } from "../db/db";

import { wsClients } from "../wsServer";
import { PROTOCOL_VERSION } from "./protocolV3";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  // WebSocketMessagePeersResponse,
  WebSocketMessageConnectionRequest,
} from "../utils/interfaces";

const prisma = new PrismaClient();

const handlePeers = async (
  fromPeerId: string,
  ws: P2PartyWSClient,
  roomId: string,
) => {
  try {
    let fromPeerPublicKey = "";
    try {
      const fromPeer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
      });

      if (
        !fromPeer ||
        !ws.data.isVerified ||
        ws.data.peerId !== fromPeerId ||
        fromPeer.publicKey !== ws.data.publicKey
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
      } else fromPeerPublicKey = fromPeer.publicKey;
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

    if (fromPeerPublicKey.length === 0) return;

    try {
      const room = await prisma.room.findUnique({
        // const room = await db.room.findUnique({
        where: { id: roomId },
        include: {
          peers: true,
        },
      });

      // const peers: { id: string; publicKey: string }[] = [];
      if (!room?.peers.some((peer) => peer.id === fromPeerId))
        throw new Error("Requesting peer is not a member of this room");

      const len = room?.peers.length ?? 0;
      for (let i = 0; i < len; i++) {
        if (room && room.peers[i] && room.peers[i].id !== fromPeerId) {
          const peer = room.peers[i];
          const peerWsClient = wsClients.get(peer.id);

          if (
            peerWsClient &&
            peerWsClient.data.isAlive &&
            peerWsClient.data.isVerified &&
            peerWsClient.data.peerId === peer.id &&
            peerWsClient.data.publicKey === peer.publicKey
          ) {
            peerWsClient.send(
              JSON.stringify({
                type: "peerConnection",
                roomId,
                peer: { id: fromPeerId, publicKey: fromPeerPublicKey },
                protocolVersion: PROTOCOL_VERSION,
              } as WebSocketMessageConnectionRequest),
            );

            // peers.push({
            //   id: peer.id,
            //   publicKey: peer.publicKey,
            // });
          }
        }
      }

      await prisma.$disconnect();

      // ws.send(
      //   JSON.stringify({
      //     type: "peers",
      //     roomId,
      //     peers,
      //   } as WebSocketMessagePeersResponse),
      // );

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
