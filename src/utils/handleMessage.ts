import handleInterval from "./handleInterval";
import { isRoomLocator } from "./roomIdentifier";
import { isUUID, isHexadecimal } from "./formats";
import { persistVerifiedIdentity, undoIdentityCommit } from "./peerIdentity";
import type { IdentityCommit, RoutingClaim } from "./peerIdentity";

import handleChallenge from "./handleChallenge";
import handleRoom from "./handleRoom";
import handleLeaveRoom from "./handleLeaveRoom";
import handlePeers from "./handlePeers";
import handleCandidate from "./handleCandidate";
import handleDescription from "./handleDescription";
import handlePeerConnection from "./handlePeerConnection";
import handlePeerAcceptsConnection from "./handlePeerAcceptsConnection";
import {
  areBoundedLabels,
  isBoundedCandidate,
  isBoundedDescription,
  isProtocolV5,
  MAX_SIGNALING_MESSAGE_CHARS,
  PROTOCOL_VERSION_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION_MISMATCH_REASON,
} from "./signalingProtocol";
import {
  activateVerifiedSocket,
  isCurrentVerifiedSocket,
  MALFORMED_PROTOCOL_CLOSE_CODE,
} from "./socketAuth";
import { isExactPongMessage } from "./handlePong";
import { evictReplacedClaim, wakePendingSignalDrain } from "../pubsub";
import { describeError } from "./logError";
import { peerLogTag } from "./logTag";

import {
  wsClients,
  type P2PartyWSClient,
  type P2PartyWSEvents,
  type P2PartyWSMsg,
} from "../wsServer";
import type {
  WebSocketMessageRoomIdRequest,
  WebSocketMessageChallengeResponse,
  WebSocketMessageDescriptionSend,
  WebSocketMessageCandidateSend,
  WebSocketMessagePeersRequest,
  WebSocketMessageConnectionResponse,
  WebSocketMessagePong,
  WebSocketMessagePeerConnectionRequest,
  WebSocketMessageLeaveRoomRequest,
} from "../utils/interfaces";

/**
 * Marks exactly the nine "Malformed protocol-v5 <thing>" throws below, so the
 * catch at the bottom of handleMessage can close with
 * MALFORMED_PROTOCOL_CLOSE_CODE for those alone. Everything else the same
 * catch can see -- the identity check, the oversized-frame guard,
 * JSON.parse, and every awaited handler -- still throws a plain Error and
 * still closes bare, because none of those are provably a client-build
 * mismatch that retrying cannot fix.
 */
class MalformedProtocolV5Message extends Error {}

/**
 * A frame that declares another protocol version, or none. Closed with the
 * contract's version-mismatch code and reason (signalingProtocol.ts).
 */
class UnsupportedProtocolVersion extends Error {}

export interface ProvedSocketActivation {
  clients: Map<string, P2PartyWSClient>;
  /** Persist the identity and write this socket's claim, in one transaction. */
  persist: (ws: P2PartyWSClient) => Promise<IdentityCommit | false>;
  /** Take back a commit by owner token; whether the replaced claim is back. */
  undo: (ws: P2PartyWSClient, commit: IdentityCommit) => Promise<boolean>;
  /** Close the socket that held a claim which stays replaced. */
  evict: (peerId: string, replaced: RoutingClaim | null) => Promise<void>;
  /** Called the moment this socket becomes current. */
  becameCurrent?: (ws: P2PartyWSClient) => void;
}

/** This process's registry, store and queue; built per call (wsServer imports this module). */
const processActivation = (): ProvedSocketActivation => ({
  clients: wsClients,
  persist: (ws) => persistVerifiedIdentity(ws),
  undo: (ws, commit) => undoIdentityCommit(ws, commit),
  evict: (peerId, replaced) => evictReplacedClaim(peerId, replaced),
  // Rows queued for this socket while it activated (a frame sent between its
  // claim commit and its registration) are kept for it; deliver them now,
  // not at the next safety poll, before direct sends can overtake them.
  becameCurrent: () => wakePendingSignalDrain(),
});

/**
 * Commit a proved socket's identity and claim, then make it current.
 *
 * A socket that committed but does not become current (it closed meanwhile,
 * or a newer session of its identity became current first) gives the claim it
 * replaced back. If a successor holds the claim by then, the replaced socket
 * stays replaced, so it is closed: no state of the failed socket is left, and
 * exactly one socket of the identity stays live. Returns the commit for the
 * socket that became current; its caller closes the replaced socket after
 * activating it.
 */
export const activateProvedSocket = (
  ws: P2PartyWSClient,
  activation: ProvedSocketActivation = processActivation(),
): Promise<IdentityCommit | false> =>
  activateVerifiedSocket(
    activation.clients,
    ws,
    () => activation.persist(ws),
    async (commit) => {
      try {
        if (!(await activation.undo(ws, commit)))
          await activation.evict(ws.data.peerId, commit.replaced);
      } catch (error) {
        // The claim keeps naming this instance, so frames for the identity
        // still reach this instance; a row this socket created stays.
        console.error(
          "p2party: could not take back a failed activation's commit",
          peerLogTag(ws.data.peerId),
          describeError(error),
        );
      }
    },
    () => activation.becameCurrent?.(ws),
  );

