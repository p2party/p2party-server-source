import { describe, expect, test } from "bun:test";

import {
  PENDING_SIGNAL_MAX_AGE_MS,
  SERVER_ID,
  clearDeadServerState,
  connectedServerIds,
  routingSessionName,
  startPendingSignalSweep,
  sweepStalePendingSignals,
} from "../src/pubsub";

const DEAD = "11111111-1111-4111-8111-111111111111";
const LIVE = "22222222-2222-4222-8222-222222222222";

interface PeerRow {
  id: string;
  serverId: string | null;
}
interface SignalRow {
  id: string;
  createdAt: Date;
  targetServerId: string;
  targetPeerId: string;
  payload: string;
}

/**
 * An in-memory stand-in for the two Prisma delegates the routing code uses.
 * It implements exactly the filters the code sends and throws on anything
 * else, so an unexpected query shape fails the test instead of matching
 * every row.
 */
const routingStore = (peers: PeerRow[], signals: SignalRow[]) => {
  const keysOnly = (value: object, allowed: string[]) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) throw new Error(`unexpected filter ${key}`);
  };
  const signalMatches = (
    row: SignalRow,
    where: {
      createdAt?: { lt: Date };
      targetServerId?: { in: string[] };
    },
  ) => {
    keysOnly(where, ["createdAt", "targetServerId"]);
    if (where.createdAt) keysOnly(where.createdAt, ["lt"]);
    if (where.targetServerId) keysOnly(where.targetServerId, ["in"]);
    return (
      (where.createdAt === undefined ||
        row.createdAt.getTime() < where.createdAt.lt.getTime()) &&
      (where.targetServerId === undefined ||
        where.targetServerId.in.includes(row.targetServerId))
    );
  };
  return {
    peer: {
      findMany: async (args: {
        where: { serverId: { not: null } };
        select: { serverId: true };
        distinct: ["serverId"];
      }) => {
        expect(args).toEqual({
          where: { serverId: { not: null } },
          select: { serverId: true },
          distinct: ["serverId"],
        });
        return [
          ...new Set(peers.map((p) => p.serverId).filter((id) => id !== null)),
        ].map((serverId) => ({ serverId }));
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { serverId: { in: string[] } };
        data: { serverId: null };
      }) => {
        keysOnly(where, ["serverId"]);
        keysOnly(where.serverId, ["in"]);
        expect(data).toEqual({ serverId: null });
        let count = 0;
        for (const peer of peers)
          if (
            peer.serverId !== null &&
            where.serverId.in.includes(peer.serverId)
          ) {
            peer.serverId = null;
            count++;
          }
        return { count };
      },
    },
    pendingSignal: {
      findMany: async (args: {
        select: { targetServerId: true };
        distinct: ["targetServerId"];
      }) => {
        expect(args).toEqual({
          select: { targetServerId: true },
          distinct: ["targetServerId"],
        });
        return [...new Set(signals.map((s) => s.targetServerId))].map(
          (targetServerId) => ({ targetServerId }),
        );
      },
      deleteMany: async ({
        where,
      }: {
        where: Parameters<typeof signalMatches>[1];
      }) => {
        const before = signals.length;
        const kept = signals.filter((row) => !signalMatches(row, where));
        signals.splice(0, signals.length, ...kept);
        return { count: before - kept.length };
      },
    },
  } as never;
};

/** pg_stat_activity as the LISTEN sessions of running processes populate it. */
const fakeActivity = (sessionNames: string[]) => {
  const queries: string[] = [];
  return {
    queries,
    client: {
      query: async (text: string, values: [string[]]) => {
        queries.push(text);
        expect(text).toContain("pg_stat_activity");
        return {
          rows: sessionNames
            .filter((name) => values[0].includes(name))
            .map((application_name) => ({ application_name })),
        };
      },
    } as never,
  };
};

const signal = (
  id: string,
  targetServerId: string,
  createdAt: number,
): SignalRow => ({
  id,
  createdAt: new Date(createdAt),
  targetServerId,
  targetPeerId: "00000000-0000-4000-8000-0000000000aa",
  payload: '{"type":"candidate"}',
});

