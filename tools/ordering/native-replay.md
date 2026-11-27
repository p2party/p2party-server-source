# Verify an unspent native unit at a certified checkpoint

The local ordering experiment accepts the existing ML-DSA and SLH-DSA transfer wire. A validator obtains candidate wires from its own committed DAG, starts at its configured genesis, and executes the candidates in that order. Its execution vote covers the chain ID, genesis hash, fixed committee, anchor, accepted transfer count, receipt root and sparse state root. The tests run all validators on one computer. Public Testnet 1 continues to use its existing checkpoint format.

## Run locally

Build the libdemos ledger with CMake 3.28 or later, a C17 compiler, OpenSSL 3.5 or later, pkg-config and libsodium. From this server checkout, the commands below place the pinned native source and binaries in a temporary directory. The directory in `P2PARTY_NATIVE_BIN` must contain `demos-ledger-verify`, `demos-ledger-fixture`, `demos-ledger-state` and `demos-ledger-log`. Only the test uses the signing fixture. [Native source](https://github.com/p2party/libdemos/tree/03615e6aeb54b3233e011504db636cee9fb689cc/ledger)

```sh
LIBDEMOS=$(mktemp -d)/libdemos
git clone --branch feat/ledger-sparse-state --single-branch https://github.com/p2party/libdemos.git "$LIBDEMOS"
git -C "$LIBDEMOS" checkout --detach 03615e6aeb54b3233e011504db636cee9fb689cc
cmake -S "$LIBDEMOS/ledger" -B "$LIBDEMOS/build/ledger" -DBUILD_TESTING=ON
cmake --build "$LIBDEMOS/build/ledger" --parallel
ctest --test-dir "$LIBDEMOS/build/ledger" --output-on-failure
export P2PARTY_NATIVE_BIN="$LIBDEMOS/build/ledger"
bun install --frozen-lockfile
bun test tools/ordering/native-replay.test.ts
```

To exercise Node.js 26.13.1 or later with the same imports as the Bun server, bundle the test first.

```sh
test_bundle=$(mktemp -d)
bun build tools/ordering/native-replay.test.ts --target=node --format=esm --outfile="$test_bundle/native-replay.test.mjs"
node --test "$test_bundle/native-replay.test.mjs"
```

## Execution rules

`createOrderedLedger(config, committee, nativeBin)` requires a config loaded by the server's `ledgerConfig` and the committee descriptor pinned by the operator. It recomputes the canonical genesis hash from the chain ID, RPC chain ID, suite policy and allocations. The resulting hash must match the pinned committee. It snapshots that configuration before replay. Each call to `replay(wires)` derives `{height, logRoot, stateRoot}` from scratch. `snapshot(wires)` returns the same roots and a `prove(unitId)` method.

Genesis creates its configured units and inserts their full owner commitments into the sparse tree. A candidate wire receives one execution opportunity at its first ordered position. The native verifier checks the current unit, signature, chain, expiry, weight and suite rules at the next accepted height. A missing or spent input, rejected transfer or reused recipient commitment consumes no height. Execution retains commitment markers for spent units. Each accepted transfer appends its move ID to the receipt log and inserts three state markers for the spent input, applied move and new recipient commitment. The output receives the input's entire weight. A native executable failure, a successful reply inconsistent with the submitted wire, or exceeded snapshot capacity aborts replay before an execution vote can be issued. A local OpenSSL provider failure returns exit 2 and aborts replay.

The offline proof generator accepts at most 65,536 markers including genesis and three per accepted transfer. It rebuilds the native sparse tree when producing a proof. Full-prefix replay and these process-based tools are intended for local experiments.

## Wallet inputs

The wallet loads its own validated genesis, pins its committee and selects a fresh checkpoint through its own synchronization policy. The full expected checkpoint is passed separately from the certificate and witness returned by a peer. For example, given a locally selected anchor and an authenticated latest checkpoint, verification looks like this.

```ts
const unit = verifyWalletUnit(
  localGenesis,
  pinnedCommittee,
  currentCheckpoint,
  executionCertificate,
  { id: expectedUnitId, suite: receiveSuite, commitment: receiveCommitment },
  peerProof,
);
```

The wallet checks the execution quorum, exact checkpoint and locally recomputed genesis fingerprint. An optional `weight` on the requested unit binds the expected amount as well. For a genesis unit, the local genesis supplies the ID, weight, owner and suite. For a derived unit, the proof supplies the creation wire, zero-based receipt index, SHA-512 inclusion path, and sparse membership proof for the move ID. The wallet recomputes the move and output IDs, authenticates the wire at that position, then reads the recipient and weight from that wire. Both paths require the requested full owner and suite, owner-commitment membership, and absence of the output's spent marker under the certified state root. The returned `spentHeight: null` describes that checkpoint only. A certificate for an older checkpoint still verifies cryptographically, so rollback protection depends on the wallet retaining or synchronizing its trusted current checkpoint. No private receiving nonce or signing key is needed for a balance check.
