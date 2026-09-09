import { isUUID } from "./formats";

import { isCurrentProofOwnerSocket } from "./socketAuth";

import type { P2PartyWSClient, P2PartyWSMsg } from "../wsServer";
import type { WebSocketMessagePong } from "./interfaces";

const MAX_EXACT_PONG_CHARS = 128;

export const isExactPongMessage = (
  value: unknown,
): value is WebSocketMessagePong => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === 2 &&
    keys.every((key) => key === "type" || key === "fromPeerId") &&
    candidate.type === "pong" &&
    typeof candidate.fromPeerId === "string" &&
    isUUID(candidate.fromPeerId)
  );
};

const parseExactPong = (
  message: P2PartyWSMsg,
): WebSocketMessagePong | undefined => {
  if (typeof message !== "string" || message.length > MAX_EXACT_PONG_CHARS)
    return undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    return isExactPongMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Heartbeats bypass slow signaling work only after cryptographic proof and
 * exact process-local ownership. Routing-claim activation may still be in
 * flight; unlike application signaling, pong must keep that proved transport
 * alive while the claim completes.
 */
export const consumeProofOwnerPong = (
  clients: Map<string, P2PartyWSClient>,
  ws: P2PartyWSClient,
  message: P2PartyWSMsg,
): boolean => {
  const pong = parseExactPong(message);
  if (
    !pong ||
    pong.fromPeerId !== ws.data.peerId ||
    !isCurrentProofOwnerSocket(clients, ws)
  )
    return false;

  ws.data.isAlive = true;
  if (ws.data.pongTimeout) clearTimeout(ws.data.pongTimeout);
  ws.data.pongTimeout = undefined;
  return true;
};
