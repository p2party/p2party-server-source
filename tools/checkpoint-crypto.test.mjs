import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import {
  parsePolicy,
  operatorId,
  signCheckpoint,
  verifyWitness,
  combineWitnesses,
  verifyCertificate,
} from "./checkpoint-crypto.mjs";

const chainId = "0x" + "11".repeat(32);
const genesisHash = "0x" + "22".repeat(32);
const checkpoint = {
  chainId,
  genesisHash,
  height: "0x10",
  historyHash: "0x" + "33".repeat(64),
  logRoot: "0x" + "44".repeat(64),
};
const m = generateKeyPairSync("ml-dsa-65");
const s = generateKeyPairSync("slh-dsa-sha2-192s");
const other = generateKeyPairSync("ml-dsa-65");
const pem = (key) => key.export({ format: "pem", type: "spki" });
const policyInput = {
  version: 1,
  chainId,
  genesisHash,
  operators: [pem(m.publicKey), pem(s.publicKey)],
};
const policy = parsePolicy(policyInput);
const mw = signCheckpoint(policy, checkpoint, m.privateKey);
const sw = signCheckpoint(policy, checkpoint, s.privateKey);
const certificate = combineWitnesses(policy, [sw, mw], checkpoint);
const replaceFirstByte = (value) =>
  "0x" + (value.slice(2, 4) === "00" ? "01" : "00") + value.slice(4);

test("two different pinned signature suites attest the same local prefix", () => {
  for (const [k, w] of [
    [m, mw],
    [s, sw],
  ]) {
    assert.equal(w.keyId, operatorId(k.publicKey));
    assert.equal(w.keyId, operatorId(k.privateKey));
    assert.equal(verifyWitness(policy, w, checkpoint), w.keyId);
    // Independent encoding pins field order, byte order and purpose; each
    // signature verifies directly using only the standard Node crypto API.
    const message = Buffer.concat([
      Buffer.from("p2party/checkpoint/witness/v1\0"),
      Buffer.from(
        [policy.policyId, chainId, genesisHash].map((v) => v.slice(2)).join(""),
        "hex",
      ),
      Buffer.from("0000000000000010", "hex"),
      Buffer.from(
        checkpoint.historyHash.slice(2) + checkpoint.logRoot.slice(2),
        "hex",
      ),
      Buffer.from([w.suite]),
      Buffer.from(w.keyId.slice(2), "hex"),
    ]);
    assert.equal(
      verify(
        null,
        message,
        k.publicKey,
        Buffer.from(w.signature.slice(2), "hex"),
      ),
      true,
    );
  }
  assert.equal((mw.signature.length - 2) / 2, 3309);
  assert.equal((sw.signature.length - 2) / 2, 16224);
  assert.deepEqual(
    verifyCertificate(
      policy,
      JSON.parse(JSON.stringify(certificate)),
      checkpoint,
    ),
    checkpoint,
  );
  assert.deepEqual(combineWitnesses(policy, [mw, sw], checkpoint), certificate);
  assert.equal(
    parsePolicy({
      ...policyInput,
      operators: policyInput.operators.toReversed(),
    }).policyId,
    policy.policyId,
  );
});

