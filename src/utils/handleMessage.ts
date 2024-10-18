import { isUUID, isHexadecimal, isAlphanumeric } from "class-validator";

import handleChallenge from "./handleChallenge";
import handleRoom from "./handleRoom";
import handlePeers from "./handlePeers";

import type {
  P2PartyWSClient,
  P2PartyWSEvents,
  P2PartyWSMsg,
} from "../wsServer";
import type {
  WebSocketMessageRoomIdRequest,
  WebSocketMessageChallengeResponse,
  WebSocketMessageDescriptionSend,
  WebSocketMessageCandidateSend,
  WebSocketMessagePeersRequest,
  WebSocketMessagePong,
} from "../utils/interfaces";
import handleCandidate from "./handleCandidate";
import handleDescription from "./handleDescription";

const handleMessage = async (
  ws: P2PartyWSClient,
  message: P2PartyWSMsg,
  events: P2PartyWSEvents,
) => {
  try {
    const msg:
      | WebSocketMessagePong
      | WebSocketMessageRoomIdRequest
      | WebSocketMessageChallengeResponse
      | WebSocketMessageDescriptionSend
      | WebSocketMessageCandidateSend
      | WebSocketMessagePeersRequest = JSON.parse(message.toString());

    switch (msg.type) {
      case "pong": {
        ws.data.isAlive = true;
        clearTimeout(ws.data.pongTimeout); // Clear the pong timeout

        break;
      }

      case "challenge": {
        if (
          isUUID(msg.fromPeerId) &&
          isHexadecimal(msg.challenge) &&
          msg.challenge.length === 64 &&
          isHexadecimal(msg.signature) &&
          msg.signature.length === 1024 // 512
        ) {
          await handleChallenge(
            msg.fromPeerId,
            ws,
            msg.challenge,
            msg.signature,
          );
        }
        break;
      }

      case "room": {
        if (
          msg.type === "room" &&
          isUUID(msg.fromPeerId) &&
          isAlphanumeric(msg.roomUrl) &&
          msg.roomUrl.length > 6 &&
          msg.roomUrl.length < 10
        ) {
          await handleRoom(msg.fromPeerId, ws, msg.roomUrl);
        }
        break;
      }

      case "peers": {
        if (
          msg.type === "peers" &&
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId)
        ) {
          await handlePeers(msg.fromPeerId, ws, msg.roomId);
        }
        break;
      }

      case "candidate": {
        if (
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId) &&
          isUUID(msg.toPeerId) &&
          typeof msg.candidate === "object"
        ) {
          await handleCandidate(ws, msg);
        }

        break;
      }

      case "description": {
        if (
          isUUID(msg.fromPeerId) &&
          isUUID(msg.roomId) &&
          isUUID(msg.toPeerId) &&
          typeof msg.description === "object"
        ) {
          await handleDescription(ws, msg);
        }

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
