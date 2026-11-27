import { describeError } from "./logError";
import { prisma } from "../prismaClient";
import type { ProcessPrismaClient } from "../prismaClient";

import { admissionLimits } from "./admission";

const EMPTY_ROOM_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Remove old empty rooms after rechecking concurrent membership changes. */
export const pruneEmptyRooms = async (
  database: Pick<ProcessPrismaClient, "room"> = prisma,
  now = Date.now(),
): Promise<void> => {
  const cutoff = new Date(now - EMPTY_ROOM_RETENTION_MS);
  const rooms = await database.room.findMany({
    where: { peers: { none: {} }, updatedAt: { lt: cutoff } },
    select: { id: true },
    take: 1000,
  });
  if (rooms.length)
    await database.room.deleteMany({
      // Recheck emptiness and age in the delete itself, including another worker's joins.
      where: {
        id: { in: rooms.map(({ id }) => id) },
        peers: { none: {} },
        updatedAt: { lt: cutoff },
      },
    });
};

/** Expired offline identities and their membership/challenge rows disappear together.
 * The database rechecks the offline claim and authentication time at deletion.
 */
export const pruneExpiredMemberships = async (
  database: Pick<ProcessPrismaClient, "peer"> = prisma,
  now = Date.now(),
  ttlDays = admissionLimits.membershipTtlDays,
): Promise<number> => {
  const cutoff = now - ttlDays * EMPTY_ROOM_RETENTION_MS;
  const expired = {
    serverId: null,
    // Legacy rows may have no recorded ping. The first retention pass must
    // still give a newly created identity its full retention window.
    createdAt: { lt: new Date(cutoff) },
    lastPing: { lt: BigInt(cutoff) },
  };
  const peers = await database.peer.findMany({
    where: expired,
    select: { id: true },
    orderBy: [{ lastPing: "asc" }, { id: "asc" }],
    take: 1000,
  });
  if (!peers.length) return 0;
  const { count } = await database.peer.deleteMany({
    where: { ...expired, id: { in: peers.map(({ id }) => id) } },
  });
  return count;
};

export const startRoomRetention = (): ReturnType<typeof setInterval> => {
  const run = () => {
    void Promise.all([pruneExpiredMemberships(), pruneEmptyRooms()]).catch(
      (error: unknown) =>
        console.error("Room retention failed", describeError(error)),
    );
  };
  run();
  const timer = setInterval(run, 60 * 1000);
  timer.unref();
  return timer;
};
