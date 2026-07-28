import { describe, expect, test } from "bun:test";

import { deliverPendingSignalsLocally } from "../src/pubsub";

import type { P2PartyWSClient, P2PartyWSData } from "../src/wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";

describe("pending signal activation boundary", () => {
  test("claim-pending targets receive nothing and their row stays queued", () => {
    let sends = 0;
    let sendResult = 1;
    const ws = {
      data: {
        peerId: PEER_ID,
        publicKey: "ab".repeat(32),
        challengeNonce: "",
        challengeId: "",
        isVerified: true,
        isAuthenticating: true,
        isAlive: true,
      } satisfies P2PartyWSData,
      readyState: 1,
      send: () => {
        sends += 1;
        return sendResult;
      },
    } as unknown as P2PartyWSClient;
    const clients = new Map<string, P2PartyWSClient>([[PEER_ID, ws]]);
    const signals = [
      { id: "signal-1", targetPeerId: PEER_ID, payload: "private SDP" },
    ];

    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([]);
    expect(sends).toBe(0);

    ws.data.isAuthenticating = false;
    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([
      "signal-1",
    ]);
    expect(sends).toBe(1);

    sendResult = 0;
    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([]);
    expect(sends).toBe(2);

    clients.clear();
    expect(deliverPendingSignalsLocally(signals, clients)).toEqual([
      "signal-1",
    ]);
  });
});
