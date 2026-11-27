// The trusted policy and expected checkpoint come from the local operator.
// Public artifacts contain signatures and key identifiers only.
import {
  createHash,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";

import { signatureSuites } from "../clients/evm/src/suites.ts";
const checkpointFields = [
  "chainId",
  "genesisHash",
  "height",
  "historyHash",
  "logRoot",
];
const signatureFields = ["keyId", "suite", "signature"];
const witnessFields = ["version", "policyId", "checkpoint", ...signatureFields];

function fields(object, names) {
  if (
    !object ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    Object.keys(object).length !== names.length ||
    !names.every((name) => Object.hasOwn(object, name))
  )
    throw new Error("Unexpected checkpoint document fields");
}

const hex = (buffer) => "0x" + buffer.toString("hex");
function bytes(value, size) {
  if (
    typeof value !== "string" ||
    value.length !== 2 + size * 2 ||
    !/^0x[0-9a-f]+$/.test(value)
  )
    throw new Error(`Expected ${size} canonical hex bytes`);
  const decoded = Buffer.from(value.slice(2), "hex");
  if (decoded.length !== size) throw new Error("Incomplete hex field");
  return decoded;
}

function hash(domain, ...parts) {
  const digest = createHash("sha512").update(domain + "\0", "ascii");
  for (const part of parts) digest.update(part);
  return hex(digest.digest());
}

function keyInfo(key) {
  const entry =
    key instanceof KeyObject &&
    signatureSuites.find((suite) => suite.algorithm === key.asymmetricKeyType);
  if (!entry) throw new Error("Unsupported post-quantum operator key");
  return entry;
}

export function operatorId(key) {
  const suite = keyInfo(key);
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return hash(
    "p2party/checkpoint/operator/v1",
    Buffer.from([suite.id]),
    publicKey.export({ format: "raw-public" }),
  );
}

function readOperator(pem) {
  if (typeof pem !== "string" || pem.length > 4096)
    throw new Error("Expected a PEM-encoded operator public key");
  // OpenSSL's general-purpose reader also accepts a private key, leading text
  // and extra PEM blocks. Admit exactly one canonical SPKI, including its DER.
  const normalized = pem.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("-----BEGIN PUBLIC KEY-----\n"))
    throw new Error("Expected a PEM-encoded operator public key");
  const publicKey = createPublicKey(normalized);
  const canonical = publicKey.export({ format: "pem", type: "spki" });
  if (normalized !== canonical && normalized + "\n" !== canonical)
    throw new Error("Expected one canonical SPKI public key");
  return Object.freeze({
    keyId: operatorId(publicKey),
    suite: keyInfo(publicKey).id,
    publicKey,
  });
}

const byKeyId = (a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0);

export function parsePolicy(input) {
  fields(input, ["version", "chainId", "genesisHash", "operators"]);
  if (
    input.version !== 1 ||
    !Array.isArray(input.operators) ||
    input.operators.length < 2 ||
    input.operators.length > 16
  )
    throw new Error("Checkpoint v1 requires 2 to 16 pinned operators");
  const chain = bytes(input.chainId, 32);
  const genesis = bytes(input.genesisHash, 32);
  const operators = Array.from(input.operators, readOperator).sort(byKeyId);
  if (new Set(operators.map((key) => key.keyId)).size !== operators.length)
    throw new Error("Duplicate operator in checkpoint policy");
  // Entries are suite:u8 || keyId:64 in unsigned key-ID byte order. The
  // domain names the all-signatures rule. The count is a single unsigned byte.
  const policyId = hash(
    "p2party/checkpoint/all/v1",
    chain,
    genesis,
    Buffer.from([operators.length]),
    ...operators.map(({ suite, keyId }) =>
      Buffer.concat([Buffer.from([suite]), bytes(keyId, 64)]),
    ),
  );
  return Object.freeze({
    policyId,
    chainId: input.chainId,
    genesisHash: input.genesisHash,
    operators: Object.freeze(operators),
  });
}

function checkedCheckpoint(policy, statement) {
  fields(statement, checkpointFields);
  if (
    statement.chainId !== policy.chainId ||
    statement.genesisHash !== policy.genesisHash
  )
    throw new Error("Checkpoint chain or genesis differs from trusted policy");
  if (
    typeof statement.height !== "string" ||
    statement.height.length > 18 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(statement.height) ||
    BigInt(statement.height) > 0x7fffffffffffffffn
  )
    throw new Error("Invalid checkpoint height");
  bytes(statement.historyHash, 64);
  bytes(statement.logRoot, 64);
  return {
    chainId: statement.chainId,
    genesisHash: statement.genesisHash,
    height: statement.height,
    historyHash: statement.historyHash,
    logRoot: statement.logRoot,
  };
}

