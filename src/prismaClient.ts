import { PrismaPg } from "@prisma/adapter-pg";

import { postgresSslOptions } from "./db/ssl";

import { PrismaClient } from "./generated/prisma/client/client";

/**
 * Two deliberate choices here, both required for `bun build --compile` to
 * produce a working single-file binary.
 *
 * 1. The client is imported statically from the generated source tree. This
 *    previously used createRequire()("@prisma/client"); the bundler cannot see
 *    through a runtime require of a bare specifier, so the client was never
 *    embedded and every compiled binary crash-looped with
 *      Cannot find module '@prisma/client' from '/$bunfs/root/p2party_linux_x64'
 *    because the binary's virtual filesystem holds no node_modules.
 *
 * 2. Queries go through the `pg` driver adapter rather than Prisma's native
 *    query engine. The engine ships as a platform-specific .node binary, so a
 *    macOS build host would embed libquery_engine-darwin-arm64 into a
 *    linux-x64 binary. The adapter is pure JavaScript and cross-compiles
 *    cleanly — and `pg` is already a dependency, since src/pubsub.ts needs a
 *    dedicated connection for LISTEN/NOTIFY.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error(
    "p2party: DATABASE_URL is required. prisma/schema.prisma declares " +
      'provider = "postgresql", so this must be a postgresql:// URL.',
  );

// The same TLS decision as the LISTEN client. PrismaPg wraps node-postgres, so
// a bare connectionString here would reject Postgres's self-signed certificate
// on the first query — the failure the LISTEN client hit, one layer along.
const adapter = new PrismaPg({
  connectionString,
  ssl: postgresSslOptions(connectionString),
});

export { PrismaClient };

export type ProcessPrismaClient = Omit<PrismaClient, "$disconnect">;

/** The single Prisma connection manager used for the lifetime of the server. */
export const prisma: ProcessPrismaClient = new PrismaClient({ adapter });
