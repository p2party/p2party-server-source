import { afterEach, describe, expect, spyOn, test } from "bun:test";

import handleMessage, {
  isExactRoomRequest,
  isExactLeaveRoomRequest,
  isBoundedPeersRequest,
} from "../../src/utils/handleMessage";
import { wsClients } from "../../src/wsServer";

import type {
  P2PartyWSClient,
  P2PartyWSData,
  P2PartyWSEvents,
} from "../../src/wsServer";

const PEER_ID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  wsClients.clear();
});

describe("additive bounded roster discovery", () => {
  const base = {
    type: "peers",
    fromPeerId: PEER_ID,
    roomId: "00000000-0000-4000-8000-000000000002",
    protocolVersion: 5,
  };
  test("legacy and correlated snapshot requests coexist without changing the challenge", () => {
    expect(isBoundedPeersRequest(base)).toBe(true);
    expect(
      isBoundedPeersRequest({
        ...base,
        rosterRequestId: PEER_ID,
        targetPeerIds: [PEER_ID],
      }),
    ).toBe(true);
  });
  test("malformed ids and any exclusion list are rejected before database work", () => {
    for (const extra of [
      { rosterRequestId: "bad" },
      { rosterRequestId: 1 },
      { excludedPeerIds: [PEER_ID] },
      { excludedPeerIds: [] },
      { excludedPeerIds: "all" },
      { excludedPeerIds: [null] },
      { excludedPeerIds: ["bad"] },
      { excludedPeerIds: Array(65).fill(PEER_ID) },
      { targetPeerIds: "all" },
      { targetPeerIds: [null] },
      { targetPeerIds: ["bad"] },
      { targetPeerIds: Array(65).fill(PEER_ID) },
      { roomId: null },
    ])
      expect(isBoundedPeersRequest({ ...base, ...extra })).toBe(false);
  });
});

describe("protocol-v5 authentication boundary", () => {
  test("a versionless or downgraded challenge cannot enter the verified registry", async () => {
    let closed = false;
    const data: P2PartyWSData = {
      peerId: PEER_ID,
      publicKey: "ab".repeat(32),
      challengeNonce: "cd".repeat(32),
      challengeId: "00000000-0000-4000-8000-000000000002",
      socketGeneration: "",
      isVerified: false,
      isAuthenticating: false,
      isAlive: true,
    };
    const ws = {
      data,
      close: () => {
        closed = true;
      },
    } as unknown as P2PartyWSClient;
    const events: P2PartyWSEvents = {
      open: () => {
        throw new Error("downgraded socket was activated");
      },
      message: () => {},
      close: () => {},
    };

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "challenge",
          fromPeerId: PEER_ID,
          challenge: data.challengeNonce,
          signature: "ef".repeat(64),
          protocolVersion: 2,
        }),
        events,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(closed).toBe(true);
    expect(data.isVerified).toBe(false);
    expect(wsClients.has(PEER_ID)).toBe(false);
  });

  test("legacy bearer fields make an otherwise v3 proof fail closed", async () => {
    let closed = false;
    const data: P2PartyWSData = {
      peerId: PEER_ID,
      publicKey: "ab".repeat(32),
      challengeNonce: "cd".repeat(32),
      challengeId: "00000000-0000-4000-8000-000000000002",
      socketGeneration: "",
      isVerified: false,
      isAuthenticating: false,
      isAlive: true,
    };
    const ws = {
      data,
      close: () => {
        closed = true;
      },
    } as unknown as P2PartyWSClient;
    const events: P2PartyWSEvents = {
      open: () => {
        throw new Error("legacy bearer socket was activated");
      },
      message: () => {},
      close: () => {},
    };

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "challenge",
          fromPeerId: PEER_ID,
          challenge: data.challengeNonce,
          signature: "ef".repeat(64),
          protocolVersion: 5,
          challengeId: data.challengeId,
        }),
        events,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(closed).toBe(true);
    expect(data.isVerified).toBe(false);
    expect(wsClients.has(PEER_ID)).toBe(false);
  });
});

describe("exact protocol-v5 room request", () => {
  const base = {
    type: "room",
    fromPeerId: PEER_ID,
    roomLocator: "ab".repeat(64),
    roomRequestId: "00000000-0000-4000-8000-000000000003",
    protocolVersion: 5,
  };

  test("accepts the one closed nonce-bound shape", () => {
    expect(isExactRoomRequest(base)).toBe(true);
  });

  test("missing, malformed, and non-closed shapes fail closed", () => {
    expect(isExactRoomRequest({ ...base, roomRequestId: "not-a-uuid" })).toBe(
      false,
    );
    expect(isExactRoomRequest({ ...base, roomRequestId: undefined })).toBe(
      false,
    );
    expect(isExactRoomRequest({ ...base, roomRequestId: null })).toBe(false);
    const { roomRequestId: _missing, ...withoutRequestId } = base;
    expect(isExactRoomRequest(withoutRequestId)).toBe(false);
    expect(isExactRoomRequest({ ...base, extra: true })).toBe(false);
  });
});

describe("protocol-v5 room leave wire", () => {
  const base = {
    type: "leaveRoom",
    protocolVersion: 5,
    fromPeerId: PEER_ID,
    roomLocator: "cd".repeat(64),
    roomLeaveId: "00000000-0000-4000-8000-000000000003",
  };

  test("accepts only the exact request with a UUIDv4 correlation id", () => {
    expect(isExactLeaveRoomRequest(base)).toBe(true);
    expect(isExactLeaveRoomRequest({ ...base, extra: true })).toBe(false);
    expect(isExactLeaveRoomRequest({ ...base, protocolVersion: 3 })).toBe(
      false,
    );
    expect(
      isExactLeaveRoomRequest({
        ...base,
        roomLeaveId: "00000000-0000-1000-8000-000000000003",
      }),
    ).toBe(false);
    const { roomLeaveId: _missing, ...withoutLeaveId } = base;
    expect(isExactLeaveRoomRequest(withoutLeaveId)).toBe(false);
  });

  test("a verified but displaced socket cannot send any post-auth frame", async () => {
    let closed = false;
    const ws = {
      data: {
        peerId: PEER_ID,
        publicKey: "ab".repeat(32),
        challengeNonce: "",
        challengeId: "",
        socketGeneration: "",
        isVerified: true,
        isAuthenticating: false,
        isAlive: false,
      },
      readyState: 1,
      close: () => {
        closed = true;
      },
    } as unknown as P2PartyWSClient;
    const events: P2PartyWSEvents = {
      open: () => {},
      message: () => {},
      close: () => {},
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await handleMessage(
        ws,
        JSON.stringify({ type: "pong", fromPeerId: PEER_ID }),
        events,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(closed).toBe(true);
    expect(ws.data.isAlive).toBe(false);
  });

  test("an extra-field pong fails closed instead of refreshing liveness", async () => {
    let closed = false;
    const ws = {
      data: {
        peerId: PEER_ID,
        publicKey: "ab".repeat(32),
        challengeNonce: "",
        challengeId: "",
        socketGeneration: "",
        isVerified: true,
        isAuthenticating: false,
        isAlive: false,
      },
      readyState: 1,
      close: () => {
        closed = true;
      },
    } as unknown as P2PartyWSClient;
    wsClients.set(PEER_ID, ws);
    const events: P2PartyWSEvents = {
      open: () => {},
      message: () => {},
      close: () => {},
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await handleMessage(
        ws,
        JSON.stringify({
          type: "pong",
          fromPeerId: PEER_ID,
          extra: true,
        }),
        events,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(closed).toBe(true);
    expect(ws.data.isAlive).toBe(false);
  });
});
