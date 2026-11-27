import pg from "pg";
import databaseDeadlines from "./db/deadlines.json";

import { postgresConnection } from "./db/ssl";
import { SERVER_ID } from "./serverId";
import { prisma } from "./prismaClient";
import { wsClients } from "./wsServer";
import { peerLogTag } from "./utils/logTag";
import { describeError } from "./utils/logError";
import {
  evictSocket,
  hasPendingActivation,
  isCurrentVerifiedSocket,
} from "./utils/socketAuth";

import type { ProcessPrismaClient } from "./prismaClient";
import type { P2PartyWSClient } from "./wsServer";
import type { RoutingClaim } from "./utils/peerIdentity";

/**
 * Cross-instance signal routing.
 *
 * Supported production currently runs one signaling process because one
 * identity's room mutations are ordered only within a process (sessions are
 * fenced across processes: evictReplacedClaim). Operators can explicitly opt into
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

export { SERVER_ID };

const CHANNEL = `server_${SERVER_ID}`;
/** Catches anything a lost NOTIFY would otherwise strand. */
const SAFETY_POLL_MS = 5_000;
/** Fail fast instead of hanging: see the note at the pg.Client construction. */
const CONNECT_TIMEOUT_MS = databaseDeadlines.listenMs;
/**
 * The longest one drain pass may take before it is abandoned and the next
 * wake-up may start a fresh one. The pool also bounds each SQL operation. A healthy pass is one indexed
 * read, local sends and one delete. Twice the safety poll, so a slow but
 * working database is not cut off at every poll; a stalled pass then delays
 * delivery by at most this plus one safety poll (15 s), well inside the
 * PENDING_SIGNAL_MAX_AGE_MS (120 s) after which queued rows are swept, so the
 * rows queued meanwhile are still there for the fresh pass.
 */
export const PENDING_SIGNAL_PASS_DEADLINE_MS = 2 * SAFETY_POLL_MS;
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
/**
 * How often each process checks that the claims of its current sockets are
 * still its own. It bounds how long a socket replaced on another instance can
 * stay live when the eviction row for it is lost.
 */
export const CLAIM_RECONCILIATION_MS = 30_000;
/** Peer ids one reconciliation query names. */
const CLAIM_RECONCILIATION_BATCH = 1_000;
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
let claimReconciliation: ReturnType<typeof setInterval> | undefined;

type RoutingStore = Pick<ProcessPrismaClient, "peer" | "pendingSignal">;
type ActivityClient = Pick<pg.Client, "query">;

interface PendingSignalFrame {
  id: string;
  targetPeerId: string;
  /** "frame" for a relayed frame, "evict" for an eviction (schema.prisma). */
  kind?: string;
  payload: string;
}

/**
 * Deliver queued rows to this process's sockets, in the order given; returns
 * the ids that are done with (delivered, or undeliverable here for good).
 *
 * Frames for one recipient keep their queue order: once one of its rows is
 * kept for a later pass (its socket is activating, not current, or did not
 * take the frame), its later rows in this pass are kept too, so none of them
 * overtakes it.
 */
export const deliverPendingSignalsLocally = (
  signals: readonly PendingSignalFrame[],
  clients: Map<string, P2PartyWSClient> = wsClients,
  /** Checked before every row; false stops delivery (an abandoned pass). */
  stillCurrent: () => boolean = () => true,
): string[] => {
  const settled: string[] = [];
  /** Recipients with a row kept in this pass. */
  const waiting = new Set<string>();
  for (const signal of signals) {
    if (!stillCurrent()) break;
    if (signal.kind !== "evict" && waiting.has(signal.targetPeerId)) continue;
    const delivered = deliverPendingSignal(signal, clients);
    if (delivered) settled.push(signal.id);
    else waiting.add(signal.targetPeerId);
  }
  return settled;
};

