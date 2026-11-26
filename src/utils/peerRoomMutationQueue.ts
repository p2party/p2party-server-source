import { admissionLimits } from "./admission";

export const MAX_PENDING_ROOM_MUTATIONS_PER_PEER = 8;
/**
 * Every member of a full room can have a rejoin queued at once, for example
 * after a restart. handleRoom takes a room's lock inside the requesting peer's
 * lock, so each peer holds at most one entry in any room queue.
 */
export const MAX_PENDING_ROOM_MUTATIONS_PER_ROOM = admissionLimits.peersPerRoom;

/** "peer" serializes one peer's mutations; "room" serializes one room's membership. */
export type MembershipLock = "peer" | "room";

interface MutationQueue {
  tail: Promise<void>;
  pending: number;
}

const mutationQueues: Record<MembershipLock, Map<string, MutationQueue>> = {
  peer: new Map(),
  room: new Map(),
};
const pendingBounds: Record<MembershipLock, number> = {
  peer: MAX_PENDING_ROOM_MUTATIONS_PER_PEER,
  room: MAX_PENDING_ROOM_MUTATIONS_PER_ROOM,
};

/**
 * Serialize mutations under one lock: a peer id for "peer", a room identifier
 * for "room". Each kind has its own queues and its own pending bound.
 */
export const runMembershipMutation = async <Result>(
  lock: MembershipLock,
  key: string,
  mutation: () => Promise<Result>,
): Promise<Result> => {
  const queues = mutationQueues[lock];
  let queue = queues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    queues.set(key, queue);
  }
  if (queue.pending >= pendingBounds[lock])
    throw new Error(`Too many pending room mutations for this ${lock}`);

  queue.pending += 1;
  const predecessor = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await predecessor;
  try {
    return await mutation();
  } finally {
    queue.pending -= 1;
    release();
    if (queue.pending === 0 && queues.get(key) === queue) queues.delete(key);
  }
};

/**
 * Serialize membership mutations for one peer across same-process socket
 * replacement. Per-socket FIFO orders one transport; this is the second,
 * process-local fence that stops an old in-flight join racing its successor.
 */
export const runPeerRoomMutation = <Result>(
  peerId: string,
  mutation: () => Promise<Result>,
): Promise<Result> => runMembershipMutation("peer", peerId, mutation);
