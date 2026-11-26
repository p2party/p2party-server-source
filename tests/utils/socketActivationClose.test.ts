import { describe, expect, test } from "bun:test";

import {
  closeSocketsClaimedElsewhere,
  deliverPendingSignalsLocally,
  evictReplacedClaim,
} from "../../src/pubsub";
import { activateProvedSocket } from "../../src/utils/handleMessage";
import {
  hasPendingActivation,
  retireClosedSocket,
} from "../../src/utils/socketAuth";
import {
  activate,
  claimStore,
  deferred,
  establishedSocket,
  HERE,
  live,
  PEER_ID,
  prove,
  REPLACED,
  socket,
} from "./socketActivationFixture";

import type { P2PartyWSClient } from "../../src/wsServer";

const ELSEWHERE = "22222222-2222-4222-8222-222222222222";

/**
 * A socket releases only the claim that carries its own owner token, so a
 * close never needs to know what its successors are doing: a successor that
 * committed since holds a claim the release does not match.
 */
describe("routing claim across a predecessor's close", () => {
  test("a predecessor closing mid-activation leaves the claim to its successor", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");
    const commit = deferred<boolean>();

    expect(await prove(successor)).toBeTruthy();
    const activation = activate(clients, store, successor, commit.promise);
    expect(hasPendingActivation(clients, PEER_ID)).toBe(true);
    // The old tab goes away while the successor's claim write is in flight.
    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, store.release);
    expect(clients.has(PEER_ID)).toBe(false);
    expect(store.claim()).toBeNull();

    commit.resolve(true);
    expect(await activation).toBeTruthy();
    expect(live(clients, [old, successor])).toEqual(["successor"]);
    expect(store.claim()).toEqual(store.claimOf(successor));
    expect(hasPendingActivation(clients, PEER_ID)).toBe(false);
  });

  test("a late release from a replaced socket leaves its successor's claim", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");

    expect(await prove(successor)).toBeTruthy();
    expect(await activate(clients, store, successor)).toBeTruthy();
    // The replaced socket's close runs late, and a stray release with its
    // token lands after the successor's claim.
    await retireClosedSocket(clients, old, store.release);
    await store.release(PEER_ID, old.data.socketGeneration);

    expect(store.claim()).toEqual(store.claimOf(successor));
    expect(live(clients, [old, successor])).toEqual(["successor"]);
  });

  test("a successor that then fails leaves no claim behind", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");
    const commit = deferred<boolean>();

    expect(await prove(successor)).toBeTruthy();
    const activation = activate(clients, store, successor, commit.promise);
    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, store.release);
    commit.resolve(false);

    expect(await activation).toBe(false);
    expect(store.claim()).toBeNull();
    expect(clients.has(PEER_ID)).toBe(false);
    expect(hasPendingActivation(clients, PEER_ID)).toBe(false);
  });

  test("an owner closing with no activation in flight releases its claim", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);

    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, store.release);

    expect(store.claim()).toBeNull();
    expect(clients.has(PEER_ID)).toBe(false);
  });

  test("a queued cross-instance signal waits for an activating successor", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");
    const commit = deferred<boolean>();
    const signals = [{ id: "signal-1", targetPeerId: PEER_ID, payload: "SDP" }];

    expect(await prove(successor)).toBeTruthy();
    const activation = activate(clients, store, successor, commit.promise);
    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, store.release);

    // Neither delivered nor discarded while the successor activates.
    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([]);
    expect(successor.sent).toEqual([]);

    commit.resolve(true);
    expect(await activation).toBeTruthy();
    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([
      "signal-1",
    ]);
    expect(successor.sent).toEqual(["SDP"]);
  });
});

