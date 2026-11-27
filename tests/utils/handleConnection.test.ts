import { expect, test } from "bun:test";

import handleConnection from "../../src/utils/handleConnection";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const PUBLIC_KEY = "ab".repeat(32);

const socket = (): P2PartyWSClient & {
  sent: string[];
  closeArgs: { code?: number; reason?: string }[];
  wasTerminated: () => boolean;
} => {
  const sent: string[] = [];
  const closeArgs: { code?: number; reason?: string }[] = [];
  let terminated = false;
  const data: P2PartyWSData = {
    peerId: "",
    publicKey: PUBLIC_KEY,
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "",
    isVerified: false,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    data,
    sent,
    closeArgs,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    close: (code?: number, reason?: string) => {
      closeArgs.push({ code, reason });
    },
    terminate: () => {
      terminated = true;
    },
    wasTerminated: () => terminated,
  } as unknown as P2PartyWSClient & {
    sent: string[];
    closeArgs: { code?: number; reason?: string }[];
    wasTerminated: () => boolean;
  };
  return ws;
};

test("the opening challenge discloses no identity and binds only a nonce", () => {
  const ws = socket();
  handleConnection(ws);
  expect(ws.data.peerId).toBe("");
  expect(ws.data.publicKey).toBe("");
  expect(ws.sent.map((raw) => JSON.parse(raw))).toEqual([
    {
      type: "authChallenge",
      challenge: expect.stringMatching(/^[0-9a-f]{64}$/),
      protocolVersion: 5,
    },
  ]);
  expect(ws.closeArgs).toEqual([]);
});
