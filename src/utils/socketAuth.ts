import crypto from "node:crypto";

import { PROTOCOL_VERSION } from "./protocolV4";

export interface SocketAuthState {
  peerId: string;
  publicKey: string;
  challengeNonce: string;
  challengeId: string;
  /**
   * Identifies THIS socket for the whole of its authenticated life.
   *
   * The database binds one stable peerId to an identity public key, so a
   * second tab or a phrase-restored second device reconnects as the same
   * peerId and evicts its predecessor with a bare close() that nothing is
   * told about. Peers therefore had no way to learn that "peerId X" was now a
   * different session and kept a transport bound to the evicted one forever
   * (C1). The verified challenge id is already fresh per socket; it is
   * preserved here rather than re-randomised.
   *
   * Empty until this socket proves ownership of the key, and empty again
   * whenever a fresh challenge is issued on it.
   */
  socketGeneration: string;
  isVerified: boolean;
  isAuthenticating: boolean;
}

export interface SocketAuthClient {
  data: SocketAuthState;
}

export interface CurrentSocketAuthClient extends SocketAuthClient {
  readyState: number;
}

export interface ReplaceableSocketAuthClient extends CurrentSocketAuthClient {
  close: () => unknown;
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  expiresAtUnixSeconds: number;
}

export const TURN_CREDENTIAL_CONTRACT = Object.freeze({
  maxUrls: 16,
  maxUrlChars: 2048,
  maxCredentialChars: 256,
  lifetimeSeconds: 60 * 60,
});

const normalizeTurnUrls = (urls: readonly unknown[]): string[] => {
  const uniqueUrls = new Set<string>();

  for (const value of urls) {
    if (typeof value !== "string") continue;
    const url = value.trim();
    if (
      url.length === 0 ||
      url.length > TURN_CREDENTIAL_CONTRACT.maxUrlChars ||
      !/^turns?:[^\s]+$/u.test(url)
    )
      continue;

    uniqueUrls.add(url);
    if (uniqueUrls.size === TURN_CREDENTIAL_CONTRACT.maxUrls) break;
  }

  return [...uniqueUrls];
};

/**
 * The relay endpoints clients should try, from COTURN_URLS.
 *
 * A credential without a URL is unusable, which is what shipped before: the
 * server minted an HMAC every login and no client could act on it. Deployment
 * owns the schemes and ports, so a self-hoster can offer only `turns:` without
 * a code change. Anything that is not a turn/turns URI is dropped rather than
 * forwarded to a browser. Duplicates and values beyond the SDK's closed wire
 * bounds are removed here, before a credential object can be issued.
 */
export const parseTurnUrls = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return normalizeTurnUrls(raw.split(","));
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
  // An unproven socket has no generation: the value only becomes meaningful,
  // and only reaches the wire, once this socket has answered the challenge.
  state.socketGeneration = "";
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
  // Kept as this socket's generation: it is a fresh UUIDv4 per socket and the
  // only value in this state that is already unique per connection.
  state.socketGeneration = challengeId;
  state.isAuthenticating = false;
  state.isVerified = true;
  return challengeId;
};

