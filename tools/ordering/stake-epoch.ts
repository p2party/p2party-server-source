import { createHash, createPublicKey, verify } from "node:crypto";
import {
  signTransfer,
  receiveOwner,
  receiveOwnerFromNonceHash,
  transferIds,
  lengths,
  type Hex,
  type Unit,
  type LocalSigner,
} from "../../clients/evm/src/wire.ts";
import { isSuite } from "../../clients/evm/src/suites.ts";
import {
  checkPinnedGenesis,
  type LedgerConfig,
} from "../../src/ledger/config.ts";
import { readOperator } from "../checkpoint-crypto.mjs";
import { digest, fields, fixed, hex, u32 } from "./committee.mjs";
import { anchorAuthor, vertexId } from "./dag.mjs";
import { verifyExecutionCertificate } from "./execution.mjs";
import { createOrderedLedger } from "./native-replay.ts";

type Terms = {
  epoch: number;
  activeThroughRound: number;
  exitDelayRounds: number;
};
type Network = { chainId: Hex; genesisHash: Hex };
type Bond = {
  validatorPublicKey: string;
  wire: Hex;
  nonceHash: Hex;
  signature: Hex;
};
export type StakeManifest = Terms & { bonds: Bond[] };

function checkedTerms({ epoch, activeThroughRound, exitDelayRounds }: Terms) {
  const encoded = [u32(epoch), u32(activeThroughRound), u32(exitDelayRounds)];
  if (
    activeThroughRound < 2 ||
    activeThroughRound % 2 ||
    exitDelayRounds < 2 ||
    exitDelayRounds % 2 ||
    activeThroughRound + exitDelayRounds + 2 > 0xffffffff
  )
    throw Error(
      "Stake epoch requires even active and delay rounds of at least two",
    );
  return encoded;
}
function bondIntent(
  network: Network,
  terms: Terms,
  validatorId: string,
  moveId: Hex,
  nonceHash: Hex,
) {
  return digest(
    "stake-bond",
    fixed(network.chainId, 32),
    fixed(network.genesisHash, 32),
    ...checkedTerms(terms),
    fixed(validatorId, 64),
    fixed(moveId, 64),
    fixed(nonceHash, 64),
  );
}
/** Both signatures belong to the funding owner. Keep the fresh reclaim nonce. */
export async function signStakeBond(
  network: Network,
  terms: Terms,
  validatorPublicKey: string,
  input: Unit,
  owner: LocalSigner,
  inputNonce: Uint8Array,
  reclaimNonce: Uint8Array,
): Promise<Bond> {
  const target = readOperator(validatorPublicKey);
  const nonceHash = hex(
    createHash("sha512").update(reclaimNonce).digest(),
  ) as Hex;
  const recipient = receiveOwner(owner, reclaimNonce);
  const wire = await signTransfer(
    { chainId: network.chainId, input, recipient, expiryHeight: 0n },
    owner,
    inputNonce,
  );
  const moveId = transferIds(wire, network.chainId).id;
  const signature = hex(
    Buffer.from(
      await owner.sign(
        bondIntent(network, terms, target.keyId, moveId, nonceHash),
      ),
    ),
  ) as Hex;
  return { validatorPublicKey, wire, nonceHash, signature };
}

/** Only local, genesis-funded fixtures use this bootstrap registry. Pin its ID
 * independently on each validator before voting. No network-facing stake RPC. */