const hasExactKeys = (value: object, allowed: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
};

export const isExactRoomRequest = (
  value: unknown,
): value is WebSocketMessageRoomIdRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasExactKeys(candidate, [
      "type",
      "fromPeerId",
      "roomLocator",
      "roomRequestId",
      "protocolVersion",
    ]) &&
    candidate.type === "room" &&
    isProtocolV5(candidate.protocolVersion) &&
    typeof candidate.fromPeerId === "string" &&
    isUUID(candidate.fromPeerId) &&
    isRoomLocator(candidate.roomLocator) &&
    typeof candidate.roomRequestId === "string" &&
    isUUID(candidate.roomRequestId, 4)
  );
};

export const isExactLeaveRoomRequest = (
  value: unknown,
): value is WebSocketMessageLeaveRoomRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasExactKeys(candidate, [
      "type",
      "protocolVersion",
      "fromPeerId",
      "roomLocator",
      "roomLeaveId",
    ]) &&
    candidate.type === "leaveRoom" &&
    isProtocolV5(candidate.protocolVersion) &&
    typeof candidate.fromPeerId === "string" &&
    isUUID(candidate.fromPeerId) &&
    isRoomLocator(candidate.roomLocator) &&
    typeof candidate.roomLeaveId === "string" &&
    isUUID(candidate.roomLeaveId, 4)
  );
};

export const isBoundedPeersRequest = (
  value: unknown,
): value is WebSocketMessagePeersRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const msg = value as WebSocketMessagePeersRequest;
  const boundedIds = (ids: unknown): boolean =>
    ids === undefined ||
    (Array.isArray(ids) &&
      ids.length <= 64 &&
      ids.every((id) => typeof id === "string" && isUUID(id)));
  return (
    msg.type === "peers" &&
    isProtocolV5(msg.protocolVersion) &&
    typeof msg.fromPeerId === "string" &&
    isUUID(msg.fromPeerId) &&
    typeof msg.roomId === "string" &&
    isUUID(msg.roomId) &&
    (msg.rosterRequestId === undefined ||
      (typeof msg.rosterRequestId === "string" &&
        isUUID(msg.rosterRequestId, 4))) &&
    !("excludedPeerIds" in msg) &&
    boundedIds(msg.targetPeerIds)
  );
};

