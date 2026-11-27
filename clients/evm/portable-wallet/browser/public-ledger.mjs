import { transferIds } from "@p2party/ledger-client";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_sha2_192s } from "@noble/post-quantum/slh-dsa.js";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { CHAIN, WalletError, exactFields } from "../format.mjs";
import {
  CANONICAL_GENESIS,
  reportedBalance,
  snapshotFingerprint,
} from "../snapshot.mjs";

const SUITES = new Map([
  [1, ml_dsa65],
  [2, slh_dsa_sha2_192s],
]);
const wireHexLengths = new Set(
  Array.from(
    SUITES.values(),
    (suite) =>
      2 + 2 * (244 + suite.lengths.publicKey + suite.lengths.signature),
  ),
);
const LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_MOVES = 256;
const hex = (data) => "0x" + bytesToHex(data);
function tag(name, ...data) {
  return sha512(
    concatBytes(Uint8Array.of(name.length), utf8ToBytes(name), ...data),
  );
}
function invalid() {
  throw new WalletError(
    "The public receipt history does not verify against the pinned Testnet 1 checkpoint.",
  );
}
function checkPointState(checkpoint) {
  const snapshot = checkpoint.snapshot;
  reportedBalance(snapshot, []);
  if (
    !Array.isArray(checkpoint.spent) ||
    BigInt(checkpoint.spent.length) !== BigInt(snapshot.height)
  )
    invalid();
  const unspent = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  const ids = new Set(unspent.keys());
  const commitments = new Set(snapshot.units.map((unit) => unit.commitment));
  for (const entry of checkpoint.spent) {
    if (
      !exactFields(entry, ["id", "suite", "commitment"]) ||
      !SUITES.has(entry.suite) ||
      typeof entry.id !== "string" ||
      entry.id.length !== 130 ||
      !/^0x[0-9a-f]{128}$/.test(entry.id) ||
      typeof entry.commitment !== "string" ||
      entry.commitment.length !== 130 ||
      !/^0x[0-9a-f]{128}$/.test(entry.commitment) ||
      ids.has(entry.id) ||
      commitments.has(entry.commitment)
    )
      invalid();
    ids.add(entry.id);
    commitments.add(entry.commitment);
  }
  return { unspent, ids, commitments };
}
function applyWire(state, wire, height) {
  if (
    typeof wire !== "string" ||
    !wireHexLengths.has(wire.length) ||
    !/^0x[0-9a-f]+$/.test(wire)
  )
    invalid();
  const raw = hexToBytes(wire.slice(2));
  const { inputId, outputId } = transferIds(wire, CHAIN);
  const input = state.unspent.get(inputId);
  const suite = SUITES.get(raw[114]);
  if (!input || !suite || input.suite !== raw[114] || !SUITES.has(raw[115]))
    invalid();
  const bodyLength = 244 + suite.lengths.publicKey;
  const publicKey = raw.subarray(244, bodyLength);
  const source = hex(
    tag(
      "unit/owner",
      Uint8Array.of(raw[114]),
      raw.subarray(180, 244),
      sha512(publicKey),
    ),
  );
  const destination = hex(raw.subarray(116, 180));
  const header = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const weight = header.getBigUint64(98),
    expiry = header.getBigUint64(106);
  if (
    source !== input.commitment ||
    weight !== BigInt(input.weight) ||
    (expiry !== 0n && height > expiry) ||
    state.ids.has(outputId) ||
    state.commitments.has(destination) ||
    !suite.verify(
      raw.subarray(bodyLength),
      tag("move/body", raw.subarray(0, bodyLength)),
      publicKey,
    )
  )
    invalid();
  state.unspent.delete(inputId);
  state.unspent.set(outputId, {
    id: outputId,
    suite: raw[115],
    commitment: destination,
    weight: input.weight,
  });
  state.ids.add(outputId);
  state.commitments.add(destination);
}

// A valid extension authenticates transitions from the shipped checkpoint. Freshness and
// the choice of single-sequencer history still depend on the reporting public validator.
export async function verifyPublicHistory(checkpoint, response, signal) {
  try {
    if (
      !exactFields(response, [
        "type",
        "chainId",
        "genesisHash",
        "fromHeight",
        "headHeight",
        "receipts",
        "snapshot",
      ]) ||
      response.type !== "p2party.wallet.snapshot.v1" ||
      response.chainId !== CHAIN ||
      response.genesisHash !== CANONICAL_GENESIS ||
      response.fromHeight !== checkpoint.snapshot.height ||
      !Array.isArray(response.receipts)
    )
      invalid();
    reportedBalance(response.snapshot, []);
    if (response.headHeight !== response.snapshot.height) invalid();
    const length = BigInt(response.headHeight) - BigInt(response.fromHeight);
    if (length > BigInt(MAX_MOVES) || response.receipts.length > MAX_MOVES)
      throw new WalletError(
        "This history exceeds the wallet's refresh limit. Use a newer verified wallet release or import a trusted replica snapshot.",
      );
    if (length !== BigInt(response.receipts.length)) invalid();
    const state = checkPointState(checkpoint);
    let height = BigInt(response.fromHeight),
      size = 0;
    for (const wire of response.receipts) {
      if (typeof wire !== "string") invalid();
      size += wire.length;
      if (size > LIMIT_BYTES)
        throw new WalletError(
          "This history exceeds the wallet's refresh limit. Use a newer verified wallet release or import a trusted replica snapshot.",
        );
      signal?.throwIfAborted();
      applyWire(state, wire, ++height);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    const derived = {
      ...checkpoint.snapshot,
      height: response.headHeight,
      units: [...state.unspent.values()],
    };
    if (snapshotFingerprint(derived) !== snapshotFingerprint(response.snapshot))
      invalid();
    return derived;
  } catch (error) {
    if (error instanceof WalletError || signal?.aborted) throw error;
    invalid();
  }
}