describe("routing state retention", () => {
  test("pending signals older than 120 s are swept", async () => {
    const now = 1_800_000_000_000;
    const signals = [
      signal("fresh-self", SERVER_ID, now),
      signal("119s-live", LIVE, now - 119_000),
      signal("exactly-120s", SERVER_ID, now - 120_000),
      signal("121s-live", LIVE, now - 121_000),
      signal("week-old-dead", DEAD, now - 7 * 86_400_000),
    ];
    const store = routingStore([], signals);

    expect(PENDING_SIGNAL_MAX_AGE_MS).toBe(120_000);
    expect(await sweepStalePendingSignals(store, now)).toBe(2);
    // Whatever server a row is addressed to, it does not outlive 120 s.
    expect(signals.map(({ id }) => id)).toEqual([
      "fresh-self",
      "119s-live",
      "exactly-120s",
    ]);

    // The periodic sweep: run the scheduled task at later instants.
    let clock = now;
    let task: (() => void) | undefined;
    let period = 0;
    const timer = startPendingSignalSweep(
      store,
      () => clock,
      (run, ms) => {
        task = run;
        period = ms;
        return 0 as never;
      },
    );
    expect(timer).toBe(0 as never);
    // A row therefore lives at most twice the maximum age.
    expect(period).toBeGreaterThan(0);
    expect(period).toBeLessThanOrEqual(PENDING_SIGNAL_MAX_AGE_MS);
    clock = now + period;
    task!();
    await Promise.resolve();
    // The 119 s row passed 120 s one period later; the fresh one has not.
    expect(signals.map(({ id }) => id)).toEqual(["fresh-self"]);
    clock = now + 120_001;
    task!();
    await Promise.resolve();
    expect(signals).toEqual([]);
  });

  test("startup clears claims of a dead server id", async () => {
    const now = Date.now();
    const peers: PeerRow[] = [
      { id: "00000000-0000-4000-8000-000000000001", serverId: DEAD },
      { id: "00000000-0000-4000-8000-000000000002", serverId: LIVE },
      { id: "00000000-0000-4000-8000-000000000003", serverId: SERVER_ID },
      { id: "00000000-0000-4000-8000-000000000004", serverId: null },
    ];
    // A fresh row to the dead process survives an age sweep; only the
    // liveness check can remove it.
    const signals = [
      signal("to-dead", DEAD, now),
      signal(
        "to-dead-nobody-claims",
        "33333333-3333-4333-8333-333333333333",
        now,
      ),
      signal("to-live", LIVE, now),
      signal("to-self", SERVER_ID, now),
    ];
    const activity = fakeActivity([
      routingSessionName(LIVE),
      routingSessionName(SERVER_ID),
      "psql",
    ]);

    const cleared = await clearDeadServerState(
      routingStore(peers, signals),
      (ids) => connectedServerIds(activity.client, ids),
    );

    expect(cleared.sort()).toEqual(
      [DEAD, "33333333-3333-4333-8333-333333333333"].sort(),
    );
    expect(peers.map(({ serverId }) => serverId)).toEqual([
      null,
      LIVE,
      SERVER_ID,
      null,
    ]);
    expect(signals.map(({ id }) => id)).toEqual(["to-live", "to-self"]);
    expect(activity.queries).toHaveLength(1);
  });

  test("startup clears nothing when liveness cannot be read", async () => {
    const peers: PeerRow[] = [
      { id: "00000000-0000-4000-8000-000000000001", serverId: DEAD },
    ];
    const signals = [signal("to-dead", DEAD, Date.now())];

    await expect(
      clearDeadServerState(routingStore(peers, signals), async () => {
        throw new Error("pg_stat_activity unavailable");
      }),
    ).rejects.toThrow("pg_stat_activity unavailable");
    expect(peers[0]!.serverId).toBe(DEAD);
    expect(signals).toHaveLength(1);
  });

  test("a process with no foreign server ids issues no liveness query", async () => {
    const activity = fakeActivity([]);
    const peers: PeerRow[] = [
      { id: "00000000-0000-4000-8000-000000000003", serverId: SERVER_ID },
    ];
    expect(
      await clearDeadServerState(
        routingStore(peers, [signal("to-self", SERVER_ID, Date.now())]),
        (ids) => connectedServerIds(activity.client, ids),
      ),
    ).toEqual([]);
    expect(activity.queries).toEqual([]);
    expect(peers[0]!.serverId).toBe(SERVER_ID);
  });

  test("a routing session name fits PostgreSQL's application_name limit", () => {
    // NAMEDATALEN - 1: a longer name would be truncated and never match.
    expect(
      Buffer.byteLength(routingSessionName(SERVER_ID)),
    ).toBeLessThanOrEqual(63);
    expect(routingSessionName(SERVER_ID)).toEndWith(SERVER_ID);
  });
});
