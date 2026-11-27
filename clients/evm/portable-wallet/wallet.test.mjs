import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { assertVerified, verifyNative } from "./native-test-helpers.mjs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactEncrypt, compactDecrypt } from "jose";
import { receiveOwner } from "@p2party/ledger-client";
import { nodeSigner } from "@p2party/ledger-client/node";
import { Wallet, CHAIN, GENESIS, PROOF_CHAIN, MAX_ARCHIVE } from "./wallet.mjs";
import { createHash } from "node:crypto";
import { CANONICAL_GENESIS, reportedBalance } from "./snapshot.mjs";
import { startCompanion } from "./serve.mjs";
import { signOffline } from "./sign-offline.mjs";
import { importLegacy } from "./import-legacy.mjs";

const id = () => "0x" + randomBytes(64).toString("hex");
async function checkedWallet(suite) {
  const wallet = Wallet.create(suite);
  const { archive } = await wallet.backup();
  const code = wallet.recoveryCode();
  await wallet.confirm(archive, code);
  return { wallet, archive, code, account: wallet.state().wallet.accounts[0] };
}
function corruption(archive) {
  const fields = archive.split(".");
  fields[3] = (fields[3][0] === "A" ? "B" : "A") + fields[3].slice(1);
  return fields.join(".");
}
function requestFor(source, recipient) {
  return {
    chainId: CHAIN,
    genesis: GENESIS,
    input: {
      id: id(),
      suite: source.suite,
      commitment: source.commitment,
      weight: "0x1",
      createdHeight: "0x0",
      spentHeight: null,
    },
    recipient,
    expiryHeight: "0x1",
  };
}
async function changeArchive(archive, code, change) {
  const key = Buffer.from(code.slice(5), "base64url");
  const { plaintext, protectedHeader } = await compactDecrypt(archive, key);
  const data = JSON.parse(Buffer.from(plaintext).toString());
  change(data);
  return new CompactEncrypt(Buffer.from(JSON.stringify(data)))
    .setProtectedHeader(protectedHeader)
    .encrypt(key);
}

test("current downloaded archive required before new receives become shareable", async () => {
  const w = Wallet.create(1);
  const code = w.recoveryCode();
  const old = await w.backup();
  assert.deepEqual(w.state().wallet.accounts, []);
  assert.equal(w.state().wallet.pendingReceives, 1);
  await w.confirm(old.archive, code);
  const [first] = w.state().wallet.accounts;
  w.add(2);
  assert.deepEqual(w.state().wallet.accounts, [first]);
  await assert.rejects(w.confirm(old.archive, code), /latest backup/);
  const fresh = await w.backup();
  assert.notEqual((await w.backup()).archive, fresh.archive);
  await w.confirm(fresh.archive, code);
  assert.deepEqual(
    w.state().wallet.accounts.map((a) => a.suite),
    [1, 2],
  );
  assert.deepEqual(
    (await Wallet.restore(fresh.archive, code)).state(),
    w.state(),
  );
  const otherFork = await Wallet.restore(old.archive, code);
  otherFork.add(2);
  await assert.rejects(
    w.confirm((await otherFork.backup()).archive, code),
    /latest backup/,
  );
  assert.deepEqual(
    (await Wallet.restore(old.archive, code)).state().wallet.accounts,
    [first],
  );
  assert.throws(() => w.add(3), /suite/);
});

function disclosedKey(proof) {
  const raw = Buffer.from(proof.wire.slice(2), "hex");
  assert.equal(raw[114], 1);
  return raw.subarray(244, 244 + 1952);
}

