import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "bun:test";

import handleChallenge from "../../src/utils/handleChallenge";
import { activateProvedSocket } from "../../src/utils/handleMessage";
import { evictReplacedClaim } from "../../src/pubsub";
import {
  createFreshSocketChallenge,
  isCurrentVerifiedSocket,
} from "../../src/utils/socketAuth";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";
import type {
  IdentityCommit,
  RoutingClaim,
} from "../../src/utils/peerIdentity";

export const PEER_ID = "00000000-0000-4000-8000-000000000001";
/** The instance these sockets live on. */
export const HERE = "11111111-1111-4111-8111-111111111111";
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

/**
 * The identity row's routing claim, with the semantics of the real
 * statements: a commit overwrites it and reports what it replaced; undo and
 * release compare the owner token (instance and socket generation).
 */
export const claimStore = (initial: RoutingClaim | null = null) => {
  let claim: RoutingClaim | null = initial;
  const mine = (ws: P2PartyWSClient): RoutingClaim => ({
    serverId: HERE,
    socketGeneration: ws.data.socketGeneration,
  });
  const owns = (ws: P2PartyWSClient) =>
    claim?.serverId === HERE &&
    claim.socketGeneration === ws.data.socketGeneration;
  return {
    claim: () => claim,
    /** A commit that waits for `gate`, then writes the claim when it is true. */
    commit:
      (gate: Promise<boolean> | boolean = true) =>
      async (ws: P2PartyWSClient): Promise<IdentityCommit | false> => {
        if (!(await gate)) return false;
        const replaced = claim;
        claim = mine(ws);
        return { created: false, replaced };
      },
    undo: async (ws: P2PartyWSClient, commit: IdentityCommit) => {
      if (!owns(ws)) return false;
      claim = commit.replaced;
      return true;
    },
    release: async (_peerId: string, socketGeneration: string) => {
      if (
        claim?.serverId === HERE &&
        claim.socketGeneration === socketGeneration
      )
        claim = null;
    },
    claimOf: (ws: P2PartyWSClient) => mine(ws),
    /** Another instance's commit for the same identity. */
    takeOver: (other: RoutingClaim) => {
      claim = other;
    },
  };
};

/** The real activation, over `clients` and a claim store, on instance HERE. */
export const activate = (
  clients: Map<string, P2PartyWSClient>,
  store: ReturnType<typeof claimStore>,
  ws: P2PartyWSClient,
  gate: Promise<boolean> | boolean = true,
  evicted: { peerId: string; replaced: RoutingClaim | null }[] = [],
) =>
  activateProvedSocket(ws, {
    clients,
    persist: store.commit(gate),
    undo: store.undo,
    evict: async (peerId, replaced) => {
      evicted.push({ peerId, replaced });
      await evictReplacedClaim(peerId, replaced, clients, HERE);
    },
  });

/** An authenticated socket that already owns PEER_ID in `clients`. */
export const establishedSocket = async (
  clients: Map<string, P2PartyWSClient>,
  store: ReturnType<typeof claimStore>,
) => {
  const old = socket("old");
  expect(await prove(old)).toBeTruthy();
  expect(await activate(clients, store, old)).toBeTruthy();
  return old;
};
