import { randomUUID } from "node:crypto";

import pg from "pg";

import { postgresConnection } from "./db/ssl";
import { prisma } from "./prismaClient";
import { wsClients } from "./wsServer";
import { peerLogTag } from "./utils/logTag";
import { isCurrentVerifiedSocket } from "./utils/socketAuth";

import type { ProcessPrismaClient } from "./prismaClient";
import type { P2PartyWSClient } from "./wsServer";

/**
 * Cross-instance signal routing.
 *
 * Supported production currently runs one signaling process because
 * same-identity fencing is process-local. Operators can explicitly opt into
 * multiple Caddy upstreams, and each process then holds its own in-memory
 * `wsClients` map. With N workers, a pair shares a process with probability
 * 1/N. Without the routing below, every other pair's offer, answer and ICE
 * candidates are looked up in the wrong map, miss, and are dropped in silence.
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
/**
 * A queued offer, answer or ICE candidate is stale long before this. Older
 * rows are deleted whichever process they are addressed to: a live owner
 * drains within one safety poll, so an older row belongs to a dead process or
 * to a peer that never came back.
 */
export const PENDING_SIGNAL_MAX_AGE_MS = 120_000;
/**
 * How often the age sweep runs. While no more than one run's batches of rows
 * age out per period, a row lives at most MAX_AGE plus this.
 */
const PENDING_SIGNAL_SWEEP_MS = 30_000;
/** Rows one delete statement may remove, as in room retention. */
export const PENDING_SIGNAL_SWEEP_BATCH = 1_000;
/** Batches one sweep run may delete, so a run is bounded after an outage. */
export const PENDING_SIGNAL_SWEEP_MAX_BATCHES = 10;
/** Prefix of the LISTEN session's application_name; see routingSessionName. */
const ROUTING_SESSION_PREFIX = "p2party-signaling:";
/**
 * PostgreSQL closes the LISTEN session of a host that vanished without a TCP
 * reset within about a minute, instead of the operating system's defaults of
 * two hours idle or about fifteen minutes with data unacknowledged, so its
 * liveness ends with it. Keepalive values are seconds; the user timeout is
 * milliseconds (PostgreSQL 12 and later).
 */
const SESSION_KEEPALIVE = {
  tcp_keepalives_idle: "30",
  tcp_keepalives_interval: "10",
  tcp_keepalives_count: "3",
  tcp_user_timeout: "60000",
} as const;

let listenClient: pg.Client | undefined;
let safetyPoll: ReturnType<typeof setInterval> | undefined;
let pendingSignalSweep: ReturnType<typeof setInterval> | undefined;

type RoutingStore = Pick<ProcessPrismaClient, "peer" | "pendingSignal">;
type ActivityClient = Pick<pg.Client, "query">;

interface PendingSignalFrame {
  id: string;
  targetPeerId: string;
  payload: string;
}

export const deliverPendingSignalsLocally = (
  signals: readonly PendingSignalFrame[],
  clients: Map<string, P2PartyWSClient> = wsClients,
): string[] => {
  const settled: string[] = [];
  for (const signal of signals) {
    const target = clients.get(signal.targetPeerId);
    if (!target) {
      // This process no longer has the addressed socket; the row cannot become
      // deliverable here and must not replay forever.
      settled.push(signal.id);
      continue;
    }
    // A cryptographically verified socket is inserted before its routing
    // claim completes. Retain the row until activation rather than disclose
    // SDP/ICE early or delete the only queued copy.
    if (!isCurrentVerifiedSocket(clients, target)) continue;
    if (target.send(signal.payload) !== 0) settled.push(signal.id);
  }
  return settled;
};

/** Deliver active targets, discard stale targets, retain claim-pending rows. */
const drainPendingSignals = async (): Promise<void> => {
  try {
    const signals = await prisma.pendingSignal.findMany({
      where: { targetServerId: SERVER_ID },
      orderBy: { createdAt: "asc" },
    });
    if (signals.length === 0) return;

    const delivered = deliverPendingSignalsLocally(signals);
    await prisma.pendingSignal.deleteMany({
      where: { id: { in: delivered } },
    });
  } catch (error) {
    console.error("p2party: failed to drain pending signals", error);
  }
};

