import { expect, test } from "bun:test";
import { deepmerge } from "deepmerge-ts";
import { loadConfigFromFile } from "@prisma/config";
import { resolve } from "node:path";

test("the deepmerge-ts Prisma's configuration loader uses preserves the plain-object configuration contract", () => {
  expect(
    deepmerge(
      { schema: "schema.prisma", migrations: { path: "migrations" } },
      { migrations: { seed: "bun seed.ts" } },
    ),
  ).toEqual({
    schema: "schema.prisma",
    migrations: { path: "migrations", seed: "bun seed.ts" },
  });
  const left: Record<string, unknown> = {},
    right: Record<string, unknown> = {};
  left.self = left;
  right.self = right;
  expect(() => deepmerge(left, right)).not.toThrow();
});

test("Prisma's actual configuration loader accepts this repository's configuration", async () => {
  const result = await loadConfigFromFile({
    configRoot: resolve(import.meta.dir, ".."),
  });
  expect(result.error).toBeUndefined();
  expect(result.config?.schema).toBe(
    resolve(import.meta.dir, "../prisma/schema.prisma"),
  );
});
