import { describe, expect, spyOn, test } from "bun:test";

// Namespace imports, so on a server without departure signalling each test
// fails on its own instead of the whole file failing to load.
import * as peers from "../../src/utils/handlePeers";
import * as limits from "../../src/utils/admission";
import { createHandleLeaveRoom } from "../../src/utils/handleLeaveRoom";

import type { P2PartyWSClient, P2PartyWSData } from "../../src/wsServer";

const ROOM_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ROOM_ID = "00000000-0000-4000-8000-0000000000a2";
const ROOM_LOCATOR = "cd".repeat(64);
const ROOM_LEAVE_ID = "00000000-0000-4000-8000-0000000000a3";
const OTHER_SERVER = "22222222-2222-4222-8222-222222222222";

/** The departing identity and three room-mates. */
const LEAVER = "00000000-0000-4000-8000-000000000001";
const LOCAL = "00000000-0000-4000-8000-000000000002";
const REMOTE = "00000000-0000-4000-8000-000000000003";
const OFFLINE = "00000000-0000-4000-8000-000000000004";
const LEAVER_GENERATION = "33333333-3333-4333-8333-333333333333";
const SUCCESSOR_GENERATION = "44444444-4444-4444-8444-444444444444";

type Socket = P2PartyWSClient & { sent: string[]; closes: number };

const socket = (
  peerId: string,
  socketGeneration: string,
  verified = true,
): Socket => {
  const data: P2PartyWSData = {
    peerId,
    publicKey: peerId.slice(-1).repeat(64),
    challengeNonce: "",
    challengeId: "",
    socketGeneration,
    isVerified: verified,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    data,
    readyState: 1,
    sent: [] as string[],
    closes: 0,
    send(message: string) {
      this.sent.push(message);
      return message.length;
    },
    close() {
      this.closes += 1;
    },
  };
  return ws as unknown as Socket;
};

const frames = (ws: Socket) => ws.sent.map((frame) => JSON.parse(frame));

/** Frames handed to another instance's queue, as sendToPeerOnServer gets them. */
const routed = () => {
  const calls: { toPeerId: string; serverId: string; frame: unknown }[] = [];
  return {
    calls,
    send: async (toPeerId: string, serverId: string, payload: string) => {
      calls.push({ toPeerId, serverId, frame: JSON.parse(payload) });
      return true;
    },
  };
};

const peerLeft = (
  roomId: string,
  reason: "left" | "offline",
  socketGeneration = LEAVER_GENERATION,
) => ({
  type: "peerLeft",
  roomId,
  peerId: LEAVER,
  reason,
  socketGeneration,
  protocolVersion: 5,
});

/** Room-mates as the membership query returns them, with routing claims. */
const MEMBERS = [
  { id: LOCAL, serverId: "11111111-1111-4111-8111-111111111111" },
  { id: REMOTE, serverId: OTHER_SERVER },
  // The query asks for online members only; one that slips through anyway
  // has no socket anywhere and must get nothing.
  { id: OFFLINE, serverId: null },
];

