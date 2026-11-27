import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
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
    data: {
      peerId: id,
      publicKey: key,
      isVerified: verified,
      socketGeneration: "00000000-0000-4000-8000-0000000000ee",
    },
    readyState: 1,
    send: () => 1,
    close: () => {},
  }) as unknown as P2PartyWSClient;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 400 * DAY;

interface PeerRow {
  socketGeneration?: string | null;
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
    findUnique: async ({
      where,
      select,
    }: {
      where: { publicKey: string };
      select: Record<string, true>;
    }) => {
      // The commit reads the claim it replaces, never the row's id.
      expect(select).toEqual({ serverId: true, socketGeneration: true });
      const row = rows.find(({ publicKey }) => publicKey === where.publicKey);
      return row
        ? {
            serverId: row.serverId,
            socketGeneration: row.socketGeneration ?? null,
          }
        : null;
    },
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
      update,
      create,
    }: {
      where: { publicKey: string };
      update: Record<string, unknown>;
      create: {
        id: string;
        publicKey: string;
        serverId: string;
        socketGeneration: string;
      };
    }) => {
      // An existing row keeps its id: nothing per connection rewrites it.
      expect(Object.keys(update).sort()).toEqual([
        "lastPing",
        "serverId",
        "socketGeneration",
      ]);
      const existing = rows.find(
        ({ publicKey }) => publicKey === where.publicKey,
      );
      if (existing) {
        existing.serverId = update.serverId as string;
        existing.socketGeneration = update.socketGeneration as string;
        existing.updatedAt = new Date(NOW);
        return existing;
      }
      const row = {
        ...create,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
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
      socketGeneration: "00000000-0000-4000-8000-0000000000ef",
      admission,
    },
    readyState: 1,
    send: () => 1,
    close: () => {},
  }) as unknown as P2PartyWSClient;

const outcome = (attempt: Promise<unknown>) =>
  attempt.then(
    (persisted) => (persisted ? "persisted" : "inactive"),
    (error: Error) => error.message,
  );

