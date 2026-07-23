import { PrismaClient } from "../prismaClient";
import { createFreshSocketChallenge } from "./socketAuth";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageChallengeRequest,
  WebSocketMessageError,
} from "./interfaces";

const prisma = new PrismaClient();

const handleConnection = async (
  publicKey: string,
  ws: P2PartyWSClient,
): Promise<string> => {
  try {
    if (!/^[0-9a-f]{64}$/.test(publicKey))
      throw new Error("Invalid Ed25519 public key");

    // The database binds one stable peer id to the identity public key. Socket
    // authentication is deliberately NOT restored from the peer's historical
    // challenge rows: every connection receives a new in-memory nonce.
    const peer = await prisma.peer.upsert({
      where: { publicKey },
      update: {
        lastPing: Date.now(),
      },
      create: {
        lastPing: Date.now(),
        publicKey,
      },
    });

    const request = createFreshSocketChallenge(ws.data, peer.id, publicKey);
    ws.send(JSON.stringify(request satisfies WebSocketMessageChallengeRequest));

    return peer.id;
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeerId",
        error:
          error instanceof Error
            ? { message: error.message }
            : { message: "Could not initialize WebSocket identity" },
      } as WebSocketMessageError),
    );
    ws.terminate();
    return "";
  }
};

export default handleConnection;
