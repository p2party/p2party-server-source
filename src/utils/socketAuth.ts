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
  close: (code?: number, reason?: string) => unknown;
}

/**
 * Close code for a server-chosen refusal the client must never retry:
 * a challenge/signature/key refusal, or -- as used in registerVerifiedSocket
 * below -- an authenticated socket that a newer session for the same
 * identity has just superseded.
 *
 * The SDK's reconnect ladder retries every close except 1003/1008/1010
 * chosen BY THE SERVER; a bare ws.close() reaches it as 1000 ("normal
 * closure"), not 1005 ("no status received") as this comment used to claim --
 * measured (20/20 runs) against a real Bun WebSocket server, Bun 1.3.14. That
 * is Bun's behaviour, not a protocol guarantee: a different WebSocket
 * implementation may still send 1005 for the same bare close(). Either way
 * 1000 and 1005 both sit outside the permanent set, so the SDK deliberately
 * keeps retrying it and the reconnect fix is not undone. The SDK also closes
 * its own ingress backlog with 1008 locally, so this code must mean only
 * "the server refused you" -- never anything else -- everywhere the server
 * sends it.
 */
export const PERMANENT_CLOSE_CODE = 1008;

/**
 * Close code for a message that is well-formed JSON, declares a protocol
 * version the server matches, but violates the exact protocol-v4 wire shape
 * for its `type` -- an extra/missing field, a wrong field type, or a value
 * outside the bounds an `isExact*`/`isBounded*` guard checks (handleMessage.ts,
 * protocolV4.ts). Retrying changes nothing: the same bytes fail the same
 * validator forever, so this is the SDK's 1003 ("unsupported data") case --
 * a build mismatch, not PERMANENT_CLOSE_CODE's "you were refused or
 * superseded" case.
 *
 * This must never be applied to a throw a healthy client can hit from a
 * transient or server-side cause: a stale/evicted socket sending a post-auth
 * frame, a protocolVersion mismatch (a rolling deploy can make this resolve
 * on the next socket, so it is not provably the client's fault), an
 * oversized frame, or a database fault surfaced as an exception. Those keep
 * closing with no code so the SDK's reconnect ladder keeps retrying.
 */
export const MALFORMED_PROTOCOL_CLOSE_CODE = 1003;

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

/**
 * The wire form of a socket's generation: `undefined` when there is none.
 *
 * `SocketAuthState.socketGeneration` is `""` (not `undefined`) before a
 * socket has proved ownership of its key, and `""` again the instant a fresh
 * challenge is issued on it. That is a real runtime value of a `string`
 * field, not just a type-level possibility. The wire-facing fields it feeds
 * (`RoomPeer.socketGeneration`, `WebSocketMessagePeerConnectionResponse.
 * fromPeerSocketGeneration` in interfaces.ts) document only `undefined` as
 * "no information". A client comparing generations with a bare
 * `seen !== incoming` would treat an observed `""` as a real, different
 * generation and retire a healthy edge -- the exact class of bug (C1/C4)
 * this feature exists to fix. Every site that puts a generation on the wire
 * must route it through this function so `""` can never be mistaken for one.
 */
export const wireSocketGeneration = (
  state: Pick<SocketAuthState, "socketGeneration">,
): string | undefined =>
  state.socketGeneration.length > 0 ? state.socketGeneration : undefined;

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

/** Characters of the base64url HMAC kept in a username tag (132 bits). */
const TURN_USERNAME_TAG_CHARS = 22;
/**
 * Prefixed to the tag's HMAC input. COTURN_SECRET also keys coturn's
 * HMAC-SHA1 password over the username; the label keeps the two inputs from
 * ever being the same bytes.
 */
const TURN_USERNAME_TAG_LABEL = new TextEncoder().encode(
  "p2party turn username tag v1",
);

/**
 * The username's tag: the first 22 base64url characters of
 * HMAC-SHA256(COTURN_SECRET, label ‖ identity public key ‖ expiry), where the
 * key is its 32 raw bytes and the expiry an unsigned 64-bit big-endian
 * integer. Without the secret the tag cannot be linked to the key, and a new
 * expiry gives a new tag, so usernames of different lifetimes cannot be
 * linked either. The TURN host holds the same secret, so it could test a tag
 * against public keys it already knows; no other secret is configured that
 * every worker shares and the TURN host lacks.
 */
const turnUsernameTag = (
  secret: string,
  publicKey: string,
  expiresAtUnixSeconds: number,
): string => {
  const label = TURN_USERNAME_TAG_LABEL.length;
  const message = new Uint8Array(label + 40);
  message.set(TURN_USERNAME_TAG_LABEL);
  message.set(Buffer.from(publicKey, "hex"), label);
  new DataView(message.buffer).setBigUint64(
    label + 32,
    BigInt(expiresAtUnixSeconds),
  );
  return crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("base64url")
    .slice(0, TURN_USERNAME_TAG_CHARS);
};

/**
 * coturn REST credentials for one identity.
 *
 * The username is `<expiry>:<tag>` (see turnUsernameTag): coturn's REST
 * scheme reads the expiry before the colon, and the identity public key never
 * appears, so neither coturn nor anyone on the path of a plain `turn:`
 * allocation request can read it.
 *
 * The expiry is `now + lifetime` rounded up to a whole multiple of the
 * lifetime, so it is the same for every issuance inside one lifetime window
 * and a credential stays valid for at least one lifetime and less than two.
 * Every issuance inside one window returns the identical credential. The
 * design's cap of at most 4 issuances per identity per lifetime, a repeat
 * returning the same credential, holds by construction: the credential is a
 * function of identity and window alone, so any lifetime-long interval sees
 * at most two distinct ones.
 *
 * coturn counts `user-quota` per username part after `<digits>:`, here the
 * tag, so each window gives an identity a separate quota bucket. coturn checks
 * the expiry only when a TURN session first authenticates, not on Refresh, so
 * an allocation outlives its credential for as long as the client refreshes
 * it. See the README for the relay bound this leaves.
 */
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

  const lifetime = TURN_CREDENTIAL_CONTRACT.lifetimeSeconds;
  const nowUnixSeconds = Math.floor(now / 1000);
  const unixTimeStamp =
    Math.ceil((nowUnixSeconds + lifetime) / lifetime) * lifetime;
  if (
    !Number.isSafeInteger(nowUnixSeconds) ||
    nowUnixSeconds < 0 ||
    !Number.isSafeInteger(unixTimeStamp) ||
    unixTimeStamp < 1 ||
    String(unixTimeStamp).length > 11
  )
    throw new Error("TURN credential timestamp is outside the wire contract");

  const username = `${String(unixTimeStamp)}:${turnUsernameTag(
    secret,
    publicKey,
    unixTimeStamp,
  )}`;
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
    // A bare close() reaches the client as 1005, which its reconnect ladder
    // deliberately retries. Without a permanent code here, the evicted
    // predecessor reconnects, evicts whichever socket displaced it, and the
    // two sockets evict each other forever. PERMANENT_CLOSE_CODE tells the
    // predecessor's client "do not retry, another session has taken over
    // this identity" -- correct even though this socket was never invalid,
    // only superseded.
    predecessor.close(
      PERMANENT_CLOSE_CODE,
      "Replaced by a newer session for this identity",
    );
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
