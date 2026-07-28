import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";
import { PROTOCOL_VERSION } from "./protocolV4";
import { isCurrentVerifiedSocket } from "./socketAuth";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageDescriptionSend,
  WebSocketMessageDescriptionReceive,
} from "./interfaces";

const handleDescription = async (
  ws: P2PartyWSClient,
  msg: WebSocketMessageDescriptionSend,
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
      type: "description",
      description: msg.description,
      fromPeerId: msg.fromPeerId,
      fromPeerPublicKey: ws.data.publicKey,
      roomId: msg.roomId,
      protocolVersion: PROTOCOL_VERSION,
      message: `Received remote description for RTCPeerConnection from client ${msg.fromPeerId} on room ${msg.roomId}`,
    } as WebSocketMessageDescriptionReceive);

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

export default handleDescription;
