import { createPublicKey, sign, type KeyObject } from "node:crypto";
import type { LocalSigner } from "./wire.js";
import { signatureSuites } from "./suites.js";

/** Adapt a caller-owned Node post-quantum key; the private key is never exported. */
export function nodeSigner(privateKey: KeyObject): LocalSigner {
  if (privateKey.type !== "private")
    throw new Error("Expected a private signing key");
  const suite = signatureSuites.find(
    (entry) => entry.algorithm === privateKey.asymmetricKeyType,
  )?.id;
  if (!suite) throw new Error("Use a supported ML-DSA or SLH-DSA signing key");
  const publicKey = createPublicKey(privateKey).export({
    format: "raw-public",
  });
  return { suite, publicKey, sign: (digest) => sign(null, digest, privateKey) };
}
