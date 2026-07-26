import { randomUUID } from "node:crypto";

import pg from "pg";

import { postgresSslOptions } from "./db/ssl";
import { prisma } from "./prismaClient";
import { wsClients } from "./wsServer";

/**
 * Cross-instance signal routing.
 *
 * The deploy runs one signaling process per vCPU behind a round-robin Caddy
 * upstream, and each process holds its own in-memory `wsClients` map. Two peers
 * in the same room therefore land on the same process only by chance — with N
 * workers, a given pair shares a process with probability 1/N. Without the
 * routing below, every other pair's offer, answer and ICE candidates are looked
 * up in the wrong map, miss, and are dropped in silence.
 *
 * So each process claims a `SERVER_ID`, records it on every peer row it holds a
 * socket for, and delivers to peers it does not hold by writing a PendingSignal
 * row and issuing NOTIFY on the owning process's channel. The owner wakes,
 * drains its rows, and delivers locally.
 */

/** Identifies this process for the lifetime of the process. */
export const SERVER_ID = randomUUID();

const CHANNEL = `server_${SERVER_ID}`;
/** Catches anything a lost NOTIFY would otherwise strand. */
const SAFETY_POLL_MS = 5_000;
/** Fail fast instead of hanging: see the note at the pg.Client construction. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Rows older than this belong to a process that died without cleaning up. */
const STALE_SIGNAL_MS = 5 * 60 * 1000;

let listenClient: pg.Client | undefined;
let safetyPoll: ReturnType<typeof setInterval> | undefined;

/** Deliver everything addressed to this process, then forget it. */
const drainPendingSignals = async (): Promise<void> => {
  try {
    const signals = await prisma.pendingSignal.findMany({
      where: { targetServerId: SERVER_ID },
      orderBy: { createdAt: "asc" },
    });
    if (signals.length === 0) return;

    // Delete whether or not the socket was still there: a signal for a peer who
    // has since disconnected is stale, and leaving it would replay forever.
    const delivered: string[] = [];
    for (const signal of signals) {
      wsClients.get(signal.targetPeerId)?.send(signal.payload);
      delivered.push(signal.id);
    }
    await prisma.pendingSignal.deleteMany({
      where: { id: { in: delivered } },
    });
  } catch (error) {
    console.error("p2party: failed to drain pending signals", error);
  }
};

/**
 * Open the LISTEN connection. Must run once at startup, before sockets are
 * accepted. Throws if the connection cannot be established: a process that
 * silently runs without pubsub drops most of the room's signalling.
 */
export const initPubSub = async (): Promise<void> => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "p2party: DATABASE_URL is required for cross-instance signalling",
    );

  // A dedicated connection: node-postgres delivers notifications only on the
  // exact connection that issued LISTEN, and Prisma's pool would hand this
  // query to an arbitrary one.
  //
  // Both timeouts are load-bearing. node-postgres defaults connectionTimeoutMillis
  // to 0, meaning wait forever, and a cloud firewall DROPs rather than REJECTs —
  // so an unreachable Postgres makes connect() hang indefinitely. index.ts awaits
  // this before binding the listener, so the whole process would hang with no
  // error at all, presenting as a health-check timeout that says nothing about
  // the cause. Failing in seconds with a readable message is the difference
  // between a five-minute fix and an afternoon.
  listenClient = new pg.Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: CONNECT_TIMEOUT_MS,
    // node-postgres does not implement libpq's sslmode semantics. libpq reads
    // `prefer` as "try TLS, fall back to plaintext"; node-postgres treats any
    // TLS request as strict, so Postgres's default self-signed certificate is
    // rejected with DEPTH_ZERO_SELF_SIGNED_CERT and the connection fails
    // outright rather than falling back.
    //
    // The link is private-network only and the certificate is the one Debian
    // generates at install time, so there is no chain to verify against.
    // Encrypting without verifying is strictly better than the plaintext this
    // otherwise falls back to: it stops passive capture on the private network,
    // while offering no protection against an active in-path attacker. Issuing
    // a real certificate and moving to full verification is the remaining step.
    ssl: postgresSslOptions(connectionString),
  });

  try {
    await listenClient.connect();
    await listenClient.query(`LISTEN "${CHANNEL}"`);
  } catch (cause) {
    listenClient = undefined;
    // Name the host: the message lands in journalctl, where the reader has no
    // access to the environment that produced it.
    const target = /@([^/?]+)/.exec(connectionString)?.[1] ?? "the database";
    throw new Error(
      `p2party: could not reach Postgres at ${target} for cross-instance ` +
        `signalling (${cause instanceof Error ? cause.message : String(cause)}). ` +
        "The server refuses to start without it, because a worker that cannot " +
        "route silently drops signals for peers held by other workers.",
      { cause },
    );
  }

  listenClient.on("notification", (message) => {
    if (message.channel === CHANNEL) void drainPendingSignals();
  });

  // A dropped LISTEN connection would otherwise strand every later signal.
  listenClient.on("error", (error) => {
    console.error("p2party: pubsub listen connection error", error);
  });

  safetyPoll = setInterval(() => void drainPendingSignals(), SAFETY_POLL_MS);

  // Clear rows left behind by a process that exited without shutting down.
  //
  // Scoped deliberately. Deleting every row past an age threshold would also
  // delete rows addressed to sibling instances that are alive and simply busy —
  // this process does not own those, and a rolling restart would have each new
  // worker discard its siblings' queued signals in turn. Only rows addressed to
  // a server id that no connected peer claims are provably undeliverable, so
  // only those are removed.
  try {
    const claimed = await prisma.peer.findMany({
      where: { serverId: { not: null } },
      select: { serverId: true },
      distinct: ["serverId"],
    });
    const liveServerIds = claimed
      .map((peer) => peer.serverId)
      .filter((id): id is string => id !== null);

    await prisma.pendingSignal.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - STALE_SIGNAL_MS) },
        targetServerId: { notIn: liveServerIds },
      },
    });
  } catch (error) {
    console.error("p2party: failed to clear orphaned pending signals", error);
  }
};

