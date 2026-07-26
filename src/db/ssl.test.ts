import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postgresConnection } from "./ssl";

const url = (query: string) => `postgresql://u:p@10.231.0.2:5432/db?${query}`;

describe("postgres TLS decision", () => {
  test("ssl parameters are removed from the connection string", () => {
    // The whole point: pg-connection-string parses sslmode inside the Client
    // constructor and its result overrides an explicit `ssl` option, so leaving
    // the parameter in place silently reinstates verify-full.
    const dir = mkdtempSync(join(tmpdir(), "p2party-ssl-"));
    const caPath = join(dir, "ca.crt");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n");
    const { connectionString } = postgresConnection(
      url(`schema=public&sslmode=require&sslrootcert=${caPath}`),
    );
    expect(connectionString).not.toContain("sslmode");
    expect(connectionString).not.toContain("sslrootcert");
    // Everything unrelated survives.
    expect(connectionString).toContain("schema=public");
    expect(connectionString).toContain("10.231.0.2:5432");
  });

  test("disable turns TLS off", () => {
    expect(postgresConnection(url("sslmode=disable")).ssl).toBe(false);
  });

  test("an unrecognised or absent mode encrypts rather than falling back", () => {
    for (const q of ["schema=public", "sslmode=prefer", "sslmode=banana"])
      expect(postgresConnection(url(q)).ssl).toEqual({
        rejectUnauthorized: false,
      });
  });

  test("verify-full demands a verifiable chain", () => {
    expect(postgresConnection(url("sslmode=verify-full")).ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  test("sslrootcert pins a CA and enables real verification", () => {
    const dir = mkdtempSync(join(tmpdir(), "p2party-ssl-"));
    const caPath = join(dir, "ca.crt");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n");
    const { ssl } = postgresConnection(
      url(`sslmode=require&sslrootcert=${caPath}`),
    );
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    expect((ssl as { ca: string }).ca).toContain("BEGIN CERTIFICATE");
  });

  test("a mistyped CA path throws instead of quietly not verifying", () => {
    expect(() =>
      postgresConnection(url("sslrootcert=/nonexistent/ca.crt")),
    ).toThrow();
  });

  test("credentials and database name are preserved", () => {
    const { connectionString } = postgresConnection(url("sslmode=require"));
    expect(connectionString).toContain("u:p@");
    expect(connectionString).toContain("/db");
  });
});