describe("departure signalling: leave", () => {
  test("leaveRoom notifies members with reason left", async () => {
    const leaver = socket(LEAVER, LEAVER_GENERATION);
    const local = socket(LOCAL, "55555555-5555-4555-8555-555555555555");
    const clients = new Map<string, P2PartyWSClient>([
      [LEAVER, leaver],
      [LOCAL, local],
    ]);
    const order: string[] = [];
    let membershipQuery: unknown;
    const prisma = {
      peer: {
        findUnique: async () => ({
          publicKey: leaver.data.publicKey,
          rooms: [{ id: ROOM_ID }],
        }),
        update: async () => {
          order.push("unlink");
          return {};
        },
      },
      room: {
        findUnique: async (args: unknown) => {
          order.push("members");
          membershipQuery = args;
          return { peers: MEMBERS };
        },
      },
    };
    const remote = routed();

    await createHandleLeaveRoom(
      prisma as never,
      clients,
      peers.createAnnounceRoomLeave(prisma as never, {
        clients,
        sendToPeerOnServer: remote.send,
      }),
    )(LEAVER, leaver, ROOM_LOCATOR, ROOM_LEAVE_ID);

    // Read after the membership row is gone, online members only.
    expect(order).toEqual(["unlink", "members"]);
    expect(membershipQuery).toEqual({
      where: { id: ROOM_ID },
      select: {
        peers: {
          where: { id: { not: LEAVER }, serverId: { not: null } },
          select: { id: true, serverId: true },
        },
      },
    });
    // The leaver hears only its acknowledgement.
    expect(frames(leaver)).toEqual([
      {
        type: "roomLeft",
        protocolVersion: 5,
        roomLocator: ROOM_LOCATOR,
        roomLeaveId: ROOM_LEAVE_ID,
      },
    ]);
    expect(frames(local)).toEqual([peerLeft(ROOM_ID, "left")]);
    expect(Object.keys(frames(local)[0]).sort()).toEqual(
      [
        "type",
        "roomId",
        "peerId",
        "reason",
        "socketGeneration",
        "protocolVersion",
      ].sort(),
    );
    expect(remote.calls).toEqual([
      {
        toPeerId: REMOTE,
        serverId: OTHER_SERVER,
        frame: peerLeft(ROOM_ID, "left"),
      },
    ]);
    expect(leaver.closes).toBe(0);
  });

  test("the handler's own announcer tells local members once, and a repeated leave tells nobody", async () => {
    const leaver = socket(LEAVER, LEAVER_GENERATION);
    const local = socket(LOCAL, "55555555-5555-4555-8555-555555555555");
    const clients = new Map<string, P2PartyWSClient>([
      [LEAVER, leaver],
      [LOCAL, local],
    ]);
    let member = true;
    let membershipReads = 0;
    const prisma = {
      peer: {
        findUnique: async () => ({
          publicKey: leaver.data.publicKey,
          rooms: member ? [{ id: ROOM_ID }] : [],
        }),
        update: async () => {
          member = false;
          return {};
        },
      },
      room: {
        findUnique: async () => {
          membershipReads += 1;
          return { peers: [MEMBERS[0]] };
        },
      },
    };

    // The production wiring: the handler builds its own announcer.
    const leave = createHandleLeaveRoom(prisma as never, clients);
    await leave(LEAVER, leaver, ROOM_LOCATOR, ROOM_LEAVE_ID);
    // The membership is already absent: the same acknowledgement, no frame.
    await leave(LEAVER, leaver, ROOM_LOCATOR, ROOM_LEAVE_ID);

    expect(membershipReads).toBe(1);
    expect(frames(local)).toEqual([peerLeft(ROOM_ID, "left")]);
    expect(frames(leaver).map((frame) => frame.type)).toEqual([
      "roomLeft",
      "roomLeft",
    ]);
  });

  test("a failed announcement keeps the acknowledged leave and the socket", async () => {
    const leaver = socket(LEAVER, LEAVER_GENERATION);
    const clients = new Map<string, P2PartyWSClient>([[LEAVER, leaver]]);
    const prisma = {
      peer: {
        findUnique: async () => ({
          publicKey: leaver.data.publicKey,
          rooms: [{ id: ROOM_ID }],
        }),
        update: async () => ({}),
      },
      room: {
        findUnique: async () => {
          throw new Error("database unavailable");
        },
      },
    };
    const logged: unknown[][] = [];
    const consoleError = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(args);
      },
    );
    try {
      await createHandleLeaveRoom(prisma as never, clients)(
        LEAVER,
        leaver,
        ROOM_LOCATOR,
        ROOM_LEAVE_ID,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(frames(leaver).map((frame) => frame.type)).toEqual(["roomLeft"]);
    expect(leaver.closes).toBe(0);
    // One line, the error's class only: no peer or room identifier.
    expect(logged).toEqual([
      ["p2party: room leave announcement failed", "Error"],
    ]);
  });
});

