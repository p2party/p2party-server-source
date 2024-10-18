import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";

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
    msg.fromPeerPublicKey,
  );

  console.log(infoChecksOut);

  if (infoChecksOut) {
    const wsClient = wsClients.get(msg.toPeerId);

    if (wsClient) {
      wsClient.send(
        JSON.stringify({
          type: "description",
          description: msg.description,
          fromPeerId: msg.fromPeerId,
          fromPeerPublicKey: msg.fromPeerPublicKey,
          roomId: msg.roomId,
          message: `Received remote description for RTCPeerConnection from client ${msg.fromPeerId}`,
        } as WebSocketMessageDescriptionReceive),
      );

      return;
    }
  }
};

export default handleDescription;