test("a mixed four-suite policy binds each new witness to its key, suite and receipt root", () => {
  const lattice = generateKeyPairSync("ml-dsa-87");
  const hash = generateKeyPairSync("slh-dsa-shake-256s");
  const keys = [m, s, lattice, hash];
  const expanded = parsePolicy({
    ...policyInput,
    operators: keys.map((k) => pem(k.publicKey)),
  });
  const witnesses = keys.map((k) =>
    signCheckpoint(expanded, checkpoint, k.privateKey),
  );
  assert.deepEqual(
    witnesses.map((w) => w.suite),
    [1, 2, 3, 4],
  );
  const full = combineWitnesses(expanded, witnesses.toReversed(), checkpoint);
  assert.deepEqual(
    verifyCertificate(expanded, JSON.parse(JSON.stringify(full)), checkpoint),
    checkpoint,
  );
  for (const [i, size] of [
    [2, 4627],
    [3, 29792],
  ]) {
    const witness = witnesses[i];
    assert.equal(witness.keyId, operatorId(keys[i].publicKey));
    assert.equal((witness.signature.length - 2) / 2, size);
    assert.equal(verifyWitness(expanded, witness, checkpoint), witness.keyId);
    assert.throws(() =>
      verifyWitness(
        expanded,
        { ...witness, suite: i === 2 ? 4 : 3 },
        checkpoint,
      ),
    );
    assert.throws(() =>
      verifyWitness(
        expanded,
        { ...witness, signature: replaceFirstByte(witness.signature) },
        checkpoint,
      ),
    );
    assert.throws(() =>
      verifyWitness(expanded, witness, {
        ...checkpoint,
        logRoot: replaceFirstByte(checkpoint.logRoot),
      }),
    );
    assert.throws(() => signCheckpoint(policy, checkpoint, keys[i].privateKey));
    assert.throws(() =>
      combineWitnesses(
        expanded,
        witnesses.filter((w) => w !== witness),
        checkpoint,
      ),
    );
  }
  assert.throws(() => verifyCertificate(policy, full, checkpoint));
  assert.throws(() => verifyCertificate(expanded, certificate, checkpoint));
  assert.deepEqual(
    verifyCertificate(policy, certificate, checkpoint),
    checkpoint,
  );
});

test("operator suites and key encodings cannot be substituted or duplicated", () => {
  const bad = [
    [],
    [pem(m.publicKey)],
    Array(17).fill(pem(m.publicKey)),
    [pem(s.publicKey), pem(s.publicKey).replaceAll("\n", "\r\n")],
    [pem(m.publicKey), pem(generateKeyPairSync("ed25519").publicKey)],
    [pem(m.publicKey), s.privateKey.export({ type: "pkcs8", format: "pem" })],
    [pem(m.publicKey), pem(s.publicKey) + pem(m.publicKey)],
    [pem(m.publicKey), pem(s.publicKey) + "trailing"],
    [
      pem(m.publicKey),
      pem(s.publicKey).replace(
        "-----BEGIN PUBLIC KEY-----",
        "comment\n-----BEGIN PUBLIC KEY-----",
      ),
    ],
  ];
  for (const operators of bad)
    assert.throws(() => parsePolicy({ ...policyInput, operators }));
  assert.throws(() => parsePolicy({ ...policyInput, version: 2 }));
  assert.throws(() => parsePolicy({ ...policyInput, quorum: 1 }));
  assert.equal(
    parsePolicy({
      ...policyInput,
      operators: [pem(m.publicKey), pem(s.publicKey).replaceAll("\n", "\r\n")],
    }).policyId,
    policy.policyId,
  );
  assert.throws(() => signCheckpoint(policy, checkpoint, other.privateKey));
  assert.throws(() => signCheckpoint(policy, checkpoint, m.publicKey));
});

test("checkpoint keys and policy IDs have stable independent public vectors", () => {
  // Ephemeral SLH-DSA public keys only. Extracting the raw SPKI bit strings
  // and hashing the binary domains/tuples with SHA-512 reproduces these IDs.
  const operators = [
    "MEAwCwYJYIZIAWUDBAMWAzEA9P6i1K4wtZtx1trnzGCj1C9D43c1HZ1wgF5Hk32AQYzR5q2kLEDSEEkctjg72fYg",
    "MEAwCwYJYIZIAWUDBAMWAzEAdWnjRolTh1zArnNolydN/2ImFKVduNsTy2OhOFEBF2jeO/HxVBurJOzRWOojjUpE",
  ].map((value) =>
    pem(
      createPublicKey({
        key: Buffer.from(value, "base64"),
        type: "spki",
        format: "der",
      }),
    ),
  );
  const p = parsePolicy({ ...policyInput, operators });
  assert.deepEqual(
    p.operators.map((entry) => entry.keyId),
    [
      "0x68c6ff23aadd5081e01fdb68b0d883741ba213f76b0e4b0792abd7e47b4b9940d5487b08e7b87745c5ed27850fdea1186f425d9f1a7df3f5f0decb209cdb39e8",
      "0x805dd00da27f95c30ec1af9d7de408e8bce2c8cf1475a03261ccf771c4b389d33e13d8afc4369c84bd1f9ac2aa571b7990a058ccf118839116e9ee0f1235ec08",
    ],
  );
  assert.equal(
    p.policyId,
    "0xdd66fc3a56e070972edf8e25ebe3f0d1c0be9d4f741db185e8f449fc74f6943910b5e32087f0f77d6f3da6d5d7bba6f095d308ccce0057816a480dddacfc624b",
  );
});

