// Local fixed-committee experiment; all wire encodings below are versioned.
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { operatorId, parsePolicy } from "../checkpoint-crypto.mjs";
import { signatureSuites } from "../../clients/evm/src/suites.ts";

export function fields(obj, names) {
  if (
    !obj ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    Object.keys(obj).length !== names.length ||
    !names.every((k) => Object.hasOwn(obj, k))
  )
    throw Error("Unexpected document fields");
}
export function fixed(value, size) {
  if (
    typeof value !== "string" ||
    value.length !== 2 + size * 2 ||
    !/^0x[0-9a-f]+$/.test(value)
  )
    throw Error("Invalid fixed-width hex");
  return Buffer.from(value.slice(2), "hex");
}
export const hex = (bytes) => "0x" + bytes.toString("hex");
export function u32(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff || Object.is(n, -0))
    throw Error("Expected a uint32");
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
export function digest(domain, ...parts) {
  const h = createHash("sha512").update(
    "p2party/ordering/" + domain + "/v1\0",
    "ascii",
  );
  for (const p of parts) h.update(p);
  return h.digest();
}
export function makeCommittee(input) {
  fields(input, ["version", "chainId", "genesisHash", "epoch", "operators"]);
  const { epoch, ...descriptor } = input;
  const policy = parsePolicy(descriptor);
  const n = policy.operators.length,
    f = (n - 1) / 3;
  if (!Number.isInteger(f) || f < 1)
    throw Error("Expected 3f+1 pinned operators");
  const committeeId = hex(
    digest(
      "fixed-committee",
      fixed(policy.chainId, 32),
      fixed(policy.genesisHash, 32),
      u32(epoch),
      u32(n),
      ...policy.operators.map((k) =>
        Buffer.concat([u32(k.suite), fixed(k.keyId, 64)]),
      ),
    ),
  );
  return Object.freeze({
    committeeId,
    chainId: policy.chainId,
    genesisHash: policy.genesisHash,
    epoch,
    operators: policy.operators,
    f,
    quorum: n - f,
  });
}
function signatureMessage(committee, domain, subject, index) {
  if (!Number.isInteger(index) || !Object.hasOwn(committee.operators, index))
    throw Error("Unknown voter");
  return digest(
    domain,
    fixed(committee.committeeId, 64),
    fixed(subject, 64),
    u32(index),
  );
}
export function memberIndex(committee, privateKey) {
  if (privateKey?.type !== "private")
    throw Error("Expected validator private key");
  const id = operatorId(createPublicKey(privateKey));
  const i = committee.operators.findIndex((k) => k.keyId === id);
  if (i < 0) throw Error("Key is outside committee");
  return i;
}
export function signSubject(committee, domain, subject, index, key) {
  return hex(
    sign(null, signatureMessage(committee, domain, subject, index), key),
  );
}
export function checkSignature(committee, domain, subject, index, signature) {
  const message = signatureMessage(committee, domain, subject, index);
  const operator = committee.operators[index];
  const size = signatureSuites.find((s) => s.id === operator.suite).signature;
  if (!verify(null, message, operator.publicKey, fixed(signature, size)))
    throw Error("Invalid " + domain + " signature");
}
export function checkVotes(committee, domain, subject, votes) {
  if (
    !Array.isArray(votes) ||
    votes.length < committee.quorum ||
    votes.length > committee.operators.length
  )
    throw Error("Invalid certificate quorum");
  let last = -1;
  for (const item of votes) {
    fields(item, ["voter", "signature"]);
    if (!Number.isInteger(item.voter) || item.voter <= last)
      throw Error("Voters must be distinct and sorted");
    checkSignature(committee, domain, subject, item.voter, item.signature);
    last = item.voter;
  }
}
