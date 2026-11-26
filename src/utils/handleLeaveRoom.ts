import { prisma as sharedPrisma } from "../prismaClient";
import { wsClients } from "../wsServer";
import { PROTOCOL_VERSION } from "./protocolV4";
import { deriveRoomIdentifier } from "./roomIdentifier";
import { isCurrentVerifiedSocket } from "./socketAuth";
import { runPeerRoomMutation } from "./peerRoomMutationQueue";
import { describeError } from "./logError";
import { createAnnounceRoomLeave } from "./handlePeers";

import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";
import type { WebSocketMessageRoomLeftResponse } from "./interfaces";

type HandleLeaveRoomPrisma = Pick<ProcessPrismaClient, "peer" | "room">;
type SocketRegistry = Map<string, P2PartyWSClient>;
/** Tell the room's other online members; resolves to the frames handed on. */
type AnnounceRoomLeave = (
  roomId: string,
  peerId: string,
  socketGeneration: string,
) => Promise<number>;

const isConcurrentAlreadyAbsent = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error))
    return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2017" || code === "P2025";
};

const handleLeaveRoomWithClient = async (
  prisma: HandleLeaveRoomPrisma,
  clients: SocketRegistry,
  announce: AnnounceRoomLeave,
  fromPeerId: string,
  ws: P2PartyWSClient,
  roomUrl: string,
  roomLeaveId: string,
): Promise<void> => {
  try {
    await runPeerRoomMutation(fromPeerId, async () => {
      // The room this call removed the membership from; none when the peer
      // was not a member or a concurrent duplicate leave removed it first.
      let leftRoomId: string | undefined;
      if (
        ws.data.peerId !== fromPeerId ||
        !isCurrentVerifiedSocket(clients, ws)
      )
        throw new Error("Room leave was sent from an unauthenticated socket");

      const identifier = deriveRoomIdentifier(roomUrl);
      // The nested room filter produces the same empty result for a missing
      // room and for a real room this peer never joined. No existence bit is
      // exposed.
      const peer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
        select: {
          publicKey: true,
          rooms: {
            where: { identifier },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (
        !peer ||
        peer.publicKey !== ws.data.publicKey ||
        !isCurrentVerifiedSocket(clients, ws)
      )
        throw new Error("Room leave identity is no longer authenticated");

      if (peer.rooms.length > 0) {
        try {
          // Acknowledgement comes only after this membership link is gone. The
          // operation changes this peer only; it never deletes the room.
          await prisma.peer.update({
            where: { id: fromPeerId },
            data: {
              rooms: {
                disconnect: { id: peer.rooms[0]!.id },
              },
            },
          });
          leftRoomId = peer.rooms[0]!.id;
        } catch (error) {
          // Two identical leaves may both observe membership before the first
          // disconnect completes. The second is the same idempotent success.
          if (!isConcurrentAlreadyAbsent(error)) throw error;
        }
      }

      // A same-process replacement may authenticate during either database
      // operation. Never acknowledge on the displaced socket.
      if (!isCurrentVerifiedSocket(clients, ws))
        throw new Error(
          "Room leave socket was replaced before acknowledgement",
        );

      ws.send(
        JSON.stringify({
          type: "roomLeft",
          protocolVersion: PROTOCOL_VERSION,
          roomUrl,
          roomLeaveId,
        } satisfies WebSocketMessageRoomLeftResponse),
      );

      // Still inside this peer's membership lock and this socket's message
      // queue, so a rejoin from the same socket or the same process is
      // introduced only after these frames are handed on. The leave itself is
      // done and acknowledged: a failure here costs the members a hint, not
      // the leaver its socket.
      if (leftRoomId)
        try {
          await announce(leftRoomId, fromPeerId, ws.data.socketGeneration);
        } catch (error) {
          console.error(
            "p2party: room leave announcement failed",
            describeError(error),
          );
        }
    });
  } catch (error) {
    console.error("p2party: room leave failed closed", describeError(error));
    ws.close();
  }
};

export const createHandleLeaveRoom =
  (
    prisma: HandleLeaveRoomPrisma,
    clients?: SocketRegistry,
    announce?: AnnounceRoomLeave,
  ) =>
  (
    fromPeerId: string,
    ws: P2PartyWSClient,
    roomUrl: string,
    roomLeaveId: string,
  ) =>
    handleLeaveRoomWithClient(
      prisma,
      clients ?? wsClients,
      // Built per call, not at module load: this module and handlePeers.ts
      // import each other through wsServer.ts.
      announce ?? createAnnounceRoomLeave(prisma, { clients }),
      fromPeerId,
      ws,
      roomUrl,
      roomLeaveId,
    );

const handleLeaveRoom = createHandleLeaveRoom(sharedPrisma);

export default handleLeaveRoom;
