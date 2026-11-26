import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "bun:test";

import handleChallenge from "../../src/utils/handleChallenge";
import {
  activateVerifiedSocket,
  createFreshSocketChallenge,
  isCurrentVerifiedSocket,
} from "../../src/utils/socketAuth";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

export const PEER_ID = "00000000-0000-4000-8000-000000000001";
const KEY = "ab".repeat(32);
const SIGNATURE = "ef".repeat(64);
/** The close an authenticated socket gets when a newer session replaces it. */
export const REPLACED = {
  code: 1008,
  reason: "Replaced by a newer session for this identity",
};
export const BARE = { code: undefined, reason: undefined };
export const EXACT_PONG = JSON.stringify({ type: "pong", fromPeerId: PEER_ID });

export type Socket = P2PartyWSClient & {
  name: string;
  sent: string[];
  closeArgs: { code?: number; reason?: string }[];
};

/** A fake Bun socket that records what it sends and how it was closed. */
export const socket = (name: string): Socket => {
  const data: P2PartyWSData = {
    peerId: "",
    publicKey: "",
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: false,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    name,
    data,
    readyState: 1,
    sent: [] as string[],
    closeArgs: [] as { code?: number; reason?: string }[],
    send(message: string) {
      this.sent.push(message);
      return message.length;
    },
    close(code?: number, reason?: string) {
      this.closeArgs.push({ code, reason });
      this.readyState = 3;
    },
  };
  return ws as unknown as Socket;
};

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Issue a fresh challenge and answer it, through the real handleChallenge. */
export const prove = async (ws: Socket, valid = true) => {
  const nonce = randomBytes(32).toString("hex");
  createFreshSocketChallenge(ws.data, PEER_ID, KEY, nonce, randomUUID());
  return handleChallenge(PEER_ID, ws, nonce, SIGNATURE, {
    verifySignature: async () => valid,
  });
};

/** The sockets that are open and may send post-authentication frames. */
export const live = (
  clients: Map<string, P2PartyWSClient>,
  sockets: Socket[],
) =>
  sockets
    .filter((ws) => ws.readyState === 1 && isCurrentVerifiedSocket(clients, ws))
    .map((ws) => ws.name);

/** An authenticated socket that already owns PEER_ID in `clients`. */
export const establishedSocket = async (
  clients: Map<string, P2PartyWSClient>,
) => {
  const old = socket("old");
  expect(await prove(old)).toBeTruthy();
  expect(
    await activateVerifiedSocket(
      clients,
      old,
      async () => true,
      async () => {
        throw new Error("a committed activation releases nothing");
      },
    ),
  ).toBe(true);
  return old;
};
