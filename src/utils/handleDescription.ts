import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";
import { PROTOCOL_VERSION } from "./protocolV4";

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
    const wsClient = wsClients.get(msg.toPeerId);

    if (
      wsClient &&
      wsClient.data.isVerified &&
      wsClient.data.peerId === msg.toPeerId
    ) {
      wsClient.send(
        JSON.stringify({
          type: "description",
          description: msg.description,
          fromPeerId: msg.fromPeerId,
          fromPeerPublicKey: ws.data.publicKey,
          roomId: msg.roomId,
          protocolVersion: PROTOCOL_VERSION,
          message: `Received remote description for RTCPeerConnection from client ${msg.fromPeerId} on room ${msg.roomId}`,
        } as WebSocketMessageDescriptionReceive),
      );

      return;
    }
  }
};

export default handleDescription;
