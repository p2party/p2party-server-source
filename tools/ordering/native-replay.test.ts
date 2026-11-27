import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { transferIds, type Hex } from "../../clients/evm/src/wire.ts";
import { ledgerConfig } from "../../src/ledger/config.ts";
import { attestExecution, collectExecution } from "./execution.mjs";
import { localCommittee } from "./test-support.mjs";
import { createOrderedLedger } from "./native-replay.ts";
import { verifyWalletUnit } from "./wallet-proof.ts";

test("three local validators replay native conflicts and certify independently verifiable wallet proofs", async (t) => {
  const env = process.env.P2PARTY_NATIVE_BIN;
  assert.ok(
    env,
    "Set P2PARTY_NATIVE_BIN to the built libdemos ledger directory",
  );
  const bin = resolve(env);
  const f = JSON.parse(
    execFileSync(join(bin, "demos-ledger-fixture"), { encoding: "utf8" }),
  );
  const dir = mkdtempSync(join(tmpdir(), "p2party-replay-genesis-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const genesis = join(dir, "genesis.json");
  const g = {
    id: f.inputId,
    suite: 1,
    weight: "0x8",
    commitment: f.commitment,
  };
  const ceiling = {
    id: f.ceilingId,
    suite: 1,
    weight: "0x8000000000000000",
    commitment: f.ceilingCommitment,
  };
  writeFileSync(
    genesis,
    JSON.stringify({
      version: 1,
      chainId: f.chainId,
      rpcChainId: 123,
      spendSuites: [1, 2],
      receiveSuites: [1, 2],
      units: [g, ceiling],
    }),
  );
  const config = ledgerConfig({
    LEDGER_ENABLED: "true",
    LEDGER_CHAIN_ID: f.chainId,
    LEDGER_GENESIS_FILE: genesis,
    LEDGER_VERIFIER: join(bin, "demos-ledger-verify"),
  })!;
  const network = {
    chainId: config.chainId,
    genesisHash: "0x" + config.genesisHash,
  };
  const { committee, validators, close, round } = localCommittee(network);
  t.after(close);
  assert.throws(
    () =>
      createOrderedLedger(
        config,
        { ...committee, genesisHash: "0x" + "ff".repeat(32) },
        bin,
      ),
    /genesis/,
  );
  // Every callback starts from genesis; each validator has its own complete replay.
  const ledgers = validators.map(() =>
    createOrderedLedger(config, committee, bin),
  );
  const invalidSig =
    f.first.slice(0, -2) + (f.first.endsWith("aa") ? "bb" : "aa");
  // Source opening, expiry and owner uniqueness are meaningful only after
  // ordering. Exact duplicates can also arrive through different DAG vertices.
  const proposed = [invalidSig, f.first, f.alternate, f.reuse, f.second];
  round(1, {
    wires: (i: number) => (i === 0 ? proposed : i === 1 ? [f.first] : []),
  });
  round(2);
  round(3, { wires: (i: number) => (i === 0 ? [f.ceilingFirst] : []) });
  round(4);
  const anchor = validators[0]!.anchorIds[0];
  assert.ok(anchor);
  const ordered = validators[0]!.orderedWires(anchor);
  assert.deepEqual(ordered, proposed);
  const signed = await Promise.all(
    validators
      .slice(0, 3)
      .map((v, i) => attestExecution(v, anchor, ledgers[i]!.replay)),
  );
  const cert = collectExecution(committee, signed);
  const snapshot = await ledgers[3]!.snapshot(ordered);
  const pin = {
    ...network,
    committeeId: committee.committeeId,
    anchorId: anchor,
    ...snapshot.roots,
  };
  assert.deepEqual(cert.checkpoint, pin);
  assert.equal(pin.height, "0x2");
  const two = [f.first, f.second];
  assert.deepEqual(
    await ledgers[0]!.replay([...two, f.first, f.alternate, f.reuse]),
    snapshot.roots,
  );
  assert.deepEqual(
    await ledgers[0]!.replay([f.second, f.first, f.second]),
    await ledgers[0]!.replay([f.first]),
  );
  // The first wire expires at height 1. Consuming a different unit at height 1
  // leaves it expired even though its input still exists and is unspent.
  assert.deepEqual(
    await ledgers[0]!.replay([f.ceilingFirst, f.first]),
    await ledgers[0]!.replay([f.ceilingFirst]),
  );
  const receiptRoot = execFileSync(join(bin, "demos-ledger-log"), ["root"], {
    input: two.map((w) => transferIds(w, f.chainId).id + "\n").join(""),
    encoding: "utf8",
  }).trim();
  assert.equal(pin.logRoot, receiptRoot);
  const first = transferIds(f.first, f.chainId),
    last = transferIds(f.second, f.chainId);
  function recipient(wire: Hex) {
    const raw = Buffer.from(wire.slice(2), "hex");
    return {
      suite: raw[115]!,
      commitment: "0x" + raw.subarray(116, 180).toString("hex"),
    };
  }
  const output = { id: last.outputId, ...recipient(f.second) };
  const proof = snapshot.prove(output.id);
  assert.equal(proof.origin, "transfer");
  if (proof.origin !== "transfer") throw new Error("Missing derived witness");
  assert.deepEqual(
    verifyWalletUnit(config, committee, pin, cert, output, proof),
    {
      ...output,
      weight: g.weight,
      createdHeight: "0x2",
      spentHeight: null,
    },
  );
  const verify = (p: typeof proof) =>
    verifyWalletUnit(config, committee, pin, cert, output, p);
  assert.throws(() => verify({ ...proof, index: "0x0" }), /receipt/i);
  assert.throws(
    () => verify({ ...proof, inclusion: [...proof.inclusion, pin.stateRoot] }),
    /receipt/i,
  );
  assert.throws(() => verify({ ...proof, wire: f.first }));
  assert.throws(() => verify({ ...proof, move: proof.owner }), /state claim/i);
  assert.throws(
    () => verify({ ...proof, spent: proof.spent + "00" }),
    /state claim/i,
  );
  assert.throws(
    () =>
      verifyWalletUnit(
        config,
        committee,
        pin,
        cert,
        { ...output, commitment: f.commitment },
        proof,
      ),
    /requested/,
  );
  assert.throws(
    () =>
      verifyWalletUnit(
        config,
        committee,
        pin,
        cert,
        { ...output, suite: 2 },
        proof,
      ),
    /requested/,
  );
  assert.throws(
    () =>
      verifyWalletUnit(config, committee, pin, cert, g, snapshot.prove(g.id)),
    /state claim/i,
  );
  assert.throws(
    () =>
      verifyWalletUnit(
        config,
        committee,
        pin,
        cert,
        { id: first.outputId, ...recipient(f.first) },
        snapshot.prove(first.outputId),
      ),
    /state claim/i,
  );
  assert.deepEqual(
    verifyWalletUnit(
      config,
      committee,
      pin,
      cert,
      ceiling,
      snapshot.prove(ceiling.id),
    ),
    { ...ceiling, createdHeight: "0x0", spentHeight: null },
  );
  const genesisWitness = snapshot.prove(ceiling.id);
  assert.throws(
    () =>
      verifyWalletUnit(config, committee, pin, cert, output, genesisWitness),
    /absent.*genesis/i,
  );
  assert.throws(
    () =>
      verifyWalletUnit(
        { ...config, chainId: "0x" + "aa".repeat(32) },
        committee,
        pin,
        cert,
        output,
        proof,
      ),
    /genesis/,
  );
  for (const change of [
    { stateRoot: pin.logRoot },
    { logRoot: pin.stateRoot },
    { height: "0x0" },
    { anchorId: pin.stateRoot },
    { chainId: "0x" + "aa".repeat(32) },
  ])
    assert.throws(() =>
      verifyWalletUnit(
        config,
        committee,
        { ...pin, ...change },
        cert,
        output,
        proof,
      ),
    );
  const earlier = await ledgers[0]!.snapshot([f.first]);
  assert.throws(() =>
    verifyWalletUnit(
      config,
      committee,
      pin,
      cert,
      { id: first.outputId, ...recipient(f.first) },
      earlier.prove(first.outputId),
    ),
  );
  // The next anchor includes a third receipt, forming an uneven history tree.
  // The wallet advancing its pin must reject the older genuine certificate.
  round(5);
  round(6);
  const nextAnchor = validators[0]!.anchorIds[1]!;
  const nextSigned = await Promise.all(
    validators
      .slice(0, 3)
      .map((v, i) => attestExecution(v, nextAnchor, ledgers[i]!.replay)),
  );
  const nextCert = collectExecution(committee, nextSigned);
  const next = await ledgers[3]!.snapshot(
    validators[3]!.orderedWires(nextAnchor),
  );
  const nextPin = { ...pin, ...next.roots, anchorId: nextAnchor };
  assert.equal(nextPin.height, "0x3");
  const third = {
    id: transferIds(f.ceilingFirst, f.chainId).outputId,
    ...recipient(f.ceilingFirst),
  };
  for (const [unit, height] of [
    [output, "0x2"],
    [third, "0x3"],
  ] as const)
    assert.equal(
      verifyWalletUnit(
        config,
        committee,
        nextPin,
        nextCert,
        unit,
        next.prove(unit.id),
      ).createdHeight,
      height,
    );
  assert.throws(
    () => verifyWalletUnit(config, committee, nextPin, cert, output, proof),
    /unexpected executed state/i,
  );
  assert.throws(
    () => verifyWalletUnit(config, committee, nextPin, nextCert, output, proof),
    /receipt/i,
  );
  // A missing native verifier is a local fault. It can never count as a
  // deterministic invalid transaction and produce a signed empty checkpoint.
  const broken = createOrderedLedger(
    { ...config, verifier: join(dir, "missing") },
    committee,
    bin,
  );
  await assert.rejects(
    attestExecution(validators[3]!, anchor, broken.replay),
    /unavailable/,
  );
});