export const createTurnCredentials = (
  publicKey: string,
  secret: string | undefined,
  now = Date.now(),
  urls: readonly string[] = parseTurnUrls(process.env.COTURN_URLS),
): TurnCredentials | undefined => {
  if (!secret) return undefined;
  assertSecureTurnSecret(secret);
  const boundedUrls = normalizeTurnUrls(urls);
  // No endpoint means nothing to hand out; issuing a bare HMAC would only
  // repeat the previous no-op.
  if (boundedUrls.length === 0) return undefined;
  if (!isCanonicalPublicKey(publicKey))
    throw new Error("TURN username public key is not canonical Ed25519 hex");

  const nowUnixSeconds = Math.floor(now / 1000);
  const unixTimeStamp =
    nowUnixSeconds + TURN_CREDENTIAL_CONTRACT.lifetimeSeconds;
  if (
    !Number.isSafeInteger(nowUnixSeconds) ||
    nowUnixSeconds < 0 ||
    !Number.isSafeInteger(unixTimeStamp) ||
    unixTimeStamp < 1 ||
    String(unixTimeStamp).length > 11
  )
    throw new Error("TURN credential timestamp is outside the wire contract");

  const username = `${String(unixTimeStamp)}:${publicKey}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  if (
    username.length > TURN_CREDENTIAL_CONTRACT.maxCredentialChars ||
    credential.length === 0 ||
    credential.length > TURN_CREDENTIAL_CONTRACT.maxCredentialChars
  )
    throw new Error("Generated TURN credential exceeds the wire contract");

  return {
    urls: boundedUrls,
    username,
    credential,
    expiresAtUnixSeconds: unixTimeStamp,
  };
};

export const registerVerifiedSocket = <T extends ReplaceableSocketAuthClient>(
  clients: Map<string, T>,
  ws: T,
): boolean => {
  if (
    !ws.data.isVerified ||
    !isCanonicalPublicKey(ws.data.publicKey) ||
    !isUuid(ws.data.peerId)
  )
    return false;

  const predecessor = clients.get(ws.data.peerId);
  clients.set(ws.data.peerId, ws);
  if (predecessor && predecessor !== ws) {
    // Change ownership before close() can schedule the predecessor's close
    // callback. That callback is identity-guarded and cannot evict this
    // successor. Clearing authentication first also makes every stale frame
    // fail while the transport finishes closing.
    predecessor.data.isVerified = false;
    predecessor.close();
  }
  return true;
};

export const isCurrentProofOwnerSocket = <T extends CurrentSocketAuthClient>(
  clients: Map<string, T>,
  ws: T,
): boolean =>
  ws.readyState === 1 &&
  ws.data.isVerified === true &&
  clients.get(ws.data.peerId) === ws;

export const isCurrentVerifiedSocket = <T extends CurrentSocketAuthClient>(
  clients: Map<string, T>,
  ws: T,
): boolean =>
  isCurrentProofOwnerSocket(clients, ws) && ws.data.isAuthenticating === false;

export const unregisterSocketIfCurrent = <T extends SocketAuthClient>(
  clients: Map<string, T>,
  ws: T,
): boolean => {
  if (clients.get(ws.data.peerId) !== ws) return false;
  return clients.delete(ws.data.peerId);
};

/**
 * Register, claim routing ownership, then re-check the exact socket before any
 * caller subscribes it or emits an open event. A same-process replacement can
 * happen while claimPeer awaits PostgreSQL; only the map owner may activate.
 */
export const activateVerifiedSocket = async <
  T extends ReplaceableSocketAuthClient,
>(
  clients: Map<string, T>,
  ws: T,
  claimPeer: (peerId: string) => Promise<boolean>,
  releasePeer: (peerId: string) => Promise<void>,
): Promise<boolean> => {
  // Cryptographic proof is complete, but the socket is not authorized to send
  // post-auth frames until its cross-instance routing claim also succeeds.
  ws.data.isAuthenticating = true;
  if (ws.readyState !== 1 || !registerVerifiedSocket(clients, ws)) {
    ws.data.isVerified = false;
    ws.data.isAuthenticating = false;
    ws.close();
    return false;
  }

  let claimed = false;
  try {
    claimed = await claimPeer(ws.data.peerId);
  } catch {
    claimed = false;
  }

  const ownerAfterClaim = clients.get(ws.data.peerId);
  if (
    claimed &&
    ws.readyState === 1 &&
    ws.data.isVerified &&
    ownerAfterClaim === ws
  ) {
    ws.data.isAuthenticating = false;
    return true;
  }

  const wasCurrent = unregisterSocketIfCurrent(clients, ws);
  ws.data.isVerified = false;
  ws.data.isAuthenticating = false;
  ws.close();
  // If close cleanup removed this socket before the awaited claim committed,
  // the successful late write must be undone. A distinct local successor owns
  // the same SERVER_ID claim, so releasing in that case would fence the winner.
  const hasLocalSuccessor =
    ownerAfterClaim !== undefined && ownerAfterClaim !== ws;
  if (wasCurrent || (claimed && !hasLocalSuccessor))
    await releasePeer(ws.data.peerId);
  return false;
};
