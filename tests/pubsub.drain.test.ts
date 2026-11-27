import { describe, expect, spyOn, test } from "bun:test";

// A namespace import, so on a server without the single-flight drain each
// test fails on its own instead of the whole file failing to load.
import * as pubsub from "../src/pubsub";
import { activateProvedSocket } from "../src/utils/handleMessage";
import { hasPendingActivation } from "../src/utils/socketAuth";
import {
  PEER_ID,
  prove,
  socket as fixtureSocket,
} from "./utils/socketActivationFixture";

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

/** The drain's deadline timers, fired by hand: no real waiting. */
const fakeTimers = () => {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      setTimeout: (run: () => void) => {
        const handle = next++;
        pending.set(handle, run);
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    pending: () => pending.size,
    /** Every deadline now due: each pending timer runs once. */
    expire: () => {
      for (const [handle, run] of [...pending]) {
        pending.delete(handle);
        run();
      }
    },
  };
};

/** Let every promise chain that can settle now settle; no timer involved. */
const settle = async () => {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
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
  let heldDelete: ReturnType<typeof deferred> | undefined;
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
        const gate = heldDelete;
        heldDelete = undefined;
        if (gate) await gate.promise;
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
    holdNextDelete: () => (heldDelete = deferred()),
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
      fakeTimers().timers,
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
      fakeTimers().timers,
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
      fakeTimers().timers,
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
      fakeTimers().timers,
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

  /** A drain on fake deadline timers, with the error log captured. */
  const deadlineHarness = (rows: Omit<Row, "targetServerId" | "kind">[]) => {
    const alice = socket(ALICE);
    const signals = queue(rows);
    const clock = fakeTimers();
    const drain = pubsub.createPendingSignalDrain(
      signals.store as never,
      new Map([[ALICE, alice.ws]]),
      HERE,
      clock.timers,
    );
    return { alice, signals, clock, drain };
  };

  const capturingErrors = async (run: () => Promise<void>) => {
    const logged: unknown[][] = [];
    const consoleError = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(args);
      },
    );
    try {
      await run();
    } finally {
      consoleError.mockRestore();
    }
    return logged;
  };

  const ABANDONED = `p2party: abandoned a pending-signal drain pass after ${String(pubsub.PENDING_SIGNAL_PASS_DEADLINE_MS)} ms (1 since start); the next wake-up starts a fresh one`;

  test("a read that never returns does not stop later passes", async () => {
    const { alice, signals, clock, drain } = deadlineHarness([]);
    const logged = await capturingErrors(async () => {
      // The reviewer's probe: the first read never returns, a row is
      // queued, five more wake-ups follow.
      signals.holdNextRead();
      void drain();
      signals.add({ id: "s1", targetPeerId: ALICE, payload: "s1" });
      for (let i = 0; i < 5; i++) void drain();
      await settle();
      expect(signals.calls.reads).toBe(1);
      expect(alice.received).toEqual([]);

      // The pass deadline passes: the next wake-up reads and delivers.
      clock.expire();
      void drain();
      await settle();
    });

    expect(signals.calls.reads).toBe(2);
    expect(alice.received).toEqual(["s1"]);
    expect(signals.rows()).toEqual([]);
    // One error-level line, counts only.
    expect(logged).toEqual([[ABANDONED]]);
  });

  test("a pass abandoned at its deadline delivers nothing afterwards", async () => {
    const { alice, signals, clock, drain } = deadlineHarness([
      { id: "s1", targetPeerId: ALICE, payload: "s1" },
      { id: "s2", targetPeerId: ALICE, payload: "s2" },
    ]);
    const logged = await capturingErrors(async () => {
      const late = signals.holdNextRead();
      void drain();
      clock.expire();
      // A fresh pass reads the same rows and is held as well.
      const fresh = signals.holdNextRead();
      void drain();
      expect(signals.calls.reads).toBe(2);

      // The abandoned pass's read returns, with both rows: it sends nothing
      // and deletes nothing.
      late.resolve();
      await settle();
      expect(alice.received).toEqual([]);
      expect(signals.calls.deletes).toEqual([]);

      fresh.resolve();
      await settle();
    });

    expect(alice.received).toEqual(["s1", "s2"]);
    expect(signals.calls.deletes).toEqual([["s1", "s2"]]);
    expect(signals.rows()).toEqual([]);
    expect(logged).toEqual([[ABANDONED]]);
  });

  test("a delete that never returns does not stop later passes and its frame is not delivered twice", async () => {
    const { alice, signals, clock, drain } = deadlineHarness([
      { id: "s1", targetPeerId: ALICE, payload: "s1" },
    ]);
    const logged = await capturingErrors(async () => {
      signals.holdNextDelete();
      void drain();
      await settle();
      expect(alice.received).toEqual(["s1"]);
      expect(signals.rows()).toEqual(["s1"]);

      clock.expire();
      signals.add({ id: "s2", targetPeerId: ALICE, payload: "s2" });
      void drain();
      await settle();
    });

    // s1 is still queued when the fresh pass reads, but it was delivered:
    // only its delete is retried.
    expect(alice.received).toEqual(["s1", "s2"]);
    expect(signals.calls.deletes).toEqual([["s1"], ["s1", "s2"]]);
    expect(signals.rows()).toEqual([]);
    expect(logged).toEqual([[ABANDONED]]);
  });

  test("a late read of an abandoned pass does not make a delivered frame deliverable again", async () => {
    const { alice, signals, clock, drain } = deadlineHarness([]);
    const logged = await capturingErrors(async () => {
      // The abandoned pass read an empty queue.
      const late = signals.holdNextRead();
      void drain();
      clock.expire();
      // The fresh pass delivers s1, and its delete fails: s1 stays queued
      // and is recorded as delivered.
      signals.add({ id: "s1", targetPeerId: ALICE, payload: "s1" });
      signals.failNextDelete();
      void drain();
      await settle();
      // The abandoned read returns now, without s1: it must not forget it.
      late.resolve();
      await settle();
      void drain();
      await settle();
    });

    expect(alice.received).toEqual(["s1"]);
    expect(signals.rows()).toEqual([]);
    expect(logged).toEqual([
      [ABANDONED],
      ["p2party: failed to drain pending signals", "Error"],
    ]);
  });

  test("a late delete of an abandoned pass does not make its frame deliverable again", async () => {
    const { alice, signals, clock, drain } = deadlineHarness([
      { id: "s1", targetPeerId: ALICE, payload: "s1" },
    ]);
    const logged = await capturingErrors(async () => {
      const lateDelete = signals.holdNextDelete();
      void drain();
      await settle();
      clock.expire();
      // The fresh pass reads while s1 is still queued...
      const freshRead = signals.holdNextRead();
      void drain();
      // ...then the abandoned delete completes...
      lateDelete.resolve();
      await settle();
      // ...and the fresh pass sees s1 in what it read.
      freshRead.resolve();
      await settle();
    });

    expect(alice.received).toEqual(["s1"]);
    expect(signals.rows()).toEqual([]);
    expect(logged).toEqual([[ABANDONED]]);
  });

  test("a pass that ends in time leaves no deadline timer", async () => {
    const { alice, signals, clock, drain } = deadlineHarness([
      { id: "s1", targetPeerId: ALICE, payload: "s1" },
    ]);
    await drain();
    expect(alice.received).toEqual(["s1"]);
    expect(clock.pending()).toBe(0);

    // One timer while a pass is in flight; stopping the drain clears it, and
    // the stopped pass's late read delivers nothing.
    signals.add({ id: "s2", targetPeerId: ALICE, payload: "s2" });
    const late = signals.holdNextRead();
    void drain();
    expect(clock.pending()).toBe(1);
    drain.stop();
    expect(clock.pending()).toBe(0);
    late.resolve();
    await settle();
    expect(alice.received).toEqual(["s1"]);
    expect(clock.pending()).toBe(0);
  });

  test("frames queued while a socket activates are delivered when it becomes current, not at the next poll", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const ws = fixtureSocket("activating");
    expect(await prove(ws)).toBeTruthy();
    // A frame sent between the socket's claim commit and its registration
    // was queued for this process.
    const signals = queue([
      { id: "s1", targetPeerId: PEER_ID, payload: "answer for the new socket" },
    ]);
    const clock = fakeTimers();
    const drain = pubsub.createPendingSignalDrain(
      signals.store as never,
      clients,
      HERE,
      clock.timers,
    );
    const commit = deferred();
    let woken: Promise<void> | undefined;
    const activation = activateProvedSocket(ws, {
      clients,
      persist: async () => {
        await commit.promise;
        return { created: false, replaced: null };
      },
      undo: async () => true,
      evict: async () => undefined,
      becameCurrent: () => {
        woken = drain();
      },
    });

    // A wake-up while it activates keeps the row for it.
    expect(hasPendingActivation(clients, PEER_ID)).toBe(true);
    await drain();
    expect(ws.sent).toEqual([]);
    expect(signals.rows()).toEqual(["s1"]);

    // Becoming current wakes the drain; no safety poll is run here.
    commit.resolve();
    expect(await activation).toBeTruthy();
    await woken;
    expect(ws.sent).toEqual(["answer for the new socket"]);
    expect(signals.rows()).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
