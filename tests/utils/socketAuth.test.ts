import { describe, expect, test } from "bun:test";

import {
  activateVerifiedSocket,
  consumeSocketChallenge,
  createFreshSocketChallenge,
  createTurnCredentials,
  isCurrentProofOwnerSocket,
  isCurrentVerifiedSocket,
  parseTurnUrls,
  isSocketChallengeBound,
  registerVerifiedSocket,
  TURN_CREDENTIAL_CONTRACT,
  unregisterSocketIfCurrent,
} from "../../src/utils/socketAuth";
import { PROTOCOL_VERSION } from "../../src/utils/protocolV4";

import type {
  ReplaceableSocketAuthClient,
  SocketAuthState,
} from "../../src/utils/socketAuth";

const PEER_ID = "00000000-0000-4000-8000-000000000001";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000002";

const state = (): SocketAuthState => ({
  peerId: "",
  publicKey: "",
  challengeNonce: "",
  challengeId: "",
  socketGeneration: "",
  isVerified: false,
  isAuthenticating: false,
});

const replaceableSocket = (): ReplaceableSocketAuthClient & {
  closeCalls: number;
  closeArgs: { code?: number; reason?: string }[];
} => ({
  data: state(),
  readyState: 1,
  closeCalls: 0,
  closeArgs: [],
  close(code?: number, reason?: string) {
    this.closeCalls += 1;
    this.closeArgs.push({ code, reason });
  },
});

describe("fresh per-WebSocket authentication state", () => {
  test("a new challenge replaces prior socket auth and exposes no bearer signature", () => {
    const auth = state();
    auth.isVerified = true;
    auth.challengeNonce = "old";
    auth.challengeId = "old";

    const request = createFreshSocketChallenge(
      auth,
      PEER_ID,
      "ab".repeat(32),
      "cd".repeat(32),
      CHALLENGE_ID,
    );

    expect(request).toEqual({
      type: "peerId",
      peerId: PEER_ID,
      challenge: "cd".repeat(32),
      protocolVersion: PROTOCOL_VERSION,
      message: `Connected to WebSocket server. Your client id is ${PEER_ID}`,
    });
    expect("signature" in request).toBe(false);
    expect("credential" in request).toBe(false);
    expect(auth.isVerified).toBe(false);
    expect(isSocketChallengeBound(auth, PEER_ID, "cd".repeat(32))).toBe(true);
  });

  test("successful proof consumes the nonce so it cannot be replayed", () => {
    const auth = state();
    createFreshSocketChallenge(
      auth,
      PEER_ID,
      "ab".repeat(32),
      "cd".repeat(32),
      CHALLENGE_ID,
    );

    expect(consumeSocketChallenge(auth)).toBe(CHALLENGE_ID);
    expect(auth.isVerified).toBe(true);
    expect(auth.challengeNonce).toBe("");
    expect(auth.challengeId).toBe("");
    expect(isSocketChallengeBound(auth, PEER_ID, "cd".repeat(32))).toBe(false);
  });
});