/** One row: whether it is done with (see deliverPendingSignalsLocally). */
const deliverPendingSignal = (
  signal: PendingSignalFrame,
  clients: Map<string, P2PartyWSClient>,
): boolean => {
  if (signal.kind === "evict") {
    // A newer session of this identity committed on another instance. The
    // payload names the replaced socket's generation, so a socket of the
    // same identity that is newer still is left alone. Done either way.
    evictSocket(clients, signal.targetPeerId, signal.payload);
    return true;
  }
  const target = clients.get(signal.targetPeerId);
  if (!target) {
    // A proved socket is registered only once its routing claim commits.
    // Retain the row while one is activating rather than delete the only
    // queued copy.
    if (hasPendingActivation(clients, signal.targetPeerId)) return false;
    // This process no longer has the addressed socket; the row cannot become
    // deliverable here and must not replay forever.
    return true;
  }
  // A registered socket that is not current (one closing, or one replaced)
  // keeps the row rather than disclose SDP/ICE to it.
  if (!isCurrentVerifiedSocket(clients, target)) return false;
  return target.send(signal.payload) !== 0;
};

/** The timer functions the drain's pass deadline uses; injectable for tests. */
export interface DrainTimers {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const processTimers: DrainTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface PendingSignalDrain {
  /** Start a pass, or ask the pass in flight for exactly one more. */
  (): Promise<void>;
  /** Abandon the pass in flight, if any, and clear its deadline. */
  stop(): void;
}

/**
 * This process's drain of its PendingSignal queue, one pass at a time.
 *
 * Every NOTIFY on this process's channel, every safety poll and every socket
 * that becomes current wakes it. Passes that overlapped would each read the
 * same rows and deliver them twice, and the slower pass's copy could land
 * after frames queued later. So a wake-up during a pass only asks for one
 * more pass after it, however many arrive. A pass delivers in queue order
 * (deliverPendingSignalsLocally), then deletes what it delivered. When that
 * delete fails, the delivered ids are remembered here and not delivered
 * again, and the next pass retries their delete; an id the queue no longer
 * holds is forgotten. A pass that fails to read loses nothing: the rows stay
 * for the next wake-up.
 *
 * A pass that has not ended by `deadlineMs` (PENDING_SIGNAL_PASS_DEADLINE_MS)
 * is abandoned: the epoch is bumped, the drain is free again, one line is
 * logged, and the next wake-up starts a fresh pass. The abandoned pass checks
 * the epoch after each await and before every send and every delete, so once
 * stale it does nothing more and two passes never deliver at once. What it
 * delivered before is recorded in `undeleted`, so the fresh pass does not
 * deliver it again.
 */
export const createPendingSignalDrain = (
  store: Pick<RoutingStore, "pendingSignal">,
  clients: Map<string, P2PartyWSClient>,
  self: string,
  timers: DrainTimers = processTimers,
  deadlineMs: number = PENDING_SIGNAL_PASS_DEADLINE_MS,
): PendingSignalDrain => {
  /** Only a pass of the current epoch may send, delete or record. */
  let epoch = 0;
  let running: Promise<void> | undefined;
  let again = false;
  let deadline: unknown;
  let abandoned = 0;
  let stopped = false;
  /** Delivered rows whose delete has not succeeded yet. */
  const undeleted = new Set<string>();

  const clearDeadline = (): void => {
    if (deadline === undefined) return;
    timers.clearTimeout(deadline);
    deadline = undefined;
  };

  /** Make the pass in flight stale and free the drain for a fresh one. */
  const abandon = (): void => {
    epoch++;
    running = undefined;
    again = false;
    clearDeadline();
  };

  const pass = async (mine: number): Promise<void> => {
    const signals = await store.pendingSignal.findMany({
      where: { targetServerId: self },
      orderBy: { createdAt: "asc" },
    });
    if (mine !== epoch) return;
    const queued = new Set(signals.map(({ id }) => id));
    for (const id of undeleted) if (!queued.has(id)) undeleted.delete(id);
    const fresh = signals.filter(({ id }) => !undeleted.has(id));
    for (const id of deliverPendingSignalsLocally(
      fresh,
      clients,
      () => mine === epoch,
    ))
      undeleted.add(id);
    if (undeleted.size === 0 || mine !== epoch) return;
    const done = [...undeleted];
    await store.pendingSignal.deleteMany({ where: { id: { in: done } } });
    if (mine !== epoch) return;
    for (const id of done) undeleted.delete(id);
  };

  const start = (): Promise<void> => {
    const mine = ++epoch;
    const run = (async () => {
      try {
        do {
          again = false;
          deadline = timers.setTimeout(() => {
            deadline = undefined;
            if (mine !== epoch) return;
            abandon();
            abandoned++;
            // Counts only: which rows or recipients were waiting is not for
            // the journal.
            console.error(
              `p2party: abandoned a pending-signal drain pass after ${String(deadlineMs)} ms (${String(abandoned)} since start); the next wake-up starts a fresh one`,
            );
          }, deadlineMs);
          try {
            await pass(mine);
          } catch (error) {
            if (mine === epoch)
              console.error(
                "p2party: failed to drain pending signals",
                describeError(error),
              );
          }
          if (mine !== epoch) return;
          clearDeadline();
        } while (again);
      } finally {
        if (mine === epoch) running = undefined;
      }
    })();
    running = run;
    return run;
  };

  const wake = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    return start();
  };
  return Object.assign(wake, {
    stop: () => {
      stopped = true;
      abandon();
    },
  });
};

