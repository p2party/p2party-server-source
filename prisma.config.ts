import type { PrismaConfig } from "prisma/config";

/**
 * Prisma 7 no longer accepts `url` inside the datasource block. The CLI reads
 * the connection string from here; the running server never does — it goes
 * through the pg driver adapter in src/prismaClient.ts, which is what keeps the
 * compiled binary free of a platform-specific query engine.
 *
 * The fallback matters: `prisma generate` only reads the schema and never
 * opens a connection, so it must not require a live DATABASE_URL. `migrate`
 * does connect, and is always run with the real value (deploy.yml passes it in
 * the task environment). A placeholder here fails loudly at connect time
 * rather than silently pointing somewhere real.
 *
 * The import is `import type` and the default export is a plain object ON
 * PURPOSE, and this file must stay that way. The deploy host carries a single
 * compiled binary and no node_modules: it runs the CLI through
 * `bunx prisma@<pinned>`, which unpacks into a temporary tree of its own. A
 * runtime `import { defineConfig } from "prisma/config"` is resolved from THIS
 * file's directory upwards, never from that temporary tree, so it fails with
 * "Cannot find module 'prisma/config'" and no migration can run. Nothing is
 * lost by dropping it: the loader's parseDefaultExport() tries the plain
 * PrismaConfig shape first and applies defineConfig() itself.
 * Regression-tested in tests/deploy.contract.test.ts.
 */
export default {
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://unset:unset@127.0.0.1:1/unset?schema=public",
  },
} satisfies PrismaConfig;
