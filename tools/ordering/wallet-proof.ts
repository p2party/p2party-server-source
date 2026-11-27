import { createHash } from "node:crypto";
import {
  bytes,
  checkPinnedGenesis,
  hex,
  hexQuantity,
  quantity,
  type LedgerConfig,
} from "../../src/ledger/config.ts";
import { isSuite } from "../../clients/evm/src/suites.ts";
import { transferIds, type Hex } from "../../clients/evm/src/wire.ts";
import { fields, type makeCommittee } from "./committee.mjs";
import { verifyExecutionCertificate } from "./execution.mjs";
import type { ReplayRoots } from "./native-replay.ts";

type Claim = "spent" | "move" | "owner";
const kindId = { spent: 1, move: 2, owner: 3 } as const;
const bit = (b: Buffer, i: number) => (b[i >> 3]! >> (7 - (i & 7))) & 1;
function tagged(tag: string, ...parts: Buffer[]) {
  const hash = createHash("sha512")
    .update(Buffer.from([tag.length]))
    .update(tag, "ascii");
  for (const part of parts) hash.update(part);
  return hash.digest();
}
const empty = [tagged("smt/empty")];
for (let height = 1; height <= 512; height++)
  empty.push(tagged("smt/node", empty[height - 1]!, empty[height - 1]!));

/** Independent, bounded decoder of the native DSS1 witness. */
export function verifyClaim(
  root: string,
  kind: Claim,
  id: string,
  present: boolean,
  witness: string,
) {
  if (
    typeof present !== "boolean" ||
    !Object.hasOwn(kindId, kind) ||
    typeof witness !== "string" ||
    witness.length < 270 ||
    witness.length > 65806
  )
    throw new Error("Invalid state proof length");
  const raw = bytes(witness, (witness.length - 2) / 2);
  if (
    raw.length * 2 + 2 !== witness.length ||
    (raw.length - 134) % 64 ||
    !raw.subarray(0, 4).equals(Buffer.from("DSS1")) ||
    raw[4] !== kindId[kind] ||
    raw[5] !== Number(present) ||
    !raw.subarray(6, 70).equals(bytes(id, 64))
  )
    throw new Error("Invalid state claim");
  const key = tagged("smt/" + kind, raw.subarray(6, 70));
  const bitmap = raw.subarray(70, 134);
  let node = present ? tagged("smt/leaf", key) : empty[0]!;
  let end = raw.length;
  for (let depth = 511; depth >= 0; depth--) {
    const defaultHash = empty[511 - depth]!;
    let sibling: Buffer = defaultHash;
    if (bit(bitmap, depth)) {
      end -= 64;
      if (end < 134) throw new Error("Missing state proof sibling");
      sibling = raw.subarray(end, end + 64);
      if (defaultHash.equals(sibling))
        throw new Error("Redundant empty state proof sibling");
    }
    node = bit(key, depth)
      ? tagged("smt/node", sibling, node)
      : tagged("smt/node", node, sibling);
  }
  if (end !== 134 || !node.equals(bytes(root, 64)))
    throw new Error("State proof differs from checkpoint");
}

function verifyInclusion(
  root: string,
  size: bigint,
  index: bigint,
  id: string,
  path: string[],
) {
  if (index >= size || !Array.isArray(path) || path.length > 63)
    throw new Error("Invalid receipt inclusion proof");
  let consumed = 0;
  const sibling = () => {
    if (consumed === path.length)
      throw new Error("Missing receipt proof sibling");
    return bytes(path[consumed++], 64);
  };
  function fold(n: bigint, i: bigint): Buffer {
    if (n === 1n)
      return createHash("sha512")
        .update(Buffer.of(0))
        .update(bytes(id, 64))
        .digest();
    let k = 1n;
    while (k << 1n < n) k <<= 1n;
    const left = i < k;
    const child = left ? fold(k, i) : fold(n - k, i - k);
    const other = sibling();
    return createHash("sha512")
      .update(Buffer.of(1))
      .update(left ? child : other)
      .update(left ? other : child)
      .digest();
  }
  if (!fold(size, index).equals(bytes(root, 64)) || consumed !== path.length)
    throw new Error("Receipt proof differs from checkpoint");
}

