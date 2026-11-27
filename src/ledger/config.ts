import { isSuite, signatureSuites } from "../../clients/evm/src/suites.ts";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export const invalidParams = () => new RpcError(-32602, "Invalid params");
export function bytes(value: unknown, length: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length !== length * 2 + 2 ||
    !/^0x[0-9a-f]+$/.test(value)
  )
    throw invalidParams();
  return Buffer.from(value.slice(2), "hex");
}
export function quantity(value: unknown, maximum = (1n << 63n) - 1n): bigint {
  if (
    typeof value !== "string" ||
    value.length > 18 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)
  )
    throw invalidParams();
  const n = BigInt(value);
  if (n > maximum) throw invalidParams();
  return n;
}
export const hex = (buffer: Buffer) => "0x" + buffer.toString("hex");
export const hexQuantity = (n: string | number | bigint) =>
  "0x" + BigInt(n).toString(16);
export type GenesisUnit = {
  id: string;
  weight: string;
  suite: number;
  commitment: string;
};
export type LedgerConfig = {
  chainId: string;
  rpcChainId: number;
  spendMask: number;
  receiveMask: number;
  units: GenesisUnit[];
  genesisHash: string;
  verifier: string;
  corsOrigins: string[];
};

function suiteMask(suites: unknown): number {
  if (
    !Array.isArray(suites) ||
    !suites.length ||
    suites.length > signatureSuites.length ||
    new Set(suites).size !== suites.length ||
    !suites.every(isSuite)
  )
    throw new Error("Invalid ledger suite policy");
  return suites.reduce((mask, suite) => mask | (1 << (suite - 1)), 0);
}
function readGenesis(path: string) {
  const fd = openSync(path, "r");
  try {
    const limit = 1024 * 1024;
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Invalid ledger genesis file");
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = readSync(fd, buffer, used, buffer.length - used, null);
      if (!read) break;
      used += read;
    }
    if (used !== stat.size)
      throw new Error("Ledger genesis changed while reading");
    return JSON.parse(buffer.subarray(0, used).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
export function ledgerCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  const origins = value.split(",");
  if (origins.length > 16 || value.length > 2048)
    throw new Error("Invalid LEDGER_CORS_ORIGINS");
  if (origins.length === 1 && origins[0] === "*") return origins;
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("Invalid LEDGER_CORS_ORIGINS");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    )
      throw new Error("Invalid LEDGER_CORS_ORIGINS");
  }
  return [...new Set(origins)];
}
export function ledgerConfig(env: NodeJS.ProcessEnv): LedgerConfig | undefined {
  if (env.LEDGER_ENABLED === undefined || env.LEDGER_ENABLED === "false")
    return;
  if (env.LEDGER_ENABLED !== "true")
    throw new Error("LEDGER_ENABLED must be true or false");
  const {
    LEDGER_CHAIN_ID: chainId,
    LEDGER_GENESIS_FILE: file,
    LEDGER_VERIFIER: verifier,
  } = env;
  if (!file || !verifier || !isAbsolute(file) || !isAbsolute(verifier))
    throw new Error(
      "Enabling the ledger requires absolute LEDGER_GENESIS_FILE and LEDGER_VERIFIER paths",
    );
  bytes(chainId, 32);
  const g = readGenesis(file);
  const keys = (v: object, allowed: string[]) =>
    Object.keys(v).every((k) => allowed.includes(k));
  if (
    !g ||
    typeof g !== "object" ||
    !keys(g, [
      "version",
      "chainId",
      "rpcChainId",
      "spendSuites",
      "receiveSuites",
      "units",
    ]) ||
    g.version !== 1 ||
    g.chainId !== chainId ||
    !Number.isSafeInteger(g.rpcChainId) ||
    g.rpcChainId < 1 ||
    !Array.isArray(g.units) ||
    g.units.length > 4096
  )
    throw new Error("Invalid ledger genesis identity or units");
  const spendMask = suiteMask(g.spendSuites),
    receiveMask = suiteMask(g.receiveSuites);
  const ids = new Set<string>(),
    commitments = new Set<string>();
  const units: GenesisUnit[] = g.units.map((u: GenesisUnit) => {
    if (
      !u ||
      typeof u !== "object" ||
      !keys(u, ["id", "weight", "suite", "commitment"]) ||
      !isSuite(u.suite) ||
      !(spendMask & (1 << (u.suite - 1)))
    )
      throw new Error("Invalid genesis owner suite");
    bytes(u.id, 64);
    bytes(u.commitment, 64);
    const weight = quantity(u.weight, 1n << 63n);
    if (
      !weight ||
      weight & (weight - 1n) ||
      ids.has(u.id) ||
      commitments.has(u.commitment)
    )
      throw new Error("Invalid or duplicate genesis unit");
    ids.add(u.id);
    commitments.add(u.commitment);
    return {
      id: u.id,
      weight: u.weight,
      suite: u.suite,
      commitment: u.commitment,
    };
  });
  units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const config = {
    chainId: chainId!,
    rpcChainId: g.rpcChainId as number,
    spendMask,
    receiveMask,
    units,
  };
  const genesisHash = createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
  if (
    execFileSync(verifier, ["--version"], {
      timeout: 2000,
      killSignal: "SIGKILL",
      maxBuffer: 128,
      env: {},
      encoding: "utf8",
    }).trim() !== "demos-ledger-verify/1"
  )
    throw new Error("Unsupported native ledger verifier");
  return {
    ...config,
    genesisHash,
    verifier,
    corsOrigins: ledgerCorsOrigins(env.LEDGER_CORS_ORIGINS),
  };
}
