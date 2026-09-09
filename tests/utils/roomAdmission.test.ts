import { expect, test } from "bun:test";
import { createHandleRoom } from "../../src/utils/handleRoom";
import { admissionLimits } from "../../src/utils/admission";
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
