import { isUUID, isHexadecimal } from "class-validator";

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
  isProtocolV4,
  MAX_SIGNALING_MESSAGE_CHARS,
} from "./protocolV4";
import { activateVerifiedSocket, isCurrentVerifiedSocket } from "./socketAuth";
import { isExactPongMessage } from "./handlePong";
import { claimPeer, releasePeer } from "../pubsub";

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
      "roomUrl",
      "roomRequestId",
      "protocolVersion",
    ]) &&
    candidate.type === "room" &&
    isProtocolV4(candidate.protocolVersion) &&
    typeof candidate.fromPeerId === "string" &&
    isUUID(candidate.fromPeerId) &&
    typeof candidate.roomUrl === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.roomUrl) &&
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
      "roomUrl",
      "roomLeaveId",
    ]) &&
    candidate.type === "leaveRoom" &&
    isProtocolV4(candidate.protocolVersion) &&
    typeof candidate.fromPeerId === "string" &&
    isUUID(candidate.fromPeerId) &&
    typeof candidate.roomUrl === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.roomUrl) &&
    typeof candidate.roomLeaveId === "string" &&
    isUUID(candidate.roomLeaveId, 4)
  );
};

const handleMessage = async (
  ws: P2PartyWSClient,
  message: P2PartyWSMsg,
  events: P2PartyWSEvents,
) => {
  try {
    const serialized = message.toString();
    if (serialized.length > MAX_SIGNALING_MESSAGE_CHARS)
      throw new Error("Signaling message exceeds the protocol-v4 limit");

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

    if (
      !("fromPeerId" in msg) ||
      msg.fromPeerId !== ws.data.peerId ||
      (msg.type !== "challenge" && !isCurrentVerifiedSocket(wsClients, ws))
    )
      throw new Error("WebSocket identity is not freshly authenticated");
    if (msg.type !== "pong" && !isProtocolV4(msg.protocolVersion))
      throw new Error("Incompatible signaling protocol version");

    switch (msg.type) {
      case "pong": {
        if (!isExactPongMessage(msg))
          throw new Error("Malformed protocol-v4 pong");
        ws.data.isAlive = true;
        clearTimeout(ws.data.pongTimeout); // Clear the pong timeout
        ws.data.pongTimeout = undefined;

        break;
      }

      case "challenge": {
        if (
          hasExactKeys(msg, [
            "type",
            "fromPeerId",
            "challenge",
            "signature",
            "protocolVersion",
          ]) &&
          isProtocolV4(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isHexadecimal(msg.challenge) &&
          msg.challenge.length === 64 &&
          isHexadecimal(msg.signature) &&
          msg.signature.length === 128
        ) {
          const authenticated = await handleChallenge(
            msg.fromPeerId,
            ws,
            msg.challenge,
            msg.signature,
          );
          if (authenticated) {
            // Record which instance now owns this socket, so the other workers
            // can route signals here instead of dropping them. Awaited: a peer
            // that is routable before it is claimed is a lost signal.
            if (
              !(await activateVerifiedSocket(
                wsClients,
                ws,
                claimPeer,
                releasePeer,
              ))
            )
              break;
            // activateVerifiedSocket re-checks exact registry ownership after
            // claimPeer's await. No await belongs between that fence and these
            // activation side effects.
            ws.send(JSON.stringify(authenticated));
            ws.subscribe("global");
            events.open(ws);
          }
        } else {
          throw new Error("Malformed protocol-v4 challenge response");
        }
        break;
      }

      case "leaveRoom": {
        if (isExactLeaveRoomRequest(msg)) {
          await handleLeaveRoom(
            msg.fromPeerId,
            ws,
            msg.roomUrl,
            msg.roomLeaveId,
          );
        } else throw new Error("Malformed protocol-v4 room leave");
        break;
      }

      case "room": {
        if (isExactRoomRequest(msg)) {
          await handleRoom(msg.fromPeerId, ws, msg.roomUrl, msg.roomRequestId);
        } else throw new Error("Malformed protocol-v4 room request");
        break;
      }

      case "peerConnection": {
        if (
          msg.type === "peerConnection" &&
          isProtocolV4(msg.protocolVersion) &&
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
          throw new Error("Malformed protocol-v4 peer-connection response");
        break;
      }

      case "peers": {
        if (
          msg.type === "peers" &&
          isProtocolV4(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId)
        ) {
          await handlePeers(msg.fromPeerId, ws, msg.roomId);
        } else throw new Error("Malformed protocol-v4 peers request");
        break;
      }

      case "candidate": {
        if (
          isProtocolV4(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId) &&
          isUUID(msg.toPeerId) &&
          isBoundedCandidate(msg.candidate)
        ) {
          await handleCandidate(ws, msg);
        } else throw new Error("Malformed protocol-v4 ICE candidate");

        break;
      }

      case "description": {
        if (
          isProtocolV4(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId) &&
          isUUID(msg.toPeerId) &&
          isBoundedDescription(msg.description)
        ) {
          await handleDescription(ws, msg);
        } else throw new Error("Malformed protocol-v4 description");

        break;
      }

      case "connection": {
        if (
          isProtocolV4(msg.protocolVersion) &&
          isUUID(msg.roomId) &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.toPeerId) &&
          areBoundedLabels(msg.labels)
        ) {
          await handlePeerConnection(ws, msg);
        } else throw new Error("Malformed protocol-v4 connection request");

        break;
      }

      default: {
        events.message(ws, message);
        break;
      }
    }
  } catch (error) {
    console.error(error);

    ws.close();
  }
};

export default handleMessage;
