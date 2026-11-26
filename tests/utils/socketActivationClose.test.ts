import { describe, expect, test } from "bun:test";

import { deliverPendingSignalsLocally } from "../../src/pubsub";
import {
  activateVerifiedSocket,
  hasPendingActivation,
  retireClosedSocket,
} from "../../src/utils/socketAuth";
import {
  deferred,
  establishedSocket,
  live,
  PEER_ID,
  prove,
  socket,
} from "./socketActivationFixture";

import type { P2PartyWSClient } from "../../src/wsServer";

/**
 * Every socket of one identity in this process shares one routing claim
 * (Peer.serverId = this SERVER_ID). Whichever socket is last to leave must
 * release it, and no socket may release it while another one holds it or is
 * about to.
 */
describe("routing claim across a predecessor's close", () => {
  test("a predecessor closing mid-activation leaves the claim to its successor", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const successor = socket("successor");
    const commit = deferred<boolean>();
    const releases: string[] = [];
    const release = async (peerId: string) => {
      releases.push(peerId);
    };

    expect(await prove(successor)).toBeTruthy();
    const activation = activateVerifiedSocket(
      clients,
      successor,
      () => commit.promise,
      release,
    );
    expect(hasPendingActivation(clients, PEER_ID)).toBe(true);
    // The old tab goes away while the successor's claim write is in flight.
    // A release now could land after that write and clear it.
    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, release);
    expect(releases).toEqual([]);
    expect(clients.has(PEER_ID)).toBe(false);

    commit.resolve(true);
    expect(await activation).toBe(true);
    expect(live(clients, [old, successor])).toEqual(["successor"]);
    expect(releases).toEqual([]);
    expect(hasPendingActivation(clients, PEER_ID)).toBe(false);
  });

  test("a successor that then fails releases the claim its predecessor left", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const successor = socket("successor");
    const commit = deferred<boolean>();
    const releases: string[] = [];
    const release = async (peerId: string) => {
      releases.push(peerId);
    };

    expect(await prove(successor)).toBeTruthy();
    const activation = activateVerifiedSocket(
      clients,
      successor,
      () => commit.promise,
      release,
    );
    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, release);
    commit.resolve(false);

    expect(await activation).toBe(false);
    // No socket of this identity is left here, so the claim goes, once.
    expect(releases).toEqual([PEER_ID]);
    expect(clients.has(PEER_ID)).toBe(false);
    expect(hasPendingActivation(clients, PEER_ID)).toBe(false);
  });

  test("an owner closing with no activation in flight releases its claim", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const releases: string[] = [];

    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, async (peerId) => {
      releases.push(peerId);
    });

    expect(releases).toEqual([PEER_ID]);
    expect(clients.has(PEER_ID)).toBe(false);
  });

  test("a replaced predecessor's late close releases nothing", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const successor = socket("successor");
    const releases: string[] = [];
    const release = async (peerId: string) => {
      releases.push(peerId);
    };

    expect(await prove(successor)).toBeTruthy();
    expect(
      await activateVerifiedSocket(
        clients,
        successor,
        async () => true,
        release,
      ),
    ).toBe(true);
    await retireClosedSocket(clients, old, release);

    expect(releases).toEqual([]);
    expect(live(clients, [old, successor])).toEqual(["successor"]);
  });

  test("a queued cross-instance signal waits for an activating successor", async () => {
    const clients = new Map<string, P2PartyWSClient>();
    const old = await establishedSocket(clients);
    const successor = socket("successor");
    const commit = deferred<boolean>();
    const signals = [{ id: "signal-1", targetPeerId: PEER_ID, payload: "SDP" }];

    expect(await prove(successor)).toBeTruthy();
    const activation = activateVerifiedSocket(
      clients,
      successor,
      () => commit.promise,
      async () => {},
    );
    old.close(1001, "tab closed");
    await retireClosedSocket(clients, old, async () => {});

    // Neither delivered nor discarded while the successor activates.
    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([]);
    expect(successor.sent).toEqual([]);

    commit.resolve(true);
    expect(await activation).toBe(true);
    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([
      "signal-1",
    ]);
    expect(successor.sent).toEqual(["SDP"]);
  });
});
