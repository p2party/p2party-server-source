# Native transfer validator

The signaling process can expose a JSON-RPC 2.0 transfer validator backed by PostgreSQL. Each accepted transfer spends one existing unit, retains its weight, creates a unit under a fresh owner commitment, and appends its signed native bytes at the next height. The same database orders submissions across signaling workers. This stage has local committed heights. Consensus, staking, finality and minting are outside the protocol implemented here.

The local fixed-committee experiment certifies batches, orders their committed causal history using Bullshark anchors, and collects separate signatures over independently replayed execution roots. [Ordering protocol and tests](../../tools/ordering/README.md)

## Start a node

Build `demos-ledger-verify` from the pinned public source with CMake, OpenSSL 3.5+ and libsodium. The reference Linux amd64 release checks the executable's SHA-256 digest and exercises a positive and negative vector for each signing suite. [Pinned verifier](https://github.com/p2party/libdemos/tree/243a5dbbf4cb95507bb1104a47ad46ad3ed1e7a0/ledger) · [Release configuration](../../deploy/README.md#public-testnet-release)

Supply a genesis JSON file with `version: 1`, a 32-byte `chainId`, `rpcChainId` between 1 and `Number.MAX_SAFE_INTEGER`, explicit `spendSuites` and `receiveSuites` arrays, and a `units` array. Every genesis entry supplies `id`, `weight`, `suite`, and `commitment`. IDs and commitments are 64-byte lowercase `0x`-prefixed hex strings. Weights are canonical hex quantities and must be powers of two through `0x8000000000000000`. Public Testnet 1 authorizes suite 1 (ML-DSA-65) and suite 2 (SLH-DSA-SHA2-192s). Local networks can additionally authorize suite 3 (ML-DSA-87) and suite 4 (SLH-DSA-SHAKE-256s). The genesis commits to the exact spend and receive policies. Changing that file creates a different chain identity for replay. Each ID and owner commitment is unique. The node accepts up to 4,096 genesis entries and a 1 MiB genesis file. The operator supplies all allocations, policies and identifiers. [Public testnet genesis](https://p2party.com/downloads/testnet-1/genesis.json)

Export `LEDGER_ENABLED=true`, `LEDGER_CHAIN_ID`, `LEDGER_GENESIS_FILE` and `LEDGER_VERIFIER`. Both filesystem paths must be absolute. Use `SIGNALING_BIND_HOST=127.0.0.1` for a local-only listener. The signaling process retains its ordinary `DATABASE_URL`, `SIGNALING_HOST` and migration requirements. A disabled process returns HTTP 404 on `/rpc` and creates no ledger schema. When first enabled it creates `p2party_ledger` in that database under a transaction. At startup every enabled worker compares the supplied chain, policy and allocations to the stored genesis digest. A different genesis refuses startup. `--check-config` validates the file and verifier executable before host cutover.

Run `--check-ledger-state` using the staged environment to check the existing chain identity and schema/table access or, on an empty installation, the worker role's database CREATE permission. This check uses a read-only transaction. Include the ledger schema in backups. The database is trusted storage. The transfer log provides ordered signed records. [Trust assumptions and roadmap](../../ROADMAP.md)

## RPC

Send `POST /rpc` with `Content-Type: application/json`, positional `params` and `jsonrpc: "2.0"`. Heights and weights are canonical hex quantities. Native IDs, commitments and wire bytes use lowercase `0x`-prefixed hex. An unknown native unit or transfer returns `null`. `GET /rpc/health` reads the database and returns `{status:"ok",chainId,rpcChainId,height}`, where `rpcChainId` and `height` are hex quantities. A storage failure returns HTTP 503. Both routes return HTTP 404 when the ledger is disabled.

| Method                      | Params                              | Result                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demos_chainId`             | `[]`                                | 32-byte ledger ID signed into each transfer                                                                                                                                                                               |
| `eth_chainId`               | `[]`                                | Separately configured numeric provider chain ID as a hex quantity                                                                                                                                                         |
| `eth_blockNumber`           | `[]`                                | Latest committed log height as a hex quantity                                                                                                                                                                             |
| `eth_getBalance`            | `[address,block?]`                  | Integer native weight at a 20-byte read handle. Block accepts `latest` (default), `earliest`, or a canonical hex height. Unknown handle returns `0x0`, future height returns `-32001`, ambiguous handle returns `-32004`. |
| `demos_getHead`             | `[]`                                | `{chainId,height}`; genesis is height `0x0`                                                                                                                                                                               |
| `demos_getUnit`             | `[id]`                              | `{id,weight,suite,commitment,createdHeight,spentHeight}`; `spentHeight` is `null` for a live unit                                                                                                                         |
| `demos_listUnspent`         | `[suite,commitment,limit,afterId?]` | Units in ascending ID order after an exclusive cursor; limit is an integer from 1 to 64. Fresh commitment rules allow at most one match per commitment.                                                                   |
| `demos_sendRawTransfer`     | `[wire]`                            | The 64-byte native move ID after the database commits                                                                                                                                                                     |
| `demos_getTransfer`         | `[moveId]`                          | `{id,height,inputId,outputId,wire}`                                                                                                                                                                                       |
| `demos_getTransferByHeight` | `[height]`                          | The same receipt by log position                                                                                                                                                                                          |

A native verifier checks the signed chain ID, expiry at the candidate height, denomination, opening, both suite policies and signature. A transaction advances the expected head, marks the source spent, inserts the recipient under its unique commitment, and appends the receipt. If another worker wins, the loser reloads the head and validates against the new height. Submitting exactly the same signed bytes again returns the original move ID, including concurrent retries and retries after restart. A different signed transfer that spends the same input is rejected. A native move ID is SHA-512 of the byte length of `move/id`, the ASCII tag `move/id`, and all signed wire bytes, as defined by the codec.

The 20-byte Ethereum read handle is the last 20 bytes of Keccak-256 of the one-byte suite followed by the full 64-byte owner commitment. A spend requires the native signed wire and full commitment. The RPC implements the three Ethereum read methods listed above. EVM transactions, contracts and gas are outside its method set. [Public wallet guide](https://github.com/p2party/p2party-js/blob/master/docs/testnet-1.md) · [Client source archive](https://p2party.com/downloads/testnet-1/ledger-client-source.tar.gz)

`LEDGER_CORS_ORIGINS` accepts up to 16 comma-separated exact HTTPS origins, or HTTP origins on localhost or a loopback address. Leaving it empty allows same-origin browser access. Setting it explicitly to `*` allows anonymous cross-origin access for a public node. Credentialed CORS is disabled. Allowed preflights accept `POST` and `Content-Type`. Requests are limited to 68 KiB, eight sequential calls per batch, eight simultaneous requests per worker and a five-second body-read deadline. The native verifier accepts exactly the 5,505-byte or 16,516-byte format and is given three seconds per invocation. Conflicting spends, invalid transfers or reused commitments return `-32010`. Contended submissions may return `-32005` and can be retried. A worker at its request limit returns HTTP 429.

## Integration tests

Build `libdemos` with `cmake -S ledger -B build/ledger -DBUILD_TESTING=ON`, then `cmake --build build/ledger` and `ctest --test-dir build/ledger`. For the signaling tests, set `P2PARTY_TEST_LEDGER_VERIFIER` and `P2PARTY_TEST_LEDGER_FIXTURE` to the absolute paths of `demos-ledger-verify` and `demos-ledger-fixture`, and use the repository's isolated `P2PARTY_TEST_POSTGRES_URL`. Run `bun run check`. The fixture generates ephemeral signing keys and exports only synthetic authorized transfers and public commitments.

## Replay a local peer into a second database

Start a local proposer using this branch and the genesis and verifier settings above. Create an empty, separate PostgreSQL database for the replica. In the replica process, set `LEDGER_ENABLED`, `LEDGER_CHAIN_ID`, `LEDGER_GENESIS_FILE`, and `LEDGER_VERIFIER` independently. Use your own verified copy of the genesis and native verifier. The replica needs no spending key.

```sh
export LEDGER_REPLICA_DATABASE_URL='postgresql://localhost:55432/ledger_replica?sslmode=disable'
bun run ledger:verify-peer http://127.0.0.1:3001/rpc
bun run ledger:verify-peer http://127.0.0.1:3001/rpc 0x2 --serve
```

The first command verifies the advertised head. A peer above 10,000 transfers requires an explicit target height. The second command verifies through height two, prints the checkpoint, and serves the replica’s stored ledger through a read-only RPC at the printed loopback URL. The read API shows the latest locally accepted height even if you request a checkpoint at an earlier height. Run the first command again against the same replica database to catch up. A restart rechecks the accepted prefix. An interrupted synchronization preserves verified transfers and can be retried. Writer and replica databases have separate roles.

Compare checkpoints at the same height. The initial digest is SHA-512 of the UTF-8 domain `p2party/replay/v1`, a zero byte and the 32-byte canonical genesis hash returned by `demos_getGenesisHash`. This genesis hash covers the decoded chain ID, RPC chain ID, suite policy and sorted units. The downloadable file has a separate byte-level checksum. Each subsequent digest is SHA-512 of the preceding 64-byte digest, the height as eight big-endian bytes, and the 64-byte transfer ID. The replica recomputes each new transfer ID, signature, input spend and output from its own database and native verifier before committing it.

A matching checkpoint establishes agreement on that prefix. The proposer still selects transaction order and can withhold transfers. Replay reports the history it checked. Operators can attest to that prefix with the local command below. A conflicting prefix stops synchronization for operator review.

## Sign a local checkpoint

The commands below run on a local test network. The public Testnet 1 proposer still has one operator. Each signer runs Node 26.13.1 with post-quantum key support, Bun, its own verified genesis and verifier, and a dedicated replica database. Each uses a separate operator directory outside the checkout. The signing process replays a loopback peer. It never accepts a checkpoint supplied by that peer for signing.

For a two-operator exercise, each operator runs one of the first two commands on their own machine. Exchange the public PEM files and compare their printed key IDs over an independently trusted channel. The public keys identify checkpoint signers and carry no spending authority.

```sh
node tools/ledger-checkpoint.mjs init "$OPERATOR_A" ml-dsa-65
node tools/ledger-checkpoint.mjs init "$OPERATOR_B" slh-dsa-sha2-192s
node tools/ledger-checkpoint.mjs policy "$CHAIN_ID" "$GENESIS_HASH" a-public.pem b-public.pem > policy.json
```

Use the chain ID and **canonical genesis hash** from each operator’s verified genesis checkpoint. Each operator must pin the same roster. The policy supports two through sixteen distinct keys and requires every listed signature. Both suites can appear in one roster. An unavailable operator prevents issuing the next certificate. Current certificates have no automatic expiry and an older certificate can remain cryptographically valid. A client needing freshness must pin a minimum height or compare against a known recent checkpoint.

On each machine, set the same ledger environment as for `ledger:verify-peer`, including a dedicated `LEDGER_REPLICA_DATABASE_URL`. Set `LOCAL_RPC` to a local proposer or forwarded loopback peer, and `HEIGHT` to an explicit canonical hex height present on both replicas. Exchange the resulting public witness files.

```sh
node tools/ledger-checkpoint.mjs attest "$OPERATOR_A" policy.json "$LOCAL_RPC" "$HEIGHT" > a-witness.json
node tools/ledger-checkpoint.mjs attest "$OPERATOR_B" policy.json "$LOCAL_RPC" "$HEIGHT" > b-witness.json
node tools/ledger-checkpoint.mjs combine policy.json a-witness.json b-witness.json > certificate.json
node tools/ledger-checkpoint.mjs verify policy.json certificate.json "$LOCAL_RPC"
```

The verifier authenticates the certificate against the pinned policy, replays the same height and compares both digests. To check an archived certificate offline against a previously verified local replay, use `verify-file POLICY CERTIFICATE REPLAY_JSON`. Only use `REPLAY_JSON` from a trusted source. The signed statement binds the chain, genesis, height, rolling replay digest, receipt-log root, policy and signer identity. Each key signs a single versioned binary encoding. The tests include an independent encoding vector. [Checkpoint encoding](../../tools/checkpoint-crypto.mjs) · [ML-DSA standard](https://csrc.nist.gov/pubs/fips/204/final) · [SLH-DSA standard](https://csrc.nist.gov/pubs/fips/205/final)

The operator directory contains an unencrypted PKCS#8 secret protected by filesystem permissions and a SQLite decision journal. A successful signature and its height are committed together before the witness is printed. An exact retry returns the recorded witness. The next attestation must extend the previously signed prefix, including across a roster change. After losing or restoring a replica, catch it up to the last signed height before signing again. Protect the journal and key together. Cloning a key with two writable journals or restoring an old journal defeats this safeguard. The certificate attests to the listed keys' agreement on a prefix. Fork selection, operator independence, availability and finality require separate rules.

## Prove a receipt from a verified checkpoint

Each verified receipt contributes its 64-byte move ID in ledger order. Height one is leaf index zero. `logRoot` uses the [RFC 9162 tree shape and domain prefixes](https://www.rfc-editor.org/rfc/rfc9162#section-2.1) with SHA-512. It commits to ordered receipts; balances and spent-state proofs need a separate state commitment. The earlier `historyHash` remains available for comparing sequential replays.

With the `demos-ledger-log` executable built from the local libdemos receipt-proof branch, export a verified prefix to a new file. The exporter writes one lowercase, 0x-prefixed move ID per line. An interrupted or rejected verification leaves any existing destination untouched.

```sh
bun run ledger:verify-peer "$LOCAL_RPC" "$HEIGHT" --export-log receipts.txt > replay.json
node tools/ledger-checkpoint.mjs verify-file policy.json certificate.json replay.json > trusted.json
ROOT=$(jq -r .logRoot trusted.json)
demos-ledger-log inclusion "$INDEX" < receipts.txt > inclusion.txt
demos-ledger-log verify-inclusion "$HEIGHT" "$INDEX" "$MOVE_ID" "$ROOT" < inclusion.txt
```

To check that one certified tree extends another, verify each certificate against the same pinned policy, then call `demos-ledger-log consistency "$OLD_HEIGHT" < receipts.txt > consistency.txt`. The receiver calls `demos-ledger-log verify-consistency "$OLD_HEIGHT" "$HEIGHT" "$OLD_ROOT" "$ROOT" < consistency.txt` using those trusted roots. A proof for an empty prefix records no earlier receipts. Inclusion of a move does not establish that the corresponding output remains unspent.

### Exercising the four-suite configuration

Point `P2PARTY_TEST_LEDGER_VERIFIER`, `P2PARTY_TEST_LEDGER_FIXTURE` and `P2PARTY_TEST_LEDGER_LOG` at the three executables built from the native suite-extension revision `fc67c0c` on the `p2party/libdemos` branch `feat/ledger-sparse-state`. Use a disposable PostgreSQL server on loopback for `P2PARTY_TEST_POSTGRES_URL`. Set `P2PARTY_TEST_EXTENDED_LEDGER=1` and run `bun run check` and `npm run test:validator --prefix clients/evm`. The original two-suite genesis and its receipts remain valid. New local networks may opt into 3 and 4 in their genesis. Existing public Testnet 1 stays on its original two-suite policy.
