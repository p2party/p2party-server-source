import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import { keccak256, concat, toBeHex } from "ethers";
import {
  receiveOwner,
  readHandle,
  signTransfer,
  transferIds,
  createLedgerTransport,
} from "../dist/index.js";
import { nodeSigner } from "../dist/node.js";

test("read handles and fresh receive nonces preserve the full post-quantum identity", async () => {
  const signer = nodeSigner(generateKeyPairSync("ml-dsa-65").privateKey);
  const nonce = randomBytes(32),
    owner = receiveOwner(signer, nonce),
    next = receiveOwner(signer, randomBytes(32));
  assert.notEqual(owner.commitment, next.commitment);
  assert.equal(
    readHandle(owner),
    "0x" +
      keccak256(concat([toBeHex(owner.suite, 1), owner.commitment])).slice(-40),
  );
  assert.notEqual(readHandle(owner), readHandle({ ...owner, suite: 2 }));
  assert.throws(
    () =>
      nodeSigner(
        generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey,
      ),
    /ML-DSA/,
  );
  const chainId = "0x" + "ca".repeat(32),
    input = {
      ...owner,
      id: "0x" + "12".repeat(64),
      createdHeight: "0x0",
      spentHeight: null,
      weight: "0x8000000000000000",
    };
  const args = { chainId, input, recipient: next, expiryHeight: 999n };
  const wire = await signTransfer(args, signer, nonce);
  assert.equal(transferIds(wire, chainId).inputId, input.id);
  assert.throws(() => transferIds(wire, `0x${"31".repeat(32)}`), /chain/);
  await assert.rejects(
    signTransfer({ ...args, recipient: owner }, signer, nonce),
    /fresh/,
  );
  await assert.rejects(signTransfer(args, signer, randomBytes(32)), /open/);
  await assert.rejects(
    signTransfer(
      { ...args, input: { ...input, weight: "0x3" } },
      signer,
      nonce,
    ),
    /weight/,
  );
  await assert.rejects(
    createLedgerTransport({
      url: "http://wallet.example/rpc",
      rpcChainId: 8123,
      chainId,
    }),
    /HTTPS/,
  );
});
