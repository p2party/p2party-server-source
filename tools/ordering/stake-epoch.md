# A fixed epoch funded by native P2PARTY units

This local experiment starts with disposable wallets and an independently pinned synthetic genesis. A holder can delegate the entire weight of a unit to a validator, retain its reclaim key and verify its lock from a certified checkpoint. The same validators use the bonded weights for data availability, DAG parents, anchor decisions, proposer rotation and execution certificates. Testnet 1 still runs the PostgreSQL sequencer.

## Reproduce the experiment

Build the native tools and set `P2PARTY_NATIVE_BIN` as described in the [native replay instructions](native-replay.md). Then run:

```sh
bun test tools/ordering/stake-epoch.test.ts
```

The fixture bonds five units across four operators whose weights total ten. Two operators holding eight units certify a transfer. Three operators holding six fail the quorum check. The DAG accepts one four-unit supporter of an anchor and rejects two supporters who together hold two units. During the exit delay the scheduled leader goes offline. A later committed anchor lets the stake owners reclaim. Reopening a signer's SQLite journal preserves its final vote.

## Create and verify an epoch

1. Use `signStakeBond(network, terms, validatorPublicKey, unit, signer, inputNonce, freshReclaimNonce)` with a test wallet. Save the reclaim nonce in the wallet. The native transfer moves the unit to a fresh commitment controlled by the same signing key. A second signature authorizes the exact move ID, reclaim nonce hash, target validator ID, chain ID, genesis fingerprint, epoch number, last transaction round and exit delay. Both signatures use the unit's existing suite.
2. Collect the signed bond records under `{epoch, activeThroughRound, exitDelayRounds, bonds}`. Both round counts must be even and at least two. The provisioning operator can derive the registry ID with `buildStakeEpoch(config, nativeBin, manifest)`. Each validator then calls the same function **with its independently pinned registry ID** as the fourth argument. The operator supplies the validated local genesis and absolute native binary path.
3. The builder sorts deposits by source ID, checks each distinct genesis funding unit and its typed authorization, reconstructs its reclaim commitment, and aggregates weights by validator key ID. Native replay must accept every deposit. Its normal signature, denomination, suite, expiry, commitment-uniqueness and single-spend checks run on the entire ordered prefix. Each unit enters once at its complete genesis weight. Two to sixteen distinct validator keys can receive stake in this local bootstrap.
4. The returned `committee` carries a versioned identifier derived from the stake registry. The registry digest includes chain, genesis, epoch terms and each output ID, target and whole-unit weight. An output ID already commits to its entire signed funding wire. The output's native commitment and its separate stake lock can therefore be checked against a pinned registry. Recipients' identities are pseudonymous. Reuse of a funding key, public weight and visible target disclose links between bonds.
5. Construct a `Validator` with that committee, its own key and a durable journal. Pass `epoch.replay` to `validator.attestExecution`. Each voter rebuilds the funding prefix, rejects attempts to spend locked outputs and applies ordinary transfers through the native verifier. `verifyWalletUnit` reports `stakeLock` on a bonded, unspent output. Its native spent-absence marker alone is insufficient to establish that it can be transferred during the epoch.

## Voting and reclaim

For total bonded weight `W`, availability votes, parents from the preceding round and execution attestations require distinct operators whose combined weight exceeds `2W/3`. Direct support for a Bullshark-style anchor must exceed `W/3`. Under the assumption of strictly less than one-third Byzantine stake, two strong quorums intersect in more weight than faulty signers can hold. Interleaved weighted round robin assigns each operator one leader turn per bonded unit in a full cycle. The schedule is predictable and can contain long runs when one operator controls most of the stake. Rounds and parent sets still contain at most one vertex per operator.

After `activeThroughRound`, new proposals must have empty transaction batches. The first committed anchor at or beyond `activeThroughRound + exitDelayRounds` can close the epoch. A missed leader can be skipped. A validator records one closing execution vote in the same durable transaction that prevents it from signing new votes for this epoch. Retries return its stored signature. The delay counts protocol rounds and gives no wall-clock guarantee.

A successor can call `epoch.settle(terminalHeader, closingExecutionCertificate, orderedWires, withdrawalWires)` to verify a **candidate** settlement. It checks the designated leader and delay, the closing stake quorum and the exact roots reproduced by the locked execution. It then allows explicitly submitted, native owner-signed transfers of the bonded outputs. Invalid signatures and double spends retain their normal rejection behavior. A spend seen during the lock is discarded from that prefix. The successor must itself order and finalize competing withdrawal candidates. A settlement returned by this helper has no successor execution certificate.

## Requirements before public activation

Genesis-funded admission makes the starting registry reproducible. A running network also needs a certified transition from each closing state into the next active validator registry, independent operators, stale-checkpoint and long-range attack protection, key recovery, and reviewed economic rules for slashing and rewards. The prototype uses the existing stateless ML-DSA and SLH-DSA suites and durable local signing journals. Copying keys or rolling back journal storage defeats their equivocation protection. LMS forward-only operator signing, slashing evidence processing and durable successor settlement remain open. Stake owners must keep their private keys and reclaim data. Reading an untrusted peer's choice of registry or old execution certificate cannot establish current network state. This weighted adaptation needs a protocol-specific safety and liveness review before public funds can depend on it.

The DAG's direct anchor rule and backward ordering come from Algorithms 1–2 in Spiegelman, A., Giridharan, N., Sonnino, A., and Kokoris-Kogias, L. (2022), _Bullshark: The Partially Synchronous Version_. The weighted rules and finite-epoch closure above are local adaptations. [Authors' paper, arXiv:2209.05633v1](https://arxiv.org/abs/2209.05633v1)
