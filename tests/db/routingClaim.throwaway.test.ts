import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";

import { pruneExpiredMemberships } from "../../src/utils/roomRetention";
import { releasePeer } from "../../src/pubsub";
import {
  AdmissionController,
  admissionAddress,
  admissionLimits,
} from "../../src/utils/admission";
import { createFindRoomTarget } from "../../src/utils/findRoomPeers";
import {
  createPersistVerifiedIdentity,
  createUndoIdentityCommit,
  provisionalPeerId,
} from "../../src/utils/peerIdentity";
import {
  describeWithThrowawayPostgres,
  freshDatabase,
  type ThrowawayDatabase,
} from "./throwawayPostgres";

import type { AdmissionLease } from "../../src/utils/admission";
import type { P2PartyWSClient } from "../../src/wsServer";

const WORKER_1 = "11111111-1111-4111-8111-111111111111";
const WORKER_2 = "22222222-2222-4222-8222-222222222222";

const provedSocket = (publicKey: string, admission?: AdmissionLease) =>
  ({
    data: {
      peerId: provisionalPeerId(publicKey),
      publicKey,
      isVerified: true,
      isAuthenticating: false,
      socketGeneration: randomUUID(),
      challengeNonce: "",
      challengeId: "",
      isAlive: true,
      admission,
    },
    readyState: 1,
    send: () => 1,
    close: () => {},
  }) as unknown as P2PartyWSClient;

const claimOf = async (db: ThrowawayDatabase, peerId: string) =>
  db.prisma.peer.findUnique({
    where: { id: peerId },
    select: { serverId: true, socketGeneration: true },
  });

/** Admission with a creation budget of `budget` per minute, at a fixed time. */
const budgeted = (budget: number) => {
  const guard = new AdmissionController(
    { ...admissionLimits, newIdentitiesPerMinute: budget },
    () => 1_000_000,
  );
  let address = 0;
  return (key: string) => {
    const lease = guard.reserve(
      admissionAddress(`198.51.100.${String(++address)}`, null, false)!,
    )!;
    expect(lease.authenticate(key)).toBe(true);
    return lease;
  };
};

let database: ThrowawayDatabase | undefined;
afterEach(async () => {
  await database?.drop();
  database = undefined;
});

