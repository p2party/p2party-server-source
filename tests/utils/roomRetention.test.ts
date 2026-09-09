import { expect, test } from "bun:test";
import { pruneEmptyRooms } from "../../src/utils/roomRetention";

test("retention bounds each batch and rechecks emptiness and age at deletion", async () => {
  let read: unknown, write: unknown;
  await pruneEmptyRooms(
    {
      room: {
        findMany: async (query: unknown) => {
          read = query;
          return [{ id: "room" }];
        },
        deleteMany: async (query: unknown) => {
          write = query;
          return { count: 0 };
        },
      },
    } as never,
    2 * 86400000,
  );
  expect(read).toEqual({
    where: { peers: { none: {} }, updatedAt: { lt: new Date(86400000) } },
    select: { id: true },
    take: 1000,
  });
  expect(write).toEqual({
    where: {
      id: { in: ["room"] },
      peers: { none: {} },
      updatedAt: { lt: new Date(86400000) },
    },
  });
});
