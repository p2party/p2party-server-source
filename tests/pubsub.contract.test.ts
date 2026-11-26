import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Supported production runs one signaling process while distributed
 * same-identity fencing remains a nonclaim. Multi-worker routing is retained as
 * an explicit experimental operator opt-in. In that topology each process
 * keeps its own in-memory wsClients map, so a peer pair shares a process only
 * with probability 1/N. Any delivery site that resolves a target socket and
 * does NOT fall back to cross-instance routing silently drops the signal for
 * most pairs — and silently is the operative word: nothing logs, the room
 * simply never forms.
 *
 * These tests are structural on purpose. Exercising the real path needs a live
 * Postgres with LISTEN/NOTIFY, which unit tests must not require; what they can
 * guarantee is that no delivery site regresses to local-only.
 */

// These read the real sources to assert structure, so they must point at
// src/ now that the suite lives in tests/.
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const utilsDir = join(srcRoot, "utils");

const handlerFiles = readdirSync(utilsDir)
  .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
  .map((f) => ({ name: f, source: readFileSync(join(utilsDir, f), "utf8") }));

const pubsub = readFileSync(join(srcRoot, "pubsub.ts"), "utf8");
const socketAuth = readFileSync(join(utilsDir, "socketAuth.ts"), "utf8");

describe("cross-instance signal routing", () => {
  test("every handler that resolves a socket also routes remotely", () => {
    const localOnly = handlerFiles
      .filter((f) => f.source.includes("wsClients.get("))
      .filter((f) => !f.source.includes("sendToPeer"))
      .map((f) => f.name);

    expect(localOnly).toEqual([]);
  });

  test("sendToPeer never throws, so routing cannot close a healthy socket", () => {
    // The signalling handlers wrap their bodies in try/catch and disconnect the
    // peer on error. If routing threw, a brief database blip would disconnect
    // everyone rather than merely delaying a signal.
    const body = /export const sendToPeer[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    expect(body).toContain("try {");
    expect(body).toContain("catch");
    expect(body).toMatch(/return false;/);
    // No bare throw inside the routing path.
    expect(/\n\s{2,}throw new Error/.test(body)).toBe(false);
  });

  test("a peer is claimed only after its socket is verified", () => {
    const handleMessage = readFileSync(
      join(utilsDir, "handleMessage.ts"),
      "utf8",
    );
    const authenticated = handleMessage.indexOf("if (authenticated)");
    const activation = handleMessage.indexOf("activateVerifiedSocket(");
    expect(authenticated).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(authenticated);

    // registerVerifiedSocket is the gate: it returns false unless isVerified.
    const body =
      /export const activateVerifiedSocket[\s\S]*?\n\};/.exec(
        socketAuth,
      )?.[0] ?? "";
    const gate = body.indexOf("registerVerifiedSocket(clients, ws)");
    const claim = body.indexOf("claimPeer(ws.data.peerId)");
    expect(gate).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(gate);
  });

  test("release is guarded on this instance's id", () => {
    // Otherwise a slow close on the old worker clears the claim that the new
    // worker just took for a reconnecting peer, stranding it.
    const body =
      /export const releasePeer[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    expect(body).toContain("serverId: SERVER_ID");
    expect(body).toContain("updateMany");
  });

  test("shutdown clears this instance's claims and routing rows", () => {
    const body =
      /export const shutdownPubSub[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    expect(body).toContain("pendingSignal.deleteMany");
    expect(body).toContain("serverId: null");
  });

  test("the listener uses its own connection, not the Prisma pool", () => {
    // node-postgres delivers notifications only on the connection that issued
    // LISTEN; a pooled query would land on an arbitrary one and never fire.
    expect(pubsub).toContain("new pg.Client(");
    expect(pubsub).toContain("LISTEN");
  });
});

describe("data ownership", () => {
  test("startup sweeps by age, then clears dead servers by LISTEN-session liveness", () => {
    // A live owner drains within one safety poll, so rows past the age limit
    // are undeliverable wherever they are addressed (behaviour is covered in
    // pubsub.routingRetention.test.ts). Claims are cleared only for server ids
    // without a connected LISTEN session, which a sibling opens before it
    // claims any peer.
    const init = /export const initPubSub[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    const naming = init.indexOf("routingSessionName(SERVER_ID)");
    const listen = init.indexOf("query(`LISTEN");
    const clearDead = init.indexOf("clearDeadServerState(prisma");
    const sweep = init.indexOf("sweepStalePendingSignals()");
    const periodic = init.indexOf("startPendingSignalSweep()");
    expect(naming).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(naming);
    // The age sweep runs first, so the liveness check only groups rows that
    // are younger than the age limit.
    expect(sweep).toBeGreaterThan(listen);
    expect(clearDead).toBeGreaterThan(sweep);
    expect(init).toContain("connectedServerIds(client, serverIds)");
    expect(periodic).toBeGreaterThan(clearDead);
    const shutdown =
      /export const shutdownPubSub[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    expect(shutdown).toContain("clearInterval(pendingSignalSweep)");
  });

  test("startup logs how many server ids it cleared, and nothing else about them", () => {
    // The behaviour of the clearing is covered in pubsub.routingRetention;
    // initPubSub itself needs a live database, so its log line is read here.
    const init = /export const initPubSub[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    const infos = [...init.matchAll(/console\.info\(([\s\S]*?)\);/g)].map(
      ([, args]) => args!,
    );
    expect(infos).toHaveLength(1);
    // One template literal whose only interpolation is the count: the array
    // itself, or any id from it, never reaches the log.
    const message = infos[0]!.trim();
    expect(message).toMatch(/^`[^`]*`,?$/);
    expect(message.match(/\$\{/g)).toHaveLength(1);
    expect(message).toContain("${String(cleared.length)}");
    expect(init.indexOf("console.info(")).toBeGreaterThan(
      init.indexOf("clearDeadServerState(prisma"),
    );
  });

  test("shutdown deletes only this instance's rows", () => {
    const body =
      /export const shutdownPubSub[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    expect(body).toContain("targetServerId: SERVER_ID");
  });

  test("nothing in pubsub drops a table or database", () => {
    for (const forbidden of [
      "deleteMany({})",
      "DROP TABLE",
      "DROP DATABASE",
      "TRUNCATE",
      "$executeRawUnsafe",
    ])
      expect(pubsub).not.toContain(forbidden);
  });
});

describe("test isolation", () => {
  test("routing short-circuits before any query when uninitialised", () => {
    // handlePeers and friends are dependency-injected for tests, but sendToPeer
    // uses the module-level prisma singleton. Without this guard a unit test
    // opens a real database connection through the routing path.
    const body = /export const sendToPeer[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    const guard = body.indexOf("if (!listenClient) return false;");
    const query = body.indexOf("prisma.");
    expect(guard).toBeGreaterThan(-1);
    expect(query).toBeGreaterThan(guard);
  });
});

describe("startup cannot hang", () => {
  test("the listen client sets connection and query timeouts", () => {
    // index.ts awaits initPubSub before binding the port, and node-postgres
    // defaults connectionTimeoutMillis to 0 (wait forever). A firewall that
    // DROPs makes an unreachable database hang the whole process with no log
    // line — indistinguishable from a health check that just never passes.
    expect(pubsub).toContain("connectionTimeoutMillis: CONNECT_TIMEOUT_MS");
    expect(pubsub).toContain("query_timeout: CONNECT_TIMEOUT_MS");
    const timeout = /const CONNECT_TIMEOUT_MS = ([0-9_]+);/.exec(pubsub)?.[1];
    expect(Number((timeout ?? "0").replace(/_/g, ""))).toBeGreaterThan(0);
  });

  test("a failed connect names the host and clears the client", () => {
    const init = /export const initPubSub[\s\S]*?\n\};/.exec(pubsub)?.[0] ?? "";
    expect(init).toContain("listenClient = undefined;");
    expect(init).toMatch(/could not reach Postgres at \$\{target\}/);
  });
});
