# Take a P2Party spending wallet to another browser

Bring **your latest encrypted wallet file and its separate recovery code**. Together they open the signing keys and the original nonce for every receive request in the file. Anyone with both can spend those units. A public balance handle is enough to look up a balance. A sender needs the suite and full receive commitment.

## Open the wallet in a browser

Open the standalone restore tool in its own tab. **Choose the encrypted wallet file or paste its contents, then enter your separate recovery code.** The tool opens the existing wallet inside this browser. It displays the saved receive commitments and can verify spending access or sign a native Testnet 1 payment for export. The user needs a browser with Web Crypto. No installation, server or account is required. The downloadable HTML file contains the complete app and can be used on a disconnected computer. [Standalone restore tool and checksum](browser/README.md)

The restored wallet immediately shows the total reported at its included checkpoint. Its balance menu can refresh against the public validator, import a replica snapshot, or share just the amount and height with the site navbar after an explicit choice. [Balance verification and privacy](browser/README.md#balance-in-the-wallet-and-site-navigation)

The optional **Remember encrypted backup** setting saves the verified ciphertext in this browser. On the next visit, enter just the recovery code. Use **Forget** to remove the saved file. By default, reselect the file each time. The code, opened signing keys, nonces and signed transfers stay out of persistent browser storage. Locking the wallet, leaving the page or reloading clears the active signer.

You can also create a wallet and issue new one-time payment requests entirely in the standalone browser. The local companion provides a second way to create wallets, export checked backups and migrate multiple original receive folders. [Receive while offline and catch up later](browser/README.md#receive-a-payment-including-while-offline)

## Start the local companion

Install Node.js 26.13.1 or later with ML-DSA-65 and SLH-DSA-SHA2-192s support on a trusted computer. From a verified copy of this repository, run the following commands. Installation downloads the locked dependencies, including the published Testnet 1 ledger client. The companion works offline after installation.

```sh
cd clients/evm/portable-wallet
npm ci
npm start
```

Open the exact `http://127.0.0.1:PORT/` address printed in the terminal. The random port belongs to the local signer. A second browser on this computer can open the same address. On another computer, install the companion there and open its own local address. The hosted P2Party website can check public balances. Enter recovery codes only in a verified standalone restore tool or your trusted local companion.

1. Choose **Create a new wallet**, select one of the two Testnet 1 suites and download the encrypted backup. Save its machine-generated code in a separate trusted place such as a password manager. Check the file by selecting it and entering the code from your separate copy.
2. Open a confirmed request to see its full receive commitment and public balance handle. Share the suite and full commitment with one sender. For another payment, create a fresh request, save the updated file and check it first. Each commitment receives one unit once.
3. In the destination browser choose **Restore my wallet**, select the latest file and enter the code. Open a receive request and choose **Check spending access**. The local signer uses its recovered key and nonce to spend a synthetic unit on a separate proof chain and checks the signature. The proof stays on this computer.
4. After checking the destination, choose **Close this local wallet** on the original device or stop its companion process. The encrypted kit is a copy. Everyone holding both pieces retains signing authority. To revoke an old copy's ability to spend a unit, transfer the unit to a fresh commitment in a separately created wallet.

Archive names include a wallet identifier and revision. **Each file covers only the receive requests present when it was saved.** A replacement with just an older valid file can restore that revision and cannot discover later nonces. After moving, use one device to add new requests and carry the updated file to other devices. Two devices that add requests independently produce separate histories, even if their revision numbers match. Retain both files if that happens. Browser storage contains only a tab's random session token. The local signer keeps unlocked wallet material in process memory until you close the wallet or stop it. Recovery is self-custodial. Protect both pieces against loss and keep separate backups.

The local companion and command-line tools require a computer that runs the supported Node runtime. The automated browser test uses separate desktop Chromium profiles. A separate Chromium-to-Firefox 161 recovery check reproduced the original ML-DSA-65 commitment and verified an offline signature after the source signer stopped. A narrow viewport check covers the layout. Installation and signing on mobile operating systems need a separate release.

## What someone with one address can see

Share only the selected receive request. Each new request created by this companion has a fresh independent post-quantum signing key **and** a fresh 32-byte nonce. The derived public read handle identifies that one commitment. The chain has no wallet ID or record grouping these new requests together; the grouping lives in the encrypted backup. Someone given one handle can query that commitment's unit balance. A full wallet balance requires knowing which other commitments the holder controls.

Transfers publicly reveal the spent input, its whole weight, recipient commitment, source public key and hashed receive nonce. The chain exposes the path of a unit across transfers. An observer may link requests using outside information such as timing, contacts, shared descriptors or queries made to the same RPC provider. A legacy wallet that reused one key with different nonces exposes the same public key when those units are spent. Import faithfully preserves that relationship. To receive future units, create independent fresh requests in the companion. This wallet provides no confidential amounts or graph anonymity. [Native transfer wire](../src/wire.ts)

### Check the wallet total privately

In the local companion, expand **Check my total locally** and choose a complete all-units snapshot from a synchronized Testnet 1 replica you trust. The same public file works for every wallet. Only your local companion compares the snapshot to its confirmed receive requests by suite and full commitment. Neither the file producer nor a remote RPC receives your list of handles. The total is **reported by that snapshot at its stated height**. An incomplete wallet backup understates what you own; an old or dishonest replica may report the wrong holdings. The companion does not use this result to authorize a payment.

A replica operator can produce the generic public JSON file using a read-only database role and the included SQL statement. Use a new output pathname outside the checkout. The statement reads the chain head and the entire current unspent set in one consistent database view.

```sh
psql -XAt -v ON_ERROR_STOP=1 -d verified_replica -f export-snapshot.sql > testnet1-snapshot.json
```

A disposable PostgreSQL 18 database using the server schema reproduced all 128 published genesis units, their canonical fingerprint and height zero with this query. The checker pins the server’s canonical decoded-genesis fingerprint, verifies the 128 distinct, weight-one units required by Testnet 1, validates suite IDs, and rejects duplicate IDs or commitments. A wallet-side structural check cannot authenticate membership, freshness or the claimed head. Obtain the file directly from a trusted verified replay. The standalone browser wallet can also refresh the complete public dataset through the website's snapshot page. [Replica replay instructions](../../../src/ledger/README.md#replay-a-local-peer-into-a-second-database) · [Consistent snapshot query](export-snapshot.sql)

## Bring an existing key and receive nonce

The original native client tutorial saved `key.pk8` (DER PKCS#8) and `nonce` (32 raw bytes) in a local folder for a receive request. Gather **each** receive folder and the full commitment you previously shared for that folder. The same signing key can have multiple nonces. The converter reconstructs each commitment with the published ledger client and verifies a complete restore before creating the two output files. Use new paths inside private writable directories on local filesystems that support hard links.

```sh
node import-legacy.mjs /secure/wallet/testnet.jwe /separate/private-code/testnet.code \
  /secure/first-receive FULL_FIRST_COMMITMENT \
  /secure/second-receive FULL_SECOND_COMMITMENT
```

Replace the capitalized values with the actual `0x`-prefixed 64-byte public commitments. The tool reads only the folders you name and creates private files with exclusive names. Each original receive folder remains available to its existing client. On the destination, select the encrypted file and enter the single recovery-code line.

## Sign a native Testnet 1 payment offline

Use trusted RPC clients to fetch the current unspent unit with `demos_getUnit` and the current chain height with `demos_getHead`. Obtain the recipient's **full one-time commitment and suite** over an independently verified channel. A payment moves the entire unit. The offline signer checks the network, source opening, destination and weight. Only the network can establish whether an input is still unspent, a destination is still fresh, and the expiry is still ahead of the current head. The native client guide covers RPC identity checks and submission. [Native ledger client](../README.md#sign-a-transfer-locally)

Prepare a public JSON file with these fields. Replace the placeholders with lowercase hex values. Copy the entire JSON object returned by `demos_getUnit` into `input`; the additional `result` wrapper from JSON-RPC is omitted. Set a finite inclusive expiry in unsigned hexadecimal relative to the current head.

```json
{
  "chainId": "0x09a0ffa8e6af6aeb11d26671c6c76648965d60509cc3b7a1a4b454b6ec73c760",
  "genesis": "0x38d42d50a5a6d5ceb43fd6f63235e542716b1df5ccff59161c5fd7810aed17c6",
  "input": {
    "id": "FULL_INPUT_ID",
    "weight": "0x1",
    "suite": 1,
    "commitment": "FULL_SOURCE_COMMITMENT",
    "createdHeight": "0x1",
    "spentHeight": null
  },
  "recipient": { "suite": 2, "commitment": "FULL_RECIPIENT_COMMITMENT" },
  "expiryHeight": "FINITE_EXPIRY_HEIGHT_IN_HEX"
}
```

On the offline computer, put the saved recovery code alone on one line in a private file on your separate medium. Choose a private existing output directory on a filesystem with hard links. Use the same output directory for this wallet's signed payments.

```sh
node sign-offline.mjs /secure/wallet/testnet.jwe /separate/private-code/testnet.code \
  /transfer/request.json /secure/signed-payments
```

Review the full source, amount, destination suite, full recipient commitment, derived read handle and expiry on the terminal. Type the requested confirmation to authorize the payment. The signer verifies the signature and creates one file named `signed-<input-id>.json` with exclusive permissions. Anyone holding that file can submit its `wire` to the Testnet 1 RPC. The signer has no network client. Relay the same signed bytes with ethers or viem, compare the returned full move ID against the file, then check the receipt. If a response is lost, look up or resubmit those exact bytes. A second export in the same directory preserves the existing file. Independent wallet copies can attempt conflicting spends; Testnet 1 accepts at most one spend per input. [Submission and receipt methods](../README.md#methods-and-receipts)

## Archive and local security

The encrypted file is compact JSON Web Encryption (JWE) using the pinned `jose` library. It uses direct encryption with a uniformly random 256-bit recovery key, AES-256-GCM and a fresh library-generated IV per backup. The protected header fixes `alg=dir`, `enc=A256GCM` and `typ=p2party-wallet+jwe`. The recovery code encodes the key as unpadded base64url with the `P2W1-` prefix. There is no password-derived key. The authenticated payload pins the network and genesis, a random wallet ID, append-only revision, each native PKCS#8 signing key, suite, receive commitment and nonce. On restore the signer rederives every commitment and rejects unsupported suites, duplicates, invalid encodings and mismatches before opening the wallet. The application caps a file at 2 MiB and 64 receives. The archive construction comes from the JOSE standards. Independent review of this wallet integration is still pending. [M. Jones and J. Hildebrand, RFC 7516, 2015](https://www.rfc-editor.org/rfc/rfc7516) · [M. Jones, RFC 7518 §§4.5 and 5.3, 2015](https://www.rfc-editor.org/rfc/rfc7518) · [jose implementation](https://github.com/panva/jose)

The companion binds only to IPv4 loopback, checks the exact Host and Origin on API calls, isolates sessions, disables response caching and serves local scripts under a restrictive content security policy. Local browser requests carry the archive and code to the signer on the same computer. Native signing keys stay in the signer. Browser extensions, local malware, a modified distribution, a compromised operating system or unauthorized access to an unlocked session can compromise the wallet. Use trusted devices, profiles and installation sources. JavaScript and native runtimes may retain transient copies in memory. [Published Testnet 1 client and checksum](../README.md#install-and-connect)

## Reproduce verification

```sh
npm test
P2PARTY_WALLET_VERIFIER=/absolute/path/to/demos-ledger-verify npm test
```

The second command also checks both suites' native transfers against the separate C verifier, including wrong-chain and changed-signature rejection. All inputs are generated locally. For the end-to-end journey, install Playwright and Chromium in a separate test workspace and point the test at the local package.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright node browser.test.mjs
```

The browser test starts two companions, checks encrypted download and restore after the source process stops, checks both suites' spending proofs and tests profile isolation. It fails on off-device browser requests. [Native verification source](https://github.com/p2party/libdemos/tree/243a5dbbf4cb95507bb1104a47ad46ad3ed1e7a0/ledger)