test("one fresh same-suite receive per key and nonce avoids a common public-key fingerprint when both are spent", async () => {
  const { wallet, account: first, code } = await checkedWallet(1);
  wallet.add(1);
  const { archive } = await wallet.backup();
  await wallet.confirm(archive, code);
  const second = wallet.state().wallet.accounts[1];
  assert.notEqual(first.readHandle, second.readHandle);
  assert.notEqual(first.commitment, second.commitment);
  const one = await wallet.prove(first.commitment);
  const two = await wallet.prove(second.commitment);
  assert.equal(disclosedKey(one).equals(disclosedKey(two)), false);
  const firstWire = Buffer.from(one.wire.slice(2), "hex"),
    secondWire = Buffer.from(two.wire.slice(2), "hex");
  assert.equal(
    firstWire.subarray(180, 244).equals(secondWire.subarray(180, 244)),
    false,
  );
  assert.equal("0x" + firstWire.subarray(34, 98).toString("hex"), one.inputId);
  assert.equal(firstWire.readBigUInt64BE(98), 1n);
  assert.equal(
    "0x" + firstWire.subarray(116, 180).toString("hex"),
    one.recipient.commitment,
  );
});

test("wrong key, changes, truncation, large, duplicate, wrong chain, mismatched key and nonce cannot alter the current wallet", async () => {
  const { wallet, code, archive } = await checkedWallet(1);
  const original = wallet.state();
  const other = await checkedWallet(2);
  for (const [file, secret] of [
    [archive, other.code],
    [archive, "passphrase"],
    [archive.slice(0, -1), code],
    [corruption(archive), code],
    ["a".repeat(MAX_ARCHIVE + 1), code],
    [other.archive, other.code],
  ]) {
    await assert.rejects(wallet.confirm(file, secret));
    assert.deepEqual(wallet.state(), original);
  }
  for (const change of [
    (d) => {
      d.chainId = PROOF_CHAIN;
    },
    (d) => {
      d.genesis = "invalid";
    },
    (d) => {
      d.revision++;
    },
    (d) => {
      d.receives.push(d.receives[0]);
      d.revision++;
    },
    (d) => {
      d.receives[0].suite = 2;
    },
    (d) => {
      d.receives[0].key += "AAA";
    },
    (d) => {
      d.receives[0].nonce = randomBytes(32).toString("base64url");
    },
  ]) {
    const modified = await changeArchive(archive, code, change);
    await assert.rejects(Wallet.restore(modified, code));
    assert.deepEqual(wallet.state(), original);
  }
});

test(
  "offline native verifier accepts recovered signing authority for both suites and rejects a wrong chain or signature",
  {
    skip:
      !process.env.P2PARTY_WALLET_VERIFIER &&
      "Set P2PARTY_WALLET_VERIFIER to the built demos-ledger-verify executable.",
  },
  async () => {
    for (const suite of [1, 2]) {
      const { wallet, archive, code, account } = await checkedWallet(suite);
      wallet.destroy();
      const replacement = await Wallet.restore(archive, code);
      const proof = await replacement.prove(account.commitment);
      assert.equal(proof.chainId, PROOF_CHAIN);
      assert.notEqual(proof.chainId, CHAIN);
      assertVerified(proof, account);
      assert.equal(verifyNative(proof, account, CHAIN).status, 1);
      const last = proof.wire.at(-1);
      assert.equal(
        verifyNative(
          {
            ...proof,
            wire: proof.wire.slice(0, -1) + (last === "a" ? "b" : "a"),
          },
          account,
          PROOF_CHAIN,
        ).status,
        1,
      );
      const request = requestFor(account, proof.recipient);
      const payment = await replacement.signPayment(request);
      assert.equal(payment.chainId, CHAIN);
      assertVerified(payment, account);
      replacement.destroy();
    }
  },
);

