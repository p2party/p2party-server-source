import { prisma as sharedPrisma } from "../prismaClient";

import type { ProcessPrismaClient } from "../prismaClient";

import { wsClients } from "../wsServer";
import { releasePeer, sendToPeer, sendToPeerOnServer } from "../pubsub";
import { PROTOCOL_VERSION } from "./protocolV4";
import { describeError } from "./logError";
import {
  isCurrentVerifiedSocket,
  PERMANENT_CLOSE_CODE,
  retireClosedSocket,
  wireSocketGeneration,
} from "./socketAuth";

import type { P2PartyWSClient } from "../wsServer";
import type {
  PeerDepartureReason,
  WebSocketMessageError,
  WebSocketMessagePeerLeft,
  WebSocketMessagePeersResponse,
  WebSocketMessageConnectionRequest,
} from "../utils/interfaces";

type HandlePeersPrisma = Pick<ProcessPrismaClient, "peer" | "room">;
type SendToPeer = typeof sendToPeer;

interface HandlePeersDependencies {
  clients?: Map<string, P2PartyWSClient>;
  sendToPeer?: SendToPeer;
}

const handlePeersWithClient = async (
  prisma: HandlePeersPrisma,
  clients: Map<string, P2PartyWSClient>,
  send: SendToPeer,
  fromPeerId: string,
  ws: P2PartyWSClient,
  roomId: string,
  rosterRequestId?: string,
  excludedPeerIds: readonly string[] = [],
  targetPeerIds?: readonly string[],
) => {
  const isCurrentRequester = () =>
    ws.data.peerId === fromPeerId && isCurrentVerifiedSocket(clients, ws);

  try {
    let fromPeerPublicKey = "";
    try {
      const fromPeer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
      });

      if (!isCurrentRequester()) return;

      if (!fromPeer || fromPeer.publicKey !== ws.data.publicKey) {
        ws.send(
          JSON.stringify({
            type: "error",
            fromAction: "requestPeers",
            error: {
              message: "Peers request was sent from an unverified peer",
            },
          } as WebSocketMessageError),
        );

        // Peer rows are never deleted, and this socket already proved
        // ownership of ws.data.publicKey via the challenge, so this branch
        // means the identity claim itself is broken -- not a database fault
        // (that is the catch below) and not a race (isCurrentRequester()
        // above already confirmed this is still the current owner of
        // fromPeerId). Retrying with the same credentials cannot succeed;
        // PERMANENT_CLOSE_CODE tells the client so instead of the bare
        // close's 1005, which its reconnect ladder retries forever.
        ws.close(
          PERMANENT_CLOSE_CODE,
          "Peer identity does not match this socket",
        );

        return;
      } else fromPeerPublicKey = fromPeer.publicKey;
    } catch (error) {
      // A caught database error is a server fault, not evidence about the
      // requester. Pool exhaustion or a replica hiccup used to close a healthy
      // member's socket -- terminal on the client (C4) -- while telling it that
      // it does not exist. Refuse this one request and leave the socket up,
      // exactly as findRoomPeers now does.
      console.error("handlePeers peer lookup failed", describeError(error));
      if (!isCurrentRequester()) return;
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestPeers",
          error: {
            message:
              "Peers request from peer with id " +
              fromPeerId +
              " could not be served",
          },
        } as WebSocketMessageError),
      );

      return;
    }

    if (fromPeerPublicKey.length === 0) return;

    try {
      const room = await prisma.room.findUnique({
        // const room = await db.room.findUnique({
        where: { id: roomId },
        include: {
          peers: true,
        },
      });

      // const peers: { id: string; publicKey: string }[] = [];
      if (!room?.peers.some((peer) => peer.id === fromPeerId))
        throw new Error("Requesting peer is not a member of this room");
      if (!isCurrentRequester()) return;

      // An explicit request opts in: old clients still receive only accepted
      // peer deltas. This is membership, including offline members, not proof
      // that any listed peer accepted a connection. Send before any remote
      // delivery await so a delayed introduction cannot stale this snapshot.
      if (rosterRequestId)
        ws.send(
          JSON.stringify({
            type: "peers",
            rosterKind: "snapshot",
            rosterRequestId,
            roomId,
            peers: room.peers
              .filter((peer) => peer.id !== fromPeerId)
              .map((peer) => {
                const live = clients.get(peer.id);
                return {
                  id: peer.id,
                  publicKey: peer.publicKey,
                  ...(live &&
                  isCurrentVerifiedSocket(clients, live) &&
                  live.data.publicKey === peer.publicKey
                    ? { socketGeneration: wireSocketGeneration(live.data) }
                    : {}),
                };
              }),
            protocolVersion: PROTOCOL_VERSION,
          } satisfies WebSocketMessagePeersResponse),
        );

      const len = room?.peers.length ?? 0;
      for (let i = 0; i < len; i++) {
        if (!isCurrentRequester()) return;
        if (
          room &&
          room.peers[i] &&
          room.peers[i].id !== fromPeerId &&
          !excludedPeerIds.includes(room.peers[i].id) &&
          (targetPeerIds === undefined ||
            targetPeerIds.includes(room.peers[i].id))
        ) {
          const peer = room.peers[i];
          const introduction = JSON.stringify({
            type: "peerConnection",
            roomId,
            peer: {
              id: fromPeerId,
              publicKey: fromPeerPublicKey,
              // Names the requesting socket, so a member that was told this
              // identity departed can tell its return from a stale report.
              socketGeneration: wireSocketGeneration(ws.data),
            },
            protocolVersion: PROTOCOL_VERSION,
          } satisfies WebSocketMessageConnectionRequest);
          const peerWsClient = clients.get(peer.id);

          if (peerWsClient) {
            // No isAlive conjunct: it is false for the whole round trip of
            // every 10 s ping, and sendToPeer does not check it either, so it
            // was never a transport requirement. The pong timer is what evicts
            // a dead socket; gating here only dropped introductions silently.
            if (
              isCurrentRequester() &&
              isCurrentVerifiedSocket(clients, peerWsClient) &&
              peerWsClient.data.publicKey === peer.publicKey
            )
              peerWsClient.send(introduction);
          } else {
            // This is the introduction that makes an existing room member dial
            // the joiner when an operator explicitly enables multiple workers.
            if (!isCurrentRequester()) return;
            await send(peer.id, introduction);
          }
        }
      }

      // ws.send(
      //   JSON.stringify({
      //     type: "peers",
      //     roomId,
      //     peers,
      //   } as WebSocketMessagePeersResponse),
      // );

      return;
    } catch (error) {
      // Two unrelated causes land here and neither earns a close. One is a
      // database fault, the same server-side fault as above. The other is the
      // membership check, which a requestPeers already in flight when its peer
      // leaves and rejoins trips on a pure race: the roster is momentarily
      // missing a member whose socket is perfectly healthy. Both used to close
      // that socket and blame a room that does exist. The message stays
      // identical for both causes, so no room-existence bit is exposed.
      console.error("handlePeers room lookup failed", describeError(error));
      if (!isCurrentRequester()) return;
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestPeers",
          error: {
            message:
              "Peers request for room with id " +
              roomId +
              " could not be served",
          },
        } as WebSocketMessageError),
      );

      return;
    }
  } catch (error) {
    // If it is ever reached, only a fixed message goes to the client: the
    // caught value can be anything thrown below, such as a database driver
    // error with its codes and version.
    console.error("handlePeers failed", describeError(error));
    if (!isCurrentRequester()) return;
    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeers",
        error: { message: "Peers request could not be served" },
      } as WebSocketMessageError),
    );

    ws.close();

    return;
  }
};

