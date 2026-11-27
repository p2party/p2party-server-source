# Native ledger client for ethers and viem

This testnet package connects an ethers `BrowserProvider` or a viem `custom` transport to the validator's HTTPS `/rpc` endpoint. A balance is the integer weight of a whole native unit. The owner supplies a signature suite and a full 64-byte commitment. Each receive commitment can hold one unit once over its lifetime.

## Install and connect

Download the [versioned npm tarball](https://p2party.com/downloads/testnet-1/p2party-ledger-client-0.1.0-testnet.0.tgz) and [SHA-256 checksum](https://p2party.com/downloads/testnet-1/p2party-ledger-client-0.1.0-testnet.0.tgz.sha256) from p2party.com. With both files in your working directory, verify and install the archive.

```sh
shasum -a 256 -c p2party-ledger-client-0.1.0-testnet.0.tgz.sha256
npm install ./p2party-ledger-client-0.1.0-testnet.0.tgz
```

The [source archive](https://p2party.com/downloads/testnet-1/ledger-client-source.tar.gz) and its [checksum](https://p2party.com/downloads/testnet-1/ledger-client-source.tar.gz.sha256) contain the reviewed wallet source. For a source build, extract the archive and run `npm ci` and `npm pack` from this directory with Node 26. Install the resulting tarball with the same `npm install` command. Install `ethers` or `viem` in the consuming application. The tested versions are ethers 6.17.0 and viem 2.58.8. The package's main entry runs in browsers and Node. Its optional `/node` signer uses Node 26 with OpenSSL support for the selected post-quantum algorithm.

The public, valueless testnet manifest is [genesis.json](https://p2party.com/downloads/testnet-1/genesis.json) ([SHA-256](https://p2party.com/downloads/testnet-1/genesis.json.sha256)). Its RPC URL is `https://signaling.p2party.com/rpc`, native chain ID is `0x09a0ffa8e6af6aeb11d26671c6c76648965d60509cc3b7a1a4b454b6ec73c760`, and numeric provider ID is `1345474644` (`0x50325054`). Wallets should pin this pair before signing. Request a valueless unit from the public testnet operator using the steps below.

```ts
import { JsonRpcProvider } from "ethers";
import { createPublicClient, http, rpcSchema } from "viem";
import { readHandle, type NativeRpcSchema } from "@p2party/ledger-client";

const url = "https://signaling.p2party.com/rpc";
const chainId =
  "0x09a0ffa8e6af6aeb11d26671c6c76648965d60509cc3b7a1a4b454b6ec73c760";
const rpcChainId = 1345474644;
const ethers = new JsonRpcProvider(url, undefined, {
  cacheTimeout: -1,
  batchMaxCount: 8,
});
const viem = createPublicClient({
  transport: http(url),
  rpcSchema: rpcSchema<NativeRpcSchema>(),
  cacheTime: 0,
});
if (
  (await ethers.getNetwork()).chainId !== BigInt(rpcChainId) ||
  (await ethers.send("demos_chainId", [])) !== chainId
)
  throw new Error("Wrong ledger");
const address = readHandle(recipientDescriptor);
const balance = await ethers.getBalance(address);
const sameBalance = await viem.getBalance({ address });
const genesisBalance = await ethers.getBalance(address, 0);
const latestHeight = await viem.getBlockNumber();
```

Any client can read a public handle directly over HTTP. No wallet connection or owner registration is required. The handle is the final 20 bytes of `Keccak-256(uint8(suite) || commitment[64])`. It identifies a single native receive commitment and gives no signing authority. A missing, unfunded or spent handle returns zero. A handle with multiple full commitments at the requested height returns `-32004`; use `demos_getUnit` or `demos_listUnspent` to disambiguate. Historical lookup uses the unit's creation and spend heights. A future height returns `-32001`. The server accepts batches of up to eight requests.

Applications that prefer a pinned EIP-1193 transport can call `await createLedgerTransport({url, chainId, rpcChainId})`, pass the result to ethers `BrowserProvider` or viem `custom`, and use the same methods. The transport verifies both network identifiers and recomputes native IDs when submitting a transfer or looking up its receipt.

## Receive a test unit

Run the following once in a Node ESM file from your wallet project. It creates a local owner-only directory and prints the public receive descriptor. The key and nonce files are local plaintext testnet credentials. Use a new directory for each run and keep both files private.

```js
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { receiveOwner } from "@p2party/ledger-client";
import { nodeSigner } from "@p2party/ledger-client/node";

const dir = "./testnet-wallet";
mkdirSync(dir, { mode: 0o700 });
const { privateKey } = generateKeyPairSync("ml-dsa-65");
const nonce = randomBytes(32);
const descriptor = receiveOwner(nodeSigner(privateKey), nonce);
writeFileSync(
  `${dir}/key.pk8`,
  privateKey.export({ type: "pkcs8", format: "der" }),
  { mode: 0o600, flag: "wx" },
);
writeFileSync(`${dir}/nonce`, nonce, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(descriptor));
```

Open a [public testnet unit request](https://github.com/p2party/p2party-js/issues/new?title=Testnet%20unit%20request) with only the suite number and full receive commitment. The operator returns the native output unit ID. Look it up with `demos_getUnit` and compare the suite, commitment and weight before spending. The [public guide](https://github.com/p2party/p2party-js/blob/master/docs/testnet-1.md) describes the wider testnet workflow.

## Sign a transfer locally

The wallet supplies the private key and the original 32-byte receive nonce corresponding to its unspent input. Suite 1 uses ML-DSA-65 and suite 2 uses SLH-DSA-SHA2-192s. A recipient creates a fresh cryptographically random nonce, calls `receiveOwner(signer, nonce)` and gives the sender only the resulting `{suite, commitment}`. It must retain the key and nonce to spend the received unit later. The native validator carries the whole original weight into the sole output and enforces commitment freshness atomically.

```ts
import { receiveOwner, signTransfer, type Unit } from "@p2party/ledger-client";
import { nodeSigner } from "@p2party/ledger-client/node";

const local = nodeSigner(myPrivateKey); // Caller-owned Node KeyObject.
const input: Unit | null = await ethers.send("demos_getUnit", [myUnitId]);
if (!input) throw new Error("Unknown unit");
const wire = await signTransfer(
  {
    chainId,
    input,
    recipient: recipientDescriptor,
    expiryHeight: lastAcceptableHeight,
  },
  local,
  originalReceiveNonce,
);
const moveId = await ethers.send("demos_sendRawTransfer", [wire]);
const receipt = await viem.request({
  method: "demos_getTransfer",
  params: [moveId],
});
```

Viem can also submit `await viem.request({method: 'demos_sendRawTransfer', params: [wire]})`. Ethers can retrieve `await ethers.send('demos_getTransfer', [moveId])`. For browser or hardware wallets, `signTransfer` accepts a `LocalSigner` with its suite, raw public key, and a local `sign(digest)` callback. The callback must apply the suite's pure signature to the supplied domain-separated 64-byte digest with the empty context. `expiryHeight` is inclusive, and `0n` selects no expiry. Choose it before signing.

Only an accepted post-quantum signature spends a native unit. The Ethereum `Wallet`, `signer.sendTransaction`, `broadcastTransaction`, gas, contracts and conventional 32-byte EVM receipts have no mapping in this transport. A local wallet can query units and construct post-quantum transactions using either client's normal JSON-RPC extension mechanism.

## Methods and receipts

| Request                                          | Meaning                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `eth_chainId`, `eth_blockNumber`                 | Configured numeric network ID and latest committed native log height.                          |
| `eth_getBalance`                                 | Native unit weight for a public read handle at `latest`, `earliest` or a committed hex height. |
| `demos_chainId`, `demos_getHead`                 | Native signed chain ID, or ID and committed height.                                            |
| `demos_getUnit`, `demos_listUnspent`             | A unit by its full ID, or live units for a full descriptor.                                    |
| `demos_sendRawTransfer`                          | Submit exact signed native bytes and return the 64-byte native move ID after commit.           |
| `demos_getTransfer`, `demos_getTransferByHeight` | Native receipt `{id, height, inputId, outputId, wire}`, or `null` for an unknown transfer.     |

The transport recomputes move and output IDs from the signed bytes. The height comes from the selected validator's committed log. The receipt carries no consensus or finality proof. To recover from a timed-out submission, keep the original signed bytes. `transferIds(wire, chainId).id` gives the full lookup ID before submission. Query that ID or submit the exact same bytes again, including after reconnecting. Signing again can produce different bytes and a competing spend of the same input.

## Verify

Run `npm test`. To exercise both real client libraries against the full local validator, install the server's dependencies, generate its Prisma client, set `P2PARTY_TEST_POSTGRES_URL` to the repository's isolated loopback PostgreSQL fixture and set `P2PARTY_TEST_LEDGER_VERIFIER` to the built `demos-ledger-verify` executable. Run `npm run test:validator` with Bun 1.4.5 and Node 26 on `PATH`. The test creates a fresh database and a valueless synthetic genesis, generates ephemeral PQ key pairs, submits both suites over `/rpc`, verifies receipts and balances, and removes the temporary database and public genesis.

## Outcomes and roadmap

The integration test uses an actual PostgreSQL-backed validator, a C verifier and two independent JavaScript libraries. Ethers submits an ML-DSA-65 transfer. Viem spends that output using SLH-DSA-SHA2-192s. Both read the same current and historical balances and receipts. A fresh connection can recover the full move from its ID. The test also checks corrupted signatures, unsigned or classical transactions, reused commitments, wrong networks, absent handles and exact-byte retries.

The current validator provides a committed local transfer log and one-unit transfers. The roadmap includes wallet-managed nonce and key backup, a browser post-quantum signer integration, and independently verifiable inclusion and finality. The public testnet carries no monetary value.

### Currency and signing suites

The **P2PARTY** ticker denotes whole native units (zero decimal places). The wallet exports `nativeCurrency` for chain configuration. The [coin icon](https://p2party.com/logo-cat.svg) is also the web client favicon. Testnet units have no monetary value.

| Suite ID | Signing key        | Signed transfer size | Network availability             |
| -------- | ------------------ | -------------------: | -------------------------------- |
| 1        | ML-DSA-65          |          5,505 bytes | Public Testnet 1                 |
| 2        | SLH-DSA-SHA2-192s  |         16,516 bytes | Public Testnet 1                 |
| 3        | ML-DSA-87          |          7,463 bytes | Explicitly enabled local genesis |
| 4        | SLH-DSA-SHAKE-256s |         30,100 bytes | Explicitly enabled local genesis |

Select the algorithm when generating a key, then pass that key to `nodeSigner`. A transfer that changes suites uses a fresh recipient commitment. The current owner must still sign using the suite that owns the input.
