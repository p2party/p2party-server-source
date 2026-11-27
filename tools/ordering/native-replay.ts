import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  bytes,
  hex,
  hexQuantity,
  RpcError,
  type LedgerConfig,
} from "../../src/ledger/config.ts";
import { validateTransfer, type StoredUnit } from "../../src/ledger/native.ts";
import { ReceiptFrontier } from "../../src/ledger/receiptFrontier.ts";
import { hasTransferHexLength } from "../../clients/evm/src/suites.ts";
import type { WalletProof } from "./wallet-proof.ts";

export type ReplayRoots = {
  height: string;
  logRoot: string;
  stateRoot: string;
};
type Network = { chainId: string; genesisHash: string };

export function checkGenesis(config: LedgerConfig, network: Network) {
  if (
    config.chainId !== network.chainId ||
    "0x" + config.genesisHash !== network.genesisHash
  )
    throw new Error("Local genesis differs from the pinned committee");
}

/** Replay starts at the locally validated genesis on every call. A verifier error
 * aborts the whole call, so no partial checkpoint or witness can escape. */
export function createOrderedLedger(
  config: LedgerConfig,
  committee: Network,
  nativeBin: string,
) {
  checkGenesis(config, committee);
  if (!isAbsolute(nativeBin))
    throw new Error("Supply an absolute native binary directory");
  function tool(name: "state" | "log", args: string[], input: string) {
    return execFileSync(join(nativeBin, "demos-ledger-" + name), args, {
      input,
      env: {},
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
  }
  async function snapshot(orderedWires: readonly string[]) {
    const units = new Map<string, StoredUnit>();
    const owners = new Set<string>();
    const receipts: { id: string; wire: string }[] = [];
    const moves = new Set<string>();
    const seenWires = new Set<string>();
    const frontier = new ReceiptFrontier();
    const claims = [];
    for (const unit of config.units) {
      units.set(unit.id, {
        id: bytes(unit.id, 64),
        suite: unit.suite,
        weight: BigInt(unit.weight).toString(),
        commitment: bytes(unit.commitment, 64),
        created: "0",
        spent: null,
      });
      owners.add(unit.commitment);
      claims.push("owner " + unit.commitment + "\n");
    }
    for (const candidate of orderedWires) {
      if (
        typeof candidate !== "string" ||
        !hasTransferHexLength(candidate.length) ||
        !/^0x[0-9a-f]+$/.test(candidate)
      )
        continue;
      // The DAG gives each wire one ordered position, including rejected wires.
      if (seenWires.has(candidate)) continue;
      seenWires.add(candidate);
      const wire = Buffer.from(candidate.slice(2), "hex");
      const source = units.get(hex(wire.subarray(34, 98)));
      if (!source || source.spent !== null) continue;
      const height = BigInt(receipts.length) + 1n;
      let result;
      try {
        result = await validateTransfer(config, height, source, wire);
      } catch (err) {
        if (err instanceof RpcError && err.code === -32010) continue;
        throw err;
      }
      const owner = hex(result.commitment),
        id = hex(result.id),
        output = hex(result.outputId);
      if (owners.has(owner) || moves.has(id) || units.has(output)) continue;
      // The native offline set generator permits at most 65,536 distinct claims.
      if (claims.length + 3 > 65536)
        throw new Error("Local state snapshot capacity exceeded");
      units.set(output, {
        id: result.outputId,
        weight: source.weight,
        suite: result.suite,
        commitment: result.commitment,
        created: height.toString(),
        spent: null,
      });
      source.spent = height.toString();
      owners.add(owner);
      moves.add(id);
      receipts.push({ id, wire: candidate });
      claims.push(
        "spent " + hex(source.id) + "\n",
        "move " + id + "\n",
        "owner " + owner + "\n",
      );
      frontier.append(result.id);
    }
    const exported = claims.join("");
    const stateRoot = tool("state", ["root", "-"], exported)
      .toString("ascii")
      .trimEnd();
    bytes(stateRoot, 64);
    const roots: ReplayRoots = {
      height: hexQuantity(receipts.length),
      logRoot: hex(frontier.root()),
      stateRoot,
    };
    function prove(unitId: string): WalletProof {
      const unit = units.get(unitId);
      if (!unit) throw new Error("Unknown unit");
      const proof = (kind: string, id: string) =>
        hex(tool("state", ["prove", "-", kind, id], exported));
      const witnesses = {
        spent: proof("spent", unitId),
        owner: proof("owner", hex(unit.commitment)),
      };
      if (unit.created === "0") return { origin: "genesis", ...witnesses };
      const pos = Number(unit.created) - 1;
      const receipt = receipts[pos]!;
      const path = tool(
        "log",
        ["inclusion", hexQuantity(pos)],
        receipts.map((r) => r.id + "\n").join(""),
      )
        .toString("ascii")
        .trimEnd();
      return {
        origin: "transfer",
        index: hexQuantity(pos),
        wire: receipt.wire,
        inclusion: path ? path.split("\n") : [],
        move: proof("move", receipt.id),
        ...witnesses,
      };
    }
    return { roots, prove };
  }
  return {
    snapshot,
    replay: async (orderedWires: readonly string[]) =>
      (await snapshot(orderedWires)).roots,
  };
}
