import { createHash } from "node:crypto";
import { prisma as sharedPrisma } from "../prismaClient";
import { SERVER_ID } from "../serverId";
import { admission, admissionLimits } from "./admission";
import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A memberless identity younger than this is never pruned for capacity. */
const IDENTITY_PRUNE_MIN_AGE_MS = DAY_MS;
/**
 * Each prune query is bounded. Memberless pruning begins one batch before
 * the ceiling; pruning occupied identities begins only at the ceiling.
 */
const IDENTITY_PRUNE_BATCH = 1000;
const MINIMUM_OFFLINE_MS = 10 * 60 * 1000;
const MEMBER_EVICTION_HEADROOM = 8;

/**
 * The peer id of an identity public key, derived from the key alone: every
 * socket is bound to it before its proof, so the pre-authentication answer
 * is the same whether or not the key has an identity row.
 */
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

/** Give back the charge admitIdentityCreation took for this socket. */
const refundIdentityCreation = (ws: P2PartyWSClient): void => {
  if (ws.data.admission) ws.data.admission.refundIdentity();
  else admission.refundIdentity();
};

/**
 * A routing claim: the instance and the socket holding a peer's row. Both
 * together are the claim's owner token; a socket may release or restore only
 * the claim that carries its own.
 */
export interface RoutingClaim {
  serverId: string;
  socketGeneration: string | null;
}

/** What a committed authentication wrote. */
export interface IdentityCommit {
  /** This socket's insert created the identity row; its charge stands. */
  created: boolean;
  /** The claim this commit overwrote, held by another socket, if any. */
  replaced: RoutingClaim | null;
}

/**
 * Prisma's codes for a serializable conflict and a unique-key race. A first
 * attempt that loses either way is retried once: the second attempt sees the
 * winner's row and commits as a socket of an existing identity.
 */
const isWriteConflict = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2034" || code === "P2002";
};

/**
 * Persist the identity and write this socket's routing claim, in one
 * serializable transaction, only after signature verification.
 *
 * Nothing about a stored row's id is read or written for an existing
 * identity: the migration 20261127000000_rekey_peers_to_derived_ids gave every
 * row the id derived from its key, so the row a socket finds is the row its
 * peer id names.
 *
 * A new identity is charged once, inside the transaction, before the insert.
 * The charge is refunded when the transaction fails or a retried attempt finds
 * that a racing socket's insert won: one identity, one charge. Since the claim
 * is part of the same transaction, a failed claim leaves no row and no charge.
 */
