import { createPublicKey, sign, type KeyObject } from "node:crypto";
import type { LocalSigner, Suite } from "./wire.js";

/** Adapt a caller-owned Node post-quantum key; the private key is never exported. */
export function nodeSigner(privateKey: KeyObject): LocalSigner {
  if (privateKey.type !== "private")
    throw new Error("Expected a private signing key");
  const type = privateKey.asymmetricKeyType;
  let suite: Suite;
  if (type === "ml-dsa-65") suite = 1;
  else if (type === "slh-dsa-sha2-192s") suite = 2;
  else throw new Error("Use an ML-DSA-65 or SLH-DSA-SHA2-192s signing key");
  const publicKey = createPublicKey(privateKey).export({
    format: "raw-public",
  });
  return { suite, publicKey, sign: (digest) => sign(null, digest, privateKey) };
}
