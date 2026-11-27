// Local operator command. Production signaling does not load the signing key
// or invoke this program. A witness can only be issued after native replay.
import { spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  combineWitnesses,
  operatorId,
  parsePolicy,
  signCheckpoint,
  verifyCertificate,
  verifyWitness,
} from "./checkpoint-crypto.mjs";

import { signatureSuites } from "../clients/evm/src/suites.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = [
  `init NEW_OPERATOR_DIRECTORY ${signatureSuites.map((s) => s.algorithm).join("|")}`,
  "policy CHAIN_ID GENESIS_HASH PUBLIC_PEM PUBLIC_PEM [...]",
  "attest OPERATOR_DIRECTORY POLICY LOCAL_RPC HEIGHT",
  "combine POLICY WITNESS WITNESS [...]",
  "verify POLICY CERTIFICATE LOCAL_RPC",
  "verify-file POLICY CERTIFICATE PREVIOUSLY_VERIFIED_CHECKPOINT",
].join("\n  ");

function readFile(path, limit, secret = false) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > limit ||
      (secret && info.mode & 0o077)
    )
      throw new Error(
        "Expected a bounded regular file with appropriate permissions",
      );
    const bytes = Buffer.alloc(info.size + 1);
    try {
      let size = 0;
      while (size < bytes.length) {
        const n = readSync(fd, bytes, size, bytes.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size !== info.size) throw new Error("File changed during the read");
      if (secret)
        return createPrivateKey({
          key: bytes.subarray(0, size),
          format: "der",
          type: "pkcs8",
        });
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, size),
      );
    } finally {
      if (secret) bytes.fill(0);
    }
  } finally {
    closeSync(fd);
  }
}

