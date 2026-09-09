import { consumeProofOwnerPong } from "./handlePong";
import { enqueueSocketMessage } from "./socketMessageQueue";

import type { P2PartyWSClient, P2PartyWSMsg } from "../wsServer";

export const handleSocketMessageIngress = (
  clients: Map<string, P2PartyWSClient>,
  ws: P2PartyWSClient,
  message: P2PartyWSMsg,
  handle: (ws: P2PartyWSClient, message: P2PartyWSMsg) => Promise<void>,
): Promise<void> => {
  if (ws.data.admission && !ws.data.admission.message()) {
    ws.close(1013, "Signaling message rate exceeded");
    return Promise.resolve();
  }
  if (consumeProofOwnerPong(clients, ws, message)) return Promise.resolve();
  return enqueueSocketMessage(ws, message, handle);
};
