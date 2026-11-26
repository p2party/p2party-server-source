import { describe, expect, test } from "bun:test";
import { createHandleConnection } from "../../src/utils/handleConnection";
import {
  createPersistVerifiedIdentity,
  provisionalPeerId,
} from "../../src/utils/peerIdentity";
import {
  AdmissionController,
  admissionAddress,
  admissionLimits,
} from "../../src/utils/admission";
import { isUUID } from "../../src/utils/formats";
import type { AdmissionLease } from "../../src/utils/admission";
import type { P2PartyWSClient } from "../../src/wsServer";

const key = "ab".repeat(32);
const socket = (verified = false, id = provisionalPeerId(key)) =>
  ({
    data: { peerId: id, publicKey: key, isVerified: verified },
    readyState: 1,
    send: () => 1,
    close: () => {},
  }) as unknown as P2PartyWSClient;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 400 * DAY;

interface PeerRow {
  id: string;
  publicKey: string;
  createdAt: Date;
  updatedAt: Date;
  serverId: string | null;
  rooms: number;
}

/**
 * An in-memory Peer table that evaluates the subset of Prisma filters the
 * identity path uses and rolls back when the transaction callback throws.
 * Any other filter fails the test instead of silently matching.
 */
const peerTable = (rows: PeerRow[]) => {
  const instant = (value: unknown) => (value as Date).getTime();
  const matches = (row: PeerRow, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([field, condition]) => {
      if (field === "rooms") {
        expect(condition).toEqual({ none: {} });
        return row.rooms === 0;
      }
      if (field === "serverId") {
        expect(condition).toBeNull();
        return row.serverId === null;
      }
      if (field === "id")
        return (condition as { in: string[] }).in.includes(row.id);
      if (field === "createdAt" || field === "updatedAt")
        return Object.entries(condition as Record<string, unknown>).every(
          ([operator, bound]) => {
            if (operator === "gte")
              return row[field].getTime() >= instant(bound);
            if (operator === "lt") return row[field].getTime() < instant(bound);
            throw new Error(`unsupported ${field} operator ${operator}`);
          },
        );
      throw new Error(`unsupported Peer filter ${field}`);
    });
  const peer = {
    findUnique: async ({ where }: { where: { publicKey: string } }) =>
      rows.find(({ publicKey }) => publicKey === where.publicKey) ?? null,
    count: async (query?: { where?: Record<string, unknown> }) =>
      rows.filter((row) => matches(row, query?.where)).length,
    findMany: async (query: {
      where: Record<string, unknown>;
      orderBy: { updatedAt: "asc" };
      take: number;
    }) => {
      expect(query.orderBy).toEqual({ updatedAt: "asc" });
      return rows
        .filter((row) => matches(row, query.where))
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, query.take)
        .map(({ id }) => ({ id }));
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const kept = rows.filter((row) => !matches(row, where));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    },
    upsert: async ({
      where,
      create,
    }: {
      where: { publicKey: string };
      create: { id: string; publicKey: string };
    }) => {
      const existing = rows.find(
        ({ publicKey }) => publicKey === where.publicKey,
      );
      if (existing) {
        existing.updatedAt = new Date(NOW);
        return existing;
      }
      const row = {
        ...create,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
        serverId: null,
        rooms: 0,
      };
      rows.push(row);
      return row;
    },
  };
  return {
    rows,
    database: {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const snapshot = rows.map((row) => ({ ...row }));
        try {
          return await run({ peer });
        } catch (error) {
          rows.splice(0, rows.length, ...snapshot);
          throw error;
        }
      },
    } as never,
  };
};

const existingRow = (
  id: string,
  ageMs: number,
  lastSeenMs: number,
  options: Partial<PeerRow> = {},
): PeerRow => ({
  id,
  publicKey: id.padStart(64, "0"),
  createdAt: new Date(NOW - ageMs),
  updatedAt: new Date(NOW - lastSeenMs),
  serverId: null,
  rooms: 0,
  ...options,
});

const provedSocket = (publicKey: string, admission?: AdmissionLease) =>
  ({
    data: {
      peerId: provisionalPeerId(publicKey),
      publicKey,
      isVerified: true,
      admission,
    },
    readyState: 1,
    send: () => 1,
    close: () => {},
  }) as unknown as P2PartyWSClient;

const outcome = (attempt: Promise<boolean>) =>
  attempt.then(
    (persisted) => (persisted ? "persisted" : "inactive"),
    (error: Error) => error.message,
  );

