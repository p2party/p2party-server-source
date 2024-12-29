import { PrismaClient } from "@prisma/client";

import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessagePeerConnectionRequest,
  WebSocketMessagePeerConnectionResponse,
} from "./interfaces";

const prisma = new PrismaClient();

const handlePeerConnection = async (
  ws: P2PartyWSClient,
  msg: WebSocketMessagePeerConnectionRequest,
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
      const fromPeer = await prisma.peer.findUnique({
        where: { id: msg.fromPeerId },
      });

      if (fromPeer) {
        wsClient.send(
          JSON.stringify({
            type: "connection",
            roomId: msg.roomId,
            fromPeerId: msg.fromPeerId,
            fromPeerPublicKey: fromPeer.publicKey,
            labels: msg.labels,
          } as WebSocketMessagePeerConnectionResponse),
        );
      }

      return;
    }
  }
};

export default handlePeerConnection;
