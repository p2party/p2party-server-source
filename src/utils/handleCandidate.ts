import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";

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
    const wsClient = wsClients.get(msg.toPeerId);

    if (wsClient) {
      wsClient.send(
        JSON.stringify({
          type: "candidate",
          candidate: msg.candidate,
          fromPeerId: msg.fromPeerId,
          // fromPeerPublicKey: fromPeer.publicKey,
          // roomId: room.id,
          message: `Received candidate for RTCPeerConnection from client ${msg.fromPeerId}`,
        } as WebSocketMessageCandidateReceive),
      );

      return;
    }
  }
};

export default handleCandidate;