const json = (path, limit) => JSON.parse(readFile(path, limit));
const readPolicy = (file) => parsePolicy(json(file, 128 * 1024));
function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function init(dir, suite) {
  if (!signatureSuites.some((entry) => entry.algorithm === suite))
    throw new Error("Unsupported checkpoint signing suite");
  mkdirSync(dir, { mode: 0o700 }); // Exclusive: never adopt a directory or replace a key or journal.
  const { privateKey, publicKey } = generateKeyPairSync(suite);
  const keyId = operatorId(publicKey);
  writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
  const dbPath = join(dir, "witness.sqlite");
  closeSync(openSync(dbPath, "wx", 0o600));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
      CREATE TABLE operator(key_id TEXT PRIMARY KEY);
      CREATE TABLE tips(chain_id TEXT PRIMARY KEY, genesis TEXT NOT NULL, height TEXT NOT NULL, history TEXT NOT NULL, log_root TEXT NOT NULL);
      CREATE TABLE votes(policy_id TEXT NOT NULL, height TEXT NOT NULL, witness TEXT NOT NULL, PRIMARY KEY(policy_id,height));`);
    db.prepare("INSERT INTO operator VALUES (?)").run(keyId);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  writeFileSync(
    join(dir, "public.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
    { flag: "wx", mode: 0o600, flush: true },
  );
  const secret = privateKey.export({ type: "pkcs8", format: "der" });
  try {
    writeFileSync(join(dir, "operator.pk8"), secret, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  } finally {
    secret.fill(0);
  }
  syncDirectory(dir);
  syncDirectory(dirname(dir));
  return { keyId, suite };
}

function replay(endpoint, height, tip) {
  const args = [
    "--no-env-file",
    "run",
    "src/ledger/verifyPeer.ts",
    endpoint,
    height,
  ];
  if (tip) args.push("--anchor", tip.height, tip.history, tip.log_root);
  const env = { PATH: process.env.PATH };
  for (const name of [
    "DATABASE_URL",
    "LEDGER_REPLICA_DATABASE_URL",
    "LEDGER_ENABLED",
    "LEDGER_CHAIN_ID",
    "LEDGER_GENESIS_FILE",
    "LEDGER_VERIFIER",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (
    typeof height !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(height) ||
    BigInt(height) > 0x7fffffffffffffffn
  )
    throw new Error("Use a canonical ledger height");
  const r = spawnSync("bun", args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 16384,
  });
  if (r.error || r.status !== 0) {
    const reason = r.stderr?.match(/^error: (.{1,200})$/m)?.[1];
    throw new Error(
      "Local ledger replay failed" + (reason ? ": " + reason : ""),
    );
  }
  return JSON.parse(r.stdout);
}
function attest(dir, policyFile, endpoint, height) {
  const policy = readPolicy(policyFile);
  const directory = lstatSync(dir);
  const dbPath = join(dir, "witness.sqlite");
  const dbFile = lstatSync(dbPath);
  if (
    !directory.isDirectory() ||
    directory.mode & 0o077 ||
    !dbFile.isFile() ||
    dbFile.mode & 0o077
  )
    throw new Error(
      "Use the original private operator directory and witness journal",
    );
  const publicKey = createPublicKey(readFile(join(dir, "public.pem"), 8192));
  const keyId = operatorId(publicKey);
  if (!policy.operators.some((operator) => operator.keyId === keyId))
    throw new Error("Operator is outside the pinned policy");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    if (db.prepare("SELECT key_id FROM operator").get()?.key_id !== keyId)
      throw new Error("Operator key and witness journal do not match");
    const tip = db.prepare(
      "SELECT genesis, height, history, log_root FROM tips WHERE chain_id=?",
    );
    const before = tip.get(policy.chainId);
    if (
      before &&
      (before.genesis !== policy.genesisHash ||
        BigInt(height) < BigInt(before.height))
    )
      throw new Error(
        "Refusing a different genesis or a checkpoint below the operator's signed height",
      );
    const checkpoint = replay(endpoint, height, before);
    if (
      checkpoint.chainId !== policy.chainId ||
      checkpoint.genesisHash !== policy.genesisHash ||
      checkpoint.height !== height
    )
      throw new Error(
        "Verified checkpoint differs from the operator's policy or requested height",
      );
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = tip.get(policy.chainId);
      const same =
        current?.height === height &&
        current.genesis === checkpoint.genesisHash &&
        current.history === checkpoint.historyHash &&
        current.log_root === checkpoint.logRoot;
      if (
        !same &&
        (current?.height !== before?.height ||
          current?.history !== before?.history ||
          current?.log_root !== before?.log_root ||
          current?.genesis !== before?.genesis)
      )
        throw new Error(
          "Another attestation advanced the journal; replay and retry",
        );
      const saved = db
        .prepare("SELECT witness FROM votes WHERE policy_id=? AND height=?")
        .get(policy.policyId, height);
      let witness;
      if (saved) {
        witness = JSON.parse(saved.witness);
        if (verifyWitness(policy, witness, checkpoint) !== keyId)
          throw new Error("Stored witness belongs to another operator");
      } else {
        const privateKey = readFile(join(dir, "operator.pk8"), 32768, true);
        if (operatorId(createPublicKey(privateKey)) !== keyId)
          throw new Error("Private key does not match the operator journal");
        witness = signCheckpoint(policy, checkpoint, privateKey);
        db.prepare("INSERT INTO votes VALUES (?,?,?)").run(
          policy.policyId,
          height,
          JSON.stringify(witness),
        );
        db.prepare(
          "INSERT INTO tips VALUES (?,?,?,?,?) ON CONFLICT(chain_id) DO UPDATE SET height=excluded.height, history=excluded.history, log_root=excluded.log_root",
        ).run(
          checkpoint.chainId,
          checkpoint.genesisHash,
          height,
          checkpoint.historyHash,
          checkpoint.logRoot,
        );
      }
      db.exec("COMMIT"); // Never release a signature before this durable decision.
      return witness;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function run([command, ...args]) {
  if (command === "init" && args.length === 2) return init(...args);
  if (command === "policy" && args.length >= 4 && args.length <= 18) {
    const [chainId, genesisHash, ...paths] = args;
    const descriptor = {
      version: 1,
      chainId,
      genesisHash,
      operators: paths.map((path) => readFile(path, 8192)),
    };
    parsePolicy(descriptor);
    return descriptor;
  }
  if (command === "attest" && args.length === 4) return attest(...args);
  if (command === "combine" && args.length >= 3 && args.length <= 17) {
    const policy = readPolicy(args[0]);
    const witnesses = args.slice(1).map((p) => json(p, 64 * 1024));
    return combineWitnesses(policy, witnesses, witnesses[0].checkpoint);
  }
  if (
    (command === "verify" || command === "verify-file") &&
    args.length === 3
  ) {
    const policy = readPolicy(args[0]),
      cert = json(args[1], 1024 * 1024);
    // Authenticate the request before spending work on a claimed height.
    verifyCertificate(policy, cert, cert.checkpoint);
    const local =
      command === "verify"
        ? replay(args[2], cert.checkpoint.height)
        : json(args[2], 4096);
    return verifyCertificate(policy, cert, local);
  }
  throw new Error("Usage: node tools/ledger-checkpoint.mjs\n  " + usage);
}
try {
  console.log(JSON.stringify(run(process.argv.slice(2))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
