import { createHmac, getRandomValues } from "node:crypto";

/** Drawn once per process start and never logged or stored. */
const LOG_TAG_SALT = getRandomValues(new Uint8Array(32));

/**
 * An eight-hex-digit stand-in for a peer id or public key in operator logs.
 *
 * It links log lines about one peer within one process lifetime and tells
 * peers apart, without writing the stable id into the journal. The salt is
 * new at every start, so tags from different boots cannot be joined to each
 * other or to the database.
 */
export const peerLogTag = (value: string): string =>
  createHmac("sha256", LOG_TAG_SALT).update(value).digest("hex").slice(0, 8);
