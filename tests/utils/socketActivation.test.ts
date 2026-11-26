import { describe, expect, test } from "bun:test";

import { consumeProofOwnerPong } from "../../src/utils/handlePong";
import {
  activateVerifiedSocket,
  isCurrentVerifiedSocket,
} from "../../src/utils/socketAuth";
import {
  BARE,
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
    for (const [cause, commit] of failures) {
      const clients = new Map<string, P2PartyWSClient>();
      const old = await establishedSocket(clients);
      const successor = socket("successor");
      const releases: string[] = [];

      expect(await prove(successor), cause).toBeTruthy();
      expect(
        await activateVerifiedSocket(
          clients,
          successor,
          () => commit(successor),
          async (peerId) => {
            releases.push(peerId);
          },
        ),
        cause,
      ).toBe(false);

      // The established socket keeps working, untouched.
      expect(old.closeArgs, cause).toEqual([]);
      expect(old.data.isVerified, cause).toBe(true);
      expect(live(clients, [old, successor]), cause).toEqual(["old"]);
      expect(consumeProofOwnerPong(clients, old, EXACT_PONG), cause).toBe(true);
      // Nothing of the successor's is left: not registered, not verified,
      // closed, and the routing claim the old socket relies on (this
      // process's) was not released.
      expect(clients.get(PEER_ID), cause).toBe(old);
      expect(successor.data.isVerified, cause).toBe(false);
      expect(successor.data.isAuthenticating, cause).toBe(false);
      expect(successor.readyState, cause).toBe(3);
      expect(releases, cause).toEqual([]);
    }
  });

  test("a rejected signature never reaches activation and leaves the existing socket", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const successor = socket("successor");

    expect(await prove(successor, false)).toBe(false);

    expect(old.closeArgs).toEqual([]);
    expect(live(clients, [old, successor])).toEqual(["old"]);
    expect(successor.closeArgs).toEqual([
      { code: 1008, reason: "Challenge response signature cannot be verified" },
    ]);
  });

  test("a committed successor closes its predecessor with the replacement code", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const successor = socket("successor");
    const commit = deferred<boolean>();

    expect(await prove(successor)).toBeTruthy();
    const activation = activateVerifiedSocket(
      clients,
      successor,
      () => commit.promise,
      async () => {
        throw new Error("a committed activation releases nothing");
      },
    );
    // While the successor's commit is in flight the old socket still owns
    // the identity and may keep signalling.
    expect(live(clients, [old, successor])).toEqual(["old"]);
    expect(old.closeArgs).toEqual([]);

    commit.resolve(true);
    expect(await activation).toBe(true);
    expect(live(clients, [old, successor])).toEqual(["successor"]);
    expect(old.closeArgs).toEqual([REPLACED]);
    expect(old.data.isVerified).toBe(false);
  });

  test("a proved socket's exact pong keeps it alive while its commit is in flight", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const successor = socket("successor");
    const commit = deferred<boolean>();

    expect(await prove(successor)).toBeTruthy();
    const activation = activateVerifiedSocket(
      clients,
      successor,
      () => commit.promise,
      async () => {},
    );
    successor.data.isAlive = false;
    expect(consumeProofOwnerPong(clients, successor, EXACT_PONG)).toBe(true);
    expect(successor.data.isAlive).toBe(true);
    // It may not signal yet; the old socket still may.
    expect(isCurrentVerifiedSocket(clients, successor)).toBe(false);
    expect(isCurrentVerifiedSocket(clients, old)).toBe(true);

    commit.resolve(true);
    expect(await activation).toBe(true);
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
      const old = await establishedSocket(clients);
      const older = socket("older");
      const newer = socket("newer");
      const commits = {
        older: deferred<boolean>(),
        newer: deferred<boolean>(),
      };
      const releases: string[] = [];
      const release = async (peerId: string) => {
        releases.push(peerId);
      };

      expect(await prove(older), label).toBeTruthy();
      const olderActivation = activateVerifiedSocket(
        clients,
        older,
        () => commits.older.promise,
        release,
      );
      expect(await prove(newer), label).toBeTruthy();
      const newerActivation = activateVerifiedSocket(
        clients,
        newer,
        () => commits.newer.promise,
        release,
      );

      const order = scenario.olderFirst
        ? (["older", "newer"] as const)
        : (["newer", "older"] as const);
      for (const name of order) {
        commits[name].resolve(scenario[name]);
        await (name === "older" ? olderActivation : newerActivation);
      }

      const all = [old, older, newer];
      expect(live(clients, all), label).toEqual([scenario.survivor]);
      expect(
        all.filter((ws) => ws.readyState === 1).map((ws) => ws.name),
        label,
      ).toEqual([scenario.survivor]);
      expect(clients.get(PEER_ID), label).toBe(
        all.find((ws) => ws.name === scenario.survivor),
      );
      // A socket of this identity always remained here, so this process's
      // routing claim was never released.
      expect(releases, label).toEqual([]);
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