/** This process's drain, built in initPubSub, stopped in shutdownPubSub. */
let pendingSignalDrain: PendingSignalDrain | undefined;

/**
 * Wake this process's drain, if routing is initialised. Called when a socket
 * becomes current (handleMessage.ts), so rows kept for it while it activated
 * are delivered at once instead of at the next safety poll.
 */
export const wakePendingSignalDrain = (): void => {
  void pendingSignalDrain?.();
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

/** Schedule cleanup immediately, then once per period. A delayed pass never overlaps its successor. */
export const startRoutingMaintenance = (
  cleanup: () => Promise<void>,
  every: (
    task: () => Promise<void>,
    ms: number,
  ) => ReturnType<typeof setInterval> = setInterval,
): ReturnType<typeof setInterval> => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await cleanup();
    } catch (error) {
      console.error(
        "p2party: routing cleanup failed; retrying next sweep",
        describeError(error),
      );
    } finally {
      running = false;
    }
  };
  void run();
  return every(run, PENDING_SIGNAL_SWEEP_MS);
};

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
    data: { serverId: null, socketGeneration: null },
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

  // Built here, not at module load: this module and wsServer.ts import each
  // other, so wsClients does not exist yet while this module is evaluated.
  const drain = createPendingSignalDrain(prisma, wsClients, SERVER_ID);
  pendingSignalDrain = drain;
  listenClient.on("notification", (message) => {
    if (message.channel === CHANNEL) void drain();
  });

  // A dropped LISTEN connection would otherwise strand every later signal.
  listenClient.on("error", (error) => {
    console.error(
      "p2party: pubsub listen connection error",
      describeError(error),
    );
  });

  safetyPoll = setInterval(() => void drain(), SAFETY_POLL_MS);

  // LISTEN is ready. Maintenance can wait for a busy database without
  // delaying health or peer admission. Retry the startup liveness cleanup
  // after a failed pass, then keep only the age sweep on the periodic timer.
  const client = listenClient;
  let checkedLiveness = false;
  pendingSignalSweep = startRoutingMaintenance(async () => {
    await sweepStalePendingSignals();
    if (checkedLiveness) return;
    const cleared = await clearDeadServerState(prisma, (serverIds) =>
      connectedServerIds(client, serverIds),
    );
    checkedLiveness = true;
    console.info(
      `p2party: startup cleared the routing state of ${String(cleared.length)} stopped server id(s)`,
    );
  });
  claimReconciliation = startClaimReconciliation();
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

    return await sendToPeerOnServer(toPeerId, peer.serverId, payload);
  } catch (error) {
    console.error(
      "p2party: failed to route signal to peer",
      peerLogTag(toPeerId),
      describeError(error),
    );
    return false;
  }
};

