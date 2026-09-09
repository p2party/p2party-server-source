import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:tls";
import type { TLSSocket } from "node:tls";

import { postgresConnection } from "../../src/db/ssl";
import type { PostgresSslOptions } from "../../src/db/ssl";

interface PgConnection extends EventEmitter {
  stream: TLSSocket;
  connect(port: number, host: string): void;
}

// Exercise pg's real upgradeToSSL path: it intentionally omits SNI for IP
// addresses, so checking only the SSL options object misses hostname failures.
const require = createRequire(import.meta.url);
const Connection: new (options: {
  ssl: Exclude<PostgresSslOptions, false>;
  sslNegotiation: "direct";
}) => PgConnection = require(
  join(dirname(require.resolve("pg/package.json")), "lib/connection.js"),
);

const directory = mkdtempSync(join(tmpdir(), "p2party-tls-handshake-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

interface CertificateFixture {
  key: string;
  cert: string;
  caPath: string;
}

const fixtures = new Map<string, CertificateFixture>();
const certificate = (ip: string): CertificateFixture => {
  const existing = fixtures.get(ip);
  if (existing) return existing;
  const keyPath = join(directory, `${ip}.key`);
  const caPath = join(directory, `${ip}.crt`);
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=p2party synthetic TLS test",
        "-addext",
        `subjectAltName=IP:${ip}`,
        "-keyout",
        keyPath,
        "-out",
        caPath,
        "-days",
        "1",
      ],
      { stdio: "pipe" },
    );
  } catch {
    // Never include a child-process error's captured private fixture output.
    throw new Error("Could not generate disposable TLS test certificates");
  }
  const fixture = {
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(caPath, "utf8"),
    caPath,
  };
  fixtures.set(ip, fixture);
  return fixture;
};

interface HandshakeResult {
  accepted: boolean;
  errorCode?: string;
}

const handshake = async (
  serverCertificate: CertificateFixture,
  trustedCertificate = serverCertificate,
  conflictingSslFlag = false,
): Promise<HandshakeResult> => {
  const sockets = new Set<Socket>();
  const server = createServer({
    key: serverCertificate.key,
    cert: serverCertificate.cert,
    ALPNProtocols: ["postgresql"],
  });
  server.on("connection", (socket) => sockets.add(socket));
  server.on("tlsClientError", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP port");
    const url = new URL(
      `postgresql://test:test@127.0.0.1:${address.port}/test`,
    );
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.set("sslrootcert", trustedCertificate.caPath);
    if (conflictingSslFlag) url.searchParams.set("ssl", "0");
    const connection = postgresConnection(url.href);
    expect(new URL(connection.connectionString).searchParams.has("ssl")).toBe(
      false,
    );
    if (!connection.ssl) throw new Error("Verified TLS was disabled");

    return await new Promise<HandshakeResult>((resolve) => {
      const client = new Connection({
        ssl: connection.ssl as Exclude<PostgresSslOptions, false>,
        // This uses the same pg TLS upgrade as SSLRequest negotiation without
        // requiring an actual database or a fake PostgreSQL authentication loop.
        sslNegotiation: "direct",
      });
      let settled = false;
      const finish = (result: HandshakeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.stream.destroy();
        resolve(result);
      };
      const timeout = setTimeout(
        () => finish({ accepted: false, errorCode: "TEST_TIMEOUT" }),
        5000,
      );
      client.on("error", (error: NodeJS.ErrnoException) =>
        finish({ accepted: false, errorCode: error.code ?? "TLS_ERROR" }),
      );
      client.on("sslconnect", () =>
        client.stream.once("secureConnect", () => finish({ accepted: true })),
      );
      client.connect(address.port, "127.0.0.1");
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("PostgreSQL TLS peer authentication", () => {
  test("a trusted certificate with the configured IP SAN succeeds", async () => {
    expect(await handshake(certificate("127.0.0.1"))).toEqual({
      accepted: true,
    });
  });

  test("a trusted certificate with a different IP SAN is rejected", async () => {
    expect(await handshake(certificate("127.0.0.2"))).toEqual({
      accepted: false,
      errorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });

  test("a matching IP signed by an untrusted certificate is rejected", async () => {
    const result = await handshake(
      certificate("127.0.0.1"),
      certificate("127.0.0.2"),
    );
    expect(result.accepted).toBe(false);
    expect(result.errorCode).toMatch(/CERT|ISSUER|SIGNATURE/);
  });

  test("a conflicting ssl=0 flag cannot disable verified TLS", async () => {
    const correct = certificate("127.0.0.1");
    expect(await handshake(correct, correct, true)).toEqual({ accepted: true });
    const wrong = certificate("127.0.0.2");
    expect(await handshake(wrong, wrong, true)).toEqual({
      accepted: false,
      errorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });
});
