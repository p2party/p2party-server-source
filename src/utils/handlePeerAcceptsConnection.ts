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
import { SIGNALING_PROTOCOL_VERSION } from "./signalingProtocol";
import { isCurrentVerifiedSocket, wireSocketGeneration } from "./socketAuth";
import { peerLogTag } from "./logTag";
import { describeError } from "./logError";

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
    const allGood = await findPeers(ws, roomId, fromPeerId, toPeerId);

    if (!isCurrentSource()) return;
    if (!allGood) {
      // The joiner left between its introduction and this acceptance. That is
      // a race, not a protocol violation by the acceptor — handlePeerConnection
      // drops the identical condition silently. Closing the acceptor's socket
      // here left a live member with no signaling and no wake event (C4).
      // findRoomPeers returns false without logging on its membership path, so
      // without this line the whole branch is invisible to the operator too.
      console.warn(
        "peer acceptance dropped: no current room pair for " +
          peerLogTag(fromPeerId) +
          " -> " +
          peerLogTag(toPeerId),
      );

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

        return;
      }

      const introduction = JSON.stringify({
        type: "peers",
        rosterKind: "delta",
        roomId,
        peers: [
          {
            id: fromPeerId,
            publicKey: fromPeer.publicKey,
            // Names the acceptor's current socket. Without it the joiner
            // cannot tell this introduction from one sent by the session it
            // already holds a transport to (C1). Omitted rather than sent as
            // "" when this socket has no generation yet -- see
            // wireSocketGeneration's doc comment.
            socketGeneration: wireSocketGeneration(ws.data),
          },
        ],
        protocolVersion: SIGNALING_PROTOCOL_VERSION,
      } as WebSocketMessagePeersResponse);

      const peerWsClient = clients.get(toPeerId);
      if (peerWsClient) {
        // Same as handlePeers: the ping-to-pong window is not a liveness
        // verdict, and this is the frame that starts the WebRTC exchange.
        if (isCurrentVerifiedSocket(clients, peerWsClient))
          peerWsClient.send(introduction);
      } else {
        // The introduction is what starts the WebRTC exchange. Dropping it
        // because the peer's socket lives on another worker is why a room
        // silently fails to form.
        await send(toPeerId, introduction);
      }

      return;
    } catch (error) {
      // A caught database error is a server fault, not evidence about the
      // acceptor. Pool exhaustion or a replica hiccup used to close the
      // acceptor's socket -- terminal on the client (C4) -- while telling it
      // that it does not exist. Refuse this one acceptance and leave the
      // socket up, exactly as handlePeers now does.
      console.error(
        "handlePeerAcceptsConnection peer lookup failed",
        describeError(error),
      );
      if (!isCurrentSource()) return;
      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "requestPeers",
          error: {
            message:
              "Peers request from peer with id " +
              fromPeerId +
              " could not be served",
          },
        } as WebSocketMessageError),
      );

      return;
    }
  } catch (error) {
    // Provably unreachable: every fallible call in this outer try is inside
    // the inner try/catch above. findPeers (findRoomPeers) already catches
    // its own database faults and returns false rather than throwing,
    // isCurrentSource() is a plain field comparison, and the !allGood branch
    // above only logs and returns. JSON.stringify below is safe because
    // fromPeerId and roomId are isUUID()-validated before this function is
    // ever called (handleMessage.ts:209-211); Bun's ws.send returns a status
    // number instead of throwing; and sendToPeer is explicitly non-throwing.
    // If a future edit adds a fallible call out here, it is silently
    // reviving the close-an-innocent-socket defect this file was fixed for
    // -- put new fallible calls inside the inner try/catch instead.
    // If it is ever reached, only a fixed message goes to the client: the
    // caught value can be anything thrown below, such as a database driver
    // error with its codes and version.
    console.error("handlePeerAcceptsConnection failed", describeError(error));
    if (!isCurrentSource()) return;
    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeers",
        error: { message: "Peers request could not be served" },
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
