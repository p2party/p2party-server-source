import { describe, expect, spyOn, test } from "bun:test";

import { createHandleLeaveRoom } from "../../src/utils/handleLeaveRoom";
import { createHandleRoom } from "../../src/utils/handleRoom";
import { runPeerRoomMutation } from "../../src/utils/peerRoomMutationQueue";
import {
  enqueueSocketMessage,
  MAX_QUEUED_MESSAGE_BYTES_PER_SOCKET,
  MAX_QUEUED_MESSAGES_PER_SOCKET,
} from "../../src/utils/socketMessageQueue";
import { handleSocketMessageIngress } from "../../src/utils/socketMessageIngress";
import { registerVerifiedSocket } from "../../src/utils/socketAuth";

import type { ProcessPrismaClient } from "../../src/prismaClient";
import type {
  P2PartyWSClient,
  P2PartyWSData,
  P2PartyWSMsg,
} from "../../src/wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";
const ROOM_ID = "00000000-0000-4000-8000-000000000002";
const ROOM_REQUEST_ID = "00000000-0000-4000-8000-000000000003";
const ROOM_LEAVE_ID = "00000000-0000-4000-8000-000000000004";
const ROOM_TOKEN = "ab".repeat(32);
const PUBLIC_KEY = "cd".repeat(32);

type MembershipPrisma = Pick<ProcessPrismaClient, "peer" | "room">;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const roomFrame = JSON.stringify({
  type: "room",
  fromPeerId: PEER_ID,
  roomUrl: ROOM_TOKEN,
  roomRequestId: ROOM_REQUEST_ID,
  protocolVersion: 4,
});
const leaveFrame = JSON.stringify({
  type: "leaveRoom",
  fromPeerId: PEER_ID,
  roomUrl: ROOM_TOKEN,
  roomLeaveId: ROOM_LEAVE_ID,
  protocolVersion: 4,
});

const membershipFixture = (
  initiallyJoined: boolean,
  hooks: {
    beforeRoomUpsert?: () => Promise<void>;
    beforeRoomConnect?: () => Promise<void>;
    beforePeerDisconnect?: () => Promise<void>;
  } = {},
) => {
  let joined = initiallyJoined;
  const clients = new Map<string, P2PartyWSClient>();

  const database = {
    peer: {
      findUnique: async () => ({
        id: PEER_ID,
        publicKey: PUBLIC_KEY,
        rooms: joined ? [{ id: ROOM_ID }] : [],
      }),
      update: async () => {
        await hooks.beforePeerDisconnect?.();
        joined = false;
        return {};
      },
    },
    room: {
      upsert: async () => {
        await hooks.beforeRoomUpsert?.();
        return { id: ROOM_ID, identifier: "identifier" };
      },
      update: async ({
        data,
      }: {
        data: { peers: Record<string, unknown> };
      }) => {
        if ("connect" in data.peers) {
          await hooks.beforeRoomConnect?.();
          joined = true;
        } else if ("disconnect" in data.peers) {
          joined = false;
        }
        return { id: ROOM_ID, identifier: "identifier" };
      },
    },
  } as unknown as MembershipPrisma;

  const makeSocket = () => {
    const sent: Record<string, unknown>[] = [];
    const data: P2PartyWSData = {
      peerId: PEER_ID,
      publicKey: PUBLIC_KEY,
      challengeNonce: "",
      challengeId: "",
      socketGeneration: "",
      isVerified: true,
      isAuthenticating: false,
      isAlive: true,
    };
    const ws = {
      data,
      readyState: 1,
      send: (serialized: string) => {
        sent.push(JSON.parse(serialized));
        return serialized.length;
      },
      close: () => {
        ws.readyState = 2;
      },
      terminate: () => {
        ws.readyState = 3;
      },
    } as unknown as P2PartyWSClient & { readyState: number };
    return { ws, sent };
  };

  const room = createHandleRoom(database, clients);
  const leave = createHandleLeaveRoom(database, clients);
  const dispatch = async (ws: P2PartyWSClient, frame: P2PartyWSMsg) => {
    const message = JSON.parse(frame.toString()) as { type: string };
    if (message.type === "room")
      await room(PEER_ID, ws, ROOM_TOKEN, ROOM_REQUEST_ID);
    else await leave(PEER_ID, ws, ROOM_TOKEN, ROOM_LEAVE_ID);
  };

  return {
    clients,
    dispatch,
    isJoined: () => joined,
    makeSocket,
  };
};