describe("eviction from another instance", () => {
  test("an eviction row closes the replaced socket and spares a newer one", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    // A generation that differs from the socket's in its last character. The
    // generation is a random UUID, so a fixed replacement character would equal
    // the real one once in 16 runs.
    const generation = old.data.socketGeneration;
    const stale = `${generation.slice(0, -1)}${generation.endsWith("0") ? "1" : "0"}`;
    expect(stale).not.toBe(generation);

    // An eviction for a generation this instance no longer has: nothing.
    expect(
      deliverPendingSignalsLocally(
        [{ id: "e-1", targetPeerId: PEER_ID, kind: "evict", payload: stale }],
        clients,
      ),
    ).toEqual(["e-1"]);
    expect(live(clients, [old])).toEqual(["old"]);

    // The eviction for this socket: closed with the contract's code. The row
    // is settled either way.
    expect(
      deliverPendingSignalsLocally(
        [
          {
            id: "e-2",
            targetPeerId: PEER_ID,
            kind: "evict",
            payload: old.data.socketGeneration,
          },
        ],
        clients,
      ),
    ).toEqual(["e-2"]);
    expect(old.closeArgs).toEqual([REPLACED]);
    expect(live(clients, [old])).toEqual([]);
    expect(old.sent).toEqual([]);
  });

  test("a claim replaced on another instance is evicted there, through its queue", async () => {
    const queued: unknown[] = [];
    const store = {
      pendingSignal: {
        create: async (query: { data: unknown }) => {
          queued.push(query.data);
          return query.data;
        },
      },
    };
    const notified: string[] = [];
    const notifier = {
      query: async (sql: string) => {
        notified.push(sql);
        return { rows: [] };
      },
    };

    await evictReplacedClaim(
      PEER_ID,
      { serverId: ELSEWHERE, socketGeneration: "gen-on-the-other-instance" },
      new Map(),
      HERE,
      store as never,
      notifier as never,
    );

    expect(queued).toEqual([
      {
        targetServerId: ELSEWHERE,
        targetPeerId: PEER_ID,
        kind: "evict",
        payload: "gen-on-the-other-instance",
      },
    ]);
    expect(notified).toEqual([`NOTIFY "server_${ELSEWHERE}"`]);
  });

  test("a socket replaced from another instance while it commits closes, and so does the socket it replaced", async () => {
    // old is current here. successor commits here (replacing old's claim),
    // then a session on another instance commits (replacing successor's) and
    // its eviction for successor arrives before successor is registered.
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const successor = socket("successor");
    expect(await prove(successor)).toBeTruthy();

    const activation = activateProvedSocket(successor, {
      clients,
      persist: async (ws) => {
        const committed = await store.commit()(ws);
        // The other instance's commit, and its eviction row, land now.
        store.takeOver({ serverId: ELSEWHERE, socketGeneration: "remote" });
        deliverPendingSignalsLocally(
          [
            {
              id: "e-1",
              targetPeerId: PEER_ID,
              kind: "evict",
              payload: ws.data.socketGeneration,
            },
          ],
          clients,
        );
        return committed;
      },
      undo: store.undo,
      evict: (peerId, replaced) =>
        evictReplacedClaim(peerId, replaced, clients, HERE),
    });

    expect(await activation).toBe(false);
    expect(successor.closeArgs).toEqual([REPLACED]);
    // successor could not give old's claim back (the other instance holds
    // it), so old stays replaced and is closed: no socket here is live, and
    // the claim is the other instance's.
    expect(old.closeArgs).toEqual([REPLACED]);
    expect(live(clients, [old, successor])).toEqual([]);
    expect(store.claim()).toEqual({
      serverId: ELSEWHERE,
      socketGeneration: "remote",
    });
  });
});

describe("claim reconciliation", () => {
  /** The Peer rows' claims, filtered as the reconciliation query filters. */
  const claimsTable = (
    claims: Record<string, string | null>,
    duringQuery: () => void = () => {},
  ) => ({
    peer: {
      findMany: async (query: {
        where: {
          id: { in: string[] };
          AND: [{ serverId: { not: null } }, { serverId: { not: string } }];
        };
        select: { id: true };
      }) => {
        duringQuery();
        const self = query.where.AND[1].serverId.not;
        return query.where.id.in
          .filter((id) => claims[id] != null && claims[id] !== self)
          .map((id) => ({ id }));
      },
    },
  });

  test("a socket replaced elsewhere whose eviction was lost closes at the next reconciliation", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);

    // The other instance's commit took the row; its eviction row never came.
    expect(
      await closeSocketsClaimedElsewhere(
        claimsTable({ [PEER_ID]: ELSEWHERE }) as never,
        clients,
        HERE,
      ),
    ).toBe(1);
    expect(old.closeArgs).toEqual([REPLACED]);
    expect(live(clients, [old])).toEqual([]);
  });

  test("reconciliation spares a cleared claim, its own claim and a socket that became current meanwhile", async () => {
    for (const claim of [null, HERE]) {
      const clients = new Map<string, P2PartyWSClient>();
      const old = await establishedSocket(clients, claimStore());
      expect(
        await closeSocketsClaimedElsewhere(
          claimsTable({ [PEER_ID]: claim }) as never,
          clients,
          HERE,
        ),
      ).toBe(0);
      expect(live(clients, [old])).toEqual(["old"]);
    }

    // A newer socket here commits and becomes current while the query runs:
    // the row the query read named the other instance, but that verdict was
    // about the older socket only.
    const clients = new Map<string, P2PartyWSClient>();
    const store = claimStore();
    const old = await establishedSocket(clients, store);
    const newer = socket("newer");
    expect(await prove(newer)).toBeTruthy();
    let activation: Promise<unknown> | undefined;
    const closed = await closeSocketsClaimedElsewhere(
      claimsTable({ [PEER_ID]: ELSEWHERE }, () => {
        activation = activate(clients, store, newer);
      }) as never,
      clients,
      HERE,
    );
    await activation;
    expect(closed).toBe(0);
    expect(live(clients, [old, newer])).toEqual(["newer"]);
  });
});
