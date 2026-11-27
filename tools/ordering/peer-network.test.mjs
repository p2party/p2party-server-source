import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { nodeSigner } from "../../clients/evm/src/node.ts";
import {
  receiveOwner,
  signTransfer,
  transferIds,
} from "../../clients/evm/src/wire.ts";
import { ledgerConfig } from "../../src/ledger/config.ts";
import { operatorId } from "../checkpoint-crypto.mjs";
import { buildStakeEpoch, signStakeBond } from "./stake-epoch.ts";
import { collectExecution } from "./execution.mjs";
import { newChallenge, readFreshTip, verifyFreshTip } from "./fresh-tip.mjs";

test(
  "stake-backed validators recover over loopback and refresh a wallet checkpoint",
  { timeout: 65000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "p2party-peer-"));
    const bin = resolve(process.env.P2PARTY_NATIVE_BIN);
    const peer = resolve(process.env.P2PARTY_PEER_BUNDLE);
    const chainId = "0x" + randomBytes(32).toString("hex");
    const spender = nodeSigner(generateKeyPairSync("ml-dsa-65").privateKey);
    const nonces = Array.from({ length: 3 }, () => randomBytes(32));
    const recipients = nonces.map((n) => receiveOwner(spender, n));
    const unit = {
      ...recipients[0],
      id: "0x" + randomBytes(64).toString("hex"),
      weight: "0x8",
    };
    const first = await signTransfer(
      {
        chainId,
        input: { ...unit, createdHeight: "0x0", spentHeight: null },
        recipient: recipients[1],
        expiryHeight: 0n,
      },
      spender,
      nonces[0],
    );
    const second = await signTransfer(
      {
        chainId,
        input: {
          ...recipients[1],
          id: transferIds(first, chainId).outputId,
          weight: unit.weight,
          createdHeight: "0x5",
          spentHeight: null,
        },
        recipient: recipients[2],
        expiryHeight: 0n,
      },
      spender,
      nonces[1],
    );
    const ops = Array.from({ length: 4 }, () =>
      generateKeyPairSync("ml-dsa-65"),
    ).sort((a, b) =>
      operatorId(a.publicKey).localeCompare(operatorId(b.publicKey)),
    );
    const owners = ops.map((_, i) => {
      const key = nodeSigner(generateKeyPairSync("ml-dsa-65").privateKey);
      const nonce = randomBytes(32);
      const unit = {
        ...receiveOwner(key, nonce),
        id: "0x" + randomBytes(64).toString("hex"),
        weight: i === 3 ? "0x2" : "0x4",
      };
      return { key, nonce, unit, reclaimNonce: randomBytes(32) };
    });
    const genesis = join(dir, "genesis.json");
    const write = (path, data) =>
      writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    write(genesis, {
      version: 1,
      chainId: chainId,
      rpcChainId: 123,
      spendSuites: [1, 2],
      receiveSuites: [1, 2],
      units: [...owners.map((o) => o.unit), unit],
    });
    const source = ledgerConfig({
      LEDGER_ENABLED: "true",
      LEDGER_CHAIN_ID: chainId,
      LEDGER_GENESIS_FILE: genesis,
      LEDGER_VERIFIER: join(bin, "demos-ledger-verify"),
    });
    const network = {
      chainId: chainId,
      genesisHash: "0x" + source.genesisHash,
    };
    const terms = { epoch: 1, activeThroughRound: 4, exitDelayRounds: 4 };
    const bonds = await Promise.all(
      owners.map((o, i) =>
        signStakeBond(
          network,
          terms,
          ops[i].publicKey.export({ format: "pem", type: "spki" }),
          { ...o.unit, createdHeight: "0x0", spentHeight: null },
          o.key,
          o.nonce,
          o.reclaimNonce,
        ),
      ),
    );
    const manifest = { ...terms, bonds };
    const epoch = await buildStakeEpoch(source, bin, manifest);
    const sockets = await Promise.all(
      ops.map(async () => {
        const s = createServer();
        s.listen(0, "127.0.0.1");
        await once(s, "listening");
        return s;
      }),
    );
    const ports = sockets.map((s) => s.address().port);
    await Promise.all(
      sockets.map((s) => new Promise((resolve) => s.close(resolve))),
    );
    const children = new Map(),
      logs = [];
    t.after(async () => {
      await Promise.all([...children.keys()].map(stop));
      rmSync(dir, { recursive: true, force: true });
    });
    function start(i, create, roundLimit = 6) {
      const keyFile = join(dir, i + ".pem");
      if (create)
        writeFileSync(
          keyFile,
          ops[i].privateKey.export({ format: "pem", type: "pkcs8" }),
          { mode: 0o600, flag: "wx" },
        );
      const path = join(dir, i + ".json");
      write(path, {
        manifest,
        registryId: epoch.registryId,
        chainId: chainId,
        genesis,
        nativeBin: bin,
        journal: join(dir, i + ".sqlite"),
        ports,
        roundLimit,
        keyFile,
        create,
        batches: { 1: [first, second] },
      });
      const child = spawn(process.execPath, [peer, path], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.on("data", (b) => {
        logs.push(b.toString().slice(0, 1200));
      });
      children.set(i, child);
    }
    async function stop(i) {
      const child = children.get(i);
      if (!child) return;
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGKILL");
        await ended;
      }
      children.delete(i);
    }
    async function get(i, route, body, signal = AbortSignal.timeout(1500)) {
      const r = await fetch("http://127.0.0.1:" + ports[i] + route, {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      if (!r.ok) throw Error("Peer returned " + r.status);
      return r.json();
    }
    async function until(fn) {
      const end = Date.now() + 17000;
      while (Date.now() < end) {
        for (const c of children.values())
          if (c.exitCode !== null) throw Error(logs.join("\n"));
        try {
          if (await fn()) return;
        } catch {}
        await sleep(80);
      }
      throw Error("Timed out waiting for peers " + logs.join("\n"));
    }
    const read = async (i, nonce, signal) => {
      const tip = await get(i, "/fresh-tip", { nonce }, signal);
      return {
        tip,
        attestation: await get(
          i,
          "/execution/" + tip.checkpoint.anchorId,
          null,
          signal,
        ),
      };
    };
    start(0, true);
    start(1, true);
    await until(
      async () =>
        (await get(0, "/status")).ready && (await get(1, "/status")).ready,
    );
    assert.equal((await get(0, "/inventory")).length, 0);
    await assert.rejects(
      readFreshTip(epoch.committee, read),
      /quorum|timed out/,
    );
    const began = performance.now();
    start(2, true);
    await until(async () =>
      (await Promise.all([0, 1, 2].map((i) => get(i, "/status")))).every(
        (s) => s.anchors.length >= 2,
      ),
    );
    const reached = performance.now();
    const live = await readFreshTip(epoch.committee, read);
    assert.equal(live.pin.round, 4);
    assert.equal(live.pin.checkpoint.height, "0x6");
    const expected = await epoch.replay([first, second]);
    for (const [k, val] of Object.entries(expected))
      assert.equal(live.pin.checkpoint[k], val);
    assert.equal(live.certificate.votes.length, 3);
    // This source still advertises its genuinely certified inventory, but its
    // certificate storage is unavailable. A cold node must keep making progress
    // through the other independent sources while requests to this one time out.
    const slowInventory = await get(0, "/inventory");
    await stop(0);
    let delayedReads = 0;
    const delayed = createHttpServer((req, res) => {
      if (req.url === "/inventory") res.end(JSON.stringify(slowInventory));
      else if (req.url.startsWith("/certificate/")) delayedReads++;
      else {
        res.writeHead(503);
        res.end();
      }
    });
    async function stopDelayed() {
      if (!delayed.listening) return;
      const ended = once(delayed, "close");
      delayed.close();
      delayed.closeAllConnections();
      await ended;
    }
    t.after(stopDelayed);
    delayed.listen(ports[0], "127.0.0.1");
    await once(delayed, "listening");
    start(3, true);
    await until(async () =>
      (await get(3, "/status")).anchors.includes(live.pin.checkpoint.anchorId),
    );
    const caught = performance.now();
    assert.ok(delayedReads >= 1);
    await stopDelayed();
    start(0, false);
    await until(async () => (await get(0, "/status")).ready);
    const anchor = live.pin.checkpoint.anchorId;
    const values = await Promise.all(
      ops.map((_, i) => get(i, "/execution/" + anchor)),
    );
    assert.deepEqual(
      collectExecution(epoch.committee, values).checkpoint,
      live.pin.checkpoint,
    );
    const saved = await readFreshTip(epoch.committee, read, live.pin);
    assert.deepEqual(saved.pin, live.pin);
    const nonce = newChallenge();
    const replies = await Promise.all(
      ops.map((_, i) => get(i, "/fresh-tip", { nonce })),
    );
    assert.throws(
      () =>
        verifyFreshTip(
          epoch.committee,
          newChallenge(),
          replies,
          live.certificate,
          live.pin,
        ),
      /Inconsistent/,
    );
    assert.throws(
      () =>
        verifyFreshTip(
          epoch.committee,
          nonce,
          replies.slice(0, 2),
          live.certificate,
          live.pin,
        ),
      /quorum/,
    );
    assert.throws(
      () =>
        verifyFreshTip(epoch.committee, nonce, replies, live.certificate, {
          ...live.pin,
          round: 6,
        }),
      /conflicts/,
    );
    // A saved, valid certificate cannot be presented as a fresh result if too
    // little stake answers this challenge.
    await Promise.all([stop(2), stop(3)]);
    await assert.rejects(
      readFreshTip(epoch.committee, read, saved.pin),
      /quorum|timed out/,
    );
    // No process has produced round eight yet. Its scheduled leader (3) stays
    // offline. The other three can certify a later leader and close the epoch.
    await Promise.all([stop(0), stop(1)]);
    const available = [0, 1, 2];
    for (const i of available) start(i, false, 12);
    await until(async () =>
      (await Promise.all(available.map((i) => get(i, "/status")))).every(
        (s) => s.epochClosed,
      ),
    );
    const statuses = await Promise.all(available.map((i) => get(i, "/status")));
    const close = statuses[0].closingAnchor;
    assert.ok(close && statuses.every((s) => s.closingAnchor === close));
    const closingCert = collectExecution(
      epoch.committee,
      await Promise.all(available.map((i) => get(i, "/execution/" + close))),
    );
    const terminal = await get(0, "/certificate/" + close);
    assert.equal(terminal.proposal.header.round, 10);
    await assert.rejects(
      readFreshTip(epoch.committee, read, saved.pin),
      /quorum|timed out/,
    );
    const holder = owners[0];
    const exit = await signTransfer(
      {
        chainId,
        input: {
          ...receiveOwner(holder.key, holder.reclaimNonce),
          id: transferIds(bonds[0].wire, chainId).outputId,
          weight: holder.unit.weight,
          createdHeight: "0x1",
          spentHeight: null,
        },
        recipient: receiveOwner(holder.key, randomBytes(32)),
        expiryHeight: 0n,
      },
      holder.key,
      holder.reclaimNonce,
    );
    const settled = await epoch.settle(
      terminal.proposal.header,
      closingCert,
      [first, second],
      [exit],
    );
    assert.equal(settled.roots.height, "0x7");
    await stop(0);
    start(0, false, 12);
    await until(async () => (await get(0, "/status")).epochClosed);
    assert.deepEqual(
      (await get(0, "/execution/" + close)).checkpoint,
      closingCert.checkpoint,
    );
    await assert.rejects(get(0, "/fresh-tip", { nonce: newChallenge() }));
    t.diagnostic(
      "Loopback only, four processes, two committed anchors from third process launch " +
        Math.round(reached - began) +
        " ms, cold retrieval incl. restart setup " +
        Math.round(caught - reached) +
        " ms",
    );
  },
);
