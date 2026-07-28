import { consumeProofOwnerPong } from "./handlePong";
import { enqueueSocketMessage } from "./socketMessageQueue";

import type { P2PartyWSClient, P2PartyWSMsg } from "../wsServer";

export const handleSocketMessageIngress = (
  clients: Map<string, P2PartyWSClient>,
  ws: P2PartyWSClient,
  message: P2PartyWSMsg,
  handle: (ws: P2PartyWSClient, message: P2PartyWSMsg) => Promise<void>,
): Promise<void> => {
  if (consumeProofOwnerPong(clients, ws, message)) return Promise.resolve();
  return enqueueSocketMessage(ws, message, handle);
};
