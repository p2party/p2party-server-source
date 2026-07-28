import { createTurnCredentials } from "./socketAuth";
import { isCurrentVerifiedSocket } from "./socketAuth";
import { deriveRoomIdentifier } from "./roomIdentifier";
import { runPeerRoomMutation } from "./peerRoomMutationQueue";
import { prisma as sharedPrisma } from "../prismaClient";
import { wsClients } from "../wsServer";

import type { P2PartyWSClient } from "../wsServer.js";
import type { ProcessPrismaClient } from "../prismaClient";
import type {
  WebSocketMessageError,
  WebSocketMessageRoomIdResponse,
} from "../utils/interfaces.js";
import { PROTOCOL_VERSION } from "./protocolV4";

interface Peer {
  id: string;
  publicKey: string;
  rooms: { id: string }[];
}

type HandleRoomPrisma = Pick<ProcessPrismaClient, "peer" | "room">;
type SocketRegistry = Map<string, P2PartyWSClient>;

const handleRoomWithClient = async (
  prisma: HandleRoomPrisma,
  clients: SocketRegistry,
  fromPeerId: string,
  ws: P2PartyWSClient,
  roomUrl: string,
  roomRequestId: string,
) => {
  const isCurrent = () =>
    ws.data.peerId === fromPeerId && isCurrentVerifiedSocket(clients, ws);

  try {
    await runPeerRoomMutation(fromPeerId, async () => {
      if (!isCurrent())
        throw new Error("Room request socket is no longer current");

      const identifier = deriveRoomIdentifier(roomUrl);
      const peer: Peer | null = await prisma.peer.findUnique({
        where: { id: fromPeerId },
        select: {
          id: true,
          publicKey: true,
          rooms: {
            where: { identifier },
            select: { id: true },
            take: 1,
          },
        },
      });

      if (!peer || peer.publicKey !== ws.data.publicKey || !isCurrent())
        throw new Error(
          "Room id request was sent by a non-existing or unverified client",
        );

      // Keep unique room creation free of nested writes so Prisma emits one
      // atomic PostgreSQL upsert instead of a find-then-create race.
      const room = await prisma.room.upsert({
        where: { identifier },
        update: { identifier },
        create: { identifier },
      });
      if (!isCurrent())
        throw new Error("Room request socket was replaced before membership");

      const wasMember = peer.rooms.length > 0;
      await prisma.room.update({
        where: { id: room.id },
        data: {
          peers: {
            connect: {
              id: peer.id,
            },
          },
        },
      });

      if (!isCurrent()) {
        // The same-process peer mutation queue prevents a successor join from
        // racing this compensation. Preserve membership that predated this
        // request; remove only a link this stale request could have added.
        if (!wasMember)
          await prisma.room.update({
            where: { id: room.id },
            data: { peers: { disconnect: { id: peer.id } } },
          });
        throw new Error("Room request socket was replaced during membership");
      }

      // The relay endpoint travels with the room response because that is
      // where the client builds its RTCConfiguration. Credentials are
      // short-lived and socket-identity-bound, so they are issued per join.
      const turnCredentials = createTurnCredentials(
        ws.data.publicKey,
        process.env.COTURN_SECRET,
      );

      ws.send(
        JSON.stringify({
          type: "roomId",
          roomId: room.id,
          roomUrl,
          roomRequestId,
          protocolVersion: PROTOCOL_VERSION,
          ...(turnCredentials ? { turnCredentials } : {}),
        } satisfies WebSocketMessageRoomIdResponse),
      );
    });
  } catch (error) {
    console.error(error);

    if (isCurrent())
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestRoomId",
          error,
        } as WebSocketMessageError),
      );

    ws.terminate();
  }
};

export const createHandleRoom =
  (prisma: HandleRoomPrisma, clients?: SocketRegistry) =>
  (
    fromPeerId: string,
    ws: P2PartyWSClient,
    roomUrl: string,
    roomRequestId: string,
  ) =>
    handleRoomWithClient(
      prisma,
      clients ?? wsClients,
      fromPeerId,
      ws,
      roomUrl,
      roomRequestId,
    );

const handleRoom = createHandleRoom(sharedPrisma);

export default handleRoom;
