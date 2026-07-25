import { prisma } from "../prismaClient";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  WebSocketMessagePeersResponse,
} from "../utils/interfaces";
import findRoomPeers from "./findRoomPeers";
import { PROTOCOL_VERSION } from "./protocolV4";

const handlePeerAcceptsConnection = async (
  fromPeerId: string,
  toPeerId: string,
  roomId: string,
  ws: P2PartyWSClient,
) => {
  try {
    const allGood = await findRoomPeers(
      ws,
      roomId,
      fromPeerId,
      toPeerId,
      false,
    );

    if (!allGood) {
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestPeers",
          error: {
            message:
              "Peers' request was sent from peer with id " +
              fromPeerId +
              " who does not exist",
          },
        } as WebSocketMessageError),
      );

      ws.close();

      return;
    }

    try {
      const fromPeer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
      });

      if (
        !fromPeer ||
        !ws.data.isVerified ||
        ws.data.peerId !== fromPeerId ||
        ws.data.publicKey !== fromPeer.publicKey
      ) {
        ws.send(
          JSON.stringify({
            type: "error",
            fromAction: "requestPeers",
            error: {
              message:
                "Peers' request was sent from peer with id " +
                fromPeerId +
                " who does not exist",
            },
          } as WebSocketMessageError),
        );

        ws.close();

        return;
      }

      const introduction = JSON.stringify({
        type: "peers",
        roomId,
        peers: [{ id: fromPeerId, publicKey: fromPeer.publicKey }],
        protocolVersion: PROTOCOL_VERSION,
      } as WebSocketMessagePeersResponse);

      const peerWsClient = wsClients.get(toPeerId);
      if (peerWsClient) {
        if (
          peerWsClient.data.isAlive &&
          peerWsClient.data.isVerified &&
          peerWsClient.data.peerId === toPeerId
        )
          peerWsClient.send(introduction);
      } else {
        // The introduction is what starts the WebRTC exchange. Dropping it
        // because the peer's socket lives on another worker is why a room
        // silently fails to form.
        await sendToPeer(toPeerId, introduction);
      }

      return;
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestPeers",
          error: {
            message:
              "Peers' request was sent from peer with id " +
              fromPeerId +
              " who does not exist",
          },
        } as WebSocketMessageError),
      );

      ws.close();

      return;
    }
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeers",
        error,
      } as WebSocketMessageError),
    );

    ws.close();

    return;
  }
};

export default handlePeerAcceptsConnection;
