import { describe, expect, test } from "bun:test";

import { consumeProofOwnerPong } from "../../src/utils/handlePong";
import { isCurrentVerifiedSocket } from "../../src/utils/socketAuth";
import {
  activate,
  BARE,
  claimStore,
  deferred,
  establishedSocket,
  EXACT_PONG,
  live,
  PEER_ID,
  prove,
  REPLACED,
  socket,
  type Socket,
} from "./socketActivationFixture";

import type { P2PartyWSClient } from "../../src/wsServer";

describe("a successor evicts its predecessor only after it commits", () => {
  const failures: [string, (ws: Socket) => Promise<boolean>][] = [
    ["the commit is refused", async () => false],
    [
      "the commit throws",
      async () => {
        throw new Error("database unavailable");
      },
    ],
    [
      "the successor's socket closes during the commit",
      async (ws) => {
        ws.close(1006, "client went away");
        return true;
      },
    ],
  ];

  test("failed authentication does not evict the existing socket", async () => {
    for (const [cause, outcome] of failures) {
      const clients = new Map<string, P2PartyWSClient>();
      const store = claimStore();
      const old = await establishedSocket(clients, store);
      const successor = socket("successor");

      expect(await prove(successor), cause).toBeTruthy();
      expect(
        await activate(clients, store, successor, outcome(successor)),
        cause,
      ).toBe(false);

      // The established socket keeps working, untouched.
      expect(old.closeArgs, cause).toEqual([]);
      expect(old.data.isVerified, cause).toBe(true);
      expect(live(clients, [old, successor]), cause).toEqual(["old"]);
      expect(consumeProofOwnerPong(clients, old, EXACT_PONG), cause).toBe(true);
      // Nothing of the successor's is left: not registered, not verified,
      // closed, and the routing claim is the old socket's again even where
      // the successor's commit had written its own.
      expect(clients.get(PEER_ID), cause).toBe(old);
      expect(successor.data.isVerified, cause).toBe(false);
      expect(successor.data.isAuthenticating, cause).toBe(false);
      expect(successor.readyState, cause).toBe(3);
      expect(store.claim(), cause).toEqual(store.claimOf(old));
    }
  });

  test("a rejected signature never reaches activation and leaves the existing socket", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");

    expect(await prove(successor, false)).toBe(false);

    expect(old.closeArgs).toEqual([]);
    expect(live(clients, [old, successor])).toEqual(["old"]);
    expect(successor.closeArgs).toEqual([
      { code: 1008, reason: "Challenge response signature cannot be verified" },
    ]);
    expect(store.claim()).toEqual(store.claimOf(old));
  });

  test("a committed successor closes its predecessor with the replacement code", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");
    const commit = deferred<boolean>();

    expect(await prove(successor)).toBeTruthy();
    const activation = activate(clients, store, successor, commit.promise);
    // While the successor's commit is in flight the old socket still owns
    // the identity and may keep signalling.
    expect(live(clients, [old, successor])).toEqual(["old"]);
    expect(old.closeArgs).toEqual([]);

    commit.resolve(true);
    expect(await activation).toEqual({
      created: false,
      replaced: store.claimOf(old),
    });
    expect(live(clients, [old, successor])).toEqual(["successor"]);
    expect(old.closeArgs).toEqual([REPLACED]);
    expect(old.data.isVerified).toBe(false);
    expect(store.claim()).toEqual(store.claimOf(successor));
  });

  test("a proved socket's exact pong keeps it alive while its commit is in flight", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");
    const commit = deferred<boolean>();

    expect(await prove(successor)).toBeTruthy();
    const activation = activate(clients, store, successor, commit.promise);
    successor.data.isAlive = false;
    expect(consumeProofOwnerPong(clients, successor, EXACT_PONG)).toBe(true);
    expect(successor.data.isAlive).toBe(true);
    // It may not signal yet; the old socket still may.
    expect(isCurrentVerifiedSocket(clients, successor)).toBe(false);
    expect(isCurrentVerifiedSocket(clients, old)).toBe(true);

    commit.resolve(true);
    expect(await activation).toBeTruthy();
  });
});

describe("racing sockets for one identity", () => {
  // Every combination of commit outcome and commit order for two successors
  // that both verified while an older socket was live. The one that verified
  // later ("newer") wins whenever it commits.
  const cases = [
    { older: true, newer: true, olderFirst: true, survivor: "newer" },
    { older: true, newer: true, olderFirst: false, survivor: "newer" },
    { older: true, newer: false, olderFirst: true, survivor: "older" },
    { older: true, newer: false, olderFirst: false, survivor: "older" },
    { older: false, newer: true, olderFirst: true, survivor: "newer" },
    { older: false, newer: true, olderFirst: false, survivor: "newer" },
    { older: false, newer: false, olderFirst: true, survivor: "old" },
    { older: false, newer: false, olderFirst: false, survivor: "old" },
  ] as const;

  test("two racing sockets for one identity leave exactly one", async () => {
    for (const scenario of cases) {
      const label = JSON.stringify(scenario);
      const clients = new Map<string, P2PartyWSClient>();
      const store = claimStore();
      const old = await establishedSocket(clients, store);
      const older = socket("older");
      const newer = socket("newer");
      const commits = {
        older: deferred<boolean>(),
        newer: deferred<boolean>(),
      };

      expect(await prove(older), label).toBeTruthy();
      const olderActivation = activate(
        clients,
        store,
        older,
        commits.older.promise,
      );
      expect(await prove(newer), label).toBeTruthy();
      const newerActivation = activate(
        clients,
        store,
        newer,
        commits.newer.promise,
      );

      const order = scenario.olderFirst
        ? (["older", "newer"] as const)
        : (["newer", "older"] as const);
      for (const name of order) {
        commits[name].resolve(scenario[name]);
        await (name === "older" ? olderActivation : newerActivation);
      }

      const all = [old, older, newer];
      const survivor = all.find((ws) => ws.name === scenario.survivor)!;
      expect(live(clients, all), label).toEqual([scenario.survivor]);
      expect(
        all.filter((ws) => ws.readyState === 1).map((ws) => ws.name),
        label,
      ).toEqual([scenario.survivor]);
      expect(clients.get(PEER_ID), label).toBe(survivor);
      // The routing claim names the survivor, whatever order the commits
      // and their undo ran in.
      expect(store.claim(), label).toEqual(store.claimOf(survivor));
      // A replaced socket is told so with the contract's replacement code; a
      // socket whose own commit failed closes bare and may retry.
      if (scenario.survivor !== "old")
        expect(old.closeArgs, label).toEqual([REPLACED]);
      for (const name of ["older", "newer"] as const) {
        if (name === scenario.survivor) continue;
        const ws = name === "older" ? older : newer;
        expect(ws.closeArgs, label).toEqual([scenario[name] ? REPLACED : BARE]);
      }
    }
  });
});