describe("proof-gated durable identity", () => {
  test("repeated unproved connections only read, and their stable candidate survives a new process", async () => {
    let reads = 0;
    const bootstrap = createHandleConnection({
      peer: {
        findUnique: async () => {
          reads++;
          return null;
        },
        upsert: () => {
          throw new Error("unauthenticated write attempted");
        },
      },
    } as never);
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => bootstrap(key, socket())),
    );
    expect(reads).toBe(12);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(provisionalPeerId(key));
    expect(isUUID(ids[0], 4)).toBe(true);
    expect(provisionalPeerId("cd".repeat(32))).not.toBe(ids[0]);
  });

  test("existing pre-release random peer IDs are preserved", async () => {
    const oldId = "00000000-0000-4000-8000-000000000001";
    const bootstrap = createHandleConnection({
      peer: { findUnique: async () => ({ id: oldId }) },
    } as never);
    expect(await bootstrap(key, socket())).toBe(oldId);
  });

  test("invalid proof or closed socket cannot start a persistence transaction", async () => {
    const persist = createPersistVerifiedIdentity({
      $transaction: () => {
        throw new Error("unexpected database call");
      },
    } as never);
    expect(await persist(socket(false))).toBe(false);
    const closed = socket(true);
    Object.assign(closed, { readyState: 3 });
    expect(await persist(closed)).toBe(false);
  });

  test("new identity capacity is checked in the same serializable transaction as insertion", async () => {
    let count = 0,
      writes = 0,
      isolation = "";
    const database = {
      $transaction: async (
        run: (tx: unknown) => unknown,
        options: { isolationLevel: string },
      ) => {
        isolation = options.isolationLevel;
        return run({
          peer: {
            findUnique: async () => null,
            count: async () => count,
            // Near the cap the path first looks for prunable identities.
            findMany: async () => [],
            deleteMany: async () => ({ count: 0 }),
            upsert: async () => {
              writes++;
            },
          },
        });
      },
    } as never;
    const persist = createPersistVerifiedIdentity(database, () => true, 2);
    expect(await persist(socket(true))).toBe(true);
    expect(isolation).toBe("Serializable");
    expect(writes).toBe(1);
    count = 2;
    await expect(persist(socket(true))).rejects.toThrow("capacity");
    expect(writes).toBe(1);
  });

  test("a rollout race with a different persisted ID refuses activation", async () => {
    let writes = 0;
    const persist = createPersistVerifiedIdentity({
      $transaction: async (run: (tx: unknown) => unknown) =>
        run({
          peer: {
            findUnique: async () => ({
              id: "00000000-0000-4000-8000-000000000001",
            }),
            upsert: async () => {
              writes++;
            },
          },
        }),
    } as never);
    await expect(persist(socket(true))).rejects.toThrow("reconnect required");
    expect(writes).toBe(0);
  });

  test("identity creation is charged to the socket's source key", async () => {
    const guard = new AdmissionController(
      { ...admissionLimits, newIdentitiesPerMinute: 120 },
      () => NOW,
    );
    const { database, rows } = peerTable([]);
    // Default admission: the socket's own lease, not a process-wide counter.
    const persist = createPersistVerifiedIdentity(database, undefined, 1000);
    const attempt = (remote: string, publicKey: string) => {
      const lease = guard.reserve(
        admissionAddress(remote, null, false)!,
        publicKey,
      )!;
      expect(lease.authenticate()).toBe(true);
      return outcome(persist(provedSocket(publicKey, lease)));
    };
    const fromOneSlash64: string[] = [];
    for (let i = 1; i <= 7; i++)
      fromOneSlash64.push(
        await attempt(
          `2001:db8:aaaa:bbbb::${i}`,
          i.toString(16).padStart(2, "0").repeat(32),
        ),
      );
    // 5% of 120 new identities per minute.
    expect(fromOneSlash64).toEqual([
      ...Array(6).fill("persisted"),
      "Identity admission capacity reached",
    ]);
    expect(await attempt("198.51.100.7", "ee".repeat(32))).toBe("persisted");
    expect(rows).toHaveLength(7);
  });

  test("memberless old identities are pruned before refusing", async () => {
    const { database, rows } = peerTable([
      existingRow("member", 10 * DAY, 2 * DAY, { rooms: 1 }),
      existingRow("online", 10 * DAY, 2 * DAY, { serverId: "server" }),
      existingRow("young", HOUR, HOUR),
      // Old but mid-activation: persisted moments ago, not yet claimed.
      existingRow("activating", 10 * DAY, 1000),
      existingRow("memberless", 3 * DAY, 2 * DAY),
    ]);
    const persist = createPersistVerifiedIdentity(
      database,
      () => true,
      5,
      () => NOW,
    );
    expect(await outcome(persist(provedSocket("01".repeat(32))))).toBe(
      "persisted",
    );
    expect(rows.map(({ id }) => id)).toEqual([
      "member",
      "online",
      "young",
      "activating",
      provisionalPeerId("01".repeat(32)),
    ]);
    // Nothing left to prune: the cap refuses and the transaction rolls back.
    expect(await outcome(persist(provedSocket("02".repeat(32))))).toBe(
      "Identity admission capacity reached",
    );
    expect(rows).toHaveLength(5);
  });

  test("the identity cap counts only identities seen inside the retention period", async () => {
    const retentionMs = admissionLimits.membershipTtlDays * DAY;
    const { database, rows } = peerTable([
      existingRow("forgotten", retentionMs + 2 * DAY, retentionMs + DAY, {
        rooms: 1,
      }),
      existingRow("recent", 10 * DAY, DAY, { rooms: 1 }),
    ]);
    const persist = createPersistVerifiedIdentity(
      database,
      () => true,
      2,
      () => NOW,
    );
    expect(await outcome(persist(provedSocket("03".repeat(32))))).toBe(
      "persisted",
    );
    expect(await outcome(persist(provedSocket("04".repeat(32))))).toBe(
      "Identity admission capacity reached",
    );
    expect(rows).toHaveLength(3);
  });

  test("identities far below the cap are never pruned", async () => {
    const { database, rows } = peerTable([
      existingRow("memberless", 3 * DAY, 2 * DAY),
    ]);
    const persist = createPersistVerifiedIdentity(
      database,
      () => true,
      100000,
      () => NOW,
    );
    expect(await outcome(persist(provedSocket("05".repeat(32))))).toBe(
      "persisted",
    );
    expect(rows.map(({ id }) => id)).toContain("memberless");
  });
});