/** Delete every queued signal older than PENDING_SIGNAL_MAX_AGE_MS. */
export const sweepStalePendingSignals = async (
  store: Pick<RoutingStore, "pendingSignal"> = prisma,
  now = Date.now(),
): Promise<number> => {
  const cutoff = new Date(now - PENDING_SIGNAL_MAX_AGE_MS);
  let deleted = 0;
  // Oldest first through the createdAt index, one bounded batch at a time; a
  // short batch means nothing older is left.
  for (let batch = 0; batch < PENDING_SIGNAL_SWEEP_MAX_BATCHES; batch++) {
    const stale = await store.pendingSignal.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: PENDING_SIGNAL_SWEEP_BATCH,
    });
    if (stale.length === 0) break;
    const { count } = await store.pendingSignal.deleteMany({
      where: { id: { in: stale.map(({ id }) => id) } },
    });
    deleted += count;
    if (stale.length < PENDING_SIGNAL_SWEEP_BATCH) break;
  }
  return deleted;
};

/** Run sweepStalePendingSignals every PENDING_SIGNAL_SWEEP_MS. */
export const startPendingSignalSweep = (
  store: Pick<RoutingStore, "pendingSignal"> = prisma,
  now: () => number = Date.now,
  every: (task: () => void, ms: number) => ReturnType<typeof setInterval> = (
    task,
    ms,
  ) => setInterval(task, ms),
): ReturnType<typeof setInterval> =>
  every(() => {
    sweepStalePendingSignals(store, now()).catch((error: unknown) => {
      console.error("p2party: failed to sweep stale pending signals", error);
    });
  }, PENDING_SIGNAL_SWEEP_MS);

/**
 * The application_name of a process's LISTEN session. The session is the
 * process's liveness heartbeat: PostgreSQL ends it when the process exits or
 * its connection drops, and a process that has none cannot be woken to drain.
 */
export const routingSessionName = (serverId: string): string =>
  `${ROUTING_SESSION_PREFIX}${serverId}`;

/** Which of `serverIds` have a LISTEN session connected to PostgreSQL now. */
export const connectedServerIds = async (
  client: ActivityClient,
  serverIds: readonly string[],
): Promise<Set<string>> => {
  const result = await client.query<{ application_name: string }>(
    "SELECT application_name FROM pg_stat_activity WHERE application_name = ANY($1::text[])",
    [serverIds.map(routingSessionName)],
  );
  return new Set(
    result.rows.map(({ application_name }) =>
      application_name.slice(ROUTING_SESSION_PREFIX.length),
    ),
  );
};

/**
 * Clear the routing state of processes that died without shutting down.
 *
 * After SIGKILL, an OOM kill or a crash, peers that have not reconnected keep
 * `serverId` set to the dead process, and sendToPeer keeps queueing their
 * signals (SDP and ICE, with IP addresses) for a process that will never
 * drain them. Every server id named by a claim or a queued row, other than
 * this process's, is checked against the live LISTEN sessions; the claims and
 * rows of ids without one are cleared. A sibling's session exists before it
 * claims any peer, so a live sibling is never cleared. Throws, clearing
 * nothing, when liveness cannot be read.
 *
 * Returns the server ids that were cleared.
 */
