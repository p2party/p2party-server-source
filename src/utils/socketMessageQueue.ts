import { describeError } from "./logError";

export const MAX_QUEUED_MESSAGES_PER_SOCKET = 64;
export const MAX_QUEUED_MESSAGE_BYTES_PER_SOCKET = 2 * 1024 * 1024;

export type SocketMessage = string | ArrayBufferView;

export interface SocketMessageQueueState {
  messageQueue?: SocketMessage[];
  messageQueueBytes?: number;
  messageDrain?: Promise<void>;
  messageQueueClosed?: boolean;
}

interface QueuedSocket {
  data: SocketMessageQueueState;
  readyState: number;
  close: (code?: number, reason?: string) => unknown;
}

const messageBytes = (message: SocketMessage): number =>
  typeof message === "string"
    ? Buffer.byteLength(message, "utf8")
    : message.byteLength;

export const closeSocketMessageQueue = (ws: QueuedSocket): void => {
  ws.data.messageQueueClosed = true;
  ws.data.messageQueue?.splice(0);
  ws.data.messageQueueBytes = 0;
};

/**
 * Serialize async signaling handlers per socket.
 *
 * Bun documents that `message` may return a Promise, but does not promise that
 * later callbacks wait for it. The queue therefore owns ordering explicitly.
 * It is bounded so a client cannot turn one slow database operation into
 * unbounded retained messages.
 */
export const enqueueSocketMessage = <Socket extends QueuedSocket>(
  ws: Socket,
  message: SocketMessage,
  handle: (ws: Socket, message: SocketMessage) => Promise<void>,
): Promise<void> => {
  if (ws.data.messageQueueClosed) return Promise.resolve();

  const queue = (ws.data.messageQueue ??= []);
  const weight = messageBytes(message);
  const queuedBytes = ws.data.messageQueueBytes ?? 0;
  if (
    queue.length >= MAX_QUEUED_MESSAGES_PER_SOCKET ||
    weight > MAX_QUEUED_MESSAGE_BYTES_PER_SOCKET - queuedBytes
  ) {
    closeSocketMessageQueue(ws);
    ws.close(1013, "Signaling queue overloaded");
    return ws.data.messageDrain ?? Promise.resolve();
  }
  queue.push(message);
  ws.data.messageQueueBytes = queuedBytes + weight;

  if (ws.data.messageDrain) return ws.data.messageDrain;

  const drain = (async () => {
    try {
      while (!ws.data.messageQueueClosed && queue.length > 0) {
        // Keep the in-flight frame in both bounds until its handler releases
        // the reference. Otherwise one maximum-size active frame could sit on
        // top of the advertised 2 MiB queue budget.
        const next = queue[0]!;
        await handle(ws, next);
        if (queue[0] === next) {
          queue.shift();
          ws.data.messageQueueBytes = Math.max(
            0,
            (ws.data.messageQueueBytes ?? 0) - messageBytes(next),
          );
        }
        if (ws.readyState !== 1) {
          closeSocketMessageQueue(ws);
          break;
        }
      }
    } catch (error) {
      console.error(
        "p2party: signaling queue failed closed",
        describeError(error),
      );
      closeSocketMessageQueue(ws);
      ws.close(1011, "Signaling handler failed");
    } finally {
      ws.data.messageDrain = undefined;
    }
  })();

  ws.data.messageDrain = drain;
  return drain;
};
