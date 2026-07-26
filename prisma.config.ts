import { defineConfig } from "prisma/config";

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
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://unset:unset@127.0.0.1:1/unset?schema=public",
  },
});
