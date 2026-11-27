import { describe, expect, spyOn, test } from "bun:test";

// A namespace import, so on a server without the single-flight drain each
// test fails on its own instead of the whole file failing to load.
import * as pubsub from "../src/pubsub";

import type { P2PartyWSClient, P2PartyWSData } from "../src/wsServer";

const HERE = "11111111-1111-4111-8111-111111111111";
const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";

interface Row {
  id: string;
  targetServerId: string;
  targetPeerId: string;
  kind: string;
  payload: string;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/**
 * The PendingSignal table, in queue order, with the two statements the drain
 * issues. A read can be held open (`holdNextRead`) to make wake-ups overlap,
 * and a statement can be made to fail once.
 */
const queue = (rows: Omit<Row, "targetServerId" | "kind">[]) => {
  let table: Row[] = rows.map((row) => ({
    ...row,
    targetServerId: HERE,
    kind: "frame",
  }));
  let held: ReturnType<typeof deferred> | undefined;
  let failNextRead = false;
  let failNextDelete = false;
  const calls = { reads: 0, deletes: [] as string[][] };
  const store = {
    pendingSignal: {
      findMany: async (args: { where: { targetServerId: string } }) => {
        calls.reads++;
        // What the statement sees is fixed when it starts.
        const snapshot = table.filter(
          (row) => row.targetServerId === args.where.targetServerId,
        );
        const gate = held;
        held = undefined;
        if (gate) await gate.promise;
        if (failNextRead) {
          failNextRead = false;
          throw new Error("database unavailable");
        }
        return snapshot;
      },
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        calls.deletes.push([...args.where.id.in]);
        if (failNextDelete) {
          failNextDelete = false;
          throw new Error("database unavailable");
        }
        const ids = new Set(args.where.id.in);
        const before = table.length;
        table = table.filter((row) => !ids.has(row.id));
        return { count: before - table.length };
      },
    },
  };
  return {
    store,
    calls,
    rows: () => table.map((row) => row.id),
    add: (row: Omit<Row, "targetServerId" | "kind">) => {
      table.push({ ...row, targetServerId: HERE, kind: "frame" });
    },
    holdNextRead: () => (held = deferred()),
    failNextRead: () => {
      failNextRead = true;
    },
    failNextDelete: () => {
      failNextDelete = true;
    },
  };
};

/** A current verified socket that records what it took. */
const socket = (peerId: string) => {
  const received: string[] = [];
  let refuse = 0;
  const data: P2PartyWSData = {
    peerId,
    publicKey: "ab".repeat(32),
    challengeNonce: "",
    challengeId: "",
    socketGeneration: "33333333-3333-4333-8333-333333333333",
    isVerified: true,
    isAuthenticating: false,
    isAlive: true,
  };
  const ws = {
    data,
    readyState: 1,
    // Bun returns 0 for a frame it dropped.
    send: (payload: string) => {
      if (refuse > 0) {
        refuse--;
        return 0;
      }
      received.push(payload);
      return payload.length;
    },
  } as unknown as P2PartyWSClient;
  return {
    ws,
    received,
    refuseNext: () => {
      refuse++;
    },
  };
};

describe("the pending-signal drain", () => {
  test("a queued cross-worker frame is delivered exactly once when two wake-ups overlap", async () => {
    const alice = socket(ALICE);
    const clients = new Map([[ALICE, alice.ws]]);
    const signals = queue([
      { id: "s1", targetPeerId: ALICE, payload: "offer from another worker" },
    ]);
    const drain = pubsub.createPendingSignalDrain(
      signals.store as never,
      clients,
      HERE,
    );

    // A NOTIFY and the safety poll arrive while the first read is in flight.
    const gate = signals.holdNextRead();
    const first = drain();
    const second = drain();
    gate.resolve();
    await Promise.all([first, second]);

    expect(alice.received).toEqual(["offer from another worker"]);
    expect(signals.rows()).toEqual([]);
  });

  test("frames queued for one recipient are delivered in order", async () => {
    const alice = socket(ALICE);
    const bob = socket(BOB);
    const clients = new Map([
      [ALICE, alice.ws],
      [BOB, bob.ws],
    ]);
    const signals = queue([
      { id: "a1", targetPeerId: ALICE, payload: "a1" },
      { id: "b1", targetPeerId: BOB, payload: "b1" },
      { id: "a2", targetPeerId: ALICE, payload: "a2" },
      { id: "a3", targetPeerId: ALICE, payload: "a3" },
    ]);
    const drain = pubsub.createPendingSignalDrain(
      signals.store as never,
      clients,
      HERE,
    );

    // Alice's socket drops the first frame: her later frames wait with it,
    // and Bob's are not held up.
    alice.refuseNext();
    await drain();
    expect(alice.received).toEqual([]);
    expect(bob.received).toEqual(["b1"]);
    expect(signals.rows()).toEqual(["a1", "a2", "a3"]);

    await drain();
    expect(alice.received).toEqual(["a1", "a2", "a3"]);
    expect(signals.rows()).toEqual([]);
  });

  test("a wake-up during a drain causes one more pass and no more", async () => {
    const alice = socket(ALICE);
    const clients = new Map([[ALICE, alice.ws]]);
    const signals = queue([{ id: "s1", targetPeerId: ALICE, payload: "s1" }]);
    const drain = pubsub.createPendingSignalDrain(
      signals.store as never,
      clients,
      HERE,
    );

    const gate = signals.holdNextRead();
    const running = drain();
    // Queued after the first read began: only a further pass can see it.
    signals.add({ id: "s2", targetPeerId: ALICE, payload: "s2" });
    const wakeUps = [drain(), drain(), drain()];
    gate.resolve();
    await Promise.all([running, ...wakeUps]);

    expect(signals.calls.reads).toBe(2);
    expect(alice.received).toEqual(["s1", "s2"]);

    // Once it has finished, the next wake-up starts a pass of its own.
    await drain();
    expect(signals.calls.reads).toBe(3);
  });

  test("a failed read or delete neither loses nor repeats a frame", async () => {
    const alice = socket(ALICE);
    const clients = new Map([[ALICE, alice.ws]]);
    const signals = queue([{ id: "s1", targetPeerId: ALICE, payload: "s1" }]);
    const drain = pubsub.createPendingSignalDrain(
      signals.store as never,
      clients,
      HERE,
    );
    const logged: unknown[][] = [];
    const consoleError = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(args);
      },
    );
    try {
      signals.failNextRead();
      await drain();
      expect(alice.received).toEqual([]);
      expect(signals.rows()).toEqual(["s1"]);

      // Delivered, then its delete fails: the row stays queued, but the
      // next pass only retries the delete.
      signals.failNextDelete();
      await drain();
      signals.add({ id: "s2", targetPeerId: ALICE, payload: "s2" });
      await drain();
    } finally {
      consoleError.mockRestore();
    }

    expect(alice.received).toEqual(["s1", "s2"]);
    expect(signals.calls.deletes).toEqual([["s1"], ["s1", "s2"]]);
    expect(signals.rows()).toEqual([]);
    expect(logged).toEqual([
      ["p2party: failed to drain pending signals", "Error"],
      ["p2party: failed to drain pending signals", "Error"],
    ]);
  });
});