export const createHandlePeers =
  (prisma: HandlePeersPrisma, dependencies: HandlePeersDependencies = {}) =>
  (
    fromPeerId: string,
    ws: P2PartyWSClient,
    roomId: string,
    rosterRequestId?: string,
    excludedPeerIds?: readonly string[],
    targetPeerIds?: readonly string[],
  ) =>
    handlePeersWithClient(
      prisma,
      dependencies.clients ?? wsClients,
      dependencies.sendToPeer ?? sendToPeer,
      fromPeerId,
      ws,
      roomId,
      rosterRequestId,
      excludedPeerIds,
      targetPeerIds,
    );

const handlePeers = createHandlePeers(sharedPrisma);

export default handlePeers;

type SendToPeerOnServer = (
  toPeerId: string,
  serverId: string,
  payload: string,
) => Promise<boolean>;

interface DepartureDependencies {
  clients?: Map<string, P2PartyWSClient>;
  sendToPeerOnServer?: SendToPeerOnServer;
}

/** A member a departure is announced to, with its routing claim. */
interface DepartureRecipient {
  id: string;
  serverId: string | null;
}

/** What one `peerLeft` frame reports. */
export interface PeerDeparture {
  peerId: string;
  /** Generation of the socket that left or closed; never empty. */
  socketGeneration: string;
  reason: PeerDepartureReason;
}

/**
 * Send one `peerLeft` frame to each online member of one room, the way relayed
 * frames travel: straight to a current socket here, through the owning
 * instance's queue for a socket held elsewhere (the claim was read with the
 * membership, so no second lookup). A member with neither is offline and gets
 * nothing. Returns how many frames were handed on.
 */
