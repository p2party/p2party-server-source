import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";
import { PROTOCOL_VERSION } from "./protocolV4";
import { isCurrentVerifiedSocket } from "./socketAuth";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageCandidateSend,
  WebSocketMessageCandidateReceive,
} from "./interfaces";

const handleCandidate = async (
  ws: P2PartyWSClient,
  msg: WebSocketMessageCandidateSend,
) => {
  const infoChecksOut = await findRoomPeers(
    ws,
    msg.roomId,
    msg.fromPeerId,
    msg.toPeerId,
    false,
  );

  if (infoChecksOut) {
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

    const wsClient = wsClients.get(msg.toPeerId);
    if (wsClient) {
      // Local socket: enforce the same checks as before. A local socket that
      // fails them is dropped rather than routed, since routing would take
      // sendToPeer's local fast path and skip exactly these checks.
      if (isCurrentVerifiedSocket(wsClients, wsClient)) wsClient.send(payload);
      return;
    }

    // Not on this instance. This path supports the explicit experimental
    // multi-worker topology; the owning instance verified the socket when it
    // accepted it.
    await sendToPeer(msg.toPeerId, payload);
  }
};

export default handleCandidate;
