import ondemos from "@ondemos/core";

import {
  consumeSocketChallenge,
  createTurnCredentials,
  isSocketChallengeBound,
} from "./socketAuth";
import { PROTOCOL_VERSION } from "./protocolV4";

import type { P2PartyWSClient } from "../wsServer";
import type {
  WebSocketMessageError,
  WebSocketMessageSuccessfulChallenge,
} from "./interfaces";

type VerifySignature = (
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => Promise<boolean>;

export interface ChallengeVerificationOptions {
  verifySignature?: VerifySignature;
  /** `null` deliberately disables TURN even when the process env has a value. */
  turnSecret?: string | null;
  now?: number;
}

const hexBytes = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})+$/.test(value))
    throw new Error("Authentication proof is not canonical hex");
  return Uint8Array.from(
    value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
};

const rejectAuthentication = (ws: P2PartyWSClient, message: string): false => {
  ws.send(
    JSON.stringify({
      type: "error",
      fromAction: "sendChallengeResponse",
      error: { message },
    } as WebSocketMessageError),
  );
  ws.terminate();
  return false;
};

/**
 * Verify possession of the Ed25519 secret bound during this socket's open.
 *
 * The nonce and challenge id live only on this WebSocket. Historical database
 * signatures are neither read nor accepted, and successful verification
 * consumes the pending state before the socket can enter the global registry.
 */
const handleChallenge = async (
  fromPeerId: string,
  ws: P2PartyWSClient,
  challenge: string,
  signature: string,
  options: ChallengeVerificationOptions = {},
): Promise<boolean> => {
  if (!isSocketChallengeBound(ws.data, fromPeerId, challenge))
    return rejectAuthentication(
      ws,
      "Challenge is not the fresh challenge bound to this WebSocket",
    );
  if (!/^[0-9a-f]{128}$/.test(signature))
    return rejectAuthentication(ws, "Challenge signature is malformed");

  ws.data.isAuthenticating = true;
  try {
    const verification = await (options.verifySignature ?? ondemos.verify)(
      hexBytes(challenge),
      hexBytes(signature),
      hexBytes(ws.data.publicKey),
    );
    if (!verification)
      return rejectAuthentication(
        ws,
        "Challenge response signature cannot be verified",
      );

    const challengeId = consumeSocketChallenge(ws.data);
    const configuredSecret =
      options.turnSecret === null
        ? undefined
        : (options.turnSecret ?? process.env.COTURN_SECRET);
    const turnCredentials = createTurnCredentials(
      ws.data.publicKey,
      configuredSecret,
      options.now,
    );
    ws.send(
      JSON.stringify({
        type: "challenge",
        challengeId,
        protocolVersion: PROTOCOL_VERSION,
        ...turnCredentials,
      } satisfies WebSocketMessageSuccessfulChallenge),
    );

    return true;
  } catch (error) {
    ws.data.isAuthenticating = false;
    return rejectAuthentication(
      ws,
      error instanceof Error
        ? error.message
        : "Challenge response could not be verified",
    );
  }
};

export default handleChallenge;
