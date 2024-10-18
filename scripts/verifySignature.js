import crypto from "crypto";

const [nonceHex, sigHex, publicKeyPem] = process.argv.slice(2);

const nonce = Buffer.from(nonceHex, "hex");
const sig = Buffer.from(sigHex, "hex");

const publicKey = crypto.createPublicKey({
  key: publicKeyPem,
  format: "pem",
  type: "spki",
});

const isVerified = crypto.verify(
  "RSA-SHA256",
  nonce,
  {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  },
  sig,
);

// Output the result to stdout
console.log(isVerified ? "true" : "false");