function signatureMessage(policy, checkpoint, operator) {
  const height = Buffer.alloc(8);
  height.writeBigUInt64BE(BigInt(checkpoint.height));
  return Buffer.concat([
    Buffer.from("p2party/checkpoint/witness/v1\0", "ascii"),
    bytes(policy.policyId, 64),
    bytes(checkpoint.chainId, 32),
    bytes(checkpoint.genesisHash, 32),
    height,
    bytes(checkpoint.historyHash, 64),
    bytes(checkpoint.logRoot, 64),
    Buffer.from([operator.suite]),
    bytes(operator.keyId, 64),
  ]);
}

function pinnedOperator(policy, keyId) {
  const operator = policy.operators.find((entry) => entry.keyId === keyId);
  if (!operator)
    throw new Error("Checkpoint signer is outside the trusted policy");
  return operator;
}

export function signCheckpoint(policy, statement, privateKey) {
  const checkpoint = checkedCheckpoint(policy, statement);
  if (!(privateKey instanceof KeyObject) || privateKey.type !== "private")
    throw new Error("Expected a private operator key");
  const operator = pinnedOperator(policy, operatorId(privateKey));
  const signature = sign(
    null,
    signatureMessage(policy, checkpoint, operator),
    privateKey,
  );
  return {
    version: 1,
    policyId: policy.policyId,
    checkpoint,
    keyId: operator.keyId,
    suite: operator.suite,
    signature: hex(signature),
  };
}

function matchCheckpoint(policy, document, expected) {
  const checkpoint = checkedCheckpoint(policy, expected);
  fields(document.checkpoint, checkpointFields);
  if (
    document.version !== 1 ||
    document.policyId !== policy.policyId ||
    !checkpointFields.every(
      (name) => document.checkpoint[name] === checkpoint[name],
    )
  )
    throw new Error(
      "Artifact differs from the trusted policy or expected checkpoint",
    );
  return checkpoint;
}

function checkSignature(policy, checkpoint, record) {
  const operator = pinnedOperator(policy, record.keyId);
  if (record.suite !== operator.suite)
    throw new Error("Wrong checkpoint signature suite");
  const signature = bytes(
    record.signature,
    keyInfo(operator.publicKey).signature,
  );
  if (
    !verify(
      null,
      signatureMessage(policy, checkpoint, operator),
      operator.publicKey,
      signature,
    )
  )
    throw new Error("Invalid checkpoint signature");
  return operator.keyId;
}

export function verifyWitness(policy, witness, expectedCheckpoint) {
  fields(witness, witnessFields);
  const checkpoint = matchCheckpoint(policy, witness, expectedCheckpoint);
  return checkSignature(policy, checkpoint, witness);
}

function requireAll(policy, signatures) {
  if (
    !Array.isArray(signatures) ||
    signatures.length !== policy.operators.length
  )
    throw new Error("Certificate requires every pinned operator");
}

export function combineWitnesses(policy, witnesses, expectedCheckpoint) {
  requireAll(policy, witnesses);
  const checkpoint = checkedCheckpoint(policy, expectedCheckpoint);
  const signatures = Array.from(witnesses, (witness) => {
    const keyId = verifyWitness(policy, witness, checkpoint);
    return { keyId, suite: witness.suite, signature: witness.signature };
  }).sort(byKeyId);
  if (signatures.some((entry, i) => entry.keyId !== policy.operators[i].keyId))
    throw new Error("Duplicate or missing checkpoint witness");
  return { version: 1, policyId: policy.policyId, checkpoint, signatures };
}

export function verifyCertificate(policy, certificate, expectedCheckpoint) {
  fields(certificate, ["version", "policyId", "checkpoint", "signatures"]);
  const checkpoint = matchCheckpoint(policy, certificate, expectedCheckpoint);
  requireAll(policy, certificate.signatures);
  for (const [i, record] of certificate.signatures.entries()) {
    fields(record, signatureFields);
    if (record.keyId !== policy.operators[i].keyId)
      throw new Error(
        "Certificate requires one ordered signature from every pinned operator",
      );
    checkSignature(policy, checkpoint, record);
  }
  return checkpoint;
}
