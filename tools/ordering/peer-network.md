# Four local stake-backed validators

Run this from the server checkout with Bun 1.4.5, Node 26.13.1 or later, the pinned native verifier and the client dependencies. It uses loopback TCP, disposable post-quantum keys, one synthetic genesis and four separate SQLite voting journals. [Native build instructions](native-replay.md#run-locally) · [Stake admission, thresholds and withdrawals](stake-epoch.md)

```sh
bun install --frozen-lockfile
npm ci --prefix clients/evm
export P2PARTY_NATIVE_BIN=/absolute/path/to/libdemos/build/ledger
./tools/ordering/test-peer-network.sh
```

## What the run checks

Four owners bond existing native units of weights 4, 4, 4 and 2. Each peer re-verifies the funding transactions, the separate owners’ delegation signatures, and its configured registry pin on startup. Only that peer opens its private operator file and its signing journal. This test’s coordinator creates those files under one administrative account.

1. Two processes start. Their combined weight of 8 out of 14 cannot certify a proposal. A wallet cannot get a fresh checkpoint from them.
2. A third process starts. Weight 12 exceeds two thirds. Each validator polls its configured peers, retrieves certified parents, proposes its next vertex and collects signed availability acknowledgments. The ledger accepts four funding bonds and two ordinary spends. All three validators agree on two ordering anchors.
3. A populated peer is killed. Its replacement advertises genuinely certified inventory while its certificate storage is unavailable. A fourth process starts from an empty journal, requests the missing data from the other sources, verifies signatures and parents, and replays native execution. The killed process reopens its journal. A certificate collected from all four matches the original round-four checkpoint at height six, including both roots.
4. A wallet retaining its pin accepts matching, freshly signed replies. It rejects an old challenge response, insufficient weight and a rollback from a higher saved round. After two processes stop, the reader retains the saved pin and reports an inconclusive fresh read.
5. Three processes resume ordering while the round-eight leader stays offline. They commit the next scheduled leader at round ten, sign the closing execution checkpoint and stop voting. A wallet can verify a candidate owner withdrawal against that certificate. A reopened validator still serves the closing vote and refuses freshness challenges for the closed epoch.

The timer starts when the third process launches and includes startup, durably storing votes, local communication and catch-up. Results depend on process scheduling and the filesystem. This is a functional recovery test. To compare designs, hold workload, cryptographic suites, stake distribution, persistence and network conditions constant. Measure acceptance-to-finality p50/p95/p99, finalized moves per second, bytes per committed move and stall/recovery time under loss. Compare against a specified baseline on independent networks.

## How a wallet reads a checkpoint

The reader pins the chain, genesis and stake registry locally, generates a random 32-byte challenge and sets a five-second deadline. Each peer signs the challenge, its latest locally committed round and the complete execution checkpoint. The reader verifies both the fresh reply and the execution attestation under the expected peer's key. It accepts the first group with **strictly more than two thirds** of the pinned weight attesting to identical data. Repeated indices add no weight. A minority or an unavailable peer cannot override a valid group. The reader rejects a lower round or height, different roots at the same height and a conflicting anchor at the same round. Callers retain the last verified pin on failure.

This establishes that a quorum recently confirmed that state in the pinned epoch. A stopped chain can confirm the same old height. If peers have moved to different anchors faster than the reader can collect matching replies, the read may fail and be retried with a new challenge. A node that signed epoch closure will no longer answer a freshness challenge. A production wallet also needs trusted bootstrap and successor-committee updates, plus an inclusion or consistency proof when checking a particular transaction or history extension.

## Scope of the transport

Each peer binds to 127.0.0.1. The fixture configures a finite run of up to 32 rounds, bounded message sizes and explicit local peer ports. Each data source has a separate poller with at most two simultaneous certificate fetches. Voting advances independently and can finish a collection as soon as verified acknowledgments meet the stake threshold. Consensus objects carry native post-quantum signatures. The transport and polling interval are for local tests. Independent administration, authenticated wide-area transport, a reviewed pacemaker, congestion control, certified membership transitions and wide-area measurements remain open. Testnet 1 uses its existing single public validator.
