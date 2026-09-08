export interface WebSocketMessagePong {
  type: "pong";
  fromPeerId: string;
}

export interface WebSocketMessageChallengeRequest {
  type: "peerId";
  peerId: string;
  challenge: string;
  protocolVersion: number;
  message: string;
}

export interface WebSocketMessageChallengeResponse {
  type: "challenge";
  fromPeerId: string;
  challenge: string;
  signature: string;
  protocolVersion: number;
}

export interface WebSocketMessageSuccessfulChallenge {
  type: "challenge";
  challengeId: string;
  protocolVersion: number;
}

export interface WebSocketTurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  expiresAtUnixSeconds: number;
}

export interface WebSocketMessageRoomIdRequest {
  type: "room";
  fromPeerId: string;
  roomUrl: string;
  roomRequestId: string;
  protocolVersion: number;
}

export interface WebSocketMessageRoomIdResponse {
  type: "roomId";
  roomId: string;
  roomUrl: string;
  roomRequestId: string;
  protocolVersion: number;
  /** Omitted when no relay is configured; clients then stay STUN-only. */
  turnCredentials?: WebSocketTurnCredentials;
}

export interface WebSocketMessageLeaveRoomRequest {
  type: "leaveRoom";
  fromPeerId: string;
  roomUrl: string;
  roomLeaveId: string;
  protocolVersion: number;
}

export interface WebSocketMessageRoomLeftResponse {
  type: "roomLeft";
  roomUrl: string;
  roomLeaveId: string;
  protocolVersion: number;
}

export interface WebSocketMessageDescriptionSend {
  type: "description";
  description: unknown;
  fromPeerId: string;
  fromPeerPublicKey: string;
  toPeerId: string;
  roomId: string;
  protocolVersion: number;
}

export interface WebSocketMessageDescriptionReceive {
  type: "description";
  description: unknown;
  fromPeerId: string;
  fromPeerPublicKey: string;
  roomId: string;
  protocolVersion: number;
}

export interface WebSocketMessageCandidateSend {
  type: "candidate";
  candidate: unknown;
  fromPeerId: string;
  toPeerId: string;
  roomId: string;
  protocolVersion: number;
}

export interface WebSocketMessageCandidateReceive {
  type: "candidate";
  candidate: unknown;
  fromPeerId: string;
  roomId: string;
  protocolVersion: number;
}

export interface WebSocketMessagePeersRequest {
  type: "peers";
  fromPeerId: string;
  roomId: string;
  protocolVersion: number;
}

export interface RoomPeer {
  id: string;
  publicKey: string;
  /**
   * The introduced peer's per-socket generation (see SocketAuthState).
   *
   * Optional and additive: a 0.14.7 client ignores unknown fields, and a
   * client talking to a pre-generation server sees `undefined` and behaves
   * exactly as before. It is what lets a peer tell "the same identity, same
   * socket" from "the same identity, a new socket that replaced the one my
   * transport is bound to" (C1).
   */
  socketGeneration?: string;
}

export interface WebSocketMessagePeersResponse {
  type: "peers";
  roomId: string;
  peers: RoomPeer[];
  protocolVersion: number;
}

export interface WebSocketMessageConnectionRequest {
  type: "peerConnection";
  roomId: string;
  peer: { id: string; publicKey: string };
  protocolVersion: number;
}

export interface WebSocketMessageConnectionResponse {
  type: "peerConnection";
  roomId: string;
  fromPeerId: string;
  toPeerId: string;
  protocolVersion: number;
}

export interface WebSocketMessagePeerConnectionRequest {
  type: "connection";
  roomId: string;
  fromPeerId: string;
  toPeerId: string;
  labels: string[];
  protocolVersion: number;
}

export interface WebSocketMessagePeerConnectionResponse {
  type: "connection";
  roomId: string;
  fromPeerId: string;
  /** The dialling peer's per-socket generation; optional and additive. */
  fromPeerSocketGeneration?: string;
  labels: string[];
  protocolVersion: number;
}

export interface WebSocketMessageError {
  type: "error";
  fromAction:
    | "ping"
    | "sendCandidate"
    | "receiveCandidate"
    | "sendDescription"
    | "receiveDescription"
    | "requestRoomId"
    | "leaveRoom"
    | "requestPeerId"
    | "requestPeers"
    | "sendChallengeResponse";
  error:
    | Error
    | {
        message: string;
        [key: string]: unknown;
      };
}