export const createPersistVerifiedIdentity =
  (
    prisma: Pick<ProcessPrismaClient, "$transaction">,
    admitCreation: (ws: P2PartyWSClient) => boolean = admitIdentityCreation,
    maxIdentities = admissionLimits.persistentIdentities,
    now: () => number = Date.now,
    serverId: string = SERVER_ID,
    refundCreation: (ws: P2PartyWSClient) => void = refundIdentityCreation,
  ) =>
  async (ws: P2PartyWSClient): Promise<IdentityCommit | false> => {
    if (!ws.data.isVerified || ws.readyState !== 1) return false;
    const { peerId, publicKey, socketGeneration } = ws.data;
    if (provisionalPeerId(publicKey) !== peerId)
      throw new Error("Socket peer id is not derived from its key");
    if (socketGeneration.length === 0)
      throw new Error("Socket has no generation to claim with");
    const at = now();
    // Routing-claim release refreshes updatedAt. Even a memberless identity
    // gets a reconnect window before it can be removed for capacity.
    const offline = {
      serverId: null,
      updatedAt: { lt: new Date(at - MINIMUM_OFFLINE_MS) },
    };
    const prunable = {
      ...offline,
      createdAt: { lt: new Date(at - IDENTITY_PRUNE_MIN_AGE_MS) },
      rooms: { none: {} },
    };
    let charged = false;
    let pruned = 0;
    const attempt = () =>
      prisma.$transaction(
        async (transaction): Promise<IdentityCommit | null> => {
          pruned = 0; // Report only rows removed by the committed attempt.
          // The claim this commit replaces, read in the transaction that
          // replaces it.
          const existing = await transaction.peer.findUnique({
            where: { publicKey },
            select: { serverId: true, socketGeneration: true },
          });
          if (!existing) {
            if (!charged) {
              if (!admitCreation(ws))
                throw new Error("Identity admission capacity reached");
              charged = true;
            }
            // Enforce the hard cap in the serializable creation transaction.
            let identities = await transaction.peer.count();
            if (identities >= maxIdentities - IDENTITY_PRUNE_BATCH) {
              // Least recently seen first: rows past the retention window go
              // before any recent one ("updatedAt" is bumped on
              // authentication, claim and release).
              const stale = await transaction.peer.findMany({
                where: prunable,
                select: { id: true },
                orderBy: { updatedAt: "asc" },
                take: IDENTITY_PRUNE_BATCH,
              });
              if (stale.length) {
                const { count } = await transaction.peer.deleteMany({
                  where: {
                    ...prunable,
                    id: { in: stale.map(({ id }) => id) },
                  },
                });
                pruned += count;
                identities -= count;
              }
            }
            if (identities >= maxIdentities) {
              const oldest = await transaction.peer.findMany({
                where: offline,
                select: { id: true },
                orderBy: [{ lastPing: "asc" }, { id: "asc" }],
                take: Math.min(
                  IDENTITY_PRUNE_BATCH,
                  identities - maxIdentities + 1 + MEMBER_EVICTION_HEADROOM,
                ),
              });
              if (oldest.length) {
                const { count } = await transaction.peer.deleteMany({
                  where: { ...offline, id: { in: oldest.map(({ id }) => id) } },
                });
                identities -= count;
                pruned += count;
              }
            }
            // A lowered ceiling may require several bounded passes. Commit
            // the removals even when this request still cannot claim a slot.
            if (identities >= maxIdentities) return null;
          }
          if (!ws.data.isVerified || ws.readyState !== 1)
            throw new Error("Authentication socket closed");
          await transaction.peer.upsert({
            where: { publicKey },
            update: { lastPing: at, serverId, socketGeneration },
            create: {
              id: peerId,
              publicKey,
              lastPing: at,
              serverId,
              socketGeneration,
            },
          });
          return {
            created: !existing,
            replaced: existing?.serverId
              ? {
                  serverId: existing.serverId,
                  socketGeneration: existing.socketGeneration,
                }
              : null,
          };
        },
        { isolationLevel: "Serializable" },
      );

    try {
      let commit: IdentityCommit | null;
      try {
        commit = await attempt();
      } catch (error) {
        if (!isWriteConflict(error)) throw error;
        commit = await attempt();
      }
      if (pruned > 0)
        console.warn("p2party: identities pruned for admission", {
          count: pruned,
        });
      if (!commit) throw new Error("Identity admission capacity reached");
      if (charged && !commit.created) refundCreation(ws);
      return commit;
    } catch (error) {
      if (charged) refundCreation(ws);
      throw error;
    }
  };

export const persistVerifiedIdentity =
  createPersistVerifiedIdentity(sharedPrisma);

/**
 * Take back what a committed authentication wrote, for a socket that then
 * failed to become current (it closed during the commit, or a newer session
 * of its identity became current first).
 *
 * A row this socket created is deleted, and its charge refunded, while it
 * still carries this socket's claim. Otherwise the claim this socket replaced
 * is put back, while the row still carries this socket's claim. Both compare
 * the owner token in the statement, so neither can touch a successor's claim.
 *
 * Returns whether the replaced claim (or its absence) is back in place. When
 * it is not, a successor overwrote this socket's claim, and the replaced
 * socket stays replaced.
 */
export const createUndoIdentityCommit =
  (
    prisma: Pick<ProcessPrismaClient, "peer">,
    serverId: string = SERVER_ID,
    refundCreation: (ws: P2PartyWSClient) => void = refundIdentityCreation,
  ) =>
  async (ws: P2PartyWSClient, commit: IdentityCommit): Promise<boolean> => {
    const mine = {
      id: ws.data.peerId,
      serverId,
      socketGeneration: ws.data.socketGeneration,
    };
    if (commit.created) {
      const { count } = await prisma.peer.deleteMany({
        where: { ...mine, rooms: { none: {} } },
      });
      if (count > 0) refundCreation(ws);
      return count > 0;
    }
    const { count } = await prisma.peer.updateMany({
      where: mine,
      data: commit.replaced ?? { serverId: null, socketGeneration: null },
    });
    return count > 0;
  };

export const undoIdentityCommit = createUndoIdentityCommit(sharedPrisma);
