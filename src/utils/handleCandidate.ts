import { findRoomTarget } from "./findRoomPeers";

import { wsClients } from "../wsServer";
import { sendToPeerOnServer } from "../pubsub";
import { PROTOCOL_VERSION } from "./protocolV4";
import { isCurrentVerifiedSocket } from "./socketAuth";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageCandidateSend,
  WebSocketMessageCandidateReceive,
} from "./interfaces";

interface HandleCandidateDependencies {
  clients?: Map<string, P2PartyWSClient>;
  findRoomTarget?: typeof findRoomTarget;
  sendToPeerOnServer?: (
    toPeerId: string,
    serverId: string,
    payload: string,
  ) => Promise<boolean>;
}

const handleCandidateWithDependencies = async (
  clients: Map<string, P2PartyWSClient>,
  findTarget: typeof findRoomTarget,
  send: NonNullable<HandleCandidateDependencies["sendToPeerOnServer"]>,
  ws: P2PartyWSClient,
  msg: WebSocketMessageCandidateSend,
) => {
  // One query: the target's routing claim, only if both are room members.
  const target = await findTarget(ws, msg.roomId, msg.fromPeerId, msg.toPeerId);
  if (!target) return;

  // Build once: the same bytes are either delivered locally or handed to
  // the instance that owns the target's socket.
  const payload = JSON.stringify({
    type: "candidate",
    candidate: msg.candidate,
    fromPeerId: msg.fromPeerId,
    roomId: msg.roomId,
    protocolVersion: PROTOCOL_VERSION,
    message: `Received candidate for RTCPeerConnection from client ${msg.fromPeerId}`,
  } as WebSocketMessageCandidateReceive);

  const wsClient = clients.get(msg.toPeerId);
  if (wsClient) {
    // Local socket: enforce the same checks as before. A local socket that
    // fails them is dropped rather than routed, since routing would take
    // sendToPeer's local fast path and skip exactly these checks.
    if (isCurrentVerifiedSocket(clients, wsClient)) wsClient.send(payload);
    return;
  }

  // Not on this instance. This path supports the explicit experimental
  // multi-worker topology; the owning instance verified the socket when it
  // accepted it. The membership query already read where that is.
  if (target.serverId) await send(msg.toPeerId, target.serverId, payload);
};

export const createHandleCandidate =
  (dependencies: HandleCandidateDependencies = {}) =>
  (ws: P2PartyWSClient, msg: WebSocketMessageCandidateSend) =>
    handleCandidateWithDependencies(
      dependencies.clients ?? wsClients,
      dependencies.findRoomTarget ?? findRoomTarget,
      dependencies.sendToPeerOnServer ?? sendToPeerOnServer,
      ws,
      msg,
    );

const handleCandidate = createHandleCandidate();

export default handleCandidate;
