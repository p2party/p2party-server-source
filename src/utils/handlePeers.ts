import { prisma as sharedPrisma } from "../prismaClient";

import type { ProcessPrismaClient } from "../prismaClient";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";
import { PROTOCOL_VERSION } from "./protocolV4";
import {
  isCurrentVerifiedSocket,
  PERMANENT_CLOSE_CODE,
  wireSocketGeneration,
} from "./socketAuth";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
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
      console.error("handlePeers peer lookup failed", error);
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
            peer: { id: fromPeerId, publicKey: fromPeerPublicKey },
            protocolVersion: PROTOCOL_VERSION,
          } as WebSocketMessageConnectionRequest);
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
      console.error("handlePeers room lookup failed", error);
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
    console.error("handlePeers failed", error);
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
