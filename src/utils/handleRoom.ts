import { createTurnCredentials } from "./socketAuth";
import { isCurrentVerifiedSocket } from "./socketAuth";
import { deriveRoomIdentifier } from "./roomIdentifier";
import {
  runMembershipMutation,
  runPeerRoomMutation,
} from "./peerRoomMutationQueue";
import { prisma as sharedPrisma } from "../prismaClient";
import { wsClients } from "../wsServer";

import type { P2PartyWSClient } from "../wsServer.js";
import type { ProcessPrismaClient } from "../prismaClient";
import type {
  WebSocketMessageError,
  WebSocketMessageRoomIdResponse,
} from "../utils/interfaces.js";
import { PROTOCOL_VERSION } from "./protocolV4";
import { admission, admissionLimits } from "./admission";

interface Peer {
  id: string;
  publicKey: string;
  rooms: { id: string }[];
  _count?: { rooms: number };
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
          _count: { select: { rooms: true } },
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

      const wasMember = peer.rooms.length > 0;
      // A new membership is charged to the socket's source key and /48 before
      // the process, but only once the join is about to be written: a refusal
      // below (full room, replaced socket) must not spend it. Checking here
      // first keeps a source with no budget left from creating room rows.
      const membershipBudget = ws.data.admission ?? admission;
      if (
        !wasMember &&
        ((peer._count?.rooms ?? 0) >= admissionLimits.roomsPerIdentity ||
          !membershipBudget.canAddMembership())
      )
        throw new Error("Room membership capacity reached");

      // Serialize different identities joining one room on the supported worker.
      // Keep the peer queue outside this lock so stale-socket compensation cannot
      // erase a successor's membership.
      await runMembershipMutation("room", identifier, async () => {
        // Keep unique room creation free of nested writes so Prisma emits one
        // atomic PostgreSQL upsert instead of a find-then-create race.
        const room = await prisma.room.upsert({
          where: { identifier },
          update: { identifier },
          create: { identifier },
          include: { _count: { select: { peers: true } } },
        });
        if (!isCurrent())
          throw new Error("Room request socket was replaced before membership");

        if (
          !wasMember &&
          (room._count?.peers ?? 0) >= admissionLimits.peersPerRoom
        )
          throw new Error("Room member capacity reached");
        if (!wasMember && !membershipBudget.newMembership())
          throw new Error("Room membership capacity reached");
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
        // short-lived and identity-bound and are issued with every join; all
        // joins of one identity inside one credential lifetime receive the
        // same credential (see createTurnCredentials).
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
    });
  } catch (error) {
    console.error(error);

    if (isCurrent()) {
      // Capacity and database failures refuse this request without stranding
      // an otherwise healthy authenticated socket.
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestRoomId",
          error: {
            message:
              "Room request could not be served or its admission limit was reached",
          },
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
