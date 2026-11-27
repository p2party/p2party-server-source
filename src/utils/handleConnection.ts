import { createFreshSocketChallenge } from "./socketAuth";
import { describeError } from "./logError";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageChallengeRequest,
  WebSocketMessageError,
} from "./interfaces";

const handleConnection = (ws: P2PartyWSClient): void => {
  try {
    const request = createFreshSocketChallenge(ws.data);
    ws.send(JSON.stringify(request satisfies WebSocketMessageChallengeRequest));
  } catch (error) {
    console.error("handleConnection failed", describeError(error));
    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "requestPeerId",
        error: { message: "Could not initialize WebSocket identity" },
      } as WebSocketMessageError),
    );
    // Send only a generic error and close gracefully so it reaches the client.
    ws.close(1011, "Could not initialize WebSocket identity");
  }
};

export default handleConnection;
