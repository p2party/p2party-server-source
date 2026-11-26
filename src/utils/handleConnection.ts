import { createFreshSocketChallenge } from "./socketAuth";
import { provisionalPeerId } from "./peerIdentity";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageChallengeRequest,
  WebSocketMessageError,
} from "./interfaces";

/**
 * Bind a new socket to its key's peer id and send it a fresh challenge.
 *
 * The peer id is derived from the public key alone, and nothing is read from
 * the database before the signature is checked: every key, whether it has an
 * identity row or not, gets the same frame after the same work. A row an
 * older server created with another id takes the derived one at its first
 * proof (persistVerifiedIdentity).
 */
const handleConnection = async (
  publicKey: string,
  ws: P2PartyWSClient,
): Promise<string> => {
  try {
    const peerId = provisionalPeerId(publicKey);
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
    // Send only a generic error and close gracefully so it reaches the client.
    ws.close(1011, "Could not initialize WebSocket identity");
    return "";
  }
};

export default handleConnection;
