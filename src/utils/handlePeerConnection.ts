import { prisma } from "../prismaClient";

import findRoomPeers from "./findRoomPeers";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";
import { PROTOCOL_VERSION } from "./protocolV4";

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
    const localUsable =
      wsClient !== undefined &&
      wsClient.data.isVerified &&
      wsClient.data.peerId === msg.toPeerId;

    if (localUsable || wsClient === undefined) {
      const fromPeer = await prisma.peer.findUnique({
        // const fromPeer = await db.peer.findUnique({
        where: { id: msg.fromPeerId },
      });

      if (fromPeer) {
        const request = JSON.stringify({
          type: "connection",
          roomId: msg.roomId,
          fromPeerId: msg.fromPeerId,
          fromPeerPublicKey: fromPeer.publicKey,
          labels: msg.labels,
          protocolVersion: PROTOCOL_VERSION,
        } as WebSocketMessagePeerConnectionResponse);

        // Local socket, or route to the worker that owns it. Without the
        // second path the DataChannel request never reaches most peers.
        if (localUsable) wsClient.send(request);
        else await sendToPeer(msg.toPeerId, request);
      }

      return;
    }
  }
};

export default handlePeerConnection;
