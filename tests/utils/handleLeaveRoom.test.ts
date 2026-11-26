import { describe, expect, spyOn, test } from "bun:test";

import { createHandleLeaveRoom } from "../../src/utils/handleLeaveRoom";

import type { ProcessPrismaClient } from "../../src/prismaClient";
import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";
const ROOM_ID = "00000000-0000-4000-8000-000000000002";
const ROOM_TOKEN = "cd".repeat(32);
const ROOM_LEAVE_ID = "00000000-0000-4000-8000-000000000003";
const PUBLIC_KEY = "ab".repeat(32);

type HandleLeaveRoomPrisma = Pick<ProcessPrismaClient, "peer" | "room">;

/** No other member is online, so a leave announces nothing. */
const emptyRoom = { findUnique: async () => ({ peers: [] }) };

const fakeSocket = () => {
  const sent: string[] = [];
  let closeCalls = 0;
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
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    close: () => {
      closeCalls += 1;
    },
  } as unknown as P2PartyWSClient;

  return { ws, sent, closeCalls: () => closeCalls };
};

const registryFor = (ws: P2PartyWSClient) =>
  new Map<string, P2PartyWSClient>([[PEER_ID, ws]]);

const acknowledgement = {
  type: "roomLeft",
  protocolVersion: 4,
  roomUrl: ROOM_TOKEN,
  roomLeaveId: ROOM_LEAVE_ID,
};

describe("authenticated idempotent room leave", () => {
  test("unlinks membership before sending the exact correlated acknowledgement", async () => {
    const socket = fakeSocket();
    const order: string[] = [];
    let updateArgs: unknown;
    const prisma = {
      peer: {
        findUnique: async () => {
          order.push("find");
          return { publicKey: PUBLIC_KEY, rooms: [{ id: ROOM_ID }] };
        },
        update: async (args: unknown) => {
          order.push("unlink");
          updateArgs = args;
          return {};
        },
      },
      room: emptyRoom,
    } as unknown as HandleLeaveRoomPrisma;
    const send = socket.ws.send.bind(socket.ws);
    socket.ws.send = ((message: string | ArrayBufferView) => {
      order.push("ack");
      return send(message as string);
    }) as P2PartyWSClient["send"];

    await createHandleLeaveRoom(prisma, registryFor(socket.ws))(
      PEER_ID,
      socket.ws,
      ROOM_TOKEN,
      ROOM_LEAVE_ID,
    );

    expect(order).toEqual(["find", "unlink", "ack"]);
    expect(updateArgs).toEqual({
      where: { id: PEER_ID },
      data: { rooms: { disconnect: { id: ROOM_ID } } },
    });
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      acknowledgement,
    ]);
    expect(Object.keys(JSON.parse(socket.sent[0]!)).sort()).toEqual(
      ["type", "protocolVersion", "roomUrl", "roomLeaveId"].sort(),
    );
    expect(socket.closeCalls()).toBe(0);
  });

  test("already-absent membership gets the identical ack without an update", async () => {
    const socket = fakeSocket();
    let updates = 0;
    const prisma = {
      peer: {
        findUnique: async () => ({ publicKey: PUBLIC_KEY, rooms: [] }),
        update: async () => {
          updates += 1;
          return {};
        },
      },
      room: emptyRoom,
    } as unknown as HandleLeaveRoomPrisma;

    await createHandleLeaveRoom(prisma, registryFor(socket.ws))(
      PEER_ID,
      socket.ws,
      ROOM_TOKEN,
      ROOM_LEAVE_ID,
    );

    expect(updates).toBe(0);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      acknowledgement,
    ]);
    expect(socket.closeCalls()).toBe(0);
  });

  test("a concurrent duplicate disconnect remains idempotent", async () => {
    const socket = fakeSocket();
    const prisma = {
      peer: {
        findUnique: async () => ({
          publicKey: PUBLIC_KEY,
          rooms: [{ id: ROOM_ID }],
        }),
        update: async () => {
          throw { code: "P2017" };
        },
      },
      room: emptyRoom,
    } as unknown as HandleLeaveRoomPrisma;

    await createHandleLeaveRoom(prisma, registryFor(socket.ws))(
      PEER_ID,
      socket.ws,
      ROOM_TOKEN,
      ROOM_LEAVE_ID,
    );

    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      acknowledgement,
    ]);
    expect(socket.closeCalls()).toBe(0);
  });

  test("identity mismatch and database failures close without acknowledging", async () => {
    for (const failure of [
      async () => ({ publicKey: "cd".repeat(32), rooms: [] }),
      async () => {
        throw new Error("database unavailable");
      },
    ]) {
      const socket = fakeSocket();
      const prisma = {
        peer: {
          findUnique: failure,
          update: async () => ({}),
        },
        room: emptyRoom,
      } as unknown as HandleLeaveRoomPrisma;
      const consoleError = spyOn(console, "error").mockImplementation(() => {});

      try {
        await createHandleLeaveRoom(prisma, registryFor(socket.ws))(
          PEER_ID,
          socket.ws,
          ROOM_TOKEN,
          ROOM_LEAVE_ID,
        );
      } finally {
        consoleError.mockRestore();
      }

      expect(socket.sent).toEqual([]);
      expect(socket.closeCalls()).toBe(1);
    }
  });

  test("a socket replaced during unlink cannot receive the acknowledgement", async () => {
    const socket = fakeSocket();
    const replacement = fakeSocket();
    const clients = registryFor(socket.ws);
    let finishUnlink!: () => void;
    const unlink = new Promise<void>((resolve) => {
      finishUnlink = resolve;
    });
    const prisma = {
      peer: {
        findUnique: async () => ({
          publicKey: PUBLIC_KEY,
          rooms: [{ id: ROOM_ID }],
        }),
        update: async () => unlink,
      },
      room: emptyRoom,
    } as unknown as HandleLeaveRoomPrisma;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const leave = createHandleLeaveRoom(prisma, clients)(
        PEER_ID,
        socket.ws,
        ROOM_TOKEN,
        ROOM_LEAVE_ID,
      );
      await Promise.resolve();
      clients.set(PEER_ID, replacement.ws);
      socket.ws.data.isVerified = false;
      finishUnlink();
      await leave;
    } finally {
      consoleError.mockRestore();
    }

    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls()).toBe(1);
  });
});