const deliverPeerLeft = async (
  clients: Map<string, P2PartyWSClient>,
  send: SendToPeerOnServer,
  roomId: string,
  departure: PeerDeparture,
  recipients: readonly DepartureRecipient[],
): Promise<number> => {
  const payload = JSON.stringify({
    type: "peerLeft",
    roomId,
    peerId: departure.peerId,
    reason: departure.reason,
    socketGeneration: departure.socketGeneration,
    protocolVersion: PROTOCOL_VERSION,
  } satisfies WebSocketMessagePeerLeft);
  let delivered = 0;
  for (const member of recipients) {
    if (member.id === departure.peerId) continue;
    const local = clients.get(member.id);
    if (local) {
      if (isCurrentVerifiedSocket(clients, local)) {
        local.send(payload);
        delivered++;
      }
      continue;
    }
    if (member.serverId && (await send(member.id, member.serverId, payload)))
      delivered++;
  }
  return delivered;
};

/**
 * Tell the other online members of `roomId` that `peerId` left it. Called by
 * the leave handler after the membership row is gone, inside that peer's
 * membership lock, so a rejoin on the same process is announced after it.
 * At most MAX_PEERS_PER_ROOM - 1 frames per leave.
 */
export const createAnnounceRoomLeave =
  (
    prisma: Pick<ProcessPrismaClient, "room">,
    dependencies: DepartureDependencies = {},
  ) =>
  async (
    roomId: string,
    peerId: string,
    socketGeneration: string,
  ): Promise<number> => {
    if (socketGeneration.length === 0) return 0;
    // Online members only (a row with a routing claim), never the leaver.
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: {
        peers: {
          where: { id: { not: peerId }, serverId: { not: null } },
          select: { id: true, serverId: true },
        },
      },
    });
    if (!room) return 0;
    return deliverPeerLeft(
      dependencies.clients ?? wsClients,
      dependencies.sendToPeerOnServer ?? sendToPeerOnServer,
      roomId,
      { peerId, socketGeneration, reason: "left" },
      room.peers,
    );
  };

/**
 * Tell the online members of every room `peerId` belongs to that it went
 * offline: one frame per member per room, at most
 * MAX_ROOMS_PER_IDENTITY * (MAX_PEERS_PER_ROOM - 1). The membership is read
 * with the identity's routing claim, after the closing socket released it:
 * a claim found here belongs to a successor socket that has already
 * committed, on this instance or another, and nothing is announced.
 */
export const createAnnounceOffline =
  (
    prisma: Pick<ProcessPrismaClient, "peer">,
    dependencies: DepartureDependencies = {},
  ) =>
  async (peerId: string, socketGeneration: string): Promise<number> => {
    if (socketGeneration.length === 0) return 0;
    const peer = await prisma.peer.findUnique({
      where: { id: peerId },
      select: {
        serverId: true,
        rooms: {
          select: {
            id: true,
            peers: {
              where: { id: { not: peerId }, serverId: { not: null } },
              select: { id: true, serverId: true },
            },
          },
        },
      },
    });
    if (!peer || peer.serverId !== null) return 0;
    const clients = dependencies.clients ?? wsClients;
    const send = dependencies.sendToPeerOnServer ?? sendToPeerOnServer;
    let delivered = 0;
    for (const room of peer.rooms)
      delivered += await deliverPeerLeft(
        clients,
        send,
        room.id,
        { peerId, socketGeneration, reason: "offline" },
        room.peers,
      );
    return delivered;
  };

interface SocketCloseDependencies {
  clients?: Map<string, P2PartyWSClient>;
  /** Release the claim by owner token; whether it cleared it (pubsub.ts). */
  release?: (peerId: string, socketGeneration: string) => Promise<boolean>;
  announceOffline?: (
    peerId: string,
    socketGeneration: string,
  ) => Promise<number>;
}

/**
 * The close handler's departure step. Retire the closed socket, and when it
 * was its identity's last socket (it was current here and its release
 * cleared the claim), announce the identity offline to its rooms, within
 * the identity's MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE.
 *
 * A socket that never authenticated, never became current, or was replaced
 * by a newer session (here or on another instance) releases nothing and
 * announces nothing. An identity in no room has no one to tell. Never
 * throws: a failed announcement is logged without identifiers.
 *
 * Returns how many frames were handed on.
 */
export const createRetireClosedSocket =
  (dependencies: SocketCloseDependencies = {}) =>
  async (ws: P2PartyWSClient): Promise<number> => {
    const clients = dependencies.clients ?? wsClients;
    if (
      !(await retireClosedSocket(
        clients,
        ws,
        dependencies.release ?? releasePeer,
      ))
    )
      return 0;
    const socketGeneration = wireSocketGeneration(ws.data);
    if (!socketGeneration) return 0;
    if (ws.data.admission && !ws.data.admission.offlineAnnouncement()) return 0;
    try {
      return await (
        dependencies.announceOffline ??
        createAnnounceOffline(sharedPrisma, { clients })
      )(ws.data.peerId, socketGeneration);
    } catch (error) {
      console.error(
        "p2party: offline announcement failed",
        describeError(error),
      );
      return 0;
    }
  };

/** This process's close-handler departure step (wsServer.ts). */
export const retireClosedSocketAndAnnounce = createRetireClosedSocket();
