import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postgresSslOptions } from "./ssl";

const url = (query: string) => `postgresql://u:p@10.231.0.2:5432/db?${query}`;

describe("postgres TLS decision", () => {
  test("disable turns TLS off", () => {
    expect(postgresSslOptions(url("sslmode=disable"))).toBe(false);
  });

  test("an unrecognised or absent mode encrypts rather than falling back", () => {
    // Defaulting to false here would silently downgrade the link to plaintext.
    for (const q of ["schema=public", "sslmode=prefer", "sslmode=banana"])
      expect(postgresSslOptions(url(q))).toEqual({ rejectUnauthorized: false });
  });

  test("verify-full demands a verifiable chain", () => {
    expect(postgresSslOptions(url("sslmode=verify-full"))).toEqual({
      rejectUnauthorized: true,
    });
  });

  test("sslrootcert pins a CA and enables real verification", () => {
    const dir = mkdtempSync(join(tmpdir(), "p2party-ssl-"));
    const caPath = join(dir, "ca.crt");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n");
    const result = postgresSslOptions(
      url(`sslmode=prefer&sslrootcert=${caPath}`),
    );
    expect(result).toMatchObject({ rejectUnauthorized: true });
    expect((result as { ca: string }).ca).toContain("BEGIN CERTIFICATE");
  });

  test("a mistyped CA path throws instead of quietly not verifying", () => {
    expect(() =>
      postgresSslOptions(url("sslrootcert=/nonexistent/ca.crt")),
    ).toThrow();
  });
});
