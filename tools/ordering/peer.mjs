// Bounded loopback experiment. Each process has its own signing journal and
// learns certified data from other peers before executing it against genesis.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { ledgerConfig } from "../../src/ledger/config.ts";
import { checkSignature, hasQuorum, memberIndex } from "./committee.mjs";
import { certifyVertex, Validator, vertexId } from "./dag.mjs";
import { buildStakeEpoch } from "./stake-epoch.ts";
import { signTip } from "./fresh-tip.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const bin = resolve(config.nativeBin);
const genesis = ledgerConfig({
  LEDGER_ENABLED: "true",
  LEDGER_GENESIS_FILE: config.genesis,
  LEDGER_CHAIN_ID: config.chainId,
  LEDGER_VERIFIER: join(bin, "demos-ledger-verify"),
});
if (!/^0x[0-9a-f]{128}$/.test(config.registryId))
  throw Error("Expected pinned stake registry");
const ledger = await buildStakeEpoch(
  genesis,
  bin,
  config.manifest,
  config.registryId,
);
const committee = ledger.committee;
const key = createPrivateKey(readFileSync(config.keyFile));
const index = memberIndex(committee, key);
const { ports, roundLimit } = config;
if (
  ports.length !== committee.operators.length ||
  new Set(ports).size !== ports.length ||
  !ports.every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535) ||
  !Number.isInteger(roundLimit) ||
  roundLimit < 4 ||
  roundLimit > 32
)
  throw Error("Invalid local peer configuration");
const origin = (i) => "http://127.0.0.1:" + ports[i];
const peers = ports.map((_, i) => i).filter((i) => i !== index);
const maxBytes = 2 * 1024 * 1024;
const idPattern = /^0x[0-9a-f]{128}$/;
const v = new Validator(committee, key, config.journal, {
  create: config.create === true,
});
const known = new Map(v.certificateIndex().map((row) => [row.id, row]));
const attestations = new Map();
const shutdown = new AbortController();
const firstClosingAnchor = () =>
  v.anchorIds.find((id) => known.get(id).round >= committee.terminalRound);
let stopping = false,
  ready = false;

