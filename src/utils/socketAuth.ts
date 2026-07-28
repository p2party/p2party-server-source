import crypto from "node:crypto";

import { PROTOCOL_VERSION } from "./protocolV4";

export interface SocketAuthState {
  peerId: string;
  publicKey: string;
  challengeNonce: string;
  challengeId: string;
  isVerified: boolean;
  isAuthenticating: boolean;
}

export interface SocketAuthClient {
  data: SocketAuthState;
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
}

/**
 * The relay endpoints clients should try, from COTURN_URLS.
 *
 * A credential without a URL is unusable, which is what shipped before: the
 * server minted an HMAC every login and no client could act on it. Deployment
 * owns the schemes and ports, so a self-hoster can offer only `turns:` without
 * a code change. Anything that is not a turn/turns URI is dropped rather than
 * forwarded to a browser.
 */
export const parseTurnUrls = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => /^turns?:[^\s]+$/u.test(url));
};

export const assertSecureTurnSecret = (secret: string | undefined): void => {
  if (secret !== undefined && Buffer.byteLength(secret, "utf8") < 32)
    throw new Error("COTURN_SECRET must contain at least 32 bytes");
};

const isCanonicalPublicKey = (value: string): boolean =>
  /^[0-9a-f]{64}$/.test(value);
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

export const createFreshSocketChallenge = (
  state: SocketAuthState,
  peerId: string,
  publicKey: string,
  nonce = crypto.randomBytes(32).toString("hex"),
  challengeId: string = crypto.randomUUID(),
) => {
  if (!isUuid(peerId) || !isUuid(challengeId))
    throw new Error("WebSocket peer or challenge id is malformed");
  if (!isCanonicalPublicKey(publicKey))
    throw new Error("WebSocket public key is not canonical Ed25519 hex");
  if (!/^[0-9a-f]{64}$/.test(nonce))
    throw new Error("WebSocket challenge nonce is malformed");

  state.peerId = peerId;
  state.publicKey = publicKey;
  state.challengeNonce = nonce;
  state.challengeId = challengeId;
  state.isVerified = false;
  state.isAuthenticating = false;

  return {
    type: "peerId" as const,
    peerId,
    challenge: nonce,
    protocolVersion: PROTOCOL_VERSION,
    message: `Connected to WebSocket server. Your client id is ${peerId}`,
  };
};

export const isSocketChallengeBound = (
  state: SocketAuthState,
  peerId: string,
  challenge: string,
): boolean =>
  !state.isVerified &&
  !state.isAuthenticating &&
  state.peerId === peerId &&
  state.challengeNonce.length === 64 &&
  state.challengeNonce === challenge &&
  state.challengeId.length > 0 &&
  isCanonicalPublicKey(state.publicKey);

export const consumeSocketChallenge = (state: SocketAuthState): string => {
  const challengeId = state.challengeId;
  state.challengeNonce = "";
  state.challengeId = "";
  state.isAuthenticating = false;
  state.isVerified = true;
  return challengeId;
};

export const createTurnCredentials = (
  publicKey: string,
  secret: string | undefined,
  now = Date.now(),
  urls: string[] = parseTurnUrls(process.env.COTURN_URLS),
): TurnCredentials | undefined => {
  if (!secret) return undefined;
  assertSecureTurnSecret(secret);
  // No endpoint means nothing to hand out; issuing a bare HMAC would only
  // repeat the previous no-op.
  if (urls.length === 0) return undefined;

  const unixTimeStamp = Math.floor(now / 1000) + 60 * 60;
  const username = `${String(unixTimeStamp)}:${publicKey}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");

  return { urls, username, credential };
};

export const registerVerifiedSocket = <T extends SocketAuthClient>(
  clients: Map<string, T>,
  ws: T,
): boolean => {
  if (
    !ws.data.isVerified ||
    !isCanonicalPublicKey(ws.data.publicKey) ||
    !isUuid(ws.data.peerId)
  )
    return false;

  clients.set(ws.data.peerId, ws);
  return true;
};

export const unregisterSocketIfCurrent = <T extends SocketAuthClient>(
  clients: Map<string, T>,
  ws: T,
): boolean => {
  if (clients.get(ws.data.peerId) !== ws) return false;
  return clients.delete(ws.data.peerId);
};
