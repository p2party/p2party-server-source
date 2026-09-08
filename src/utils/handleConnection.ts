import { prisma as sharedPrisma } from "../prismaClient";
import { createFreshSocketChallenge } from "./socketAuth";

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
    console.error("handleConnection failed", error);
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
    // close(), not terminate(): terminate() can drop the send() above before
    // it reaches the wire. 1011 ("handler failed"), matching the code
    // socketMessageQueue.ts already uses for an unexpected handler
    // exception -- not the bare close this used to send, and never
    // PERMANENT_CLOSE_CODE (1008): the malformed-public-key branch above is
    // provably unreachable here (wsServer.ts's fetch handler already
    // rejects any publicKey that fails this exact regex before the
    // WebSocket is ever upgraded, so ws.data.publicKey is always canonical
    // by the time `open` calls this function), so the only realistically
    // reachable cause of this catch is prisma.peer.upsert throwing -- the
    // same database/server-fault class 15af423/d502ac0/ee91b95 fixed
    // elsewhere. Unlike those three sites, though, there is no live,
    // keepalive'd connection to leave open: the ping loop only starts once
    // this function returns a real peer id, and there is no message-level
    // retry for the initial identity handshake, so the client's only path
    // forward is a fresh connection. 1011 tells its reconnect ladder to
    // make one instead of retrying a bare 1005 forever against a socket
    // that can never move past this point.
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
