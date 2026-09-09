import { createHash } from "node:crypto";
import { prisma as sharedPrisma } from "../prismaClient";
import { admission, admissionLimits } from "./admission";
import type { ProcessPrismaClient } from "../prismaClient";
import type { P2PartyWSClient } from "../wsServer";

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

/** Persist only after signature verification, before the routing claim goes live. */
export const createPersistVerifiedIdentity =
  (
    prisma: Pick<ProcessPrismaClient, "$transaction">,
    admitCreation = () => admission.newIdentity(),
    maxIdentities = admissionLimits.persistentIdentities,
  ) =>
  async (ws: P2PartyWSClient): Promise<boolean> => {
    if (!ws.data.isVerified || ws.readyState !== 1) return false;
    const { peerId, publicKey } = ws.data;
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
          if (
            provisionalPeerId(publicKey) !== peerId ||
            !admitCreation() ||
            (await transaction.peer.count()) >= maxIdentities
          )
            throw new Error("Identity admission capacity reached");
        }
        if (!ws.data.isVerified || ws.readyState !== 1)
          throw new Error("Authentication socket closed");
        await transaction.peer.upsert({
          where: { publicKey },
          update: { lastPing: Date.now() },
          create: { id: peerId, publicKey, lastPing: Date.now() },
        });
      },
      { isolationLevel: "Serializable" },
    );
    return ws.data.isVerified && ws.readyState === 1;
  };

export const persistVerifiedIdentity =
  createPersistVerifiedIdentity(sharedPrisma);
