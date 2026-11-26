import { expect, spyOn, test } from "bun:test";
import { createHandleRoom } from "../../src/utils/handleRoom";
import {
  AdmissionController,
  admissionAddress,
  admissionLimits,
} from "../../src/utils/admission";
import type { P2PartyWSClient } from "../../src/wsServer";

const roomId = "00000000-0000-4000-8000-000000000099";
const roomUrl = "ac".repeat(32);
const requestId = "00000000-0000-4000-8000-000000000098";

const fixture = (
  initialMembers: number,
  ownRooms: number,
  alreadyMember = false,
) => {
  let members = initialMembers,
    writes = 0;
  const frames: Record<string, unknown>[] = [];
  const clients = new Map<string, P2PartyWSClient>();
  const sockets = ["01", "02"].map((suffix) => {
    const ws = {
      data: {
        peerId: `00000000-0000-4000-8000-0000000000${suffix}`,
        publicKey: suffix.repeat(32),
        isVerified: true,
        isAuthenticating: false,
        challengeNonce: "",
        challengeId: "",
        socketGeneration: requestId,
      },
      readyState: 1,
      send: (frame: string) => {
        frames.push(JSON.parse(frame));
        return frame.length;
      },
      terminate: () => {
        throw new Error("healthy socket terminated");
      },
    } as unknown as P2PartyWSClient;
    clients.set(ws.data.peerId, ws);
    return ws;
  });
  const handle = createHandleRoom(
    {
      peer: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          publicKey: clients.get(where.id)!.data.publicKey,
          rooms: alreadyMember ? [{ id: roomId }] : [],
          _count: { rooms: ownRooms },
        }),
      },
      room: {
        upsert: async () => ({ id: roomId, _count: { peers: members } }),
        update: async () => {
          writes++;
          members++;
          return { id: roomId };
        },
      },
    } as never,
    clients,
  );
  return { frames, sockets, handle, writes: () => writes };
};

test("concurrent joins cannot exceed the room-member cap on the supported worker", async () => {
  const f = fixture(admissionLimits.peersPerRoom - 1, 0);
  await Promise.all(
    f.sockets.map((ws) => f.handle(ws.data.peerId, ws, roomUrl, requestId)),
  );
  expect(f.writes()).toBe(1);
  expect(f.frames.filter((frame) => frame.type === "roomId")).toHaveLength(1);
  expect(f.frames.filter((frame) => frame.type === "error")).toHaveLength(1);
});

test("per-identity cap refuses a new membership but preserves an existing membership reconnect", async () => {
  const full = fixture(0, admissionLimits.roomsPerIdentity);
  await full.handle(
    full.sockets[0]!.data.peerId,
    full.sockets[0]!,
    roomUrl,
    requestId,
  );
  expect(full.writes()).toBe(0);
  expect(full.frames[0]?.type).toBe("error");
  const existing = fixture(
    admissionLimits.peersPerRoom,
    admissionLimits.roomsPerIdentity,
    true,
  );
  await existing.handle(
    existing.sockets[0]!.data.peerId,
    existing.sockets[0]!,
    roomUrl,
    requestId,
  );
  expect(existing.frames[0]?.type).toBe("roomId");
});

test("new memberships are charged to the requesting socket's source key", async () => {
  const guard = new AdmissionController(
    { ...admissionLimits, newMembershipsPerMinute: 600 },
    () => 100000,
  );
  const frames: { peer: string; type: string }[] = [];
  const clients = new Map<string, P2PartyWSClient>();
  const joined = new Map<string, number>();
  const socket = (suffix: string, remote: string) => {
    const publicKey = suffix.repeat(32);
    const lease = guard.reserve(
      admissionAddress(remote, null, false)!,
      publicKey,
    )!;
    expect(lease.authenticate()).toBe(true);
    const ws = {
      data: {
        peerId: `00000000-0000-4000-8000-0000000000${suffix}`,
        publicKey,
        isVerified: true,
        isAuthenticating: false,
        challengeNonce: "",
        challengeId: "",
        socketGeneration: requestId,
        admission: lease,
      },
      readyState: 1,
      send: (frame: string) => {
        frames.push({ peer: suffix, ...JSON.parse(frame) });
        return frame.length;
      },
      terminate: () => {
        throw new Error("healthy socket terminated");
      },
    } as unknown as P2PartyWSClient;
    clients.set(ws.data.peerId, ws);
    return ws;
  };
  const handle = createHandleRoom(
    {
      peer: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          publicKey: clients.get(where.id)!.data.publicKey,
          rooms: [],
          _count: { rooms: joined.get(where.id) ?? 0 },
        }),
      },
      room: {
        upsert: async () => ({ id: roomId, _count: { peers: 0 } }),
        update: async ({
          data,
        }: {
          data: { peers: { connect: { id: string } } };
        }) => {
          const id = data.peers.connect.id;
          joined.set(id, (joined.get(id) ?? 0) + 1);
          return { id: roomId };
        },
      },
    } as never,
    clients,
  );
  // Two identities on one /64: one source key.
  const attackers = [
    socket("a1", "2001:db8:aaaa:bbbb::1"),
    socket("a2", "2001:db8:aaaa:bbbb::2"),
  ];
  const victim = socket("b1", "198.51.100.7");
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let room = 0; room < 31; room++) {
      const ws = attackers[room % 2]!;
      await handle(
        ws.data.peerId,
        ws,
        room.toString(16).padStart(64, "0"),
        requestId,
      );
    }
    await handle(victim.data.peerId, victim, "ff".repeat(32), requestId);
  } finally {
    consoleError.mockRestore();
  }
  const attackerFrames = frames.filter(({ peer }) => peer !== "b1");
  // 5% of 600 new memberships per minute.
  expect(attackerFrames.filter(({ type }) => type === "roomId")).toHaveLength(
    30,
  );
  expect(attackerFrames.at(-1)?.type).toBe("error");
  expect(frames.filter(({ peer }) => peer === "b1")).toEqual([
    expect.objectContaining({ peer: "b1", type: "roomId" }),
  ]);
});
