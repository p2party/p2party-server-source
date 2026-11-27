import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserProvider, JsonRpcProvider, Wallet } from "ethers";
import { createPublicClient, http } from "viem";
import {
  createLedgerTransport,
  readHandle,
  receiveOwner,
  signTransfer,
  transferIds,
} from "../dist/index.js";
import { nodeSigner } from "../dist/node.js";

const [bun, serverRoot, policy] = process.argv.slice(2),
  chainId = `0x${randomBytes(32).toString("hex")}`,
  rpcChainId = 8123;
assert(["original", "expanded"].includes(policy));
const suites = policy === "expanded" ? [1, 2, 3, 4] : [1, 2];
function wallet(algorithm) {
  const signer = nodeSigner(generateKeyPairSync(algorithm).privateKey),
    nonce = randomBytes(32);
  return { signer, nonce, owner: receiveOwner(signer, nonce) };
}
const a = wallet("ml-dsa-65"),
  b = wallet("slh-dsa-sha2-192s"),
  c = wallet("ml-dsa-65");
const id = `0x${randomBytes(64).toString("hex")}`;
const dir = await mkdtemp(join(tmpdir(), "ledger-clients-"));
const genesisFile = join(dir, "public-genesis.json");
const locator = createServer();
await new Promise((resolve) => locator.listen(0, "127.0.0.1", resolve));
const { port } = locator.address();
await new Promise((resolve) => locator.close(resolve));
assert(port > 5000);
const url = `http://127.0.0.1:${port}`;
let worker, exited;
try {
  await writeFile(
    genesisFile,
    JSON.stringify({
      version: 1,
      chainId,
      rpcChainId,
      spendSuites: suites,
      receiveSuites: suites,
      units: [{ id, weight: "0x8", ...a.owner }],
    }),
  );
  worker = spawn(bun, ["--no-env-file", "run", "src/index.ts"], {
    cwd: serverRoot,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: process.env.DATABASE_URL,
      LEDGER_VERIFIER: process.env.LEDGER_VERIFIER,
      LEDGER_CHAIN_ID: chainId,
      LEDGER_GENESIS_FILE: genesisFile,
      LEDGER_ENABLED: "true",
      PORT: String(port),
      SIGNALING_HOST: `127.0.0.1:${port}`,
      SIGNALING_BIND_HOST: "127.0.0.1",
    },
    stdio: "ignore",
  });
  exited = new Promise((resolve) => worker.once("exit", resolve));
  let ready = false;
  for (let i = 0; i < 160; i++) {
    if (worker.exitCode !== null) throw new Error("Validator exited");
    try {
      if ((await fetch(url + "/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(50);
  }
  assert(ready, "Validator must be listening");
  const opts = { url: url + "/rpc", chainId, rpcChainId };
  const ethers = new JsonRpcProvider(opts.url, undefined, { cacheTimeout: -1 });
  const viem = createPublicClient({
    transport: http(opts.url, { retryCount: 0 }),
    cacheTime: 0,
  });
  const [sender, intermediate, recipient] = [a, b, c].map(({ owner }) =>
    readHandle(owner),
  );
  const bothBalances = async (address, want) => {
    assert.equal(await ethers.getBalance(address), want);
    assert.equal(await viem.getBalance({ address }), want);
  };
  assert.equal((await ethers.getNetwork()).chainId, 8123n);
  assert.equal(await viem.getChainId(), 8123);
  assert.equal(await ethers.getBlockNumber(), 0);
  assert.equal(await viem.getBlockNumber(), 0n);
  await bothBalances(sender, 8n);
  await bothBalances(intermediate, 0n);
  const unknown = `0x${"24".repeat(20)}`;
  await bothBalances(unknown, 0n);
  assert.deepEqual(
    await Promise.all([
      ethers.getBalance(sender),
      ethers.getBalance(unknown),
      ethers.getBlockNumber(),
    ]),
    [8n, 0n, 0],
  );
  const input = await ethers.send("demos_getUnit", [id]);
  assert.deepEqual(
    (
      await viem.request({
        method: "demos_listUnspent",
        params: [a.owner.suite, a.owner.commitment, 1],
      })
    )[0],
    input,
  );
  const wire = await signTransfer(
    { chainId, input, recipient: b.owner, expiryHeight: 1n },
    a.signer,
    a.nonce,
  );
  const damaged = wire.slice(0, -2) + (wire.endsWith("ab") ? "bc" : "ab");
  await assert.rejects(
    viem.request({ method: "demos_sendRawTransfer", params: [damaged] }),
  );
  const classical = await Wallet.createRandom().signTransaction({
    chainId: 8123,
    to: recipient,
    value: 1n,
    nonce: 0,
    gasLimit: 21000n,
    gasPrice: 0n,
  });
  await assert.rejects(ethers.broadcastTransaction(classical));
  await assert.rejects(
    viem.request({
      method: "eth_sendTransaction",
      params: [{ from: sender, to: recipient, value: "0x8" }],
    }),
  );
  assert.equal(await viem.getBlockNumber(), 0n);
  const move = await ethers.send("demos_sendRawTransfer", [wire]);
  assert.equal(move, transferIds(wire, chainId).id);
  assert.equal(
    await viem.request({ method: "demos_sendRawTransfer", params: [wire] }),
    move,
  );
  const receipt = await viem.request({
    method: "demos_getTransfer",
    params: [move],
  });
  assert.equal(receipt.height, "0x1");
  assert.equal(receipt.wire, wire);
  assert.equal(receipt.inputId, id);
  assert.deepEqual(
    await ethers.send("demos_getTransferByHeight", ["0x1"]),
    receipt,
  );
  await bothBalances(sender, 0n);
  await bothBalances(intermediate, 8n);
  assert.equal(await ethers.getBalance(sender, 0), 8n);
  assert.equal(await viem.getBalance({ address: sender, blockNumber: 0n }), 8n);
  const secondInput = await viem.request({
    method: "demos_getUnit",
    params: [receipt.outputId],
  });
  const again = await signTransfer(
    { chainId, input: secondInput, recipient: a.owner, expiryHeight: 0n },
    b.signer,
    b.nonce,
  );
  await assert.rejects(ethers.send("demos_sendRawTransfer", [again]));
  const second = await signTransfer(
    { chainId, input: secondInput, recipient: c.owner, expiryHeight: 0n },
    b.signer,
    b.nonce,
  );
  const secondMove = await viem.request({
    method: "demos_sendRawTransfer",
    params: [second],
  });
  assert.equal(
    await ethers.send("demos_sendRawTransfer", [second]),
    secondMove,
  );
  const fresh = await createLedgerTransport(opts),
    newlyConnected = new BrowserProvider(fresh, undefined, {
      cacheTimeout: -1,
    });

  assert.equal(await newlyConnected.getBalance(sender, 0), 8n);
  const persisted = await newlyConnected.send("demos_getTransfer", [
    secondMove,
  ]);
  assert.equal(persisted.height, "0x2");
  assert.equal(persisted.wire, second);
  assert.equal(persisted.inputId, receipt.outputId);
  assert.equal(await ethers.getBlockNumber(), 2);
  assert.equal(await viem.getBlockNumber(), 2n);
  await bothBalances(intermediate, 0n);
  await bothBalances(recipient, 8n);
  await assert.rejects(ethers.getBalance(sender, 3));
  await assert.rejects(
    createLedgerTransport({ ...opts, chainId: "0x" + "ff".repeat(32) }),
    /identity/,
  );
  await assert.rejects(
    createLedgerTransport({ ...opts, rpcChainId: 8124 }),
    /identity/,
  );
  const level5Lattice = wallet("ml-dsa-87");
  const level5Hash = wallet("slh-dsa-shake-256s");
  assert.equal(level5Lattice.owner.suite, 3);
  assert.equal(level5Hash.owner.suite, 4);
  let unit = await ethers.send("demos_getUnit", [persisted.outputId]);

  if (policy === "original") {
    for (const destination of [level5Lattice, level5Hash]) {
      const disallowed = await signTransfer(
        {
          chainId,
          input: unit,
          recipient: destination.owner,
          expiryHeight: 0n,
        },
        c.signer,
        c.nonce,
      );
      const { id: disallowedId } = transferIds(disallowed, chainId);
      await assert.rejects(
        viem.request({ method: "demos_sendRawTransfer", params: [disallowed] }),
      );
      assert.equal(
        await ethers.send("demos_getTransfer", [disallowedId]),
        null,
      );
    }
    assert.equal(await ethers.getBlockNumber(), 2);
    await bothBalances(recipient, 8n);
  } else {
    const moves = [
      { from: c, to: level5Lattice, height: 3, length: 5505, client: "ethers" },
      {
        from: level5Lattice,
        to: level5Hash,
        height: 4,
        length: 7463,
        client: "ethers",
      },
      {
        from: level5Hash,
        to: wallet("ml-dsa-87"),
        height: 5,
        length: 30100,
        client: "viem",
      },
    ];
    for (const { from, to, height, length, client } of moves) {
      const signed = await signTransfer(
        {
          chainId,
          input: unit,
          recipient: to.owner,
          expiryHeight: BigInt(height),
        },
        from.signer,
        from.nonce,
      );
      assert.equal((signed.length - 2) / 2, length);
      const ids = transferIds(signed, chainId);
      if (from.owner.suite >= 3) {
        const corrupt =
          signed.slice(0, -2) + (signed.endsWith("00") ? "01" : "00");
        await assert.rejects(ethers.send("demos_sendRawTransfer", [corrupt]));
        assert.equal(await viem.getBlockNumber(), BigInt(height - 1));
      }
      const sendEthers = () => ethers.send("demos_sendRawTransfer", [signed]);
      const sendViem = () =>
        viem.request({ method: "demos_sendRawTransfer", params: [signed] });
      const [submit, retry] =
        client === "ethers" ? [sendEthers, sendViem] : [sendViem, sendEthers];
      assert.equal(await submit(), ids.id);
      assert.equal(await retry(), ids.id);
      const actual = await newlyConnected.send("demos_getTransfer", [ids.id]);
      assert.deepEqual(actual, {
        ...ids,
        height: "0x" + height.toString(16),
        wire: signed,
      });
      assert.deepEqual(
        await viem.request({
          method: "demos_getTransferByHeight",
          params: [actual.height],
        }),
        actual,
      );
      const source = readHandle(from.owner),
        destination = readHandle(to.owner);
      assert.equal(await ethers.getBalance(source, height - 1), 8n);
      assert.equal(
        await viem.getBalance({
          address: destination,
          blockNumber: BigInt(height - 1),
        }),
        0n,
      );
      await bothBalances(source, 0n);
      await bothBalances(destination, 8n);
      unit = await ethers.send("demos_getUnit", [ids.outputId]);
      assert.deepEqual(unit, {
        id: ids.outputId,
        weight: "0x8",
        ...to.owner,
        createdHeight: actual.height,
        spentHeight: null,
      });
    }
    assert.equal(await ethers.getBlockNumber(), 5);
    assert.equal(await viem.getBlockNumber(), 5n);
    assert.equal(
      await viem.getBalance({ address: sender, blockNumber: 0n }),
      8n,
    );
  }
  ethers.destroy();
  newlyConnected.destroy();
  console.log(
    `Both clients verified native IDs, receipts, historical balances and retries with the ${policy} signature policy.`,
  );
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await exited;
  }
  await rm(dir, { recursive: true, force: true });
}