export async function buildStakeEpoch(
  sourceConfig: LedgerConfig,
  nativeBin: string,
  sourceManifest: StakeManifest,
  expectedRegistryId?: string,
) {
  const config = structuredClone(sourceConfig);
  const network: Network = {
    chainId: config.chainId as Hex,
    genesisHash: ("0x" + config.genesisHash) as Hex,
  };
  checkPinnedGenesis(config, network);
  const manifest = structuredClone(sourceManifest);
  fields(manifest, ["epoch", "activeThroughRound", "exitDelayRounds", "bonds"]);
  const encodedTerms = checkedTerms(manifest);
  if (
    !Array.isArray(manifest.bonds) ||
    manifest.bonds.length < 2 ||
    manifest.bonds.length > config.units.length
  )
    throw Error("Invalid genesis stake bond count");
  const funding = new Map(config.units.map((unit) => [unit.id, unit]));
  const inputs = new Set<string>(),
    locked = new Set<string>();
  const keys = new Map<string, ReturnType<typeof readOperator>>();
  const byOperator = new Map<string, bigint>();
  const deposits = manifest.bonds
    .map((bond) => {
      fields(bond, ["validatorPublicKey", "wire", "nonceHash", "signature"]);
      const validator = readOperator(bond.validatorPublicKey);
      const ids = transferIds(bond.wire, network.chainId);
      const source = funding.get(ids.inputId);
      if (!source || inputs.has(ids.inputId) || locked.has(ids.outputId))
        throw Error("Absent or duplicate genesis funding unit");
      const raw = fixed(bond.wire, (bond.wire.length - 2) / 2);
      const suite = raw[114];
      if (
        !isSuite(suite) ||
        suite !== source.suite ||
        suite !== raw[115] ||
        !(config.spendMask & (1 << (suite - 1))) ||
        !(config.receiveMask & (1 << (suite - 1)))
      )
        throw Error("Bond requires a spendable reclaim suite");
      const { key, algorithm, signature } = lengths(suite);
      const rawKey = raw.subarray(244, 244 + key);
      const reclaim = receiveOwnerFromNonceHash(
        { suite, publicKey: rawKey },
        fixed(bond.nonceHash, 64),
      );
      if (reclaim.commitment !== hex(raw.subarray(116, 180)))
        throw Error("Reclaim commitment must belong to the funding key");
      const publicKey = createPublicKey({
        key: rawKey,
        format: "raw-public",
        asymmetricKeyType: algorithm,
      });
      if (
        !verify(
          null,
          bondIntent(
            network,
            manifest,
            validator.keyId,
            ids.id,
            bond.nonceHash,
          ),
          publicKey,
          fixed(bond.signature, signature),
        )
      )
        throw Error("Invalid owner stake authorization");
      const weight = BigInt(source.weight);
      if (weight !== raw.readBigUInt64BE(98))
        throw Error("Incorrect bond weight");
      inputs.add(ids.inputId);
      locked.add(ids.outputId);
      keys.set(validator.keyId, validator);
      byOperator.set(
        validator.keyId,
        (byOperator.get(validator.keyId) ?? 0n) + weight,
      );
      return { ...ids, wire: bond.wire, keyId: validator.keyId, weight };
    })
    .sort((a, b) => (a.inputId < b.inputId ? -1 : 1));
  if (keys.size < 2 || keys.size > 16)
    throw Error("Expected 2 to 16 stake targets");
  const operators = Object.freeze(
    [...keys.values()].sort((a, b) => (a.keyId < b.keyId ? -1 : 1)),
  );
  const weights = Object.freeze(
    operators.map((key) => byOperator.get(key.keyId)!),
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0n);
  const prefix = deposits.map((deposit) => deposit.wire);
  const ledger = createOrderedLedger(config, network, nativeBin);
  const registryId = hex(
    digest(
      "stake-registry",
      fixed(network.chainId, 32),
      fixed(network.genesisHash, 32),
      ...encodedTerms,
      u32(prefix.length),
      ...deposits.map((d) =>
        Buffer.concat([
          fixed(d.outputId, 64),
          fixed(d.keyId, 64),
          fixed("0x" + d.weight.toString(16).padStart(16, "0"), 8),
        ]),
      ),
    ),
  );
  if (expectedRegistryId !== undefined && expectedRegistryId !== registryId)
    throw Error("Stake registry differs from local pin");
  const initial = await ledger.replay(prefix);
  if (BigInt(initial.height) !== BigInt(prefix.length))
    throw Error("Native replay rejected a funding transfer");
  const isLockedSpend = (wire: string) =>
    typeof wire === "string" && locked.has("0x" + wire.slice(70, 198));
  const epochPrefix = (ordered: readonly string[]) => [
    ...prefix,
    ...ordered.filter((wire) => !isLockedSpend(wire)),
  ];
  const snapshot = (ordered: readonly string[]) =>
    ledger.snapshot(epochPrefix(ordered));
  const replay = (ordered: readonly string[]) =>
    ledger.replay(epochPrefix(ordered));

  const committee = Object.freeze({
    ...network,
    epoch: manifest.epoch,
    activeThroughRound: manifest.activeThroughRound,
    terminalRound: manifest.activeThroughRound + manifest.exitDelayRounds,
    operators,
    weights,
    totalWeight,
    registryId,
    replay,
    bondedOutputs: Object.freeze([...locked].sort()),
    committeeId: hex(digest("stake-committee", fixed(registryId, 64))),
  });
  // Replay on a successor verifies that the final anchor has the designated
  // round/leader, a weighted execution certificate, and identical local roots.
  // Only then are fresh owner-signed whole-unit withdrawals eligible.
  async function settle(
    terminalHeader: {
      committeeId: string;
      round: number;
      author: number;
      parents: string[];
      moves: string[];
    },
    certificate: unknown,
    ordered: readonly string[],
    withdrawals: readonly string[],
  ) {
    const header = structuredClone(terminalHeader),
      cert = structuredClone(certificate);
    const history = epochPrefix(ordered),
      exits = [...withdrawals];
    if (
      header.round < committee.terminalRound ||
      header.author !== anchorAuthor(committee, header.round)
    )
      throw Error("Expected terminal stake anchor after the exit delay");
    const anchorId = vertexId(committee, header);
    const roots = await ledger.replay(history);
    verifyExecutionCertificate(
      committee,
      { ...network, committeeId: committee.committeeId, anchorId, ...roots },
      cert,
    );
    if (!exits.every(isLockedSpend))
      throw Error("Settlement accepts only bonded inputs");
    // An early spend is discarded from the active prefix. Release requires
    // an explicit submission after the certified close.
    return ledger.snapshot([...history, ...exits]);
  }
  return Object.freeze({ committee, registryId, replay, snapshot, settle });
}