/**
 * Deliver a serialized frame to a peer, wherever its socket lives.
 *
 * Returns true when the frame was delivered locally or handed to the owning
 * process, false when the peer is not connected anywhere. Callers that need to
 * distinguish "offline" from "delivered" should check it; the signalling
 * handlers treat both as non-fatal.
 */
export const sendToPeer = async (
  toPeerId: string,
  payload: string,
): Promise<boolean> => {
  const local = wsClients.get(toPeerId);
  if (local) {
    local.send(payload);
    return true;
  }

  // Deliberately never throws. Callers are signalling handlers whose own catch
  // blocks disconnect the peer, and a routing problem — the database being
  // briefly unreachable, or this process not yet initialised — must not tear
  // down sockets that are working fine. Undelivered signalling is retried by
  // the client; a closed socket is not.
  // Checked before any query. Without a listener this process cannot NOTIFY the
  // owner, so the lookup would be wasted work — and in unit tests, where
  // initPubSub never runs, it would otherwise open a real database connection
  // and break the isolation those tests are written to have.
  if (!listenClient) return false;

  try {
    const peer = await prisma.peer.findUnique({
      where: { id: toPeerId },
      select: { serverId: true },
    });
    // No row, or no owner: the peer is not connected to any instance.
    if (!peer?.serverId) return false;

    await prisma.pendingSignal.create({
      data: {
        targetServerId: peer.serverId,
        targetPeerId: toPeerId,
        payload,
      },
    });

    // The NOTIFY carries no payload: the channel name alone tells the owner to
    // drain. That keeps the signal out of Postgres's notification queue and
    // clear of its 8000-byte payload limit.
    await listenClient.query(`NOTIFY "server_${peer.serverId}"`);
    return true;
  } catch (error) {
    console.error("p2party: failed to route signal to peer", toPeerId, error);
    return false;
  }
};

/** Record that this process now holds the socket for `peerId`. */
export const claimPeer = async (peerId: string): Promise<void> => {
  try {
    await prisma.peer.update({
      where: { id: peerId },
      data: { serverId: SERVER_ID },
    });
  } catch (error) {
    console.error("p2party: failed to claim peer", peerId, error);
  }
};

/**
 * Release a peer this process no longer holds. Guarded on SERVER_ID so a
 * delayed close cannot clear a claim that another instance has already taken
 * after the peer reconnected there.
 */
export const releasePeer = async (peerId: string): Promise<void> => {
  try {
    await prisma.peer.updateMany({
      where: { id: peerId, serverId: SERVER_ID },
      data: { serverId: null },
    });
  } catch (error) {
    console.error("p2party: failed to release peer", peerId, error);
  }
};

/** Drop this process's claims and routing rows so peers can reconnect elsewhere. */
export const shutdownPubSub = async (): Promise<void> => {
  if (safetyPoll) clearInterval(safetyPoll);
  safetyPoll = undefined;
  try {
    await prisma.pendingSignal.deleteMany({
      where: { targetServerId: SERVER_ID },
    });
    await prisma.peer.updateMany({
      where: { serverId: SERVER_ID },
      data: { serverId: null },
    });
  } catch (error) {
    console.error("p2party: error during pubsub shutdown", error);
  } finally {
    await listenClient?.end().catch(() => undefined);
    listenClient = undefined;
  }
};
