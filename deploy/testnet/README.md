# P2Party Testnet 1

This is a public development network for experimenting with native post-quantum transfers. The 128 genesis units have weight one and no monetary value. A single signaling validator orders transfers. Anyone can query units and receipts or submit a correctly signed transfer. The testnet has no public mint.

| Setting                  | Value                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| JSON-RPC                 | `https://signaling.p2party.com/rpc`                                  |
| Health                   | `https://signaling.p2party.com/rpc/health`                           |
| Native ledger ID         | `0x09a0ffa8e6af6aeb11d26671c6c76648965d60509cc3b7a1a4b454b6ec73c760` |
| Ethereum client chain ID | `1345474644` (`0x50325054`)                                          |
| Genesis SHA-256          | `38d42d50a5a6d5ceb43fd6f63235e542716b1df5ccff59161c5fd7810aed17c6`   |
| Signing suites           | 1 = ML-DSA-65, 2 = SLH-DSA-SHA2-192s                                 |

Every receive commitment is single-use. Generate a fresh wallet key and nonce locally. To request one test unit, open a public issue titled **Testnet unit request** on this repository with the suite number and full 64-byte receive commitment. Keep the private key and nonce in your wallet. An operator can grant one of the remaining unspent genesis units and return its output ID. Use that ID to verify the result and spend it. [Client examples](../../clients/evm/README.md) · [Request a test unit](https://github.com/p2party/p2party-server/issues/new) · [Public genesis](genesis.json)

## Operator grants

Build the wallet library from its lockfile in `clients/evm` using `npm ci && npm run build`. On the operator's controller select one unspent input from the public genesis. Pipe the decrypted custody file to the grant command. Only the resulting public receipt belongs in the issue. Submitting the same grant again returns its existing receipt, even if the recipient has since spent the unit.

```sh
ansible-vault view --vault-password-file "$VAULT_PASSWORD_HELPER" "$TESTNET_CUSTODY_VAULT" |
  node deploy/testnet/grant-unit.mjs "$GENESIS_UNIT_ID" "$RECEIVE_SUITE" "$RECEIVE_COMMITMENT"
```

## Roadmap

Testnet 1 exercises algorithm selection, exact receipt recovery, double-spend protection and native currency access through ethers and viem. Distributed proof-of-stake ordering, independent validators, staking and recovery policies, denominations that can be split or joined, and mainnet supply decisions are future work. Testnet balances have no entitlement to future issuance. [Native verifier](https://github.com/ondemos/libdemos/tree/master/ledger)