test("offline payment export requires deliberate approval, writes an intact signed file, and preserves it on duplicate", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "p2party-offline-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const { wallet, archive, code, account } = await checkedWallet(1);
  const recipient = { suite: 2, commitment: id() };
  const request = requestFor(account, recipient);
  const paths = [
    join(dir, "wallet.jwe"),
    join(dir, "separate-code"),
    join(dir, "request.json"),
    dir,
  ];
  await Promise.all([
    writeFile(paths[0], archive),
    writeFile(paths[1], code),
    writeFile(paths[2], JSON.stringify(request)),
  ]);
  await assert.rejects(
    signOffline(paths, async () => false),
    /cancelled/,
  );
  const expectedPath = join(
    dir,
    "signed-" + request.input.id.slice(2) + ".json",
  );
  await assert.rejects(stat(expectedPath), { code: "ENOENT" });
  const result = await signOffline(paths, async (review) => {
    assert.deepEqual(review.recipient, recipient);
    assert.equal(review.expiry, "1");
    assert.equal(review.weight, "1");
    return true;
  });
  const snapshot = await readFile(expectedPath, "utf8");
  const transaction = JSON.parse(snapshot);
  assert.equal(transaction.moveId, result.moveId);
  assert.equal(transaction.inputId, request.input.id);
  assert.equal(transaction.chainId, CHAIN);
  assert.deepEqual(transaction.recipient, recipient);
  assert.equal((await stat(expectedPath)).mode & 0o777, 0o600);
  await assert.rejects(
    signOffline(paths, async () => true),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(expectedPath, "utf8"), snapshot);
  for (const changed of [
    { chainId: PROOF_CHAIN },
    { genesis: "wrong" },
    { recipient: { suite: 3, commitment: id() } },
    { recipient: { suite: 1, commitment: account.commitment } },
    { expiryHeight: "0x0" },
    { recipient: { suite: 2, commitment: recipient.commitment.slice(0, 42) } },
    { expiryHeight: "0x10000000000000000" },
    { input: { ...request.input, spentHeight: "0x7" } },
    { input: { ...request.input, weight: "0x3" } },
    { input: { ...request.input, commitment: id() } },
  ])
    assert.throws(() => wallet.reviewTransfer({ ...request, ...changed }));
});

test("migrate legacy key.pk8 and every receive nonce, bound to independently supplied public commitments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p2party-import-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const output = join(root, "kit"),
    separate = join(root, "code");
  const args = [output, separate];
  const { privateKey } = generateKeyPairSync("ml-dsa-65");
  const signer = nodeSigner(privateKey);
  for (let i = 0; i < 2; i++) {
    const dir = join(root, "record" + i);
    await mkdir(dir);
    const nonce = randomBytes(32);
    await writeFile(join(dir, "nonce"), nonce);
    await writeFile(
      join(dir, "key.pk8"),
      privateKey.export({ type: "pkcs8", format: "der" }),
    );
    args.push(dir, receiveOwner(signer, nonce).commitment);
  }
  await assert.rejects(
    importLegacy([...args.slice(0, -1), id()]),
    /expected public commitment/,
  );
  await assert.rejects(
    importLegacy([...args, ...args.slice(2, 4)]),
    /distinct/,
  );
  await assert.rejects(stat(output), { code: "ENOENT" });
  assert.equal(await importLegacy(args), 2);
  assert.equal((await stat(separate)).mode & 0o777, 0o600);
  const w = await Wallet.restore(
    await readFile(output, "utf8"),
    (await readFile(separate, "utf8")).trim(),
  );
  assert.deepEqual(
    w.state().wallet.accounts.map((a) => a.commitment),
    [args[3], args[5]],
  );
  await assert.rejects(importLegacy(args), { code: "EEXIST" });
  const legacyOne = await w.prove(args[3]),
    legacyTwo = await w.prove(args[5]);
  assert.equal(disclosedKey(legacyOne).equals(disclosedKey(legacyTwo)), true);
  assert.notEqual(legacyOne.readHandle, legacyTwo.readHandle);
});

