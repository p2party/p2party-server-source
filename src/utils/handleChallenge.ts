import { loginProof, requireSignalingHost } from "./loginProof";
import { provisionalPeerId } from "./peerIdentity";
import ondemos from "@ondemos/core";

import {
  consumeSocketChallenge,
  isSocketChallengeBound,
  PERMANENT_CLOSE_CODE,
} from "./socketAuth";
import { SIGNALING_PROTOCOL_VERSION } from "./signalingProtocol";
import { describeError } from "./logError";

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
  signalingHost?: string;
  verifySignature?: VerifySignature;
}

const hexBytes = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})+$/.test(value))
    throw new Error("Authentication proof is not canonical hex");
  return Uint8Array.from(
    value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
};

/**
 * Reject one challenge/signature-response attempt.
 *
 * Only `permanent` gets `PERMANENT_CLOSE_CODE`: a signature that genuinely
 * fails to verify is the one case here that proves the client does not hold
 * the key, so retrying can never succeed. Every other caller of this
 * function is not that -- a stale/mismatched challenge also fires for a
 * legitimate duplicate or late "challenge" frame on an already-verified or
 * already-authenticating socket (not a credentials verdict at all), a
 * malformed signature encoding is a fixable client-side bug, and an
 * exception from the verification library itself could be transient -- so
 * those close bare, leaving the client's reconnect ladder free to retry.
 *
 * close(), never terminate(), in both cases: terminate() can drop the
 * ws.send() error frame above it before it reaches the wire, which is
 * exactly the frame a rejected client needs to see.
 */
const rejectAuthentication = (
  ws: P2PartyWSClient,
  message: string,
  permanent: boolean,
): false => {
  ws.send(
    JSON.stringify({
      type: "error",
      fromAction: "sendChallengeResponse",
      error: { message },
    } as WebSocketMessageError),
  );
  if (permanent) ws.close(PERMANENT_CLOSE_CODE, message);
  else ws.close();
  return false;
};

/**
 * Verify possession of the signing key supplied in the first client frame.
 *
 * The nonce and challenge id live only on this WebSocket. Historical database
 * signatures are neither read nor accepted, and successful verification
 * consumes the pending state before the socket can enter the global registry.
 */
const handleChallenge = async (
  publicKey: string,
  ws: P2PartyWSClient,
  challenge: string,
  signature: string,
  options: ChallengeVerificationOptions = {},
): Promise<WebSocketMessageSuccessfulChallenge | false> => {
  if (!isSocketChallengeBound(ws.data, challenge))
    return rejectAuthentication(
      ws,
      "Challenge is not the fresh challenge bound to this WebSocket",
      false,
    );
  if (!/^[0-9a-f]{128}$/.test(signature))
    return rejectAuthentication(ws, "Challenge signature is malformed", false);

  ws.data.isAuthenticating = true;
  try {
    const verification = await (options.verifySignature ?? ondemos.verify)(
      loginProof(
        requireSignalingHost(
          options.signalingHost ?? process.env.SIGNALING_HOST,
        ),
        challenge,
      ),
      hexBytes(signature),
      hexBytes(publicKey),
    );
    if (!verification)
      return rejectAuthentication(
        ws,
        "Challenge response signature cannot be verified",
        true,
      );

    ws.data.publicKey = publicKey;
    ws.data.peerId = provisionalPeerId(publicKey);
    return {
      type: "challenge",
      peerId: ws.data.peerId,
      challengeId: consumeSocketChallenge(ws.data),
      protocolVersion: SIGNALING_PROTOCOL_VERSION,
    } satisfies WebSocketMessageSuccessfulChallenge;
  } catch (error) {
    ws.data.isAuthenticating = false;
    // The library's own text stays in the operator log: it describes the
    // server, not the client's proof.
    console.error("Challenge verification failed", describeError(error));
    return rejectAuthentication(
      ws,
      "Challenge response could not be verified",
      false,
    );
  }
};

export default handleChallenge;
