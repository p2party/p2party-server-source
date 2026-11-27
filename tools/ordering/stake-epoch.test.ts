import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { nodeSigner } from "../../clients/evm/src/node.ts";
import {
  receiveOwner,
  signTransfer,
  transferIds,
  hex,
  type Hex,
  type Unit,
} from "../../clients/evm/src/wire.ts";
import { ledgerConfig, genesisFingerprint } from "../../src/ledger/config.ts";
import { operatorId } from "../checkpoint-crypto.mjs";
import { buildStakeEpoch, signStakeBond } from "./stake-epoch.ts";
import { hasQuorum, hasAnchorSupport } from "./committee.mjs";
import { certifyVertex, vertexId, anchorAuthor, Validator } from "./dag.mjs";
import { collectExecution } from "./execution.mjs";
import { localValidators } from "./test-support.mjs";
import { createOrderedLedger } from "./native-replay.ts";
import { verifyWalletUnit, verifyClaim } from "./wallet-proof.ts";

test("whole-unit bonds select voting power, freeze spending, then allow certified owner exit", async (t) => {
  assert.ok(process.env.P2PARTY_NATIVE_BIN);
  const bin = resolve(process.env.P2PARTY_NATIVE_BIN);
  const dir = mkdtempSync(join(tmpdir(), "p2party-stake-synthetic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chainId = hex(randomBytes(32));
  const keys = Array.from({ length: 4 }, () =>
    generateKeyPairSync("ml-dsa-65"),
  ).sort((a, b) =>
    operatorId(a.publicKey) < operatorId(b.publicKey) ? -1 : 1,
  );
  const publicKeys = keys.map((k) =>
    k.publicKey.export({ type: "spki", format: "pem" }),
  );
  const owners = [2, 4, 1, 1, 2, 8].map((weight) => {
    const key = nodeSigner(generateKeyPairSync("ml-dsa-65").privateKey);
    const nonce = randomBytes(32),
      reclaim = randomBytes(32);
    const unit: Unit = {
      ...receiveOwner(key, nonce),
      id: hex(randomBytes(64)),
      weight: ("0x" + weight.toString(16)) as Hex,
      createdHeight: "0x0",
      spentHeight: null,
    };
    return { key, nonce, reclaim, unit };
  });
  const genesis = join(dir, "genesis.json");
  writeFileSync(
    genesis,
    JSON.stringify({
      version: 1,
      chainId,
      rpcChainId: 123,
      spendSuites: [1],
      receiveSuites: [1],
      units: owners.map(({ unit: { id, weight, suite, commitment } }) => ({
        id,
        suite,
        commitment,
        weight,
      })),
    }),
  );
  const config = ledgerConfig({
    LEDGER_ENABLED: "true",
    LEDGER_CHAIN_ID: chainId,
    LEDGER_GENESIS_FILE: genesis,
    LEDGER_VERIFIER: join(bin, "demos-ledger-verify"),
  })!;
  const network = { chainId, genesisHash: ("0x" + config.genesisHash) as Hex };
  const terms = { epoch: 0, activeThroughRound: 2, exitDelayRounds: 4 };
  const bonds = await Promise.all(
    owners
      .slice(0, 5)
      .map((o, i) =>
        signStakeBond(
          network,
          terms,
          publicKeys[i % 4]!,
          o.unit,
          o.key,
          o.nonce,
          o.reclaim,
        ),
      ),
  );
  const manifest = { ...terms, bonds };
  const epoch = await buildStakeEpoch(config, bin, manifest);
  const { committee } = epoch;
  assert.deepEqual(committee.weights, [4n, 4n, 1n, 1n]);
  assert.equal(committee.totalWeight, 10n);
  assert.equal(
    (
      await buildStakeEpoch(
        config,
        bin,
        { ...manifest, bonds: [...bonds].reverse() },
        epoch.registryId,
      )
    ).registryId,
    epoch.registryId,
  );
  await assert.rejects(
    buildStakeEpoch(config, bin, manifest, hex(randomBytes(64))),
    /pin/,
  );
  await assert.rejects(
    buildStakeEpoch(config, bin, { ...manifest, bonds: [bonds[0]!, ...bonds] }),
    /duplicate/,
  );
  for (const mutation of [
    { epoch: 1 },
    { exitDelayRounds: 2 },
    { activeThroughRound: 4 },
  ])
    await assert.rejects(
      buildStakeEpoch(config, bin, { ...manifest, ...mutation }),
      /authorization/,
    );
  await assert.rejects(
    buildStakeEpoch(config, bin, {
      ...manifest,
      bonds: [
        { ...bonds[0]!, validatorPublicKey: publicKeys[1]! },
        ...bonds.slice(1),
      ],
    }),
    /authorization/,
  );
  await assert.rejects(
    buildStakeEpoch(config, bin, {
      ...manifest,
      bonds: [
        { ...bonds[0]!, nonceHash: hex(randomBytes(64)) },
        ...bonds.slice(1),
      ],
    }),
    /reclaim/i,
  );
  const forged = await signStakeBond(
    network,
    terms,
    publicKeys[0]!,
    { ...owners[0]!.unit, ...receiveOwner(owners[1]!.key, owners[1]!.nonce) },
    owners[1]!.key,
    owners[1]!.nonce,
    randomBytes(32),
  );
  await assert.rejects(
    buildStakeEpoch(config, bin, {
      ...manifest,
      bonds: [forged, ...bonds.slice(1)],
    }),
    /Native replay rejected/,
  );
  for (const change of [
    { rpcChainId: 124 },
    { chainId: hex(randomBytes(32)) },
    { receiveMask: 2 },
  ]) {
    const altered = { ...config, ...change };
    altered.genesisHash = genesisFingerprint(altered);
    await assert.rejects(
      buildStakeEpoch(altered, bin, manifest),
      /authorization|chain|suite/,
    );
  }
  assert.equal(hasQuorum(committee, [0, 1]), true);
  assert.equal(hasQuorum(committee, [0, 2, 3]), false);
  assert.equal(hasAnchorSupport(committee, [1]), true);
  assert.equal(hasAnchorSupport(committee, [2, 3]), false);
  assert.throws(() => hasQuorum(committee, [0, 0]), /distinct/);
  const schedule = Array.from({ length: 10 }, (_, i) =>
    anchorAuthor(committee, 2 * (i + 1)),
  );
  assert.deepEqual(
    keys.map((_, i) => schedule.filter((k) => k === i).length),
    [4, 4, 1, 1],
  );

  const fixture = localValidators(
    committee,
    keys.map((k) => k.privateKey),
  );
  t.after(fixture.close);
  const { validators, round } = fixture;
  const holder = owners[0]!,
    bond = bonds[0]!;
  const unit: Unit = {
    ...holder.unit,
    ...receiveOwner(holder.key, holder.reclaim),
    id: transferIds(bond.wire, chainId).outputId,
  };
  const beneficiary = receiveOwner(holder.key, randomBytes(32));
  const exit = await signTransfer(
    { chainId, input: unit, recipient: beneficiary, expiryHeight: 0n },
    holder.key,
    holder.reclaim,
  );
  const liquid = owners[5]!;
  const transfer = await signTransfer(
    {
      chainId,
      input: liquid.unit,
      recipient: receiveOwner(liquid.key, randomBytes(32)),
      expiryHeight: 0n,
    },
    liquid.key,
    liquid.nonce,
  );
  const all = [0, 1, 2, 3],
    high = [0, 1],
    low = [0, 2, 3];
  const r1 = round(1, {
    authors: all,
    voters: high,
    wires: (i: number) => (i === 0 ? [exit, transfer] : []),
  });
  const proposal = r1[0].proposal;
  assert.throws(
    () =>
      certifyVertex(
        committee,
        proposal,
        low.map((i) => validators[i].acknowledge(proposal)),
      ),
    /quorum/,
  );
  assert.throws(
    () =>
      validators[0].propose(
        2,
        low.map((i) => vertexId(committee, r1[i].proposal.header)),
        [],
      ),
    /parent voting power/,
  );
  const r2 = round(2, { authors: all, voters: high });
  assert.throws(
    () =>
      validators[0].propose(
        3,
        r2.map((p: { proposal: { header: unknown } }) =>
          vertexId(committee, p.proposal.header),
        ),
        [exit],
      ),
    /batch/,
  );
  round(3, { authors: all, voters: high });
  round(4, { authors: all, voters: high });
  const early = validators[0].anchorIds[0];
  const earlyVotes = await Promise.all(
    validators.map((v) => v.attestExecution(early, epoch.replay)),
  );
  assert.throws(
    () =>
      collectExecution(
        committee,
        low.map((i) => earlyVotes[i]),
      ),
    /quorum/,
  );
  const earlyCert = collectExecution(
    committee,
    high.map((i) => earlyVotes[i]),
  );
  await assert.rejects(
    epoch.settle(r2[0].proposal.header, earlyCert, [exit, transfer], [exit]),
    /terminal/,
  );
  await assert.rejects(
    validators[0].attestExecution(
      early,
      createOrderedLedger(config, network, bin).replay,
    ),
    /verified stake epoch replay/,
  );
  const snap = await epoch.snapshot([exit, transfer]);
  assert.equal(snap.roots.height, "0x6");
  const proven = verifyWalletUnit(
    config,
    committee,
    earlyCert.checkpoint,
    earlyCert,
    {
      id: unit.id,
      commitment: unit.commitment,
      suite: unit.suite,
      weight: unit.weight,
    },
    snap.prove(unit.id),
  );
  assert.ok("stakeLock" in proven);
  assert.deepEqual(proven.stakeLock, {
    registryId: epoch.registryId,
    terminalRound: 6,
  });
  // Validator 2 goes offline. It would have authored the round-six leader.
  // Rounds with an available leader still reach finality and permit withdrawal.
  const remaining = [0, 1, 3];
  for (let n = 5; n <= 7; n++) round(n, { authors: remaining, voters: high });
  const r8 = round(8, { authors: remaining, voters: high });
  round(9, { authors: remaining, voters: high });
  const r10 = round(10, { authors: remaining, voters: high });
  const header = r8.find(
    (p: { proposal: { header: { author: number } } }) =>
      p.proposal.header.author === anchorAuthor(committee, 8),
  )!.proposal.header;
  const anchor = vertexId(committee, header);
  const ordered = validators[0].orderedWires(anchor);
  assert.deepEqual(ordered, [exit, transfer]);
  const cert = collectExecution(
    committee,
    await Promise.all(
      high.map((i) => validators[i].attestExecution(anchor, epoch.replay)),
    ),
  );
  const parents = r10.map((p: { proposal: { header: unknown } }) =>
    vertexId(committee, p.proposal.header),
  );
  assert.throws(() => validators[0].propose(11, parents, []), /closed/);
  const retry = await validators[0].attestExecution(anchor, epoch.replay);
  assert.equal(retry.signature, cert.votes[0].signature);
  const restarted = new Validator(
    committee,
    keys[0]!.privateKey,
    fixture.paths[0],
  );
  try {
    assert.throws(() => restarted.propose(11, parents, []), /closed/);
    assert.equal(
      (await restarted.attestExecution(anchor, epoch.replay)).signature,
      retry.signature,
    );
  } finally {
    restarted.close();
  }
  await assert.rejects(
    epoch.settle(header, earlyCert, ordered, [exit]),
    /Unexpected executed/,
  );
  await assert.rejects(
    epoch.settle(header, cert, [], [exit]),
    /Unexpected executed/,
  );
  await assert.rejects(
    epoch.settle(header, cert, ordered, [transfer]),
    /only bonded inputs/,
  );
  const thief = owners[1]!;
  const forgedExit = await signTransfer(
    {
      chainId,
      input: { ...unit, ...receiveOwner(thief.key, thief.nonce) },
      recipient: beneficiary,
      expiryHeight: 0n,
    },
    thief.key,
    thief.nonce,
  );
  assert.deepEqual(
    (await epoch.settle(header, cert, ordered, [forgedExit])).roots,
    snap.roots,
  );
  assert.deepEqual(
    (await epoch.settle(header, cert, ordered, [])).roots,
    snap.roots,
  );
  const released = await epoch.settle(header, cert, ordered, [
    forgedExit,
    exit,
    exit,
  ]);
  assert.equal(released.roots.height, "0x7");
  verifyClaim(
    released.roots.stateRoot,
    "spent",
    unit.id,
    true,
    released.prove(unit.id).spent,
  );
  const withdrawn = transferIds(exit, chainId).outputId;
  const w = released.prove(withdrawn);
  verifyClaim(released.roots.stateRoot, "spent", withdrawn, false, w.spent);
  assert.equal(w.origin, "transfer");
  if (w.origin === "transfer")
    assert.equal(
      Buffer.from(w.wire.slice(2), "hex").readBigUInt64BE(98),
      BigInt(unit.weight),
    );
  // The leader in round six has one unit. Two low-weight parents cannot
  // commit it, while a single four-unit supporter supplies > 1/3 of stake.
  for (const supporters of [[2, 3], [1]]) {
    const experiment = localValidators(
      committee,
      keys.map((k) => k.privateKey),
    );
    try {
      const options = { authors: all, voters: high };
      for (let i = 1; i < 6; i++) experiment.round(i, options);
      const six = experiment.round(6, options);
      const ids = six.map((p: { proposal: { header: unknown } }) =>
        vertexId(committee, p.proposal.header),
      );
      experiment.round(7, {
        ...options,
        parents: (i: number) =>
          supporters.includes(i) ? ids : [ids[0], ids[1]],
      });
      experiment.round(8, options);
      assert.equal(
        experiment.validators[0].anchorIds.includes(ids[2]),
        supporters.length === 1,
      );
    } finally {
      experiment.close();
    }
  }
});
