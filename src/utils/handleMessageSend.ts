import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageMessageSendRequest,
  WebSocketMessageMessageSendResponse,
} from "./interfaces";

const handleMessageSend = async (
  ws: P2PartyWSClient,
  msg: WebSocketMessageMessageSendRequest,
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

    if (wsClient) {
      wsClient.send(
        JSON.stringify({
          type: "message",
          message: msg.message,
          roomId: msg.roomId,
          fromPeerId: msg.fromPeerId,
          label: msg.label,
        } as WebSocketMessageMessageSendResponse),
      );

      return;
    }
  }
};

export default handleMessageSend;