describeWithThrowawayPostgres("routing claims against PostgreSQL", () => {
  test("two concurrent creations at one below the cap admit exactly one", async () => {
    database = await freshDatabase();
    const { prisma } = database;
    const persist = createPersistVerifiedIdentity(prisma, () => true, 2);
    const connect = () =>
      persist(provedSocket(randomBytes(32).toString("hex")));
    await connect();
    const results = await Promise.allSettled([connect(), connect()]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const refused = results.find(({ status }) => status === "rejected");
    expect(refused?.status === "rejected" && String(refused.reason)).toContain(
      "capacity",
    );
    expect(await prisma.peer.count()).toBe(2);
  }, 60_000);

  test("concurrent retention removes expired memberships and memberless identities, preserving recent and online peers", async () => {
    database = await freshDatabase();
    const { prisma } = database;
    const now = Date.now();
    const old = BigInt(now - 91 * 86400000);
    const create = (lastPing: bigint, serverId: string | null = null) =>
      prisma.peer.create({
        data: {
          publicKey: randomBytes(32).toString("hex"),
          createdAt: new Date(Number(lastPing)),
          lastPing,
          serverId,
        },
      });
    const [member, empty, recent, online] = await Promise.all([
      create(old),
      create(old),
      create(BigInt(now)),
      create(old, WORKER_1),
    ]);
    const room = await prisma.room.create({
      data: {
        identifier: randomBytes(64).toString("hex"),
        peers: { connect: [member, recent, online].map(({ id }) => ({ id })) },
      },
    });
    const counts = await Promise.all([
      pruneExpiredMemberships(prisma, now),
      pruneExpiredMemberships(prisma, now),
    ]);
    expect(counts[0]! + counts[1]!).toBe(2);
    expect(
      await prisma.peer.count({ where: { id: { in: [member.id, empty.id] } } }),
    ).toBe(0);
    const members = await prisma.peer.findMany({
      where: { rooms: { some: { id: room.id } } },
      select: { id: true },
    });
    expect(members.map(({ id }) => id).sort()).toEqual(
      [recent.id, online.id].sort(),
    );
  }, 60_000);

  test("cap pressure reclaims the least recently authenticated offline members and preserves online or just-disconnected identities", async () => {
    database = await freshDatabase();
    const { prisma } = database;
    const now = Date.now();
    const room = await prisma.room.create({
      data: { identifier: randomBytes(64).toString("hex") },
    });
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) {
      const peer = await prisma.peer.create({
        data: {
          publicKey: randomBytes(32).toString("hex"),
          lastPing: BigInt(now - (100 - i) * 86400000),
          updatedAt: new Date(i === 1 ? now : now - 86400000),
          serverId: i === 0 ? WORKER_2 : null,
          rooms: { connect: { id: room.id } },
        },
      });
      ids.push(peer.id);
    }
    const persist = createPersistVerifiedIdentity(
      prisma,
      () => true,
      ids.length,
      () => now,
    );
    expect(
      await persist(provedSocket(randomBytes(32).toString("hex"))),
    ).toMatchObject({ created: true });
    const members = await prisma.peer.findMany({
      where: { rooms: { some: { id: room.id } } },
    });
    expect(members.map(({ id }) => id).sort()).toEqual(
      [ids[0]!, ids[1]!, ids[11]!, ids[12]!].sort(),
    );
  }, 60_000);

  test("a late release from an old socket does not clear the new socket's claim", async () => {
    database = await freshDatabase();
    const db = database;
    const key = randomBytes(32).toString("hex");
    const peerId = provisionalPeerId(key);
    const persistOn = (serverId: string) =>
      createPersistVerifiedIdentity(
        db.prisma,
        () => true,
        admissionLimits.persistentIdentities,
        Date.now,
        serverId,
      );
    const old = provedSocket(key);
    const sameWorker = provedSocket(key);
    const otherWorker = provedSocket(key);

    expect(await persistOn(WORKER_1)(old)).toMatchObject({ created: true });

    // Same worker: a successor's commit, then the old socket's late release.
    expect(await persistOn(WORKER_1)(sameWorker)).toEqual({
      created: false,
      replaced: {
        serverId: WORKER_1,
        socketGeneration: old.data.socketGeneration,
      },
    });
    await releasePeer(peerId, old.data.socketGeneration, db.prisma, WORKER_1);
    expect(await claimOf(db, peerId)).toEqual({
      serverId: WORKER_1,
      socketGeneration: sameWorker.data.socketGeneration,
    });

    // Cross worker: a login on worker 2, then worker 1's late release for
    // the socket it lost.
    expect(await persistOn(WORKER_2)(otherWorker)).toEqual({
      created: false,
      replaced: {
        serverId: WORKER_1,
        socketGeneration: sameWorker.data.socketGeneration,
      },
    });
    await releasePeer(
      peerId,
      sameWorker.data.socketGeneration,
      db.prisma,
      WORKER_1,
    );
    expect(await claimOf(db, peerId)).toEqual({
      serverId: WORKER_2,
      socketGeneration: otherWorker.data.socketGeneration,
    });

    // The owner's own release does clear it.
    await releasePeer(
      peerId,
      otherWorker.data.socketGeneration,
      db.prisma,
      WORKER_2,
    );
    expect(await claimOf(db, peerId)).toEqual({
      serverId: null,
      socketGeneration: null,
    });
  }, 60_000);

  test("two racing first-time sockets of one key are charged once", async () => {
    database = await freshDatabase();
    const db = database;
    for (let round = 0; round < 3; round++) {
      const key = randomBytes(32).toString("hex");
      const lease = budgeted(2);
      // Hold each transaction after its first read until both have read, so
      // both see no row and both try to insert: a real race, every round.
      let readers = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempts: number[] = [];
      const racing = {
        $transaction: (
          run: (tx: unknown) => Promise<unknown>,
          options: unknown,
        ) =>
          db.prisma.$transaction(async (tx) => {
            const attempt = attempts.push(1);
            return run(
              new Proxy(tx, {
                get: (target, model) =>
                  model !== "peer"
                    ? Reflect.get(target, model)
                    : new Proxy(target.peer, {
                        get: (peer, operation) =>
                          operation !== "findUnique" || attempt > 2
                            ? Reflect.get(peer, operation)
                            : async (args: never) => {
                                const found = await peer.findUnique(args);
                                if (++readers === 2) release();
                                await bothRead;
                                return found;
                              },
                      }),
              }),
            );
          }, options as never),
      };
      const persist = createPersistVerifiedIdentity(racing as never);

      const results = await Promise.all([
        persist(provedSocket(key, lease(key))),
        persist(provedSocket(key, lease(key))),
      ]);

      // One insert won; the loser retried, found it, and committed as a
      // second socket of the identity.
      expect(results.map((r) => r && r.created).sort()).toEqual([false, true]);
      expect(attempts.length).toBe(3);
      expect(await db.prisma.peer.count({ where: { publicKey: key } })).toBe(1);
      // One creation spent of a budget of two: one more is admitted, then
      // none.
      expect(lease("cd".repeat(32)).newIdentity()).toBe(true);
      expect(lease("ef".repeat(32)).newIdentity()).toBe(false);
    }
  }, 60_000);

  test("a failed routing claim leaves no identity row and no charge", async () => {
    database = await freshDatabase();
    const db = database;
    // Every claim write fails, as a database fault at that statement would.
    await db.client.query(`
      CREATE FUNCTION refuse_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."serverId" IS NOT NULL THEN RAISE EXCEPTION 'claim refused'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_claim BEFORE INSERT OR UPDATE ON "Peer"
        FOR EACH ROW EXECUTE FUNCTION refuse_claim();
    `);
    const key = randomBytes(32).toString("hex");
    const lease = budgeted(1);
    const persist = createPersistVerifiedIdentity(db.prisma);

    await expect(persist(provedSocket(key, lease(key)))).rejects.toThrow();
    expect(await db.prisma.peer.count()).toBe(0);
    // The budget of one is unspent.
    expect(lease("cd".repeat(32)).newIdentity()).toBe(true);
  }, 60_000);

  test("a socket that fails after its commit leaves no identity row and no charge", async () => {
    database = await freshDatabase();
    const db = database;
    const key = randomBytes(32).toString("hex");
    const lease = budgeted(1);
    const ws = provedSocket(key, lease(key));
    const persist = createPersistVerifiedIdentity(
      db.prisma,
      undefined,
      undefined,
      undefined,
      WORKER_1,
    );
    const undo = createUndoIdentityCommit(db.prisma, WORKER_1);

    const commit = await persist(ws);
    expect(commit).toEqual({ created: true, replaced: null });
    expect(await db.prisma.peer.count()).toBe(1);
    // The socket closed before it became current: activation undoes.
    expect(await undo(ws, commit as never)).toBe(true);
    expect(await db.prisma.peer.count()).toBe(0);
    expect(lease("cd".repeat(32)).newIdentity()).toBe(true);
  }, 60_000);

  test("a failed successor gives the replaced claim back", async () => {
    database = await freshDatabase();
    const db = database;
    const key = randomBytes(32).toString("hex");
    const persist = createPersistVerifiedIdentity(
      db.prisma,
      () => true,
      undefined,
      undefined,
      WORKER_1,
    );
    const undo = createUndoIdentityCommit(db.prisma, WORKER_1);
    const old = provedSocket(key);
    const successor = provedSocket(key);
    await persist(old);

    const commit = await persist(successor);
    expect(await undo(successor, commit as never)).toBe(true);
    expect(await claimOf(db, provisionalPeerId(key))).toEqual({
      serverId: WORKER_1,
      socketGeneration: old.data.socketGeneration,
    });
  }, 60_000);

  test("the relay finds a target only when both are members of the room", async () => {
    database = await freshDatabase();
    const db = database;
    const keys = ["a1", "b2", "c3"].map((byte) => byte.repeat(32));
    const [sender, target, outsider] = keys.map((key) => ({
      key,
      id: provisionalPeerId(key),
    }));
    for (const { id, key } of [sender!, target!, outsider!])
      await db.prisma.peer.create({
        data: { id, publicKey: key, lastPing: 0n, serverId: WORKER_2 },
      });
    const room = "00000000-0000-4000-8000-0000000000a1";
    const otherRoom = "00000000-0000-4000-8000-0000000000a2";
    await db.prisma.room.create({
      data: {
        id: room,
        identifier: "a",
        peers: { connect: [{ id: sender!.id }, { id: target!.id }] },
      },
    });
    await db.prisma.room.create({
      data: {
        id: otherRoom,
        identifier: "b",
        peers: { connect: [{ id: outsider!.id }] },
      },
    });
    const socketOf = (peer: { id: string; key: string }, key = peer.key) =>
      ({
        data: {
          peerId: peer.id,
          publicKey: key,
          isVerified: true,
          isAuthenticating: false,
          socketGeneration: randomUUID(),
        },
        readyState: 1,
      }) as unknown as P2PartyWSClient;
    const senderSocket = socketOf(sender!);
    const outsiderSocket = socketOf(outsider!);
    const clients = new Map([
      [sender!.id, senderSocket],
      [outsider!.id, outsiderSocket],
    ]);
    const find = createFindRoomTarget(db.prisma, clients);
    const missing = "00000000-0000-4000-8000-0000000000ff";

    expect(await find(senderSocket, room, sender!.id, target!.id)).toEqual({
      serverId: WORKER_2,
    });
    for (const [roomId, toPeerId] of [
      [room, outsider!.id],
      [room, missing],
      [missing, target!.id],
      [otherRoom, outsider!.id],
    ])
      expect(
        await find(senderSocket, roomId!, sender!.id, toPeerId!),
      ).toBeUndefined();
    expect(
      await find(outsiderSocket, room, outsider!.id, target!.id),
    ).toBeUndefined();
    // A socket whose proved key is not the member's key relays nothing.
    const impostor = socketOf(sender!, "dd".repeat(32));
    clients.set(sender!.id, impostor);
    expect(await find(impostor, room, sender!.id, target!.id)).toBeUndefined();
  }, 60_000);
});