test("witness tampering and checkpoint substitution fail for both suites", () => {
  for (const witness of [mw, sw]) {
    for (const changed of [
      { version: 2 },
      { keyId: operatorId(other.publicKey) },
      { keyId: witness === mw ? sw.keyId : mw.keyId },
      { suite: witness === mw ? 2 : 1 },
      { policyId: replaceFirstByte(policy.policyId) },
      { signature: replaceFirstByte(witness.signature) },
      { signature: witness.signature + "00" },
      { signature: witness.signature.slice(0, -2) },
      { signature: witness.signature.toUpperCase() },
      { publicKey: pem(other.publicKey) },
      { checkpoint: { ...checkpoint, unknown: true } },
    ])
      assert.throws(() =>
        verifyWitness(policy, { ...witness, ...changed }, checkpoint),
      );
    for (const changed of [
      { chainId: replaceFirstByte(chainId) },
      { genesisHash: replaceFirstByte(genesisHash) },
      { height: "0x11" },
      { historyHash: replaceFirstByte(checkpoint.historyHash) },
      { logRoot: replaceFirstByte(checkpoint.logRoot) },
    ]) {
      const divergent = { ...checkpoint, ...changed };
      assert.throws(() => verifyWitness(policy, witness, divergent));
      assert.throws(() =>
        verifyWitness(policy, { ...witness, checkpoint: divergent }, divergent),
      );
    }
    for (const invalidHeight of [
      "0x01",
      "0X1",
      "0xF",
      "0x8000000000000000",
      "0x1\n",
      1,
      null,
    ])
      assert.throws(() =>
        signCheckpoint(
          policy,
          { ...checkpoint, height: invalidHeight },
          m.privateKey,
        ),
      );
  }
});

test("certificates require every pinned operator in canonical order on one prefix", () => {
  for (const wrong of [[mw], [sw, sw], [mw, sw, mw]])
    assert.throws(() => combineWitnesses(policy, wrong, checkpoint));
  assert.throws(() =>
    combineWitnesses(
      policy,
      [
        mw,
        signCheckpoint(policy, { ...checkpoint, height: "0x0" }, s.privateKey),
      ],
      checkpoint,
    ),
  );
  const [a, b] = certificate.signatures;
  for (const signatures of [
    [],
    [a],
    [b, a],
    [a, a],
    [a, b, b],
    [a, { ...b, signature: replaceFirstByte(b.signature) }],
    [{ ...a, operator: "untrusted" }, b],
  ])
    assert.throws(() =>
      verifyCertificate(policy, { ...certificate, signatures }, checkpoint),
    );
  assert.throws(() =>
    verifyCertificate(policy, { ...certificate, threshold: 1 }, checkpoint),
  );
  assert.throws(() =>
    verifyCertificate(policy, certificate, { ...checkpoint, height: "0x0" }),
  );
  const replacement = parsePolicy({
    ...policyInput,
    operators: [pem(m.publicKey), pem(other.publicKey)],
  });
  assert.throws(() => verifyCertificate(replacement, certificate, checkpoint));
  // A legitimate signer retained in both policies cannot replay its signature
  // across the change of membership, even when the statement is identical.
  assert.throws(() =>
    verifyWitness(
      replacement,
      { ...mw, policyId: replacement.policyId },
      checkpoint,
    ),
  );
});
