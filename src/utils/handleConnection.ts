import { prisma as sharedPrisma } from "../prismaClient";
import { createFreshSocketChallenge } from "./socketAuth";
import { provisionalPeerId } from "./peerIdentity";

import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageChallengeRequest,
  WebSocketMessageError,
} from "./interfaces";

type HandleConnectionPrisma = Pick<ProcessPrismaClient, "peer">;

const handleConnectionWithClient = async (
  prisma: HandleConnectionPrisma,
  publicKey: string,
  ws: P2PartyWSClient,
): Promise<string> => {
  try {
    if (!/^[0-9a-f]{64}$/.test(publicKey))
      throw new Error("Invalid Ed25519 public key");

    // The database binds one stable peer id to the identity public key. Socket
    // authentication is deliberately NOT restored from the peer's historical
    // challenge rows: every connection receives a new in-memory nonce.
    const peer = await prisma.peer.findUnique({
      where: { publicKey },
      select: { id: true },
    });

    const peerId = peer?.id ?? provisionalPeerId(publicKey);
    const request = createFreshSocketChallenge(ws.data, peerId, publicKey);
    ws.send(JSON.stringify(request satisfies WebSocketMessageChallengeRequest));

    return peerId;
  } catch (error) {
    console.error("handleConnection failed", error);
    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeerId",
        error: { message: "Could not initialize WebSocket identity" },
      } as WebSocketMessageError),
    );
    // A bootstrap lookup fault is retryable. Send only a generic error and
    // close gracefully so it reaches the client before reconnect.
    ws.close(1011, "Could not initialize WebSocket identity");
    return "";
  }
};

export const createHandleConnection =
  (prisma: HandleConnectionPrisma) =>
  (publicKey: string, ws: P2PartyWSClient) =>
    handleConnectionWithClient(prisma, publicKey, ws);

const handleConnection = createHandleConnection(sharedPrisma);

export default handleConnection;