/** A routing claim with the owner-token semantics of releasePeer. */
const claimOf = (generation: string | null) => {
  let claim = generation;
  return {
    takeOver: (successor: string) => {
      claim = successor;
    },
    release: async (_peerId: string, socketGeneration: string) => {
      if (claim !== socketGeneration) return false;
      claim = null;
      return true;
    },
  };
};

const offlineFixture = (
  options: { claimedByReadTime?: string | null; rooms?: unknown[] } = {},
) => {
  const leaver = socket(LEAVER, LEAVER_GENERATION);
  const local = socket(LOCAL, "55555555-5555-4555-8555-555555555555");
  const clients = new Map<string, P2PartyWSClient>([
    [LEAVER, leaver],
    [LOCAL, local],
  ]);
  const claim = claimOf(LEAVER_GENERATION);
  const remote = routed();
  let membershipReads = 0;
  const prisma = {
    peer: {
      findUnique: async () => {
        membershipReads += 1;
        return {
          serverId: options.claimedByReadTime ?? null,
          rooms: options.rooms ?? [
            { id: ROOM_ID, peers: MEMBERS },
            { id: OTHER_ROOM_ID, peers: [MEMBERS[0]] },
          ],
        };
      },
    },
  };
  const retire = peers.createRetireClosedSocket({
    clients,
    release: claim.release,
    announceOffline: peers.createAnnounceOffline(prisma as never, {
      clients,
      sendToPeerOnServer: remote.send,
    }),
  });
  return {
    leaver,
    local,
    clients,
    claim,
    remote,
    retire,
    membershipReads: () => membershipReads,
  };
};

describe("departure signalling: last socket closed", () => {
  test("socket close notifies with reason offline", async () => {
    const { leaver, local, clients, remote, retire } = offlineFixture();
    leaver.close();

    expect(await retire(leaver)).toBe(3);

    expect(clients.has(LEAVER)).toBe(false);
    // One frame per room the identity is in, to each online member.
    expect(frames(local)).toEqual([
      peerLeft(ROOM_ID, "offline"),
      peerLeft(OTHER_ROOM_ID, "offline"),
    ]);
    expect(remote.calls).toEqual([
      {
        toPeerId: REMOTE,
        serverId: OTHER_SERVER,
        frame: peerLeft(ROOM_ID, "offline"),
      },
    ]);
  });

  test("a socket that never became current announces nothing", async () => {
    const { local, remote, retire, membershipReads } = offlineFixture();
    // Proved or not, a socket that is not the registered one for its id:
    // refused at admission, timed out before its proof, or still activating.
    const stranger = socket(LEAVER, "", false);

    expect(await retire(stranger)).toBe(0);
    expect(membershipReads()).toBe(0);
    expect(local.sent).toEqual([]);
    expect(remote.calls).toEqual([]);
  });

  test("a session replaced on this instance announces nothing", async () => {
    const { leaver, local, clients, claim, retire, membershipReads } =
      offlineFixture();
    const successor = socket(LEAVER, SUCCESSOR_GENERATION);
    // registerVerifiedSocket: the successor takes the registry entry, then
    // the predecessor is closed with the replacement code.
    clients.set(LEAVER, successor);
    claim.takeOver(SUCCESSOR_GENERATION);

    expect(await retire(leaver)).toBe(0);
    expect(membershipReads()).toBe(0);
    expect(local.sent).toEqual([]);
    expect(clients.get(LEAVER)).toBe(successor);
  });

  test("a session replaced on another instance announces nothing", async () => {
    // Still registered here (its eviction row arrived), but the claim names
    // the successor's socket, so the release matches nothing.
    const { leaver, local, claim, retire, membershipReads } = offlineFixture();
    claim.takeOver(SUCCESSOR_GENERATION);

    expect(await retire(leaver)).toBe(0);
    expect(membershipReads()).toBe(0);
    expect(local.sent).toEqual([]);
  });

  test("a successor that claimed before the membership read announces nothing", async () => {
    const { leaver, local, remote, retire, membershipReads } = offlineFixture({
      claimedByReadTime: OTHER_SERVER,
    });

    expect(await retire(leaver)).toBe(0);
    expect(membershipReads()).toBe(1);
    expect(local.sent).toEqual([]);
    expect(remote.calls).toEqual([]);
  });

  test("an identity in no room has no one to tell", async () => {
    const { leaver, local, retire } = offlineFixture({ rooms: [] });

    expect(await retire(leaver)).toBe(0);
    expect(local.sent).toEqual([]);
  });

  test("a failed announcement is logged without identifiers and never throws", async () => {
    const leaver = socket(LEAVER, LEAVER_GENERATION);
    const clients = new Map<string, P2PartyWSClient>([[LEAVER, leaver]]);
    const logged: unknown[][] = [];
    const consoleError = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(args);
      },
    );
    try {
      const retire = peers.createRetireClosedSocket({
        clients,
        release: claimOf(LEAVER_GENERATION).release,
        announceOffline: async () => {
          throw new Error("database unavailable");
        },
      });
      expect(await retire(leaver)).toBe(0);
    } finally {
      consoleError.mockRestore();
    }
    expect(logged).toEqual([["p2party: offline announcement failed", "Error"]]);
  });
});

