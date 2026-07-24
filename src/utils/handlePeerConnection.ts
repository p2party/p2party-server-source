import { prisma } from "../prismaClient";

import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";
import { PROTOCOL_VERSION } from "./protocolV3";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessagePeerConnectionRequest,
  WebSocketMessagePeerConnectionResponse,
} from "./interfaces";

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

    if (
      wsClient &&
      wsClient.data.isVerified &&
      wsClient.data.peerId === msg.toPeerId
    ) {
      const fromPeer = await prisma.peer.findUnique({
        // const fromPeer = await db.peer.findUnique({
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
            protocolVersion: PROTOCOL_VERSION,
          } as WebSocketMessagePeerConnectionResponse),
        );
      }

      return;
    }
  }
};

export default handlePeerConnection;