describe("proof-gated durable identity", () => {
  test("the derived peer id is stable across processes and identifies its key", () => {
    const id = provisionalPeerId(key);
    expect(provisionalPeerId(key)).toBe(id);
    expect(isUUID(id, 4)).toBe(true);
    expect(provisionalPeerId("cd".repeat(32))).not.toBe(id);
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
    expect(await persist(socket(true))).toEqual({
      created: true,
      replaced: null,
    });
    expect(isolation).toBe("Serializable");
    expect(writes).toBe(1);
    count = 2;
    await expect(persist(socket(true))).rejects.toThrow("capacity");
    expect(writes).toBe(1);
  });

  test("a socket bound to an id not derived from its key persists nothing", async () => {
    const persist = createPersistVerifiedIdentity({
      $transaction: () => {
        throw new Error("unexpected database call");
      },
    } as never);
    await expect(
      persist(socket(true, "00000000-0000-4000-8000-000000000001")),
    ).rejects.toThrow("not derived from its key");
  });

  test("no connection-time path reads whether a row was re-keyed", async () => {
    // The one-time migration re-keys every row. Per connection, a row with a
    // pre-0.1.4 random id and a row with the derived id get the same queries
    // and the same result: no query selects the id and no update writes it.
    const recorded = async (storedId: string) => {
      const queries: string[] = [];
      const table = peerTable([
        { ...existingRow(storedId, 30 * DAY, 2 * DAY), publicKey: key },
      ]);
      const recording = {
        $transaction: (
          run: (tx: unknown) => Promise<unknown>,
          options: unknown,
        ) =>
          (table.database as { $transaction: Function }).$transaction(
            (tx: { peer: Record<string, Function> }) =>
              run({
                peer: Object.fromEntries(
                  Object.entries(tx.peer).map(([name, query]) => [
                    name,
                    (args: unknown) => {
                      queries.push(`${name} ${JSON.stringify(args)}`);
                      return query(args);
                    },
                  ]),
                ),
              }),
            options,
          ),
      };
      const persist = createPersistVerifiedIdentity(
        recording as never,
        () => {
          throw new Error("an existing identity is not a new identity");
        },
        10,
        () => NOW,
        "00000000-0000-4000-8000-0000000000aa",
      );
      const commit = await persist(provedSocket(key));
      return { commit, queries, id: table.rows[0]!.id };
    };

    const derived = await recorded(provisionalPeerId(key));
    const old = await recorded("0b5e0f2a-7d0c-4c55-9a3e-1f0d2c3b4a59");
    expect(old.commit).toEqual(derived.commit);
    expect(old.queries).toEqual(derived.queries);
    expect(old.id).toBe("0b5e0f2a-7d0c-4c55-9a3e-1f0d2c3b4a59");
    for (const query of derived.queries) {
      const args = JSON.parse(query.slice(query.indexOf(" ") + 1)) as {
        select?: object;
        update?: object;
        where?: object;
      };
      for (const part of [args.select, args.update, args.where])
        expect(Object.keys(part ?? {}), query).not.toContain("id");
    }

    // Structure: no module on the connection path updates a row's id. The
    // re-key is the migration's job.
    const src = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
    );
    for (const file of [
      "wsServer.ts",
      "utils/handleConnection.ts",
      "utils/handleChallenge.ts",
      "utils/handleMessage.ts",
      "utils/peerIdentity.ts",
      "utils/socketAuth.ts",
      "pubsub.ts",
    ]) {
      const source = readFileSync(join(src, file), "utf8");
      expect(source, file).not.toMatch(/(?:update|data):\s*\{[^}]*\bid\s*:/);
      expect(source, file).not.toMatch(/existing\??\.id\b/);
    }
  });

  test("a failed routing claim leaves no identity row and no charge", async () => {
    // The claim is written by the same statement that inserts the row, in the
    // same transaction: when it fails, the row is rolled back and the charge
    // given back.
    const guard = new AdmissionController(
      { ...admissionLimits, newIdentitiesPerMinute: 20 },
      () => NOW,
    );
    const lease = () => {
      const granted = guard.reserve(
        admissionAddress("203.0.113.7", null, false)!,
      )!;
      expect(granted.authenticate(key)).toBe(true);
      return granted;
    };
    const table = peerTable([]);
    const failingClaim = {
      $transaction: (
        run: (tx: unknown) => Promise<unknown>,
        options: unknown,
      ) =>
        (table.database as { $transaction: Function }).$transaction(
          (tx: { peer: Record<string, Function> }) =>
            run({
              peer: {
                ...tx.peer,
                upsert: async (args: unknown) => {
                  await tx.peer.upsert!(args);
                  throw Object.assign(new Error("claim write failed"), {
                    code: "P1017",
                  });
                },
              },
            }),
          options,
        ),
    };
    const persist = createPersistVerifiedIdentity(failingClaim as never);

    await expect(persist(provedSocket(key, lease()))).rejects.toThrow(
      "claim write failed",
    );
    expect(table.rows).toEqual([]);
    // One creation per minute is this address's whole share (5% of 20): it
    // is still unspent.
    expect(lease().newIdentity()).toBe(true);
    expect(lease().newIdentity()).toBe(false);
  });

  test("two racing first-time sockets of one key are charged once", async () => {
    // Both see no row and both charge; the loser's insert conflicts, its
    // retry finds the winner's row, and its charge is given back.
    const guard = new AdmissionController(
      { ...admissionLimits, newIdentitiesPerMinute: 2 },
      () => NOW,
    );
    const lease = (address: string) => {
      const granted = guard.reserve(admissionAddress(address, null, false)!)!;
      expect(granted.authenticate(key)).toBe(true);
      return granted;
    };
    const table = peerTable([]);
    let loserAttempts = 0;
    const winner = createPersistVerifiedIdentity(table.database);
    // The winner charges and commits first.
    expect(await winner(provedSocket(key, lease("198.51.100.1")))).toEqual({
      created: true,
      replaced: null,
    });
    const loser = createPersistVerifiedIdentity({
      $transaction: (
        run: (tx: unknown) => Promise<unknown>,
        options: unknown,
      ) =>
        (table.database as { $transaction: Function }).$transaction(
          async (tx: { peer: Record<string, Function> }) => {
            if (++loserAttempts > 1) return run(tx);
            // The first attempt's snapshot predates the winner's insert.
            return run({
              peer: {
                ...tx.peer,
                findUnique: async () => null,
                upsert: async () => {
                  throw Object.assign(new Error("write conflict"), {
                    code: "P2034",
                  });
                },
              },
            });
          },
          options,
        ),
    } as never);

    // The loser commits as a second socket of the identity, replacing the
    // winner's claim, and keeps no charge.
    expect(await loser(provedSocket(key, lease("198.51.100.2")))).toMatchObject(
      { created: false, replaced: { serverId: expect.any(String) } },
    );
    expect(loserAttempts).toBe(2);
    expect(table.rows).toHaveLength(1);
    // A budget of 2 with one creation spent admits exactly one more.
    expect(lease("198.51.100.3").newIdentity()).toBe(true);
    expect(lease("198.51.100.4").newIdentity()).toBe(false);
  });

  test("identity creation is charged to the socket's source key", async () => {
    const guard = new AdmissionController(
      { ...admissionLimits, newIdentitiesPerMinute: 120 },
      () => NOW,
    );
    const { database, rows } = peerTable([]);
    // Default admission: the socket's own lease, not a process-wide counter.
    const persist = createPersistVerifiedIdentity(
      database,
      undefined,
      1000,
      () => NOW,
    );
    const attempt = (remote: string, publicKey: string) => {
      const lease = guard.reserve(admissionAddress(remote, null, false)!)!;
      expect(lease.authenticate(publicKey)).toBe(true);
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

  test("total identity rows never exceed the hard cap", async () => {
    // Well past any retention window (task X3 proposes 90 days).
    const longAgo = 200 * DAY;

    // Rows that cannot be pruned still count: the cap refuses, it never grows.
    const full = peerTable([
      existingRow("member", longAgo + DAY, longAgo, { rooms: 1 }),
      existingRow("stale-claim", longAgo + DAY, longAgo, {
        serverId: "server",
      }),
      existingRow("also-member", longAgo + DAY, longAgo, { rooms: 2 }),
    ]);
    const persistFull = createPersistVerifiedIdentity(
      full.database,
      () => true,
      3,
      () => NOW,
    );
    for (const prefix of ["06", "07", "08"])
      expect(await outcome(persistFull(provedSocket(prefix.repeat(32))))).toBe(
        "Identity admission capacity reached",
      );
    expect(full.rows).toHaveLength(3);

    // More prunable rows than one batch: least recently seen go first, so
    // every row past the retention window goes before any recent one.
    const recent = Array.from({ length: 1000 }, (_, i) =>
      existingRow(`recent-${i}`, 10 * DAY, 2 * DAY - i * 1000),
    );
    const mixed = peerTable([
      existingRow("member", longAgo + DAY, longAgo, { rooms: 1 }),
      ...recent,
      existingRow("forgotten-1", longAgo + DAY, longAgo),
      existingRow("forgotten-2", longAgo + 2 * DAY, longAgo + DAY),
    ]);
    const cap = mixed.rows.length;
    const persistMixed = createPersistVerifiedIdentity(
      mixed.database,
      () => true,
      cap,
      () => NOW,
    );
    expect(await outcome(persistMixed(provedSocket("09".repeat(32))))).toBe(
      "persisted",
    );
    const ids = mixed.rows.map(({ id }) => id);
    expect(ids).not.toContain("forgotten-1");
    expect(ids).not.toContain("forgotten-2");
    expect(ids.filter((id) => id.startsWith("recent-"))).toEqual([
      "recent-998",
      "recent-999",
    ]);
    expect(ids).toEqual([
      "member",
      "recent-998",
      "recent-999",
      provisionalPeerId("09".repeat(32)),
    ]);
    expect(mixed.rows.length).toBeLessThanOrEqual(cap);
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
