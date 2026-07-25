import { isUUID, isHexadecimal } from "class-validator";

import handleChallenge from "./handleChallenge";
import handleRoom from "./handleRoom";
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
import { registerVerifiedSocket } from "./socketAuth";

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
} from "../utils/interfaces";

const hasExactChallengeResponseKeys = (value: object): boolean => {
  const allowed = [
    "type",
    "fromPeerId",
    "challenge",
    "signature",
    "protocolVersion",
  ];
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
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
      throw new Error("Signaling message exceeds the protocol-v3 limit");

    const msg:
      | WebSocketMessagePong
      | WebSocketMessageRoomIdRequest
      | WebSocketMessageChallengeResponse
      | WebSocketMessageDescriptionSend
      | WebSocketMessageCandidateSend
      | WebSocketMessagePeersRequest
      | WebSocketMessageConnectionResponse
      | WebSocketMessagePeerConnectionRequest = JSON.parse(serialized);

    if (
      !("fromPeerId" in msg) ||
      msg.fromPeerId !== ws.data.peerId ||
      (msg.type !== "challenge" && !ws.data.isVerified)
    )
      throw new Error("WebSocket identity is not freshly authenticated");
    if (msg.type !== "pong" && !isProtocolV4(msg.protocolVersion))
      throw new Error("Incompatible signaling protocol version");

    switch (msg.type) {
      case "pong": {
        ws.data.isAlive = true;
        clearTimeout(ws.data.pongTimeout); // Clear the pong timeout

        break;
      }

      case "challenge": {
        if (
          hasExactChallengeResponseKeys(msg) &&
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
            if (ws.readyState !== 1 || !registerVerifiedSocket(wsClients, ws))
              throw new Error(
                "Verified WebSocket could not enter the client registry",
              );
            ws.subscribe("global");
            events.open(ws);
          }
        } else {
          throw new Error("Malformed protocol-v3 challenge response");
        }
        break;
      }

      case "room": {
        if (
          msg.type === "room" &&
          isProtocolV4(msg.protocolVersion) &&
          isUUID(msg.fromPeerId) &&
          isHexadecimal(msg.roomUrl) &&
          msg.roomUrl.length === 64
        ) {
          await handleRoom(msg.fromPeerId, ws, msg.roomUrl);
        } else throw new Error("Malformed protocol-v3 room request");
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
          throw new Error("Malformed protocol-v3 peer-connection response");
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
        } else throw new Error("Malformed protocol-v3 peers request");
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
        } else throw new Error("Malformed protocol-v3 ICE candidate");

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
        } else throw new Error("Malformed protocol-v3 description");

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
        } else throw new Error("Malformed protocol-v3 connection request");

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