describe("departure signalling: cost", () => {
  test("offline announcements are bounded per identity per minute", async () => {
    let now = 100_000;
    const admission = new limits.AdmissionController(
      { ...limits.admissionLimits, attemptsPerIpPerMinute: 10_000 },
      () => now,
    );
    const local = socket(LOCAL, "55555555-5555-4555-8555-555555555555");
    const announced: number[] = [];
    // One identity opening and closing sockets from a new address each time,
    // as fast as admission lets it: every close is its last socket.
    const cycle = async () => {
      const lease = admission.reserve(
        `198.51.100.${String(announced.length % 250)}`,
      )!;
      expect(lease.authenticate("identity")).toBe(true);
      const leaver = socket(LEAVER, LEAVER_GENERATION);
      leaver.data.admission = lease;
      const clients = new Map<string, P2PartyWSClient>([
        [LEAVER, leaver],
        [LOCAL, local],
      ]);
      // The close handler releases the lease before it retires the socket.
      lease.release();
      const retire = peers.createRetireClosedSocket({
        clients,
        release: claimOf(LEAVER_GENERATION).release,
        announceOffline: peers.createAnnounceOffline(
          {
            peer: {
              findUnique: async () => ({
                serverId: null,
                rooms: [{ id: ROOM_ID, peers: [MEMBERS[0]] }],
              }),
            },
          } as never,
          { clients, sendToPeerOnServer: async () => true },
        ),
      });
      announced.push(await retire(leaver));
    };

    for (
      let i = 0;
      i < 4 * limits.MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE;
      i++
    )
      await cycle();
    expect(local.sent).toHaveLength(
      limits.MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE,
    );
    expect(
      announced.slice(
        0,
        limits.MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE,
      ),
    ).toEqual(
      Array(limits.MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE).fill(1),
    );

    // The next window admits the next close again.
    now += 60_000;
    await cycle();
    expect(local.sent).toHaveLength(
      limits.MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE + 1,
    );
  });

  test("a socket that never authenticated has no identity to charge", () => {
    const admission = new limits.AdmissionController(limits.admissionLimits);
    const lease = admission.reserve("198.51.100.1")!;
    lease.release();
    expect(lease.offlineAnnouncement()).toBe(false);
  });

  test("departure announcements from one source are bounded across identities", async () => {
    let now = 100_000;
    const admission = new limits.AdmissionController(
      { ...limits.admissionLimits, attemptsPerIpPerMinute: 10_000 },
      () => now,
    );
    // Every room the identity may be in, each with every other seat taken by
    // an online member on another worker: one offline announcement is as
    // large as it can be.
    const member = (n: number) =>
      `00000000-0000-4000-8000-${(0x100000 + n).toString(16).padStart(12, "0")}`;
    const rooms = Array.from(
      { length: limits.admissionLimits.roomsPerIdentity },
      (_, room) => ({
        id: member(room),
        peers: Array.from(
          { length: limits.admissionLimits.peersPerRoom - 1 },
          (_, seat) => ({
            id: member(1_000 + room * 1_000 + seat),
            serverId: OTHER_SERVER,
          }),
        ),
      }),
    );
    let routed = 0;
    let skipped = 0;
    let identities = 0;
    /** A new identity's last socket, from `address`, closing once. */
    const close = async (address: string) => {
      const lease = admission.reserve(address)!;
      expect(lease.authenticate(`identity-${++identities}`)).toBe(true);
      const leaver = socket(LEAVER, LEAVER_GENERATION);
      leaver.data.admission = lease;
      const clients = new Map<string, P2PartyWSClient>([[LEAVER, leaver]]);
      lease.release();
      return peers.createRetireClosedSocket({
        clients,
        release: claimOf(LEAVER_GENERATION).release,
        announceOffline: peers.createAnnounceOffline(
          {
            peer: { findUnique: async () => ({ serverId: null, rooms }) },
          } as never,
          {
            clients,
            sendToPeerOnServer: async () => {
              routed++;
              return true;
            },
            reportSkipped: () => {
              skipped++;
            },
          },
        ),
      })(leaver);
    };
    const full = limits.MAX_FRAMES_PER_OFFLINE_ANNOUNCEMENT;
    const perSource = limits.MAX_DEPARTURE_FRAMES_PER_SOURCE_PER_MINUTE / full;
    const perBlock = limits.MAX_DEPARTURE_FRAMES_PER_IPV6_48_PER_MINUTE / full;
    expect([full, perSource, perBlock]).toEqual([64 * 127, 6, 12]);

    // One IPv4 address, a new identity each time.
    const fromOneAddress = [];
    for (let i = 0; i <= perSource; i++)
      fromOneAddress.push(await close("198.51.100.7"));
    expect(fromOneAddress).toEqual([...Array(perSource).fill(full), 0]);
    expect(await close("198.51.100.8")).toBe(full);

    // One IPv6 /48, a new /64 each time: each /64 has a budget of its own,
    // the /48 one for all of them.
    const fromOneBlock = [];
    for (let i = 0; i <= perBlock; i++)
      fromOneBlock.push(await close(`2001:db8:1:${i.toString(16)}::1`));
    expect(fromOneBlock).toEqual([...Array(perBlock).fill(full), 0]);
    expect(await close("2001:db8:2::1")).toBe(full);

    expect(routed).toBe((perSource + 1 + perBlock + 1) * full);
    expect(skipped).toBe(2);

    // The next window admits the address again.
    now += 60_000;
    expect(await close("198.51.100.7")).toBe(full);
  });

  test("a skipped announcement changes nothing else", async () => {
    const admission = new limits.AdmissionController(limits.admissionLimits);
    // The address has one frame of its budget left.
    const earlier = admission.reserve("198.51.100.9")!;
    expect(earlier.authenticate("earlier")).toBe(true);
    expect(
      earlier.departureFrames(
        limits.MAX_DEPARTURE_FRAMES_PER_SOURCE_PER_MINUTE - 1,
      ),
    ).toBe(true);
    earlier.release();

    const leaver = socket(LEAVER, LEAVER_GENERATION);
    const lease = admission.reserve("198.51.100.9")!;
    expect(lease.authenticate("leaver")).toBe(true);
    leaver.data.admission = lease;
    const local = socket(LOCAL, "55555555-5555-4555-8555-555555555555");
    const clients = new Map<string, P2PartyWSClient>([
      [LEAVER, leaver],
      [LOCAL, local],
    ]);
    const claim = claimOf(LEAVER_GENERATION);
    let unlinked = 0;
    const remote = routed();
    const skips: number[] = [];
    const dependencies = {
      clients,
      sendToPeerOnServer: remote.send,
      reportSkipped: (frames: number) => {
        skips.push(frames);
      },
    };
    const prisma = {
      peer: {
        findUnique: async (args: { select: Record<string, unknown> }) =>
          "rooms" in args.select && "serverId" in args.select
            ? {
                serverId: null,
                rooms: [{ id: ROOM_ID, peers: [MEMBERS[0], MEMBERS[1]] }],
              }
            : { publicKey: leaver.data.publicKey, rooms: [{ id: ROOM_ID }] },
        update: async () => {
          unlinked++;
          return {};
        },
      },
      room: {
        findUnique: async () => ({ peers: [MEMBERS[0], MEMBERS[1]] }),
      },
    };

    // A leave whose two frames do not fit: acknowledged and done as before.
    await createHandleLeaveRoom(
      prisma as never,
      clients,
      peers.createAnnounceRoomLeave(prisma as never, dependencies),
    )(LEAVER, leaver, ROOM_LOCATOR, ROOM_LEAVE_ID);
    expect(unlinked).toBe(1);
    expect(frames(leaver).map((frame) => frame.type)).toEqual(["roomLeft"]);
    expect(leaver.closes).toBe(0);

    // The last socket closing: retired and released as before.
    expect(
      await peers.createRetireClosedSocket({
        clients,
        release: claim.release,
        announceOffline: peers.createAnnounceOffline(
          prisma as never,
          dependencies,
        ),
      })(leaver),
    ).toBe(0);
    expect(clients.has(LEAVER)).toBe(false);
    expect(await claim.release(LEAVER, LEAVER_GENERATION)).toBe(false);

    // Nothing reached a member, both skips were counted, and the budget was
    // not charged for them: an announcement of one frame still fits.
    expect(local.sent).toEqual([]);
    expect(remote.calls).toEqual([]);
    expect(skips).toEqual([2, 2]);
    expect(lease.departureFrames(1)).toBe(true);
    expect(lease.departureFrames(1)).toBe(false);
  });

  test("skipped announcements are reported once a minute, as counts", () => {
    let now = 0;
    const report = peers.createSkippedDepartureReport(() => now);
    const warned: unknown[][] = [];
    const consoleWarn = spyOn(console, "warn").mockImplementation(
      (...args: unknown[]) => {
        warned.push(args);
      },
    );
    try {
      report(127);
      now += 1_000;
      report(8_128);
      now += 1_000;
      report(1);
      now += 60_000;
      report(2);
    } finally {
      consoleWarn.mockRestore();
    }
    expect(warned).toEqual([
      [
        "p2party: skipped 1 departure announcement(s) of 127 frame(s) over the per-source departure budget",
      ],
      [
        "p2party: skipped 3 departure announcement(s) of 8131 frame(s) over the per-source departure budget",
      ],
    ]);
  });
});

