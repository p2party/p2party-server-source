import { describe, expect, test } from "bun:test";
import { createHandlePeers } from "../../src/utils/handlePeers";
import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const roomId = "00000000-0000-4000-8000-000000000010";
const ids = [1, 2, 3].map(
  (n) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
);
const members = ids.map((id, n) => ({
  id,
  publicKey: (n + 1).toString().repeat(64),
}));
const requestId = "11111111-1111-4111-8111-111111111111";

const fixture = () => {
  let roster = [...members];
  const frames: Record<string, unknown>[][] = [[], [], []];
  const clients = new Map<string, P2PartyWSClient>();
  const sockets = members.map((member, n) => {
    const ws = {
      data: {
        peerId: member.id,
        publicKey: member.publicKey,
        challengeNonce: "",
        challengeId: "",
        socketGeneration: requestId,
        isVerified: true,
        isAuthenticating: false,
        isAlive: false,
      } satisfies P2PartyWSData,
      readyState: 1,
      send: (frame: string) => {
        frames[n].push(JSON.parse(frame));
        return 1;
      },
      close: () => {},
    } as unknown as P2PartyWSClient;
    clients.set(member.id, ws);
    return ws;
  });
  const database = {
    peer: { findUnique: async () => members[0] },
    room: { findUnique: async () => ({ id: roomId, peers: roster }) },
  };
  const handler = createHandlePeers(database as never, {
    clients,
    sendToPeer: async () => true,
  });
  return {
    handler,
    sockets,
    clients,
    frames,
    roster: (next: typeof members) => {
      roster = next;
    },
    database,
  };
};

describe("explicit membership snapshots", () => {
  test("three-member snapshot reaches the requester even when no peer accepts", async () => {
    const f = fixture();
    f.clients.delete(ids[2]); // Offline remains membership; generation is unknown.
    await f.handler(ids[0], f.sockets[0], roomId, requestId);
    expect(f.frames[0]).toEqual([
      {
        type: "peers",
        rosterKind: "snapshot",
        rosterRequestId: requestId,
        roomId,
        peers: [{ ...members[1], socketGeneration: requestId }, members[2]],
        protocolVersion: 4,
      },
    ]);
    expect(f.frames[1][0]?.type).toBe("peerConnection");
  });

  test("terminal exclusions suppress introductions, never censor snapshot membership", async () => {
    const f = fixture();
    await f.handler(ids[0], f.sockets[0], roomId, requestId, [ids[1]]);
    expect((f.frames[0][0]?.peers as unknown[]).length).toBe(2);
    expect(f.frames[1]).toEqual([]);
    expect(f.frames[2][0]?.type).toBe("peerConnection");
  });

  test("legacy requests retain acceptance-only behavior", async () => {
    const f = fixture();
    await f.handler(ids[0], f.sockets[0], roomId);
    expect(f.frames[0]).toEqual([]);
    expect(f.frames[1][0]?.type).toBe("peerConnection");
  });

  test("member targets narrow introductions while exclusions win and snapshots stay complete", async () => {
    const f = fixture();
    await f.handler(ids[0], f.sockets[0], roomId, requestId, [], [ids[2]]);
    expect((f.frames[0][0]?.peers as unknown[]).length).toBe(2);
    expect(f.frames[1]).toEqual([]);
    expect(f.frames[2][0]?.type).toBe("peerConnection");
    f.frames[2].length = 0;
    await f.handler(ids[0], f.sockets[0], roomId, ids[1], [ids[2]], [ids[2]]);
    expect((f.frames[0][1]?.peers as unknown[]).length).toBe(2);
    expect(f.frames[1]).toEqual([]);
    expect(f.frames[2]).toEqual([]);
  });

  test("a later request reflects departures and authoritative empty membership", async () => {
    const f = fixture();
    await f.handler(ids[0], f.sockets[0], roomId, requestId);
    f.roster([members[0]]);
    await f.handler(ids[0], f.sockets[0], roomId, ids[2]);
    expect(f.frames[0][1]?.peers).toEqual([]);
    expect(f.frames[0][1]?.rosterRequestId).toBe(ids[2]);
  });

  test("a requester which left or was displaced gets no snapshot", async () => {
    for (const cause of ["left", "displaced"]) {
      const f = fixture();
      if (cause === "left") f.roster([members[1]]);
      else f.clients.delete(ids[0]);
      await f.handler(ids[0], f.sockets[0], roomId, requestId);
      expect(f.frames[0].some((frame) => frame.type === "peers")).toBe(false);
      expect(f.frames[1]).toEqual([]);
    }
  });

  test("replacement while a room lookup is pending fences snapshot and introductions", async () => {
    const f = fixture();
    f.database.room.findUnique = async () => {
      f.clients.delete(ids[0]);
      return { id: roomId, peers: members };
    };
    await f.handler(ids[0], f.sockets[0], roomId, requestId);
    expect(f.frames).toEqual([[], [], []]);
  });
});
