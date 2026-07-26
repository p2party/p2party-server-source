import { readFileSync } from "node:fs";

/**
 * One place that decides how TLS to Postgres is negotiated.
 *
 * node-postgres does not implement libpq's `sslmode` semantics. libpq reads
 * `prefer` as "try TLS, fall back to plaintext"; pg 8 treats `prefer`,
 * `require` and `verify-ca` as aliases for `verify-full` — full chain
 * verification — and warns that pg 9 will flip to libpq behaviour. Relying on
 * the URL alone means the meaning of this deployment's connection changes
 * underneath it on a dependency bump.
 *
 * Both consumers pass an explicit `ssl` option derived here: the LISTEN client
 * in src/pubsub.ts and the Prisma adapter in src/prismaClient.ts. Getting this
 * wrong on only one of them is not hypothetical — it is what happened: the
 * LISTEN client was fixed while Prisma still failed with
 * DEPTH_ZERO_SELF_SIGNED_CERT on its first query.
 */

export type PostgresSslOptions =
  false | { rejectUnauthorized: boolean; ca?: string };

/**
 * Resolution order, highest trust first:
 *
 *   sslrootcert=<path>   verify the chain against that CA. This is the correct
 *                        end state — point it at the CA that signed the server
 *                        certificate and the connection is both encrypted and
 *                        authenticated. Requires a certificate whose SAN covers
 *                        the address actually connected to (10.231.0.2), which
 *                        Debian's install-time self-signed certificate is not.
 *   sslmode=verify-full  verify against the system trust store.
 *   sslmode=disable      no TLS at all.
 *   anything else        encrypt without verifying.
 *
 * The last case is a deliberate, bounded compromise, not an oversight. It is
 * strictly better than the plaintext it replaces — it defeats passive capture
 * on the private network — and strictly worse than verification, because it
 * cannot detect an active in-path attacker. Provisioning a real certificate and
 * setting sslrootcert is the remaining step, and needs no code change.
 */
export const postgresSslOptions = (
  connectionString: string,
): PostgresSslOptions => {
  const param = (name: string): string | undefined =>
    new RegExp(`[?&]${name}=([^&]+)`).exec(connectionString)?.[1];

  const mode = param("sslmode")?.toLowerCase();
  if (mode === "disable") return false;

  const rootCertPath = param("sslrootcert");
  if (rootCertPath) {
    // Fail loudly. Silently falling back to an unverified connection because a
    // path was mistyped would defeat the reason for configuring it.
    const ca = readFileSync(decodeURIComponent(rootCertPath), "utf8");
    return { rejectUnauthorized: true, ca };
  }

  if (mode === "verify-full") return { rejectUnauthorized: true };

  // Unrecognised values land here deliberately: defaulting to `false` would
  // silently downgrade the link to plaintext.
  return { rejectUnauthorized: false };
};
