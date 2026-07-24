import { prisma } from "../prismaClient";

import type { P2PartyWSClient } from "../wsServer";
import type { WebSocketMessageError } from "./interfaces";

const findRoomPeers = async (
  ws: P2PartyWSClient,
  roomId: string,
  fromPeerId: string,
  toPeerId: string,
  isDescription: boolean,
  fromPeerPublicKey?: string,
): Promise<boolean> => {
  try {
    if (
      !ws.data.isVerified ||
      ws.data.peerId !== fromPeerId ||
      ws.data.publicKey.length !== 64
    )
      return false;

    const room = await prisma.room.findUnique({
      // const room = await db.room.findUnique({
      where: { id: roomId },
      include: {
        peers: true, // Include the peers of the room
      },
    });

    if (!room) {
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
      // const fromPeer = await db.peer.findUnique({
      where: { id: fromPeerId },
    });
    if (
      !fromPeer ||
      fromPeer.publicKey !== ws.data.publicKey ||
      (isDescription && fromPeer.publicKey !== fromPeerPublicKey)
    ) {
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
      // const toPeer = await db.peer.findUnique({
      where: { id: toPeerId },
    });
    if (!toPeer) {
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
    const roomPeerIds = new Set(room.peers.map((peer) => peer.id));
    const isInRoom = roomPeerIds.has(fromPeerId) && roomPeerIds.has(toPeerId);

    return isInRoom;
  } catch (error) {
    ws.terminate();

    return false;
  }
};

export default findRoomPeers;
