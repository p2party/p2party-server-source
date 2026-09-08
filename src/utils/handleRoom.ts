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

    if (isCurrent()) {
      // Every explicit throw in the mutation above ("...no longer current",
      // "...replaced before/during membership") only fires when isCurrent()
      // is already false at that throw site, and stays false here -- no
      // await separates that throw from this catch (peerRoomMutationQueue's
      // own cleanup is synchronous). The identity-mismatch throw ("...sent
      // by a non-existing or unverified client") is likewise provably
      // unreachable while isCurrent() is true: fromPeerId is already
      // ws.data.peerId, and Peer rows are never deleted or have their
      // publicKey changed after creation (the same fact d502ac0 relies on
      // for handlePeers.ts), so a peer row this exact socket already proved
      // ownership of cannot fail that lookup or that comparison. So a throw
      // reaching here with isCurrent() still true can only be a database or
      // server fault (peer.findUnique / room.upsert / room.update),
      // reaching this innocent, still-current socket. Terminating it for
      // that is exactly the defect 15af423/d502ac0/ee91b95 removed from the
      // three sibling functions -- leave it open instead.
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestRoomId",
          error,
        } as WebSocketMessageError),
      );
      return;
    }

    // Not current: this socket was already superseded (or is mid a fresh
    // authentication cycle) before or during the mutation -- a race, not a
    // fault against a live client. No frame was sent above, so there is
    // nothing terminate() can drop here.
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