export const clearDeadServerState = async (
  store: RoutingStore,
  isConnected: (serverIds: string[]) => Promise<Set<string>>,
  self: string = SERVER_ID,
): Promise<string[]> => {
  // GROUP BY in SQL, over the serverId and targetServerId indexes: one row
  // per server id, never every peer or queued signal.
  const claims = await store.peer.groupBy({
    by: ["serverId"],
    where: { serverId: { not: null } },
  });
  const addressed = await store.pendingSignal.groupBy({
    by: ["targetServerId"],
  });
  const foreign = [
    ...new Set([
      ...claims.map(({ serverId }) => serverId),
      ...addressed.map(({ targetServerId }) => targetServerId),
    ]),
  ].filter((id): id is string => id !== null && id !== self);
  if (foreign.length === 0) return [];

  const live = await isConnected(foreign);
  const dead = foreign.filter((id) => !live.has(id));
  if (dead.length === 0) return [];

  await store.peer.updateMany({
    where: { serverId: { in: dead } },
    data: { serverId: null },
  });
  await store.pendingSignal.deleteMany({
    where: { targetServerId: { in: dead } },
  });
  return dead;
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
  // Strip the ssl parameters before constructing: pg-connection-string parses
  // them inside the Client constructor and its result overrides an explicit
  // `ssl` option, which is why passing one alone did not take effect.
  const pgConnection = postgresConnection(connectionString);

  listenClient = new pg.Client({
    connectionString: pgConnection.connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: CONNECT_TIMEOUT_MS,
    // The shared parser verifies every encrypted connection. Production pins
    // the CA installed by postgres-tls.yml; only explicit local sslmode=disable
    // skips TLS. The LISTEN channel and Prisma must use the same trust policy.
    ssl: pgConnection.ssl,
  });

  try {
    await listenClient.connect();
    // Name the session before this process can claim a peer, so a sibling
    // that starts later sees it as live. Set after connecting so a parameter
    // in DATABASE_URL cannot override it.
    await listenClient.query(
      "SELECT set_config('application_name', $1, false)," +
        " set_config('tcp_keepalives_idle', $2, false)," +
        " set_config('tcp_keepalives_interval', $3, false)," +
        " set_config('tcp_keepalives_count', $4, false)," +
        " set_config('tcp_user_timeout', $5, false)",
      [
        routingSessionName(SERVER_ID),
        SESSION_KEEPALIVE.tcp_keepalives_idle,
        SESSION_KEEPALIVE.tcp_keepalives_interval,
        SESSION_KEEPALIVE.tcp_keepalives_count,
        SESSION_KEEPALIVE.tcp_user_timeout,
      ],
    );
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

  // Delete everything past the age limit first, so the liveness check below
  // only groups recent rows, then clear the claims and rows of processes that
  // exited without shutting down. The periodic sweep keeps the age limit.
  try {
    await sweepStalePendingSignals();
  } catch (error) {
    console.error("p2party: failed to sweep stale pending signals", error);
  }
  const client = listenClient;
  try {
    const cleared = await clearDeadServerState(prisma, (serverIds) =>
      connectedServerIds(client, serverIds),
    );
    // The count only: server ids are routing state, not for the journal.
    console.info(
      `p2party: startup cleared the routing state of ${String(cleared.length)} stopped server id(s)`,
    );
  } catch (error) {
    console.error(
      "p2party: failed to clear dead servers' routing state",
      error,
    );
  }
  pendingSignalSweep = startPendingSignalSweep();
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
    if (isCurrentVerifiedSocket(wsClients, local)) {
      local.send(payload);
      return true;
    }
    return false;
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
    console.error(
      "p2party: failed to route signal to peer",
      peerLogTag(toPeerId),
      error,
    );
    return false;
  }
};

/**
 * Record that this process now holds the socket for `peerId`.
 *
 * The caller must fail the socket closed when this returns false. Treating a
 * failed write as success would activate a socket that sibling instances
 * cannot route to.
 */
export const claimPeer = async (peerId: string): Promise<boolean> => {
  try {
    await prisma.peer.update({
      where: { id: peerId },
      data: { serverId: SERVER_ID },
    });
    return true;
  } catch (error) {
    console.error("p2party: failed to claim peer", peerLogTag(peerId), error);
    return false;
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
    console.error("p2party: failed to release peer", peerLogTag(peerId), error);
  }
};

/** Drop this process's claims and routing rows so peers can reconnect elsewhere. */
export const shutdownPubSub = async (): Promise<void> => {
  if (safetyPoll) clearInterval(safetyPoll);
  safetyPoll = undefined;
  if (pendingSignalSweep) clearInterval(pendingSignalSweep);
  pendingSignalSweep = undefined;
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
