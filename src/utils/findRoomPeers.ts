import { prisma as sharedPrisma } from "../prismaClient";

import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";
import { wsClients } from "../wsServer";
import { isCurrentVerifiedSocket } from "./socketAuth";
import { describeError } from "./logError";

type FindRoomPeersPrisma = Pick<ProcessPrismaClient, "peer">;
type SocketRegistry = Map<string, P2PartyWSClient>;

/** The target of a relayed frame, found as a member of the sender's room. */
export interface RoomTarget {
  /** The process holding the target's socket, or null when it holds none. */
  serverId: string | null;
}

/**
 * Find `toPeerId` as a member of `roomId`, for a frame `ws` relays to it.
 *
 * One query, through the primary keys of Peer and `_PeerRooms`: the target's
 * row, returned only when the target is a member of the room and the sending
 * socket's identity (its peer id and the key it proved) is a member too. It
 * loads the target's routing claim and nothing of the room's membership.
 *
 * Every refusal is the same silent undefined: a sender cannot tell a missing
 * room from a missing target, or either from a target in another room, so it
 * cannot use a relay to test whether a key ever registered. A database fault
 * is a server fault, so it refuses this one frame and leaves the socket up.
 */
const findRoomTargetWithClient = async (
  prisma: FindRoomPeersPrisma,
  clients: SocketRegistry,
  ws: P2PartyWSClient,
  roomId: string,
  fromPeerId: string,
  toPeerId: string,
): Promise<RoomTarget | undefined> => {
  const isCurrentSource = () =>
    ws.data.peerId === fromPeerId &&
    ws.data.publicKey.length === 64 &&
    isCurrentVerifiedSocket(clients, ws);

  try {
    if (!isCurrentSource()) return undefined;

    const target = await prisma.peer.findFirst({
      where: {
        id: toPeerId,
        rooms: {
          some: {
            id: roomId,
            peers: { some: { id: fromPeerId, publicKey: ws.data.publicKey } },
          },
        },
      },
      select: { serverId: true },
    });

    return target && isCurrentSource() ? target : undefined;
  } catch (error) {
    console.error("findRoomPeers failed", describeError(error));

    return undefined;
  }
};

export const createFindRoomTarget =
  (prisma: FindRoomPeersPrisma, clients?: SocketRegistry) =>
  (ws: P2PartyWSClient, roomId: string, fromPeerId: string, toPeerId: string) =>
    findRoomTargetWithClient(
      prisma,
      clients ?? wsClients,
      ws,
      roomId,
      fromPeerId,
      toPeerId,
    );

/** Whether the sender and `toPeerId` are both members of `roomId`. */
export const createFindRoomPeers = (
  prisma: FindRoomPeersPrisma,
  clients?: SocketRegistry,
) => {
  const findTarget = createFindRoomTarget(prisma, clients);
  return async (
    ws: P2PartyWSClient,
    roomId: string,
    fromPeerId: string,
    toPeerId: string,
  ): Promise<boolean> =>
    (await findTarget(ws, roomId, fromPeerId, toPeerId)) !== undefined;
};

export const findRoomTarget = createFindRoomTarget(sharedPrisma);

const findRoomPeers = createFindRoomPeers(sharedPrisma);

export default findRoomPeers;