describe("bounded per-socket signaling FIFO", () => {
  test("exact proved-owner pong bypasses a gated queue and clears its timeout", async () => {
    const gate = deferred();
    const started = deferred();
    const fixture = membershipFixture(false);
    const socket = fixture.makeSocket();
    fixture.clients.set(PEER_ID, socket.ws);
    socket.ws.data.isAlive = false;
    let timeoutFired = false;
    const pongTimeout = setTimeout(() => {
      timeoutFired = true;
    }, 60_000);
    socket.ws.data.pongTimeout = pongTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const clearTimeoutSpy = spyOn(
      globalThis,
      "clearTimeout",
    ).mockImplementation(() => {});
    const handled: string[] = [];

    try {
      const slow = handleSocketMessageIngress(
        fixture.clients,
        socket.ws,
        "slow database frame",
        async (_ws, message) => {
          handled.push(message.toString());
          started.resolve();
          await gate.promise;
        },
      );
      await started.promise;
      const queuedBytes = socket.ws.data.messageQueueBytes;
      socket.ws.data.isAuthenticating = true;

      await handleSocketMessageIngress(
        fixture.clients,
        socket.ws,
        JSON.stringify({ type: "pong", fromPeerId: PEER_ID }),
        async () => {
          throw new Error("exact pong must not enter the signaling queue");
        },
      );

      expect(socket.ws.data.isAlive).toBe(true);
      expect(socket.ws.data.pongTimeout).toBeUndefined();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(pongTimeout);
      expect(socket.ws.data.messageQueue?.map(String)).toEqual([
        "slow database frame",
      ]);
      expect(socket.ws.data.messageQueueBytes).toBe(queuedBytes);
      expect(timeoutFired).toBe(false);

      socket.ws.data.isAuthenticating = false;
      gate.resolve();
      await slow;
      expect(handled).toEqual(["slow database frame"]);
    } finally {
      clearTimeoutSpy.mockRestore();
      realClearTimeout(pongTimeout);
      gate.resolve();
    }
  });

  test("unproved, replaced, and malformed pongs never use the fast path", async () => {
    const fixture = membershipFixture(false);
    const handled: string[] = [];
    const normalHandler = async (_ws: P2PartyWSClient, frame: P2PartyWSMsg) => {
      handled.push(frame.toString());
    };
    const exactPong = JSON.stringify({ type: "pong", fromPeerId: PEER_ID });

    const unproved = fixture.makeSocket();
    unproved.ws.data.isVerified = false;
    fixture.clients.set(PEER_ID, unproved.ws);
    await handleSocketMessageIngress(
      fixture.clients,
      unproved.ws,
      exactPong,
      normalHandler,
    );

    const replaced = fixture.makeSocket();
    const successor = fixture.makeSocket();
    fixture.clients.set(PEER_ID, successor.ws);
    await handleSocketMessageIngress(
      fixture.clients,
      replaced.ws,
      exactPong,
      normalHandler,
    );

    const malformed = fixture.makeSocket();
    fixture.clients.set(PEER_ID, malformed.ws);
    const extraFieldPong = JSON.stringify({
      type: "pong",
      fromPeerId: PEER_ID,
      extra: true,
    });
    await handleSocketMessageIngress(
      fixture.clients,
      malformed.ws,
      extraFieldPong,
      normalHandler,
    );

    expect(handled).toEqual([exactPong, exactPong, extraFieldPong]);
  });

  test("room then leave ends absent with ordered responses", async () => {
    const gate = deferred();
    const started = deferred();
    const fixture = membershipFixture(false, {
      beforeRoomUpsert: async () => {
        started.resolve();
        await gate.promise;
      },
    });
    const socket = fixture.makeSocket();
    fixture.clients.set(PEER_ID, socket.ws);

    const room = enqueueSocketMessage(socket.ws, roomFrame, fixture.dispatch);
    await started.promise;
    const leave = enqueueSocketMessage(socket.ws, leaveFrame, fixture.dispatch);
    gate.resolve();
    await Promise.all([room, leave]);

    expect(fixture.isJoined()).toBe(false);
    expect(socket.sent.map(({ type }) => type)).toEqual(["roomId", "roomLeft"]);
  });

  test("leave then room ends joined with ordered responses", async () => {
    const gate = deferred();
    const started = deferred();
    const fixture = membershipFixture(true, {
      beforePeerDisconnect: async () => {
        started.resolve();
        await gate.promise;
      },
    });
    const socket = fixture.makeSocket();
    fixture.clients.set(PEER_ID, socket.ws);

    const leave = enqueueSocketMessage(socket.ws, leaveFrame, fixture.dispatch);
    await started.promise;
    const room = enqueueSocketMessage(socket.ws, roomFrame, fixture.dispatch);
    gate.resolve();
    await Promise.all([leave, room]);

    expect(fixture.isJoined()).toBe(true);
    expect(socket.sent.map(({ type }) => type)).toEqual(["roomLeft", "roomId"]);
  });

  test("replacement fences and compensates an old in-flight join before successor leave", async () => {
    const gate = deferred();
    const started = deferred();
    const fixture = membershipFixture(false, {
      beforeRoomConnect: async () => {
        started.resolve();
        await gate.promise;
      },
    });
    const oldSocket = fixture.makeSocket();
    const successor = fixture.makeSocket();
    fixture.clients.set(PEER_ID, oldSocket.ws);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const oldRoom = enqueueSocketMessage(
        oldSocket.ws,
        roomFrame,
        fixture.dispatch,
      );
      await started.promise;
      expect(registerVerifiedSocket(fixture.clients, successor.ws)).toBe(true);
      const successorLeave = enqueueSocketMessage(
        successor.ws,
        leaveFrame,
        fixture.dispatch,
      );
      gate.resolve();
      await Promise.all([oldRoom, successorLeave]);
    } finally {
      consoleError.mockRestore();
    }

    expect(fixture.isJoined()).toBe(false);
    expect(oldSocket.sent).toEqual([]);
    expect(successor.sent.map(({ type }) => type)).toEqual(["roomLeft"]);
  });

  test("count and byte overloads close before retaining unbounded work", async () => {
    for (const queued of [
      Array.from({ length: MAX_QUEUED_MESSAGES_PER_SOCKET + 1 }, () => "x"),
      [
        "x".repeat(MAX_QUEUED_MESSAGE_BYTES_PER_SOCKET / 2),
        "x".repeat(MAX_QUEUED_MESSAGE_BYTES_PER_SOCKET / 2),
        "x",
      ],
    ]) {
      const gate = deferred();
      const socket = membershipFixture(false).makeSocket();
      const closeCodes: number[] = [];
      socket.ws.close = ((code?: number) => {
        if (code !== undefined) closeCodes.push(code);
        socket.ws.readyState = 2;
      }) as P2PartyWSClient["close"];
      const first = enqueueSocketMessage(socket.ws, "active", async () => {
        await gate.promise;
      });
      for (const message of queued)
        void enqueueSocketMessage(socket.ws, message, async () => {});

      expect(closeCodes).toEqual([1013]);
      expect(socket.ws.data.messageQueue).toEqual([]);
      expect(socket.ws.data.messageQueueBytes).toBe(0);
      gate.resolve();
      await first;
    }
  });

  test("handler failure closes and clears queued work", async () => {
    const socket = membershipFixture(false).makeSocket();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await enqueueSocketMessage(socket.ws, "boom", async () => {
        throw new Error("boom");
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(socket.ws.readyState).toBe(2);
    expect(socket.ws.data.messageQueue).toEqual([]);
    expect(socket.ws.data.messageQueueBytes).toBe(0);
  });
});

test("different peer mutation queues run concurrently", async () => {
  const gate = deferred();
  const firstStarted = deferred();
  const completed: string[] = [];

  const first = runPeerRoomMutation(
    "00000000-0000-4000-8000-000000000010",
    async () => {
      firstStarted.resolve();
      await gate.promise;
      completed.push("first");
    },
  );
  await firstStarted.promise;
  await runPeerRoomMutation(
    "00000000-0000-4000-8000-000000000011",
    async () => {
      completed.push("second");
    },
  );
  expect(completed).toEqual(["second"]);
  gate.resolve();
  await first;
  expect(completed).toEqual(["second", "first"]);
});
