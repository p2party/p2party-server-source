import { randomUUID } from "node:crypto";

/**
 * Identifies this process for the lifetime of the process: the instance half
 * of every routing claim it writes (Peer.serverId) and the name of its
 * LISTEN channel. In its own module, with no imports of this server's, so
 * identity and routing code can both read it without an import cycle.
 */
export const SERVER_ID = randomUUID();