test("loopback origin, session isolation, hostile fields and rejected restore preserve the current state", async (t) => {
  const server = await startCompanion();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = {
    Origin: base,
    "Content-Type": "application/json",
    "X-P2Party-Session": randomBytes(32).toString("hex"),
  };
  const api = (action, data = {}, h = {}) =>
    fetch(base + "/api/" + action, {
      method: "POST",
      headers: { ...headers, ...h },
      body: JSON.stringify(data),
    });
  const page = await fetch(base);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(
    (await api("create", { suite: 1 }, { Origin: "https://example.invalid" }))
      .status,
    403,
  );
  assert.equal(
    (await api("create", { suite: 1 }, { "Sec-Fetch-Site": "cross-site" }))
      .status,
    403,
  );
  assert.equal(
    (await api("create", { suite: 1 }, { "X-P2Party-Session": "short" }))
      .status,
    403,
  );
  assert.equal(
    (await api("create", { suite: 1 }, { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal(
    (await api("create", { suite: 1, privateKey: "extra" })).status,
    400,
  );
  assert.deepEqual(await (await api("state")).json(), { wallet: null });
  const created = await (await api("create", { suite: 1 })).json();
  const backup = await (await api("backup")).json();
  assert.equal((await api("lock")).status, 400);
  const other = { "X-P2Party-Session": randomBytes(32).toString("hex") };
  assert.equal(
    (
      await api(
        "restore",
        { archive: backup.archive, recoveryCode: "wrong" },
        other,
      )
    ).status,
    400,
  );
  assert.deepEqual(await (await api("state", {}, other)).json(), {
    wallet: null,
  });
  const kit = { archive: backup.archive, recoveryCode: created.recoveryCode };
  assert.equal((await api("restore", kit)).status, 400);
  assert.deepEqual(await (await api("state")).json(), created.state);
  assert.equal((await api("confirm", kit)).status, 200);
  assert.equal((await api("restore", kit, other)).status, 200);
  assert.deepEqual(await (await api("lock")).json(), {
    state: { wallet: null },
  });
  assert.equal(
    (await (await api("state", {}, other)).json()).wallet.accounts.length,
    1,
  );
});

test("local total pins the same genesis as the replica and matches complete full commitments plus suites", async () => {
  const g = JSON.parse(
    await readFile(
      new URL("../../../deploy/testnet/genesis.json", import.meta.url),
    ),
  );
  const units = g.units
    .map(({ id, weight, suite, commitment }) => ({
      id,
      weight,
      suite,
      commitment,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = createHash("sha256")
    .update(
      JSON.stringify({
        chainId: g.chainId,
        rpcChainId: g.rpcChainId,
        spendMask: 3,
        receiveMask: 3,
        units,
      }),
    )
    .digest("hex");
  assert.equal(CANONICAL_GENESIS, "0x" + canonical);
  const snapshot = {
    version: 1,
    chainId: CHAIN,
    genesisHash: CANONICAL_GENESIS,
    height: "0x22",
    units: structuredClone(units),
  };
  const { wallet, code } = await checkedWallet(1);
  wallet.add(2);
  await wallet.confirm((await wallet.backup()).archive, code);
  const accounts = wallet.state().wallet.accounts;
  assert.deepEqual(reportedBalance(snapshot, accounts), {
    amount: "0",
    height: "34",
  });
  for (const [i, a] of accounts.entries())
    Object.assign(snapshot.units[i], {
      suite: a.suite,
      commitment: a.commitment,
    });
  assert.deepEqual(reportedBalance(snapshot, accounts), {
    amount: "2",
    height: "34",
  });
  assert.deepEqual(reportedBalance(snapshot, accounts.slice(0, 1)), {
    amount: "1",
    height: "34",
  });
  for (const change of [
    (s) => {
      s.units.pop();
    },
    (s) => {
      s.units[0].id = s.units[1].id;
    },
    (s) => {
      s.units[0].commitment = s.units[1].commitment;
    },
    (s) => {
      s.units[0].weight = "0x2";
    },
    (s) => {
      s.units[0].suite = 2;
    },
    (s) => {
      s.units[1].suite = 3;
    },
    (s) => {
      s.chainId = PROOF_CHAIN;
    },
    (s) => {
      s.genesisHash = GENESIS;
    },
    (s) => {
      s.height = "0x0003";
    },
  ]) {
    const invalid = structuredClone(snapshot);
    change(invalid);
    assert.throws(() => reportedBalance(invalid, accounts));
  }
});
