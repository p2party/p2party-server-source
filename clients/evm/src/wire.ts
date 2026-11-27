import { hasTransferHexLength, signatureSuites, type Suite } from "./suites.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";

export type Hex = `0x${string}`;
export type { Suite } from "./suites.js";
export type Owner = { suite: Suite; commitment: Hex };
export type Unit = Owner & {
  id: Hex;
  weight: Hex;
  createdHeight: Hex;
  spentHeight: Hex | null;
};
export type TransferReceipt = {
  id: Hex;
  height: Hex;
  inputId: Hex;
  outputId: Hex;
  wire: Hex;
};
export type LocalSigner = {
  suite: Suite;
  publicKey: Uint8Array;
  sign: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;
};

export const hex = (data: Uint8Array): Hex => `0x${bytesToHex(data)}`;
export function bytes(value: unknown, length: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length !== 2 + length * 2 ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  )
    throw new Error(`Expected ${length} hex bytes`);
  return hexToBytes(value.slice(2));
}
export function quantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(value)
  )
    throw new Error("Expected a canonical unsigned 64-bit quantity");
  return BigInt(value);
}
export function lengths(suite: Suite) {
  const entry = signatureSuites.find((entry) => entry.id === suite);
  if (!entry) throw new Error("Unknown post-quantum suite");
  return entry;
}
function tagged(tag: string, data: Uint8Array) {
  return sha512(concatBytes(Uint8Array.of(tag.length), utf8ToBytes(tag), data));
}
export function normalizeOwner(owner: Owner): Owner {
  lengths(owner.suite);
  return { suite: owner.suite, commitment: hex(bytes(owner.commitment, 64)) };
}
export function readHandle(owner: Owner): Hex {
  const { suite, commitment } = normalizeOwner(owner);
  return hex(
    keccak_256(
      concatBytes(Uint8Array.of(suite), bytes(commitment, 64)),
    ).subarray(12),
  );
}
export function receiveOwner(
  signer: Pick<LocalSigner, "suite" | "publicKey">,
  nonce: Uint8Array,
): Owner {
  const { suite, publicKey } = signer;
  if (nonce.length !== 32 || publicKey.length !== lengths(suite).key)
    throw new Error("Invalid receive nonce or public key length");
  return {
    suite,
    commitment: hex(
      tagged(
        "unit/owner",
        concatBytes(Uint8Array.of(suite), sha512(nonce), sha512(publicKey)),
      ),
    ),
  };
}
/** Uses the version-1 native transfer format. The wallet controls the signing key and the 32-byte receive nonce. */
export async function signTransfer(
  {
    chainId,
    input,
    recipient,
    expiryHeight,
  }: { chainId: Hex; input: Unit; recipient: Owner; expiryHeight: bigint },
  signer: LocalSigner,
  nonce: Uint8Array,
): Promise<Hex> {
  const { key, signature } = lengths(signer.suite);
  const source = receiveOwner(signer, nonce);
  const to = normalizeOwner(recipient);
  const weight = quantity(input.weight);
  if (
    source.suite !== input.suite ||
    source.commitment !== normalizeOwner(input).commitment ||
    input.spentHeight !== null
  )
    throw new Error(
      "Signing key and nonce must open the unspent input commitment",
    );
  if (source.commitment === to.commitment)
    throw new Error("The recipient needs a fresh commitment");
  if (
    weight === 0n ||
    (weight & (weight - 1n)) !== 0n ||
    expiryHeight < 0n ||
    expiryHeight > 0xffffffffffffffffn
  )
    throw new Error("Invalid unit weight or expiry height");
  const body = new Uint8Array(244 + key);
  const view = new DataView(body.buffer);
  body.set([1, 1]);
  body.set(bytes(chainId, 32), 2);
  body.set(bytes(input.id, 64), 34);
  view.setBigUint64(98, weight);
  view.setBigUint64(106, expiryHeight);
  body.set([source.suite, to.suite], 114);
  body.set(bytes(to.commitment, 64), 116);
  body.set(sha512(nonce), 180);
  body.set(signer.publicKey, 244);
  const signed = await signer.sign(tagged("move/body", body));
  if (signed.length !== signature)
    throw new Error("Signer returned an invalid post-quantum signature length");
  return hex(concatBytes(body, signed));
}
export function transferIds(wire: Hex, chainId: Hex) {
  if (typeof wire !== "string" || !hasTransferHexLength(wire.length))
    throw new Error("Expected a complete native signed transfer");
  const data = bytes(wire, (wire.length - 2) / 2);
  const { key, signature } = lengths(data[114] as Suite);
  lengths(data[115] as Suite);
  if (
    data[0] !== 1 ||
    data[1] !== 1 ||
    data.length !== 244 + key + signature ||
    hex(data.subarray(2, 34)) !== chainId
  )
    throw new Error("Wrong native transfer format or chain");
  const move = tagged("move/id", data);
  return {
    id: hex(move),
    inputId: hex(data.subarray(34, 98)),
    outputId: hex(tagged("unit/id", concatBytes(move, new Uint8Array(4)))),
  };
}
