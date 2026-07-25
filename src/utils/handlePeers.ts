import { prisma as sharedPrisma } from "../prismaClient";

import type { ProcessPrismaClient } from "../prismaClient";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";
import { PROTOCOL_VERSION } from "./protocolV4";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  // WebSocketMessagePeersResponse,
  WebSocketMessageConnectionRequest,
} from "../utils/interfaces";

type HandlePeersPrisma = Pick<ProcessPrismaClient, "peer" | "room">;

const handlePeersWithClient = async (
  prisma: HandlePeersPrisma,
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
          const introduction = JSON.stringify({
            type: "peerConnection",
            roomId,
            peer: { id: fromPeerId, publicKey: fromPeerPublicKey },
            protocolVersion: PROTOCOL_VERSION,
          } as WebSocketMessageConnectionRequest);
          const peerWsClient = wsClients.get(peer.id);

          if (peerWsClient) {
            if (
              peerWsClient.data.isAlive &&
              peerWsClient.data.isVerified &&
              peerWsClient.data.peerId === peer.id &&
              peerWsClient.data.publicKey === peer.publicKey
            )
              peerWsClient.send(introduction);
          } else {
            // This is the introduction that makes an existing room member dial
            // the joiner. With one worker per vCPU behind a round-robin
            // upstream, most room members are on another worker.
            await sendToPeer(peer.id, introduction);
          }
        }
      }

      // ws.send(
      //   JSON.stringify({
      //     type: "peers",
      //     roomId,
      //     peers,
      //   } as WebSocketMessagePeersResponse),
      // );

      return;
    } catch (error) {
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

export const createHandlePeers =
  (prisma: HandlePeersPrisma) =>
  (fromPeerId: string, ws: P2PartyWSClient, roomId: string) =>
    handlePeersWithClient(prisma, fromPeerId, ws, roomId);

const handlePeers = createHandlePeers(sharedPrisma);

export default handlePeers;
