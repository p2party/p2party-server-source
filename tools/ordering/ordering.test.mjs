import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { makeCommittee, signSubject } from "./committee.mjs";
import { CertifiedDag, Validator, certifyVertex, vertexId } from "./dag.mjs";
import {
  attestExecution,
  collectExecution,
  verifyExecutionCertificate,
} from "./execution.mjs";
import { localCommittee } from "./test-support.mjs";

const network = {
  chainId: "0x" + "11".repeat(32),
  genesisHash: "0x" + "22".repeat(32),
};
const zeros = "0x" + "00".repeat(64);
// Ordering-only tests use sized, chain-bound envelopes. Full native transaction
// checks belong to replay and are exercised in the native integration test.
function envelope(n) {
  const b = Buffer.alloc(5505);
  b[0] = 1;
  b[1] = 1;
  b.fill(0x11, 2, 34);
  b.writeUInt32BE(n, 34);
  b[114] = 1;
  b[115] = 1;
  return "0x" + b.toString("hex");
}
function prepared(t) {
  const f = localCommittee(network);
  t.after(() => f.close());
  return f;
}
function shuffled(values, seed) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const k = seed % (i + 1);
    [out[k], out[i]] = [out[i], out[k]];
  }
  return out;
}
function ingestOutOfOrder(dag, messages) {
  let waiting = messages,
    attempts = 0;
  while (waiting.length) {
    const retry = [];
    for (const msg of waiting) {
      try {
        dag.admit(msg);
      } catch (e) {
        if (e.message !== "Missing certified parent") throw e;
        retry.push(msg);
        attempts++;
      }
    }
    if (retry.length === waiting.length)
      throw Error("Certified ancestry unavailable");
    waiting = retry;
  }
  return attempts;
}
test("one missing committee member, shuffled deliveries, deterministic order and atomic retry", (t) => {
  const { committee: c, validators: v, keys, paths, round } = prepared(t);
  const a = envelope(1),
    b = envelope(2),
    d = envelope(3),
    certs = [];
  certs.push(...round(1, { wires: (i) => [[a, b], [d, a], []][i] }));
  for (let r = 2; r <= 6; r++) certs.push(...round(r));
  const anchors = v[0].anchorIds;
  assert.equal(anchors.length, 2);
  assert.deepEqual(v[0].orderedWires(anchors[0]), [a, b, d]);
  for (const seed of [47, 51, 99, 137]) {
    const replica = new CertifiedDag(c);
    const retries = ingestOutOfOrder(
      replica,
      shuffled([...certs, ...certs.slice(-3)], seed),
    );
    assert(retries > 0);
    assert.deepEqual(replica.anchorIds, anchors);
    assert.deepEqual(replica.orderedWires(anchors[1]), [a, b, d]);
  }
  const p = certs[0].proposal,
    ack = v[2].acknowledge(p);
  v[2].close();
  v[2] = new Validator(c, keys[2], paths[2]);
  assert.deepEqual(v[2].acknowledge(p), ack);
  assert.deepEqual(v[2].orderedWires(anchors[0]), [a, b, d]);
  assert.throws(() => new Validator(c, keys[1], paths[2]), /mismatch/);
});
test("quorum binds complete native body, parents, committee and one candidate per slot", (t) => {
  const { committee: c, validators: v, keys, round } = prepared(t);
  const p = v[0].propose(1, [], [envelope(1)]);
  const acks = v.slice(0, 3).map((n) => n.acknowledge(p));
  const cert = certifyVertex(c, p, acks);
  assert.throws(() => certifyVertex(c, p, acks.slice(0, 2)), /quorum/);
  assert.throws(
    () => certifyVertex(c, p, [acks[0], acks[0], acks[1]]),
    /distinct/,
  );
  assert.throws(() => v[0].propose(1, [], [envelope(2)]), /conflicting/);
  const byzantine = { ...p, header: { ...p.header, moves: [] }, wires: [] };
  const wrong = vertexId(c, byzantine.header);
  byzantine.signature = signSubject(c, "proposal", wrong, 0, keys[0]);
  assert.throws(() => v[1].acknowledge(byzantine), /conflicting/);
  assert.throws(() => certifyVertex(c, byzantine, acks), /different vertex/);
  assert.throws(() => v[1].acknowledge({ ...p, wires: [] }), /Incomplete/);
  assert.throws(
    () => v[1].acknowledge({ ...p, wires: [envelope(2)] }),
    /commitment/,
  );
  assert.throws(
    () =>
      v[1].admit({
        ...cert,
        votes: cert.votes.map((vote, i) =>
          i === 0 ? { ...vote, signature: p.signature } : vote,
        ),
      }),
    /signature/,
  );
  const ids = round(1, { wires: (i) => (i === 0 ? [envelope(1)] : []) }).map(
    (k) => vertexId(c, k.proposal.header),
  );
  assert.throws(() => v[1].propose(2, [ids[0], ids[0], ids[1]], []), /unique/);
  assert.throws(() => v[1].propose(2, [ids[0], ids[1]], []), /parent count/);
  assert.throws(() => v[1].propose(3, ids, []), /preceding round/);
  const other = makeCommittee({
    version: 1,
    ...network,
    epoch: 1,
    operators: c.operators.map((k) =>
      k.publicKey.export({ format: "pem", type: "spki" }),
    ),
  });
  assert.throws(() => new CertifiedDag(other).admit(cert), /context/);
});
test("a later decision can recover a linked earlier anchor without direct local evidence", (t) => {
  const { committee: c, round } = prepared(t);
  const all = [0, 1, 2, 3],
    setup = { authors: all, voters: [0, 1, 2] },
    r1 = round(1, { ...setup, wires: (i) => [envelope(i + 1)] });
  const r2 = round(2, setup),
    is = (r) => r.map((cert) => vertexId(c, cert.proposal.header));
  const ids2 = is(r2);
  // Exactly validators 0 and 1 reference anchor 0.
  const r3 = round(3, {
    ...setup,
    parents: (i) => (i < 2 ? ids2.slice(0, 3) : ids2.slice(1)),
  });
  const ids3 = is(r3);
  // Only vertex 0 in round 4 observes both votes. Keep it from the late reader.
  const r4 = round(4, {
    ...setup,
    parents: (i) => (i === 0 ? ids3.slice(0, 3) : ids3.slice(1)),
  });
  const r5 = round(5, { ...setup, parents: () => is(r4).slice(1) });
  const r6 = round(6, { ...setup, parents: () => is(r5).slice(1) });
  const early = new CertifiedDag(c),
    late = new CertifiedDag(c);
  for (const cert of [...r1, ...r2, ...r3, ...r4, ...r5, ...r6])
    early.admit(cert);
  for (const cert of [...r1, ...r2, ...r3, ...r4.slice(1), ...r5])
    late.admit(cert);
  assert.equal(late.anchorIds.length, 0);
  late.admit(r6[0]);
  assert.equal(late.anchorIds.length, 2);
  assert.deepEqual(late.anchorIds, early.anchorIds);
  assert.deepEqual(
    late.orderedWires(late.anchorIds[1]),
    early.orderedWires(early.anchorIds[1]),
  );
  late.admit(r4[0]);
  assert.deepEqual(late.anchorIds, early.anchorIds);
});
test("a later leader skips an unlinked anchor and rotates same-round tie breaks", (t) => {
  const { committee: c, validators: v, round } = prepared(t);
  const all = [0, 1, 2, 3];
  const r1 = round(1, { authors: all });
  const r2 = round(2, { authors: all, wires: (i) => [envelope(20 + i)] });
  const r2WithoutLeader = r2
    .slice(1)
    .map((cert) => vertexId(c, cert.proposal.header));
  const r3 = round(3, {
    authors: all,
    parents: () => r2WithoutLeader,
    wires: (i) => [envelope(30 + i)],
  });
  const r4 = round(4, { authors: all });
  assert.equal(v[0].anchorIds.length, 0);
  const r5 = round(5, { authors: all }),
    r6 = round(6, { authors: all });
  const anchor = vertexId(c, r4[1].proposal.header);
  assert.deepEqual(v[0].anchorIds, [anchor]);
  const wires = [21, 22, 23, 32, 33, 30, 31].map(envelope);
  assert.deepEqual(v[0].orderedWires(anchor), wires);
  const late = new CertifiedDag(c);
  ingestOutOfOrder(
    late,
    shuffled([...r1, ...r2.slice(1), ...r3, ...r4, ...r5, ...r6], 123),
  );
  late.admit(r2[0]);
  assert.deepEqual(late.anchorIds, [anchor]);
  assert.deepEqual(late.orderedWires(anchor), wires);
});
test("storage acknowledgment survives before certification and returns the full payload", (t) => {
  const { committee: c, validators: v, keys, paths } = prepared(t);
  const p = v[0].propose(1, [], [envelope(4)]);
  const id = vertexId(c, p.header),
    a = v[1].acknowledge(p);
  v[1].close();
  v[1] = new Validator(c, keys[1], paths[1]);
  assert.equal(v[1].certificate(id), null);
  assert.equal(v[1].storedProposal(zeros), null);
  const recovered = v[1].storedProposal(id);
  assert.deepEqual(recovered, p);
  const cert = certifyVertex(c, recovered, [
    a,
    v[0].acknowledge(recovered),
    v[2].acknowledge(recovered),
  ]);
  v[1].admit(cert);
  assert.deepEqual(v[1].certificate(id), cert);
});
test("concurrent signers sharing a journal release one storage vote for a slot", async (t) => {
  const { committee: c, validators: v, keys, paths } = prepared(t);
  const p = v[0].propose(1, [], [envelope(4)]),
    other = v[2].propose(1, [], [envelope(5)]);
  const header = { ...other.header, author: 0 };
  const q = {
    header,
    wires: other.wires,
    signature: signSubject(c, "proposal", vertexId(c, header), 0, keys[0]),
  };
  const gate = new SharedArrayBuffer(4);
  function submit(proposal) {
    const program = `
      const {workerData:d,parentPort}=require("node:worker_threads");
      (async()=>{
        const {Validator}=await import(d.dag);
        const {makeCommittee}=await import(d.crypto);
        const v=new Validator(makeCommittee(d.descriptor),d.key,d.path);
        const gate=new Int32Array(d.gate);
        parentPort.postMessage("ready");
        Atomics.wait(gate,0,0);
        try {parentPort.postMessage(v.acknowledge(d.proposal).vertexId);}
        catch(e){parentPort.postMessage(e.message);}
        finally {v.close();}
      })().catch(e=>{throw e});
    `;
    const descriptor = {
      version: 1,
      ...network,
      epoch: c.epoch,
      operators: c.operators.map((k) =>
        k.publicKey.export({ type: "spki", format: "pem" }),
      ),
    };
    const w = new Worker(program, {
      eval: true,
      workerData: {
        dag: new URL("./dag.mjs", import.meta.url).href,
        crypto: new URL("./committee.mjs", import.meta.url).href,
        descriptor,
        key: keys[1],
        path: paths[1],
        gate,
        proposal,
      },
    });
    const ready = new Promise((resolve, reject) => {
      w.once("message", resolve);
      w.once("error", reject);
    });
    const result = new Promise((resolve, reject) => {
      w.on("message", (m) => {
        if (m !== "ready") resolve(m);
      });
      w.once("error", reject);
    });
    t.after(() => w.terminate());
    return { ready, result };
  }
  const workers = [submit(p), submit(q)];
  await Promise.all(workers.map((w) => w.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(workers.map((w) => w.result));
  assert.equal(
    results.filter((m) => m.startsWith("Refusing conflicting vote")).length,
    1,
  );
  const winner = results.find((m) => m.startsWith("0x"));
  assert([vertexId(c, p.header), vertexId(c, q.header)].includes(winner));
  assert.equal(v[1].acknowledge(v[1].storedProposal(winner)).vertexId, winner);
});
test("availability and replayed state have distinct quorum evidence", async (t) => {
  const { committee, validators, round } = prepared(t);
  const [first] = round(1, { wires: (i) => (i === 0 ? [envelope(8)] : []) });
  for (let i = 2; i <= 4; i++) round(i);
  const [anchor] = validators[0].anchorIds;
  // Fake replay only in this signature/namespace test. Production-facing
  // integration must supply an independently initialized native replay.
  const replay = async (wires) => {
    assert.deepEqual(wires, [envelope(8)]);
    return {
      height: "0x1",
      logRoot:
        "0x" + createHash("sha512").update("fixture receipt").digest("hex"),
      stateRoot: zeros,
    };
  };
  const stamps = await Promise.all(
    validators.slice(0, 3).map((v) => attestExecution(v, anchor, replay)),
  );
  const cert = collectExecution(committee, stamps.reverse());
  assert.deepEqual(
    verifyExecutionCertificate(committee, cert.checkpoint, cert),
    cert.checkpoint,
  );
  assert.throws(
    () => collectExecution(committee, stamps.slice(0, 2)),
    /quorum/,
  );
  assert.throws(
    () =>
      verifyExecutionCertificate(
        committee,
        { ...cert.checkpoint, height: "0x0" },
        cert,
      ),
    /Unexpected/,
  );
  assert.throws(
    () =>
      verifyExecutionCertificate(committee, cert.checkpoint, {
        ...cert,
        votes: first.votes,
      }),
    /signature/,
  );
  await assert.rejects(
    attestExecution(validators[0], zeros, replay),
    /not committed/,
  );
  await assert.rejects(
    attestExecution(validators[0], anchor, async (ws) => ({
      ...(await replay(ws)),
      stateRoot: "0x" + "45".repeat(64),
    })),
    /conflicting/,
  );
});