describe("verified socket registry", () => {
  test("synchronously deauthorizes and closes a replaced same-instance socket", () => {
    const clients = new Map<string, ReplaceableSocketAuthClient>();
    const oldSocket = replaceableSocket();
    const replacement = replaceableSocket();
    oldSocket.data.peerId = PEER_ID;
    oldSocket.data.publicKey = "ab".repeat(32);
    replacement.data.peerId = PEER_ID;
    replacement.data.publicKey = "ab".repeat(32);

    expect(registerVerifiedSocket(clients, oldSocket)).toBe(false);
    oldSocket.data.isVerified = true;
    replacement.data.isVerified = true;
    expect(registerVerifiedSocket(clients, oldSocket)).toBe(true);
    expect(isCurrentVerifiedSocket(clients, oldSocket)).toBe(true);
    expect(registerVerifiedSocket(clients, replacement)).toBe(true);
    expect(oldSocket.data.isVerified).toBe(false);
    expect(oldSocket.closeCalls).toBe(1);
    expect(isCurrentVerifiedSocket(clients, oldSocket)).toBe(false);
    expect(isCurrentVerifiedSocket(clients, replacement)).toBe(true);
    expect(unregisterSocketIfCurrent(clients, oldSocket)).toBe(false);
    expect(clients.get(PEER_ID)).toBe(replacement);
    expect(unregisterSocketIfCurrent(clients, replacement)).toBe(true);
    expect(clients.has(PEER_ID)).toBe(false);
  });

  /**
   * The client's signaling reconnect ladder retries every close except
   * codes 1003/1008/1010 chosen BY THE SERVER, which it treats as
   * permanent. A bare close() reaches the client as 1005 ("no status
   * received"), which the client deliberately retries -- otherwise the
   * reconnect fix itself would be undone. Before that reconnect ladder
   * existed, an evicted predecessor (a second tab, or a phrase-restored
   * second device reconnecting as the same identity) just went quiet. Now
   * a bare close here makes the evicted tab reconnect, evict whichever
   * socket displaced it, and the two sockets evict each other forever --
   * reintroducing the exact desync class this feature exists to fix, one
   * layer up. 1008 (policy violation) is in the client's permanent set, so
   * the evicted predecessor must be closed with it: "do not retry, another
   * session has taken over this identity" is exactly the right verdict for
   * a socket that was never invalid, only superseded.
   */
  test("eviction closes the predecessor with 1008 so it cannot retry into another eviction loop", () => {
    const clients = new Map<string, ReplaceableSocketAuthClient>();
    const predecessor = replaceableSocket();
    const successor = replaceableSocket();
    predecessor.data.peerId = PEER_ID;
    predecessor.data.publicKey = "ab".repeat(32);
    predecessor.data.isVerified = true;
    successor.data.peerId = PEER_ID;
    successor.data.publicKey = "ab".repeat(32);
    successor.data.isVerified = true;

    expect(registerVerifiedSocket(clients, predecessor)).toBe(true);
    expect(registerVerifiedSocket(clients, successor)).toBe(true);

    expect(predecessor.closeCalls).toBe(1);
    expect(predecessor.closeArgs).toEqual([
      { code: 1008, reason: expect.any(String) },
    ]);
    expect(predecessor.closeArgs[0]!.reason!.length).toBeGreaterThan(0);
    // The surviving socket must be completely untouched by the eviction.
    expect(successor.closeCalls).toBe(0);
    expect(successor.data.isVerified).toBe(true);
  });

  test("a failed routing claim closes and removes the unrouteable socket", async () => {
    const clients = new Map<string, ReplaceableSocketAuthClient>();
    const socket = replaceableSocket();
    socket.data.peerId = PEER_ID;
    socket.data.publicKey = "ab".repeat(32);
    socket.data.isVerified = true;
    const releases: string[] = [];

    expect(
      await activateVerifiedSocket(
        clients,
        socket,
        async () => false,
        async (peerId) => {
          releases.push(peerId);
        },
      ),
    ).toBe(false);
    expect(socket.data.isVerified).toBe(false);
    expect(socket.data.isAuthenticating).toBe(false);
    expect(socket.closeCalls).toBe(1);
    expect(clients.has(PEER_ID)).toBe(false);
    expect(releases).toEqual([PEER_ID]);
  });

  test("claim completion cannot activate a socket replaced during the await", async () => {
    const clients = new Map<string, ReplaceableSocketAuthClient>();
    const displaced = replaceableSocket();
    const replacement = replaceableSocket();
    for (const socket of [displaced, replacement]) {
      socket.data.peerId = PEER_ID;
      socket.data.publicKey = "ab".repeat(32);
      socket.data.isVerified = true;
    }
    let resolveClaim!: (claimed: boolean) => void;
    const claim = new Promise<boolean>((resolve) => {
      resolveClaim = resolve;
    });
    const releases: string[] = [];

    const activation = activateVerifiedSocket(
      clients,
      displaced,
      async () => claim,
      async (peerId) => {
        releases.push(peerId);
      },
    );
    expect(clients.get(PEER_ID)).toBe(displaced);
    expect(displaced.data.isAuthenticating).toBe(true);
    expect(isCurrentProofOwnerSocket(clients, displaced)).toBe(true);
    expect(isCurrentVerifiedSocket(clients, displaced)).toBe(false);

    expect(registerVerifiedSocket(clients, replacement)).toBe(true);
    expect(displaced.data.isVerified).toBe(false);
    resolveClaim(true);

    expect(await activation).toBe(false);
    expect(displaced.closeCalls).toBe(2);
    expect(isCurrentVerifiedSocket(clients, replacement)).toBe(true);
    // The successor owns the same process claim; displaced cleanup must not
    // release it.
    expect(releases).toEqual([]);
  });

  test("only a successful exact-owner claim completes activation", async () => {
    const clients = new Map<string, ReplaceableSocketAuthClient>();
    const socket = replaceableSocket();
    socket.data.peerId = PEER_ID;
    socket.data.publicKey = "ab".repeat(32);
    socket.data.isVerified = true;

    expect(
      await activateVerifiedSocket(
        clients,
        socket,
        async () => true,
        async () => {
          throw new Error("successful activation must not release its claim");
        },
      ),
    ).toBe(true);
    expect(socket.data.isAuthenticating).toBe(false);
    expect(isCurrentVerifiedSocket(clients, socket)).toBe(true);
    expect(socket.closeCalls).toBe(0);
  });

  test("a late successful claim is released when close cleanup already removed the socket", async () => {
    const clients = new Map<string, ReplaceableSocketAuthClient>();
    const socket = replaceableSocket();
    socket.data.peerId = PEER_ID;
    socket.data.publicKey = "ab".repeat(32);
    socket.data.isVerified = true;
    let resolveClaim!: (claimed: boolean) => void;
    const claim = new Promise<boolean>((resolve) => {
      resolveClaim = resolve;
    });
    const releases: string[] = [];

    const activation = activateVerifiedSocket(
      clients,
      socket,
      async () => claim,
      async (peerId) => {
        releases.push(peerId);
      },
    );
    // Models the WebSocket close callback winning the race with claimPeer.
    clients.delete(PEER_ID);
    socket.readyState = 3;
    resolveClaim(true);

    expect(await activation).toBe(false);
    expect(releases).toEqual([PEER_ID]);
    expect(clients.has(PEER_ID)).toBe(false);
  });
});

