import { prisma as sharedPrisma } from "../prismaClient";

import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";
import type { WebSocketMessageError } from "./interfaces";
import { wsClients } from "../wsServer";
import { isCurrentVerifiedSocket } from "./socketAuth";

type FindRoomPeersPrisma = Pick<ProcessPrismaClient, "peer" | "room">;
type SocketRegistry = Map<string, P2PartyWSClient>;

const findRoomPeersWithClient = async (
  prisma: FindRoomPeersPrisma,
  clients: SocketRegistry,
  ws: P2PartyWSClient,
  roomId: string,
  fromPeerId: string,
  toPeerId: string,
  isDescription: boolean,
  fromPeerPublicKey?: string,
): Promise<boolean> => {
  const isCurrentSource = () =>
    ws.data.peerId === fromPeerId &&
    ws.data.publicKey.length === 64 &&
    isCurrentVerifiedSocket(clients, ws);

  try {
    if (!isCurrentSource()) return false;

    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        peers: true,
      },
    });

    if (!isCurrentSource()) return false;
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

      return false;
    }

    const fromPeer = await prisma.peer.findUnique({
      where: { id: fromPeerId },
    });
    if (!isCurrentSource()) return false;
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

      return false;
    }

    const toPeer = await prisma.peer.findUnique({
      where: { id: toPeerId },
    });
    if (!isCurrentSource()) return false;
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

      return false;
    }

    // Check if both peers are in the specified room
    const roomPeerIds = new Set(room.peers.map((peer) => peer.id));
    const isInRoom = roomPeerIds.has(fromPeerId) && roomPeerIds.has(toPeerId);

    return isInRoom && isCurrentSource();
  } catch (error) {
    if (isCurrentSource()) ws.terminate();

    return false;
  }
};

export const createFindRoomPeers =
  (prisma: FindRoomPeersPrisma, clients?: SocketRegistry) =>
  (
    ws: P2PartyWSClient,
    roomId: string,
    fromPeerId: string,
    toPeerId: string,
    isDescription: boolean,
    fromPeerPublicKey?: string,
  ) =>
    findRoomPeersWithClient(
      prisma,
      clients ?? wsClients,
      ws,
      roomId,
      fromPeerId,
      toPeerId,
      isDescription,
      fromPeerPublicKey,
    );

const findRoomPeers = createFindRoomPeers(sharedPrisma);

export default findRoomPeers;