describe("departure signalling: ordering", () => {
  test("an introduction names the requesting socket's generation", async () => {
    // A member that was told this identity departed compares the departure's
    // generation with this one, so a stale departure after the return is
    // recognised (the SDK's peerLeft handling).
    const requester = socket(LEAVER, SUCCESSOR_GENERATION);
    const member = socket(LOCAL, "55555555-5555-4555-8555-555555555555");
    const clients = new Map<string, P2PartyWSClient>([
      [LEAVER, requester],
      [LOCAL, member],
    ]);
    const handler = peers.createHandlePeers(
      {
        peer: {
          findUnique: async () => ({
            id: LEAVER,
            publicKey: requester.data.publicKey,
          }),
        },
        room: {
          findUnique: async () => ({
            id: ROOM_ID,
            peers: [
              { id: LEAVER, publicKey: requester.data.publicKey },
              { id: LOCAL, publicKey: member.data.publicKey },
            ],
          }),
        },
      } as never,
      { clients, sendToPeer: async () => true },
    );

    await handler(LEAVER, requester, ROOM_ID);

    expect(frames(member)).toEqual([
      {
        type: "peerConnection",
        roomId: ROOM_ID,
        peer: {
          id: LEAVER,
          publicKey: requester.data.publicKey,
          socketGeneration: SUCCESSOR_GENERATION,
        },
        protocolVersion: 5,
      },
    ]);
  });
});
