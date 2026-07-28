import { prisma as sharedPrisma } from "../prismaClient";

import { wsClients } from "../wsServer";
import { sendToPeer } from "../pubsub";

import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  WebSocketMessagePeersResponse,
} from "../utils/interfaces";
import findRoomPeers from "./findRoomPeers";
import { PROTOCOL_VERSION } from "./protocolV4";
import { isCurrentVerifiedSocket } from "./socketAuth";

type HandlePeerAcceptsConnectionPrisma = Pick<ProcessPrismaClient, "peer">;
type FindRoomPeers = typeof findRoomPeers;
type SendToPeer = typeof sendToPeer;

interface HandlePeerAcceptsConnectionDependencies {
  clients?: Map<string, P2PartyWSClient>;
  findRoomPeers?: FindRoomPeers;
  sendToPeer?: SendToPeer;
}

const handlePeerAcceptsConnectionWithClient = async (
  prisma: HandlePeerAcceptsConnectionPrisma,
  clients: Map<string, P2PartyWSClient>,
  findPeers: FindRoomPeers,
  send: SendToPeer,
  fromPeerId: string,
  toPeerId: string,
  roomId: string,
  ws: P2PartyWSClient,
) => {
  const isCurrentSource = () =>
    ws.data.peerId === fromPeerId && isCurrentVerifiedSocket(clients, ws);

  try {
    const allGood = await findPeers(ws, roomId, fromPeerId, toPeerId, false);

    if (!isCurrentSource()) return;
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

      if (!isCurrentSource()) return;
      if (!fromPeer || ws.data.publicKey !== fromPeer.publicKey) {
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

      const peerWsClient = clients.get(toPeerId);
      if (peerWsClient) {
        if (
          peerWsClient.data.isAlive &&
          isCurrentVerifiedSocket(clients, peerWsClient)
        )
          peerWsClient.send(introduction);
      } else {
        // The introduction is what starts the WebRTC exchange. Dropping it
        // because the peer's socket lives on another worker is why a room
        // silently fails to form.
        await send(toPeerId, introduction);
      }

      return;
    } catch (error) {
      if (!isCurrentSource()) return;
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
    if (!isCurrentSource()) return;
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

export const createHandlePeerAcceptsConnection = (
  prisma: HandlePeerAcceptsConnectionPrisma,
  dependencies: HandlePeerAcceptsConnectionDependencies = {},
) => {
  return (
    fromPeerId: string,
    toPeerId: string,
    roomId: string,
    ws: P2PartyWSClient,
  ) =>
    handlePeerAcceptsConnectionWithClient(
      prisma,
      dependencies.clients ?? wsClients,
      dependencies.findRoomPeers ?? findRoomPeers,
      dependencies.sendToPeer ?? sendToPeer,
      fromPeerId,
      toPeerId,
      roomId,
      ws,
    );
};

const handlePeerAcceptsConnection =
  createHandlePeerAcceptsConnection(sharedPrisma);

export default handlePeerAcceptsConnection;