/** A server id as an identity commit writes it: SERVER_ID, a lowercase UUID. */
const SERVER_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Queue a frame for the process whose id is `serverId`, for a caller that has
 * already read the target's routing claim (the relay's membership query
 * returns it), so no second lookup is needed. Never throws, like sendToPeer.
 *
 * `store` and `notifier` default to this process's Prisma client and LISTEN
 * connection; without the latter nothing is queued, as in sendToPeer.
 */
export const sendToPeerOnServer = async (
  toPeerId: string,
  serverId: string,
  payload: string,
  store: Pick<RoutingStore, "pendingSignal"> = prisma,
  notifier: ActivityClient | undefined = listenClient,
  kind: "frame" | "evict" = "frame",
): Promise<boolean> => {
  if (!notifier || !SERVER_ID_SHAPE.test(serverId)) return false;
  try {
    await store.pendingSignal.create({
      data: {
        targetServerId: serverId,
        targetPeerId: toPeerId,
        kind,
        payload,
      },
    });

    // The NOTIFY carries no payload: the channel name alone tells the owner to
    // drain. That keeps the signal out of Postgres's notification queue and
    // clear of its 8000-byte payload limit.
    await notifier.query(`NOTIFY "server_${serverId}"`);
    return true;
  } catch (error) {
    console.error(
      "p2party: failed to route signal to peer",
      peerLogTag(toPeerId),
      describeError(error),
    );
    return false;
  }
};

/**
 * Close the socket whose claim a newer session of its identity replaced and
 * did not give back: on this instance at once, on another one through its
 * queue (the same row-plus-NOTIFY path as relayed frames).
 *
 * An eviction row carries no SDP or ICE, only the replaced socket's
 * generation. A lost NOTIFY is caught by the owner's next safety poll (5 s); a
 * row the owner never reads (it was swept after 120 s, or the owner's
 * database access failed) is caught by the owner's claim reconciliation
 * (CLAIM_RECONCILIATION_MS). If the owner is dead, its sockets are gone and
 * the next startup clears its rows.
 */
export const evictReplacedClaim = async (
  peerId: string,
  replaced: RoutingClaim | null,
  clients: Map<string, P2PartyWSClient> = wsClients,
  self: string = SERVER_ID,
  store: Pick<RoutingStore, "pendingSignal"> = prisma,
  notifier: ActivityClient | undefined = listenClient,
): Promise<void> => {
  if (!replaced?.socketGeneration) return;
  if (replaced.serverId === self)
    evictSocket(clients, peerId, replaced.socketGeneration);
  else
    await sendToPeerOnServer(
      peerId,
      replaced.serverId,
      replaced.socketGeneration,
      store,
      notifier,
      "evict",
    );
};

/**
 * Close every current socket here whose row another instance now claims.
 *
 * That instance committed a newer session for the identity, so this socket
 * was replaced, and its eviction row did not arrive. Each socket's generation
 * is recorded before the query and compared after it, so a socket that became
 * current here meanwhile (with its own, newer claim) is left alone, as is a
 * socket still activating. A cleared claim (null) is not a replacement.
 * Returns how many sockets were closed.
 */
