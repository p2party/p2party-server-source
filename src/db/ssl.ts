import { readFileSync } from "node:fs";

/**
 * One place that decides how TLS to Postgres is negotiated.
 *
 * node-postgres does not implement libpq's `sslmode` semantics. pg 8 treats
 * `prefer`, `require` and `verify-ca` as aliases for `verify-full` — full chain
 * verification — and warns that pg 9 will flip to libpq behaviour. So the same
 * URL means opposite things on either side of a dependency bump.
 *
 * Worse, passing an explicit `ssl` option alongside a connection string that
 * still carries `sslmode` does not win: pg-connection-string parses the URL
 * inside the Client constructor and its result takes precedence. That is why an
 * explicit { rejectUnauthorized: false } was still failing with
 * DEPTH_ZERO_SELF_SIGNED_CERT. The ssl parameters therefore have to be removed
 * from the string, not merely overridden.
 *
 * Both consumers use this: the LISTEN client in src/pubsub.ts and the Prisma
 * adapter in src/prismaClient.ts. Fixing only one is not hypothetical — that is
 * exactly what happened once already.
 */

export type PostgresSslOptions =
  false | { rejectUnauthorized: boolean; ca?: string };

export interface PostgresConnection {
  /** The URL with every ssl parameter removed, so pg cannot re-derive them. */
  readonly connectionString: string;
  /** The decision, passed explicitly to pg.Client / PrismaPg. */
  readonly ssl: PostgresSslOptions;
}

/**
 * Resolution order, highest trust first:
 *
 *   sslrootcert=<path>   verify against that CA. The correct end state: point
 *                        it at the CA that signed the server certificate and
 *                        the link is encrypted *and* authenticated. Needs a
 *                        certificate whose SAN covers the address actually
 *                        dialled (10.231.0.2), which Debian's install-time
 *                        self-signed certificate does not have.
 *   sslmode=verify-full  verify against the system trust store.
 *   sslmode=disable      no TLS.
 *   anything else        encrypt without verifying.
 *
 * The last case is a bounded, deliberate compromise: strictly better than the
 * plaintext it replaces, since it defeats passive capture on the private
 * network, and strictly worse than verification, since it cannot detect an
 * active in-path attacker. Provisioning a real certificate and setting
 * sslrootcert closes it with no code change.
 */
export const postgresConnection = (raw: string): PostgresConnection => {
  const url = new URL(raw);
  const mode = url.searchParams.get("sslmode")?.toLowerCase();
  const rootCert = url.searchParams.get("sslrootcert");

  // Remove them so the Client constructor has nothing to re-interpret.
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
    url.searchParams.delete(key);

  const connectionString = url.toString();

  if (mode === "disable") return { connectionString, ssl: false };

  if (rootCert) {
    // Fail loudly: silently continuing unverified because a path was mistyped
    // would defeat the only reason to configure it.
    const ca = readFileSync(decodeURIComponent(rootCert), "utf8");
    return { connectionString, ssl: { rejectUnauthorized: true, ca } };
  }

  if (mode === "verify-full")
    return { connectionString, ssl: { rejectUnauthorized: true } };

  // Unrecognised or absent lands here on purpose: defaulting to `false` would
  // silently downgrade the link to plaintext.
  return { connectionString, ssl: { rejectUnauthorized: false } };
};