type Witnesses = { spent: string; owner: string };
export type WalletProof = Witnesses &
  (
    | { origin: "genesis" }
    | {
        origin: "transfer";
        index: string;
        wire: string;
        inclusion: string[];
        move: string;
      }
  );
type Checkpoint = ReplayRoots & {
  chainId: string;
  genesisHash: string;
  committeeId: string;
  anchorId: string;
};
type ExpectedUnit = {
  id: string;
  suite: number;
  commitment: string;
  weight?: string;
};

/** The caller pins the committee, complete current checkpoint and local genesis.
 * Proof data may originate from an untrusted peer. */
export function verifyWalletUnit(
  config: LedgerConfig,
  committee: Pick<
    ReturnType<typeof makeCommittee>,
    "committeeId" | "chainId" | "genesisHash" | "operators"
  > & {
    bondedOutputs?: readonly string[];
    registryId?: string;
    terminalRound?: number;
  },
  expected: Checkpoint,
  certificate: unknown,
  requested: ExpectedUnit,
  proof: WalletProof,
) {
  const cp = verifyExecutionCertificate(committee, expected, certificate);
  checkPinnedGenesis(config, cp);
  const withWeight = requested != null && Object.hasOwn(requested, "weight");
  fields(
    requested,
    withWeight
      ? ["id", "suite", "commitment", "weight"]
      : ["id", "suite", "commitment"],
  );
  bytes(requested.id, 64);
  bytes(requested.commitment, 64);
  if (!isSuite(requested.suite))
    throw new Error("Invalid requested owner suite");
  if (withWeight) quantity(requested.weight, 1n << 63n);
  if (!proof || typeof proof !== "object")
    throw new Error("Invalid wallet proof");
  let id: string,
    suite: number,
    commitment: string,
    weight: string,
    createdHeight: string;
  if (proof.origin === "genesis") {
    fields(proof, ["origin", "spent", "owner"]);
    const unit = config.units.find((u) => u.id === requested.id);
    if (!unit) throw new Error("Unit absent from local genesis");
    ({ id, suite, commitment, weight } = unit);
    createdHeight = "0x0";
  } else if (proof.origin === "transfer") {
    fields(proof, [
      "origin",
      "spent",
      "owner",
      "wire",
      "index",
      "move",
      "inclusion",
    ]);
    const move = transferIds(proof.wire as Hex, config.chainId as Hex);
    // transferIds validates wire length, suite IDs, version and chain. Inclusion
    // in this certified execution binds the entire wire to an accepted move.
    const wire = bytes(proof.wire, (proof.wire.length - 2) / 2);
    const index = quantity(proof.index);
    verifyInclusion(
      cp.logRoot,
      quantity(cp.height),
      index,
      move.id,
      proof.inclusion,
    );
    verifyClaim(cp.stateRoot, "move", move.id, true, proof.move);
    id = move.outputId;
    suite = wire[115]!;
    commitment = hex(wire.subarray(116, 180));
    weight = hexQuantity(wire.readBigUInt64BE(98));
    createdHeight = hexQuantity(index + 1n);
  } else throw new Error("Unknown wallet proof origin");
  if (
    id !== requested.id ||
    suite !== requested.suite ||
    commitment !== requested.commitment ||
    (withWeight && weight !== requested.weight)
  )
    throw new Error("Proof differs from requested unit, weight or full owner");
  verifyClaim(cp.stateRoot, "owner", commitment, true, proof.owner);
  verifyClaim(cp.stateRoot, "spent", id, false, proof.spent);
  const unit = {
    id,
    suite,
    commitment,
    weight,
    createdHeight,
    spentHeight: null,
  };
  if (committee.bondedOutputs?.includes(id))
    return {
      ...unit,
      stakeLock: {
        registryId: committee.registryId,
        terminalRound: committee.terminalRound,
      },
    };
  return unit;
}
