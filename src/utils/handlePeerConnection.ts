import { prisma as sharedPrisma } from "../prismaClient";

import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";
import { SIGNALING_PROTOCOL_VERSION } from "./signalingProtocol";
import { isCurrentVerifiedSocket, wireSocketGeneration } from "./socketAuth";

import type { P2PartyWSClient } from "../wsServer";
import type { ProcessPrismaClient } from "../prismaClient";
import type {
  WebSocketMessagePeerConnectionRequest,
  WebSocketMessagePeerConnectionResponse,
} from "./interfaces";

type HandlePeerConnectionPrisma = Pick<ProcessPrismaClient, "peer">;
type FindRoomPeers = typeof findRoomPeers;
type SendToPeer = typeof sendToPeer;

interface HandlePeerConnectionDependencies {
  clients?: Map<string, P2PartyWSClient>;
  findRoomPeers?: FindRoomPeers;
  sendToPeer?: SendToPeer;
}

const handlePeerConnectionWithClient = async (
  prisma: HandlePeerConnectionPrisma,
  clients: Map<string, P2PartyWSClient>,
  findPeers: FindRoomPeers,
  send: SendToPeer,
  ws: P2PartyWSClient,
  msg: WebSocketMessagePeerConnectionRequest,
) => {
  const infoChecksOut = await findPeers(
    ws,
    msg.roomId,
    msg.fromPeerId,
    msg.toPeerId,
  );

  if (infoChecksOut) {
    const fromPeer = await prisma.peer.findUnique({
      where: { id: msg.fromPeerId },
    });
    if (
      !fromPeer ||
      ws.data.peerId !== msg.fromPeerId ||
      ws.data.publicKey !== fromPeer.publicKey ||
      !isCurrentVerifiedSocket(clients, ws)
    )
      return;

    const request = JSON.stringify({
      type: "connection",
      roomId: msg.roomId,
      fromPeerId: msg.fromPeerId,
      fromPeerPublicKey: fromPeer.publicKey,
      // Names the dialling socket, so a target holding a transport bound to a
      // replaced session for this same peerId can retire it (C1). Omitted
      // rather than sent as "" when this socket has no generation yet -- see
      // wireSocketGeneration's doc comment.
      fromPeerSocketGeneration: wireSocketGeneration(ws.data),
      labels: msg.labels,
      protocolVersion: SIGNALING_PROTOCOL_VERSION,
    } as WebSocketMessagePeerConnectionResponse);

    // Resolve after every await. A target that was current before the peer
    // query may have been synchronously replaced while the query was pending.
    const target = clients.get(msg.toPeerId);
    if (target) {
      if (isCurrentVerifiedSocket(clients, target)) target.send(request);
      return;
    }

    // No local entry means the target may live on another worker.
    await send(msg.toPeerId, request);
  }
};

export const createHandlePeerConnection = (
  prisma: HandlePeerConnectionPrisma,
  dependencies: HandlePeerConnectionDependencies = {},
) => {
  return (ws: P2PartyWSClient, msg: WebSocketMessagePeerConnectionRequest) =>
    handlePeerConnectionWithClient(
      prisma,
      dependencies.clients ?? wsClients,
      dependencies.findRoomPeers ?? findRoomPeers,
      dependencies.sendToPeer ?? sendToPeer,
      ws,
      msg,
    );
};

const handlePeerConnection = createHandlePeerConnection(sharedPrisma);

export default handlePeerConnection;
