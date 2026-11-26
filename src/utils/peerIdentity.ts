import { createHash } from "node:crypto";
import { prisma as sharedPrisma } from "../prismaClient";
import { admission, admissionLimits } from "./admission";
import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A memberless identity younger than this is never pruned for capacity. */
const IDENTITY_PRUNE_MIN_AGE_MS = DAY_MS;
/**
 * At most this many identities are pruned per admission. "Near the cap" means
 * within one batch of it, so a single prune can restore the headroom.
 */
const IDENTITY_PRUNE_BATCH = 1000;

/** A stable candidate for identities that have never proved ownership. */
export const provisionalPeerId = (publicKey: string): string => {
  if (!/^[0-9a-f]{64}$/.test(publicKey))
    throw new Error("Invalid identity public key");
  const bytes = createHash("sha256")
    .update("p2party/signaling/peer-id/v1\0")
    .update(publicKey, "hex")
    .digest();
  // UUIDv4 wire shape, with 122 domain-separated hash bits. Not an authenticator.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Charge the socket's source key first; a socket without a lease has none. */
const admitIdentityCreation = (ws: P2PartyWSClient): boolean =>
  ws.data.admission ? ws.data.admission.newIdentity() : admission.newIdentity();

/** Persist only after signature verification, before the routing claim goes live. */
export const createPersistVerifiedIdentity =
  (
    prisma: Pick<ProcessPrismaClient, "$transaction">,
    admitCreation: (ws: P2PartyWSClient) => boolean = admitIdentityCreation,
    maxIdentities = admissionLimits.persistentIdentities,
    now: () => number = Date.now,
  ) =>
  async (ws: P2PartyWSClient): Promise<boolean> => {
    if (!ws.data.isVerified || ws.readyState !== 1) return false;
    const { peerId, publicKey } = ws.data;
    const at = now();
    // Offline identities in no room, created over a day ago. Any last-seen
    // time qualifies, however old, except one inside the activation deadline:
    // that row is persisted but its socket has not claimed it yet.
    const prunable = {
      createdAt: { lt: new Date(at - IDENTITY_PRUNE_MIN_AGE_MS) },
      updatedAt: {
        lt: new Date(at - admissionLimits.authenticationTimeoutMs),
      },
      serverId: null,
      rooms: { none: {} },
    };
    await prisma.$transaction(
      async (transaction) => {
        const existing = await transaction.peer.findUnique({
          where: { publicKey },
          select: { id: true },
        });
        if (existing && existing.id !== peerId)
          throw new Error(
            "Identity changed during authentication; reconnect required",
          );
        if (!existing) {
          if (provisionalPeerId(publicKey) !== peerId || !admitCreation(ws))
            throw new Error("Identity admission capacity reached");
          // A hard cap on every Peer row, whatever its age: nothing else
          // deletes identities, so rows past any retention window still count.
          let identities = await transaction.peer.count();
          if (identities >= maxIdentities - IDENTITY_PRUNE_BATCH) {
            // Least recently seen first: rows past the retention window go
            // before any recent one ("updatedAt" is bumped on authentication,
            // claim and release). Rolled back with the transaction if the cap
            // still refuses.
            const stale = await transaction.peer.findMany({
              where: prunable,
              select: { id: true },
              orderBy: { updatedAt: "asc" },
              take: IDENTITY_PRUNE_BATCH,
            });
            if (stale.length) {
              const { count } = await transaction.peer.deleteMany({
                where: { ...prunable, id: { in: stale.map(({ id }) => id) } },
              });
              identities -= count;
            }
          }
          if (identities >= maxIdentities)
            throw new Error("Identity admission capacity reached");
        }
        if (!ws.data.isVerified || ws.readyState !== 1)
          throw new Error("Authentication socket closed");
        await transaction.peer.upsert({
          where: { publicKey },
          update: { lastPing: at },
          create: { id: peerId, publicKey, lastPing: at },
        });
      },
      { isolationLevel: "Serializable" },
    );
    return ws.data.isVerified && ws.readyState === 1;
  };

export const persistVerifiedIdentity =
  createPersistVerifiedIdentity(sharedPrisma);