describe("TURN REST credentials", () => {
  test("omits credentials without an operator-provided secret", () => {
    expect(
      createTurnCredentials("ab".repeat(32), undefined, 1_000),
    ).toBeUndefined();
  });

  test("derives credentials only from the supplied secret", () => {
    // The HMAC is unchanged by carrying the URLs: username stays the sole
    // signed input, so existing coturn deployments keep verifying.
    expect(
      createTurnCredentials("ab".repeat(32), "s".repeat(32), 1_000, [
        "turns:turn.example.com:443?transport=tcp",
      ]),
    ).toEqual({
      urls: ["turns:turn.example.com:443?transport=tcp"],
      username: `3601:${"ab".repeat(32)}`,
      credential: "XY6V5LzRrbIFUOH5w0qdZ90iYuQ=",
      expiresAtUnixSeconds: 3601,
    });
  });

  test("issues nothing when no relay endpoint is configured", () => {
    // A credential without a URL is what shipped before and no client could
    // act on it; withholding it keeps the degraded state honest.
    expect(
      createTurnCredentials("ab".repeat(32), "s".repeat(32), 1_000, []),
    ).toBeUndefined();
  });

  test("keeps only well-formed turn and turns URIs", () => {
    expect(
      parseTurnUrls(
        " turns:turn.example.com:443?transport=tcp , turn:turn.example.com:3478 ",
      ),
    ).toEqual([
      "turns:turn.example.com:443?transport=tcp",
      "turn:turn.example.com:3478",
    ]);
    // Anything that is not a relay URI never reaches a browser's ICE config.
    expect(
      parseTurnUrls("https://evil.example.com,stun:stun.example.com"),
    ).toEqual([]);
    expect(parseTurnUrls(undefined)).toEqual([]);
    expect(parseTurnUrls("")).toEqual([]);
  });

  test("deduplicates and caps relay URLs at the SDK wire boundary", () => {
    const maximumLengthUrl = `turn:${"a".repeat(
      TURN_CREDENTIAL_CONTRACT.maxUrlChars - "turn:".length,
    )}`;
    const urls = Array.from(
      { length: TURN_CREDENTIAL_CONTRACT.maxUrls + 2 },
      (_, index) => `turn:turn-${String(index)}.example.com:3478`,
    );

    expect(parseTurnUrls(`${maximumLengthUrl},${maximumLengthUrl}a`)).toEqual([
      maximumLengthUrl,
    ]);
    expect(
      parseTurnUrls(
        [
          urls[0],
          urls[0],
          `turn:${"a".repeat(TURN_CREDENTIAL_CONTRACT.maxUrlChars)}`,
          ...urls,
        ].join(","),
      ),
    ).toEqual(urls.slice(0, TURN_CREDENTIAL_CONTRACT.maxUrls));
  });

  test("normalizes explicit URLs before issuing an SDK-compatible bundle", () => {
    const publicKey = "ab".repeat(32);
    const urls = Array.from(
      { length: TURN_CREDENTIAL_CONTRACT.maxUrls + 2 },
      (_, index) => `turn:turn-${String(index)}.example.com:3478`,
    );
    const credentials = createTurnCredentials(
      publicKey,
      "s".repeat(32),
      1_000,
      [
        ` ${urls[0]} `,
        urls[0],
        `turn:${"a".repeat(TURN_CREDENTIAL_CONTRACT.maxUrlChars)}`,
        "https://not-a-turn-server.example.com",
        ...urls,
      ],
    );

    expect(credentials).toBeDefined();
    expect(credentials!.urls).toEqual(
      urls.slice(0, TURN_CREDENTIAL_CONTRACT.maxUrls),
    );
    expect(credentials!.urls.length).toBeGreaterThan(0);
    expect(credentials!.urls.length).toBeLessThanOrEqual(
      TURN_CREDENTIAL_CONTRACT.maxUrls,
    );
    expect(new Set(credentials!.urls).size).toBe(credentials!.urls.length);
    expect(
      credentials!.urls.every(
        (url) =>
          url.length <= TURN_CREDENTIAL_CONTRACT.maxUrlChars &&
          /^turns?:[^\s]+$/u.test(url),
      ),
    ).toBe(true);
    expect(credentials!.username).toBe(
      `${String(credentials!.expiresAtUnixSeconds)}:${publicKey}`,
    );
    expect(credentials!.username.length).toBeLessThanOrEqual(
      TURN_CREDENTIAL_CONTRACT.maxCredentialChars,
    );
    expect(credentials!.credential.length).toBeGreaterThan(0);
    expect(credentials!.credential.length).toBeLessThanOrEqual(
      TURN_CREDENTIAL_CONTRACT.maxCredentialChars,
    );
    expect(credentials!.expiresAtUnixSeconds).toBe(3601);
  });

  test("rejects identities and times that cannot satisfy the SDK contract", () => {
    expect(() =>
      createTurnCredentials("AB".repeat(32), "s".repeat(32), 1_000, [
        "turn:turn.example.com:3478",
      ]),
    ).toThrow("not canonical");
    expect(() =>
      createTurnCredentials("ab".repeat(32), "s".repeat(32), Number.NaN, [
        "turn:turn.example.com:3478",
      ]),
    ).toThrow("timestamp");
  });

  test("rejects a weak configured secret instead of silently issuing credentials", () => {
    expect(() =>
      createTurnCredentials("ab".repeat(32), "too-short", 1_000),
    ).toThrow("at least 32 bytes");
  });
});
