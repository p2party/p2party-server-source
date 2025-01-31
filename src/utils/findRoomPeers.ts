import { PrismaClient } from "@prisma/client";

import type { P2PartyWSClient } from "../wsServer";
import type { WebSocketMessageError } from "./interfaces";

const prisma = new PrismaClient();

const findRoomPeers = async (
  ws: P2PartyWSClient,
  roomId: string,
  fromPeerId: string,
  toPeerId: string,
  isDescription: boolean,
  fromPeerPublicKey?: string,
): Promise<boolean> => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        peers: true, // Include the peers of the room
      },
    });

    if (!room) {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "receiveCandidate",
          error: {
            message: "Peer mentioned a non-existing room",
          },
        } as WebSocketMessageError),
      );

      ws.terminate();
      // await peerRepository.delete(client.id);

      return false;
    }

    const fromPeer = await prisma.peer.findUnique({
      where: { id: fromPeerId },
    });
    if (
      !fromPeer ||
      (isDescription && fromPeer.publicKey !== fromPeerPublicKey)
    ) {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "receiveDescription",
          error: {
            message: "Peer mentioned a non-existing sending client",
          },
        } as WebSocketMessageError),
      );

      ws.terminate();
      // await peerRepository.remove(client);

      return false;
    }

    const toPeer = await prisma.peer.findUnique({
      where: { id: toPeerId },
    });
    if (!toPeer) {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "receiveDescription",
          error: {
            message: "Peer mentioned a non-existing receiving client",
          },
        } as WebSocketMessageError),
      );

      ws.terminate();
      // await peerRepository.remove(client);

      return false;
    }

    // Check if both peers are in the specified room
    const isInRoom = room.peers.some(
      (peer) => peer.id === fromPeerId || peer.id === toPeerId,
    );

    return isInRoom;
  } catch (error) {
    await prisma.$disconnect();

    ws.terminate();

    return false;
  }
};

export default findRoomPeers;