export const closeSocketsClaimedElsewhere = async (
  store: Pick<RoutingStore, "peer"> = prisma,
  clients: Map<string, P2PartyWSClient> = wsClients,
  self: string = SERVER_ID,
): Promise<number> => {
  const current = new Map<string, string>();
  for (const [peerId, ws] of clients)
    if (
      isCurrentVerifiedSocket(clients, ws) &&
      !hasPendingActivation(clients, peerId)
    )
      current.set(peerId, ws.data.socketGeneration);
  const ids = [...current.keys()];
  let closed = 0;
  for (let start = 0; start < ids.length; start += CLAIM_RECONCILIATION_BATCH) {
    const claimedElsewhere = await store.peer.findMany({
      where: {
        id: { in: ids.slice(start, start + CLAIM_RECONCILIATION_BATCH) },
        AND: [{ serverId: { not: null } }, { serverId: { not: self } }],
      },
      select: { id: true },
    });
    for (const { id } of claimedElsewhere) {
      const generation = current.get(id)!;
      const ws = clients.get(id);
      if (
        ws?.data.socketGeneration === generation &&
        !hasPendingActivation(clients, id) &&
        evictSocket(clients, id, generation)
      )
        closed++;
    }
  }
  return closed;
};

/** Run closeSocketsClaimedElsewhere every CLAIM_RECONCILIATION_MS. */
export const startClaimReconciliation = (
  store: Pick<RoutingStore, "peer"> = prisma,
  every: (task: () => void, ms: number) => ReturnType<typeof setInterval> = (
    task,
    ms,
  ) => setInterval(task, ms),
): ReturnType<typeof setInterval> =>
  every(() => {
    closeSocketsClaimedElsewhere(store).then(
      (closed) => {
        // The count only, as for the startup clearing.
        if (closed > 0)
          console.warn(
            `p2party: closed ${String(closed)} socket(s) replaced on another instance`,
          );
      },
      (error: unknown) => {
        console.error(
          "p2party: failed to reconcile routing claims",
          describeError(error),
        );
      },
    );
  }, CLAIM_RECONCILIATION_MS);

/**
 * Release the routing claim of one socket this process no longer holds.
 *
 * Compare-and-delete in one statement on the claim's owner token: this
 * process's id and the socket's generation. A claim another socket wrote
 * since, on this instance or another, does not match, so however late this
 * release lands it cannot clear a successor's claim.
 *
 * Returns whether this release cleared the claim: true means no other socket
 * of the identity held it, on any instance, so this was the identity's last
 * socket. A release that matched nothing, or that failed, returns false.
 */
export const releasePeer = async (
  peerId: string,
  socketGeneration: string,
  store: Pick<RoutingStore, "peer"> = prisma,
  self: string = SERVER_ID,
): Promise<boolean> => {
  if (socketGeneration.length === 0) return false;
  try {
    const { count } = await store.peer.updateMany({
      where: { id: peerId, serverId: self, socketGeneration },
      data: { serverId: null, socketGeneration: null },
    });
    return count > 0;
  } catch (error) {
    console.error(
      "p2party: failed to release peer",
      peerLogTag(peerId),
      describeError(error),
    );
    return false;
  }
};

/** Drop this process's claims and routing rows so peers can reconnect elsewhere. */
export const shutdownPubSub = async (): Promise<void> => {
  if (safetyPoll) clearInterval(safetyPoll);
  safetyPoll = undefined;
  pendingSignalDrain?.stop();
  pendingSignalDrain = undefined;
  if (pendingSignalSweep) clearInterval(pendingSignalSweep);
  pendingSignalSweep = undefined;
  if (claimReconciliation) clearInterval(claimReconciliation);
  claimReconciliation = undefined;
  try {
    await prisma.pendingSignal.deleteMany({
      where: { targetServerId: SERVER_ID },
    });
    await prisma.peer.updateMany({
      where: { serverId: SERVER_ID },
      data: { serverId: null, socketGeneration: null },
    });
  } catch (error) {
    console.error(
      "p2party: error during pubsub shutdown",
      describeError(error),
    );
  } finally {
    await listenClient?.end().catch(() => undefined);
    listenClient = undefined;
  }
};