async function json(stream) {
  const chunks = [];
  let n = 0;
  for await (const b of stream) {
    n += b.length;
    if (n > maxBytes) throw Error("Message too large");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function request(i, route, data, signal = shutdown.signal) {
  const res = await fetch(origin(i) + route, {
    method: data ? "POST" : "GET",
    body: data ? JSON.stringify(data) : undefined,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw Error("Peer unavailable");
  }
  return json(Readable.fromWeb(res.body));
}
function add(cert) {
  const { round, author } = cert.proposal.header;
  if (round > roundLimit) throw Error("Outside local run");
  const id = v.admit(cert);
  known.set(id, { id, round, author });
}
async function route(req) {
  if (req.headers.host !== "127.0.0.1:" + ports[index] || req.headers.origin)
    throw Error("Loopback peer required");
  if (req.method === "POST" && req.url === "/availability") {
    const p = await json(req);
    if (p.header.round > roundLimit) throw Error("Outside local run");
    return v.acknowledge(p);
  }
  if (req.method === "POST" && req.url === "/fresh-tip") {
    const { nonce } = await json(req);
    if (!/^0x[0-9a-f]{64}$/.test(nonce))
      throw Error("Expected a fresh 32-byte challenge");
    if (v.epochClosed || firstClosingAnchor())
      throw Error("Stake epoch is closing");
    const anchor = v.anchorIds.at(-1);
    if (!anchor) throw Error("Waiting for a committed anchor");
    const { checkpoint } = await execution(anchor);
    if (v.epochClosed || firstClosingAnchor() || v.anchorIds.at(-1) !== anchor)
      throw Error("Epoch closed or anchor advanced during replay");
    return signTip(
      committee,
      key,
      index,
      nonce,
      known.get(anchor).round,
      checkpoint,
    );
  }
  if (req.method !== "GET") throw Error("Unsupported method");
  if (req.url === "/inventory") return [...known.values()];
  if (req.url === "/status")
    return {
      index,
      anchors: v.anchorIds,
      ready,
      epochClosed: v.epochClosed,
      closingAnchor: firstClosingAnchor() ?? null,
    };
  const [, action, id, extra] = req.url.split("/");
  if (extra !== undefined || !idPattern.test(id)) throw Error("Unknown path");
  if (action === "certificate") return v.certificate(id);
  if (action === "execution" && v.anchorIds.includes(id)) return execution(id);
  throw Error("Unknown anchor or request");
}
function execution(id) {
  if (!attestations.has(id)) {
    const result = v.attestExecution(id, ledger.replay).catch((error) => {
      attestations.delete(id);
      throw error;
    });
    attestations.set(id, result);
  }
  return attestations.get(id);
}
const server = createServer(
  { requestTimeout: 5000, headersTimeout: 4000 },
  async (req, res) => {
    try {
      const result = await route(req);
      res.writeHead(result === null ? 404 : 200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(400);
      res.end();
    }
  },
);
server.maxConnections = 64;
server.listen(ports[index], "127.0.0.1");
// Each source gets its own two certificate fetches. A slow source can only
// consume its own slots. It cannot delay another poller or the voting loop.
async function syncPeer(i) {
  while (!stopping) {
    try {
      const inventory = await request(i, "/inventory");
      if (
        !Array.isArray(inventory) ||
        inventory.length > ports.length * roundLimit
      )
        throw Error("Invalid inventory");
      const candidates = new Map();
      for (const row of inventory) {
        if (
          row &&
          typeof row.id === "string" &&
          idPattern.test(row.id) &&
          !known.has(row.id) &&
          Number.isInteger(row.round) &&
          row.round >= 1 &&
          row.round <= roundLimit &&
          Number.isInteger(row.author) &&
          row.author >= 0 &&
          row.author < ports.length
        )
          candidates.set(row.id, row);
      }
      // Admit preceding rounds first. Verified data from another source
      // may have filled a slot while these two requests were in flight.
      const batch = [...candidates.values()]
        .sort((a, b) => a.round - b.round)
        .slice(0, 2);
      const results = await Promise.allSettled(
        batch.map((row) => request(i, "/certificate/" + row.id)),
      );
      results.forEach((result, pos) => {
        if (stopping || result.status !== "fulfilled") return;
        const row = batch[pos];
        if (known.has(row.id)) return;
        try {
          const cert = result.value,
            header = cert.proposal.header;
          if (
            header.round === row.round &&
            header.author === row.author &&
            vertexId(committee, header) === row.id
          )
            add(cert);
        } catch {
          /* Retry missing parents with this or a different source. */
        }
      });
    } catch {
      /* An unavailable source is retried on its own poller. */
    }
    if (!stopping) await sleep(70);
  }
}

// Finish as soon as the signed votes suffice. Cancel slow requests at quorum
// and stop at the request deadline when the available weight is insufficient.
async function collectAvailability(proposal, id) {
  const votes = [v.acknowledge(proposal)];
  const enough = () =>
    hasQuorum(
      committee,
      votes.map((vote) => vote.voter),
    );
  if (enough()) return votes;
  const done = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, done.signal]);
  let finished = false;
  return new Promise((resolve) => {
    let pending = peers.length;
    for (const i of peers) {
      (async () => {
        try {
          const vote = await request(i, "/availability", proposal, signal);
          if (finished || vote.voter !== i || vote.vertexId !== id) return;
          checkSignature(committee, "available", id, i, vote.signature);
          votes.push(vote);
        } catch {
          /* Unavailable or unauthenticated peers add no weight. */
        } finally {
          pending--;
          if (!finished && (enough() || pending === 0)) {
            finished = true;
            done.abort();
            resolve(votes);
          }
        }
      })();
    }
  });
}
async function advance() {
  const rows = [...known.values()];
  for (let round = 1; round <= roundLimit; round++) {
    if (rows.some((r) => r.round === round && r.author === index)) continue;
    const prior = rows.filter((r) => r.round === round - 1);
    if (
      round > 1 &&
      !hasQuorum(
        committee,
        prior.map((r) => r.author),
      )
    )
      return;
    const parents = prior.map((r) => r.id);
    const p =
      v.ownProposal(round) ??
      v.propose(round, parents, config.batches[round] ?? []);
    const id = vertexId(committee, p.header);
    const votes = await collectAvailability(p, id);
    if (
      !stopping &&
      !v.epochClosed &&
      hasQuorum(
        committee,
        votes.map((a) => a.voter),
      )
    )
      add(certifyVertex(committee, p, votes));
    return;
  }
}
const drained = new Promise((resolve) => server.once("close", resolve));
process.once("SIGTERM", () => {
  stopping = true;
  shutdown.abort();
  server.close();
});
const pollers = peers.map(syncPeer);
while (!stopping) {
  if (!v.epochClosed) {
    const closing = firstClosingAnchor();
    if (closing) await execution(closing);
    else await advance();
  }
  ready = true;
  if (!stopping) await sleep(70);
}
await Promise.all(pollers);
await drained;
v.close();
