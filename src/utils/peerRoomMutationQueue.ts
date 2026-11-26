import { admissionLimits } from "./admission";

export const MAX_PENDING_ROOM_MUTATIONS_PER_PEER = 8;
/**
 * Every member of a full room can have a rejoin queued at once, for example
 * after a restart. handleRoom takes a room's lock inside the requesting peer's
 * lock, so each peer holds at most one entry in any room queue.
 */
export const MAX_PENDING_ROOM_MUTATIONS_PER_ROOM = admissionLimits.peersPerRoom;
/** handleRoom serializes one room's membership under `room:<identifier>`. */
const ROOM_KEY_PREFIX = "room:";

interface PeerMutationQueue {
  tail: Promise<void>;
  pending: number;
}

const peerMutationQueues = new Map<string, PeerMutationQueue>();

/**
 * Serialize membership mutations for one peer across same-process socket
 * replacement. Per-socket FIFO orders one transport; this is the second,
 * process-local fence that stops an old in-flight join racing its successor.
 * A `room:`-prefixed key serializes one room's membership instead and has its
 * own bound.
 */
export const runPeerRoomMutation = async <Result>(
  key: string,
  mutation: () => Promise<Result>,
): Promise<Result> => {
  const isRoom = key.startsWith(ROOM_KEY_PREFIX);
  let queue = peerMutationQueues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    peerMutationQueues.set(key, queue);
  }
  if (
    queue.pending >=
    (isRoom
      ? MAX_PENDING_ROOM_MUTATIONS_PER_ROOM
      : MAX_PENDING_ROOM_MUTATIONS_PER_PEER)
  )
    throw new Error(
      `Too many pending room mutations for this ${isRoom ? "room" : "peer"}`,
    );

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
    if (queue.pending === 0 && peerMutationQueues.get(key) === queue)
      peerMutationQueues.delete(key);
  }
};
