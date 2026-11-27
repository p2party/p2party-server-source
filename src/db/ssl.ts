import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";

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
  | false
  | {
      rejectUnauthorized: true;
      ca?: string;
      checkServerIdentity: typeof checkServerIdentity;
    };

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
 *   absent / require / prefer / verify-ca: verify against the system trust store.
 *   unknown              reject configuration before a connection is attempted.
 *
 * Every encrypted mode authenticates the server. Explicit disable remains for
 * disposable local databases; production supplies verify-full and a pinned CA.
 */
export const postgresConnection = (raw: string): PostgresConnection => {
  // URL errors can include the full input, including database credentials.
  if (!URL.canParse(raw)) throw new Error("Invalid PostgreSQL DATABASE_URL");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must use the PostgreSQL scheme");
  const mode = url.searchParams.get("sslmode")?.toLowerCase();
  const rootCert = url.searchParams.get("sslrootcert");
  if (
    mode !== undefined &&
    !["disable", "require", "prefer", "verify-ca", "verify-full"].includes(mode)
  )
    throw new Error("Unsupported PostgreSQL sslmode");

  // Remove them so the Client constructor has nothing to re-interpret.
  for (const key of [
    "ssl",
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "sslnegotiation",
    "uselibpqcompat",
  ])
    url.searchParams.delete(key);

  const connectionString = url.toString();

  if (mode === "disable") return { connectionString, ssl: false };
  // pg omits SNI for IP literals. Its already-connected TLS socket otherwise
  // falls back to localhost for name validation under Bun. Bind verification
  // to the address actually configured, without putting an IP into SNI.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const verified = {
    rejectUnauthorized: true as const,
    checkServerIdentity: (
      _servername: string,
      certificate: Parameters<typeof checkServerIdentity>[1],
    ) => checkServerIdentity(hostname, certificate),
  };

  if (rootCert) {
    // Fail loudly: silently continuing unverified because a path was mistyped
    // would defeat the only reason to configure it.
    const ca = readFileSync(rootCert, "utf8");
    return { connectionString, ssl: { ...verified, ca } };
  }

  if (mode === "verify-full") return { connectionString, ssl: verified };

  return { connectionString, ssl: verified };
};
