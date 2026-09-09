import { prisma } from "../prismaClient";
import type { ProcessPrismaClient } from "../prismaClient";

const EMPTY_ROOM_RETENTION_MS = 24 * 60 * 60 * 1000;
/** No identity or occupied-room deletion: stable IDs and offline membership survive. */
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

export const startRoomRetention = (): ReturnType<typeof setInterval> => {
  const run = () => {
    void pruneEmptyRooms().catch(() =>
      console.error("Empty-room retention failed"),
    );
  };
  run();
  const timer = setInterval(run, 60 * 1000);
  timer.unref();
  return timer;
};
