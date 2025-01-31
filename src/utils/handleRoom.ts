import { PrismaClient } from "@prisma/client";

import type { P2PartyWSClient } from "../wsServer.js";
import type { Peer } from "@prisma/client";
import type {
  WebSocketMessageError,
  WebSocketMessageRoomIdResponse,
} from "../utils/interfaces.js";

const prisma = new PrismaClient();

const handleRoom = async (
  fromPeerId: string,
  ws: P2PartyWSClient,
  roomUrl: string,
) => {
  try {
    const hasher = new Bun.CryptoHasher("sha512");
    hasher.update(roomUrl);
    // hasher.digest("hex");
    const identifier = hasher.digest("hex").toLowerCase();

    let peer: Peer | null;
    try {
      peer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
        include: {
          challenges: true,
        },
      });

      if (!peer) {
        await prisma.$disconnect();

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
      await prisma.$disconnect();

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

    let roomId = "";
    try {
      const roomExists = await prisma.room.findUnique({
        where: { identifier },
        include: {
          peers: true,
        },
      });

      if (roomExists) {
        roomId = roomExists.id;

        if (peer && roomExists?.peers.indexOf(peer) === -1) {
          await prisma.room.update({
            where: { identifier },
            data: {
              peers: {
                connect: {
                  id: peer.id,
                },
              },
            },
          });
        }
      } else {
        const room = await prisma.room.create({
          data: {
            identifier,
            peers: {
              connect: {
                id: peer.id,
              },
            },
          },
        });

        roomId = room.id;
      }
    } catch (error) {
      const room = await prisma.room.create({
        data: {
          identifier,
          peers: {
            connect: {
              id: peer.id,
            },
          },
        },
      });

      roomId = room.id;
    }

    await prisma.$disconnect();

    ws.send(
      JSON.stringify({
        type: "roomId",
        roomId,
        roomUrl,
      } as WebSocketMessageRoomIdResponse),
    );

    return;
  } catch (error) {
    console.error(error);
    await prisma.$disconnect();

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

export default handleRoom;
