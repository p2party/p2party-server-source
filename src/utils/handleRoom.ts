import { prisma as sharedPrisma } from "../prismaClient";

import type { P2PartyWSClient } from "../wsServer.js";
import type { ProcessPrismaClient } from "../prismaClient";
import type {
  WebSocketMessageError,
  WebSocketMessageRoomIdResponse,
} from "../utils/interfaces.js";
import { PROTOCOL_VERSION } from "./protocolV3";

interface Peer {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  lastPing: bigint;
  publicKey: string;
}

type HandleRoomPrisma = Pick<ProcessPrismaClient, "peer" | "room">;

const handleRoomWithClient = async (
  prisma: HandleRoomPrisma,
  fromPeerId: string,
  ws: P2PartyWSClient,
  roomUrl: string,
) => {
  try {
    const hasher = new Bun.CryptoHasher("sha512");
    hasher.update(roomUrl);
    // hasher.digest("hex");
    const identifier = hasher.digest("hex").toLowerCase();

    // const peer = await db.peer.findUnique({
    //   where: { id: fromPeerId },
    //   include: {
    //     challenges: true,
    //   },
    // });
    //
    // if (!peer) {
    //   ws.send(
    //     JSON.stringify({
    //       type: "error",
    //       fromAction: "requestRoomId",
    //       error: {
    //         message:
    //           "Room id request was sent by a non-existing or unverified client",
    //       },
    //     } as WebSocketMessageError),
    //   );
    //
    //   ws.terminate();
    //
    //   return;
    // }

    let peer: Peer | null;
    try {
      peer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
      });

      if (
        !peer ||
        !ws.data.isVerified ||
        ws.data.peerId !== fromPeerId ||
        peer.publicKey !== ws.data.publicKey
      ) {
        ws.send(
          JSON.stringify({
            type: "error",
            fromAction: "requestRoomId",
            error: {
              message:
                "Room id request was sent by a non-existing or unverified client",
            },
          } as WebSocketMessageError),
        );

        ws.terminate();

        return;
      }
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestRoomId",
          error: {
            message:
              "Room id request was sent by a non-existing or unverified client",
          },
        } as WebSocketMessageError),
      );

      ws.terminate();

      return;
    }

    // Keep the unique room creation free of nested writes so Prisma emits one
    // native SQLite upsert instead of a find-then-create race.
    const room = await prisma.room.upsert({
      where: { identifier },
      update: { identifier },
      create: { identifier },
    });
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

    ws.send(
      JSON.stringify({
        type: "roomId",
        roomId: room.id,
        roomUrl,
        protocolVersion: PROTOCOL_VERSION,
      } as WebSocketMessageRoomIdResponse),
    );

    return;
  } catch (error) {
    console.error(error);

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
  (prisma: HandleRoomPrisma) =>
  (fromPeerId: string, ws: P2PartyWSClient, roomUrl: string) =>
    handleRoomWithClient(prisma, fromPeerId, ws, roomUrl);

const handleRoom = createHandleRoom(sharedPrisma);

export default handleRoom;
