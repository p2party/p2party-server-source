export const MAX_PENDING_ROOM_MUTATIONS_PER_PEER = 8;

interface PeerMutationQueue {
  tail: Promise<void>;
  pending: number;
}

const peerMutationQueues = new Map<string, PeerMutationQueue>();

/**
 * Serialize membership mutations for one peer across same-process socket
 * replacement. Per-socket FIFO orders one transport; this is the second,
 * process-local fence that stops an old in-flight join racing its successor.
 */
export const runPeerRoomMutation = async <Result>(
  peerId: string,
  mutation: () => Promise<Result>,
): Promise<Result> => {
  let queue = peerMutationQueues.get(peerId);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    peerMutationQueues.set(peerId, queue);
  }
  if (queue.pending >= MAX_PENDING_ROOM_MUTATIONS_PER_PEER)
    throw new Error("Too many pending room mutations for this peer");

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
    if (queue.pending === 0 && peerMutationQueues.get(peerId) === queue)
      peerMutationQueues.delete(peerId);
  }
};