const handleMessage = async (
  ws: P2PartyWSClient,
  message: P2PartyWSMsg,
  events: P2PartyWSEvents,
  signalingHost = process.env.SIGNALING_HOST,
) => {
  try {
    const serialized = message.toString();
    if (serialized.length > MAX_SIGNALING_MESSAGE_CHARS)
      throw new Error("Signaling message exceeds the protocol-v5 limit");

    const msg:
      | WebSocketMessagePong
      | WebSocketMessageRoomIdRequest
      | WebSocketMessageChallengeResponse
      | WebSocketMessageDescriptionSend
      | WebSocketMessageCandidateSend
      | WebSocketMessagePeersRequest
      | WebSocketMessageConnectionResponse
      | WebSocketMessagePeerConnectionRequest
      | WebSocketMessageLeaveRoomRequest = JSON.parse(serialized);
    if (typeof msg !== "object" || msg === null || Array.isArray(msg))
      throw new Error("Signaling message is not a JSON object");

    // Before the identity check, so a client of another protocol version is
    // told so whatever else it gets wrong, authenticated or not.
    if (
      (msg.type !== "pong" || "protocolVersion" in msg) &&
      !isProtocolV5(msg.protocolVersion)
    )
      throw new UnsupportedProtocolVersion(
        "Unsupported signaling protocol version",
      );
    if ("roomUrl" in msg)
      throw new MalformedProtocolV5Message(
        "Malformed protocol-v5 room locator",
      );
    if (
      msg.type !== "challenge" &&
      (!("fromPeerId" in msg) ||
        msg.fromPeerId !== ws.data.peerId ||
        !isCurrentVerifiedSocket(wsClients, ws))
    )
      throw new Error("WebSocket identity is not freshly authenticated");
    if (
      (msg.type === "room" || msg.type === "leaveRoom") &&
      ws.data.admission &&
      !ws.data.admission.roomMutation()
    ) {
      ws.close(1013, "Room request rate exceeded");
      return;
    }

    switch (msg.type) {
      case "pong": {
        if (!isExactPongMessage(msg))
          throw new MalformedProtocolV5Message("Malformed protocol-v5 pong");
        ws.data.isAlive = true;
        clearTimeout(ws.data.pongTimeout); // Clear the pong timeout
        ws.data.pongTimeout = undefined;

        break;
      }

      case "challenge": {
        if (
          hasExactKeys(msg, [
            "type",
            "publicKey",
            "challenge",
            "signature",
            "protocolVersion",
          ]) &&
          isProtocolV5(msg.protocolVersion) &&
          typeof msg.publicKey === "string" &&
          /^[0-9a-f]{64}$/.test(msg.publicKey) &&
          typeof msg.challenge === "string" &&
          typeof msg.signature === "string" &&
          isHexadecimal(msg.challenge) &&
          msg.challenge.length === 64 &&
          isHexadecimal(msg.signature) &&
          msg.signature.length === 128
        ) {
          const authenticated = await handleChallenge(
            msg.publicKey,
            ws,
            msg.challenge,
            msg.signature,
            { signalingHost },
          );
          if (authenticated) {
            if (
              ws.data.admission &&
              !ws.data.admission.authenticate(msg.publicKey)
            ) {
              ws.data.isVerified = false;
              ws.close(1013, "Identity admission limit reached");
              break;
            }
            // Persist the identity and record which instance and socket now
            // own it, in one transaction, so the other workers can route
            // signals here instead of dropping them. Awaited: a peer that is
            // routable before it is claimed is a lost signal. Only once that
            // commits does this socket replace an older one for the same
            // identity; until then that one keeps working.
            const committed = await activateProvedSocket(ws);
            if (!committed) break;
            // activateVerifiedSocket re-checks exact registry ownership after
            // the commit's await. No await belongs between that fence and
            // these activation side effects.
            ws.send(JSON.stringify(authenticated));
            if (ws.data.authenticationTimeout)
              clearTimeout(ws.data.authenticationTimeout);
            ws.data.pingInterval = handleInterval(ws);
            ws.subscribe("global");
            events.open(ws);
            // An older socket of this identity whose claim this commit took:
            // on this instance registration closed it; on another one, that
            // instance is told to.
            await evictReplacedClaim(ws.data.peerId, committed.replaced);
          }
        } else {
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 challenge response",
          );
        }
        break;
      }

      case "leaveRoom": {
        if (isExactLeaveRoomRequest(msg)) {
          await handleLeaveRoom(
            msg.fromPeerId,
            ws,
            msg.roomLocator,
            msg.roomLeaveId,
          );
        } else
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 room leave",
          );
        break;
      }

      case "room": {
        if (isExactRoomRequest(msg)) {
          await handleRoom(
            msg.fromPeerId,
            ws,
            msg.roomLocator,
            msg.roomRequestId,
          );
        } else
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 room request",
          );
        break;
      }

      case "peerConnection": {
        if (
          msg.type === "peerConnection" &&
          isProtocolV5(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.toPeerId) &&
          isUUID(msg.roomId)
        ) {
          await handlePeerAcceptsConnection(
            msg.fromPeerId,
            msg.toPeerId,
            msg.roomId,
            ws,
          );
        } else
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 peer-connection response",
          );
        break;
      }

      case "peers": {
        if (isBoundedPeersRequest(msg)) {
          await handlePeers(
            msg.fromPeerId,
            ws,
            msg.roomId,
            msg.rosterRequestId,
            msg.targetPeerIds,
          );
        } else
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 peers request",
          );
        break;
      }

      case "candidate": {
        if (
          isProtocolV5(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId) &&
          isUUID(msg.toPeerId) &&
          isBoundedCandidate(msg.candidate)
        ) {
          await handleCandidate(ws, msg);
        } else
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 ICE candidate",
          );

        break;
      }

      case "description": {
        if (
          isProtocolV5(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId) &&
          isUUID(msg.toPeerId) &&
          isBoundedDescription(msg.description)
        ) {
          await handleDescription(ws, msg);
        } else
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 description",
          );

        break;
      }

      case "connection": {
        if (
          isProtocolV5(msg.protocolVersion) &&
          isUUID(msg.roomId) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.toPeerId) &&
          areBoundedLabels(msg.labels)
        ) {
          await handlePeerConnection(ws, msg);
        } else
          throw new MalformedProtocolV5Message(
            "Malformed protocol-v5 connection request",
          );

        break;
      }

      default: {
        events.message(ws, message);
        break;
      }
    }
  } catch (error) {
    console.error("p2party: signaling frame refused", describeError(error));

    // A version mismatch and the nine malformed-shape throws above are
    // provably a client-build mismatch that retrying can never fix; every
    // other cause this catch can see (identity, oversized-frame, JSON.parse,
    // and any awaited handler) closes bare, so the client retries.
    if (error instanceof UnsupportedProtocolVersion)
      ws.close(
        PROTOCOL_VERSION_MISMATCH_CLOSE_CODE,
        PROTOCOL_VERSION_MISMATCH_REASON,
      );
    else if (error instanceof MalformedProtocolV5Message)
      ws.close(MALFORMED_PROTOCOL_CLOSE_CODE, error.message);
    else ws.close();
  }
};

export default handleMessage;
