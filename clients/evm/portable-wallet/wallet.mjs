import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { CompactEncrypt, compactDecrypt } from "jose";
import {
  receiveOwner,
  readHandle,
  signTransfer,
  transferIds,
} from "@p2party/ledger-client";
import { nodeSigner } from "@p2party/ledger-client/node";

export const CHAIN =
  "0x09a0ffa8e6af6aeb11d26671c6c76648965d60509cc3b7a1a4b454b6ec73c760";
export const GENESIS =
  "0x38d42d50a5a6d5ceb43fd6f63235e542716b1df5ccff59161c5fd7810aed17c6";
export const PROOF_CHAIN =
  "0x" +
  createHash("sha256")
    .update("P2Party offline wallet restore proof v1")
    .digest("hex");
export const MAX_ARCHIVE = 2 * 1024 * 1024;
const HEADER = { alg: "dir", enc: "A256GCM", typ: "p2party-wallet+jwe" };
const PROTECTED = Buffer.from(JSON.stringify(HEADER)).toString("base64url");
const ALGORITHMS = new Map([
  [1, "ml-dsa-65"],
  [2, "slh-dsa-sha2-192s"],
]);
const MAX_RECORDS = 64;
const utf8 = new TextDecoder("utf-8", { fatal: true });
export class WalletError extends Error {}
function requireWallet(ok, message) {
  if (!ok) throw new WalletError(message);
}
export function exactFields(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function checkSuite(suite) {
  requireWallet(
    ALGORITHMS.has(suite),
    "Select a supported Testnet 1 signing suite.",
  );
}
function bytes(value, min, max) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new Error("Invalid encoding");
  const out = Buffer.from(value, "base64url");
  if (
    out.length < min ||
    out.length > max ||
    out.toString("base64url") !== value
  )
    throw new Error("Invalid encoding");
  return out;
}
function record(privateKey, nonce, expectedSuite) {
  const signer = nodeSigner(privateKey);
  checkSuite(signer.suite);
  if (signer.suite !== expectedSuite || nonce.length !== 32)
    throw new Error("Wrong receive material");
  const owner = receiveOwner(signer, nonce);
  return {
    privateKey,
    nonce,
    owner,
    descriptor: { ...owner, readHandle: readHandle(owner) },
  };
}
function newRecord(suite) {
  checkSuite(suite);
  return record(
    generateKeyPairSync(ALGORITHMS.get(suite)).privateKey,
    randomBytes(32),
    suite,
  );
}
function serialized(entry) {
  const der = entry.privateKey.export({ type: "pkcs8", format: "der" });
  try {
    return {
      ...entry.owner,
      key: der.toString("base64url"),
      nonce: entry.nonce.toString("base64url"),
    };
  } finally {
    der.fill(0);
  }
}
function restoreRecord(value) {
  if (!exactFields(value, ["key", "nonce", "suite", "commitment"]))
    throw new Error("Wrong record");
  checkSuite(value.suite);
  const der = bytes(value.key, 32, 12 * 1024);
  const nonce = bytes(value.nonce, 32, 32);
  try {
    const key = createPrivateKey({ key: der, type: "pkcs8", format: "der" });
    const canonical = key.export({ type: "pkcs8", format: "der" });
    try {
      if (!canonical.equals(der)) throw new Error("Unexpected PKCS8 data");
    } finally {
      canonical.fill(0);
    }
    const entry = record(key, nonce, value.suite);
    if (entry.owner.commitment !== value.commitment)
      throw new Error("Commitment mismatch");
    return entry;
  } catch (error) {
    nonce.fill(0);
    throw error;
  } finally {
    der.fill(0);
  }
}
function encodeCode(key) {
  return "P2W1-" + key.toString("base64url");
}
function decodeCode(code) {
  if (typeof code !== "string" || !/^P2W1-[A-Za-z0-9_-]{43}$/.test(code))
    throw new Error("Wrong code");
  return bytes(code.slice(5), 32, 32);
}
export class Wallet {
  #key;
  #entries;
  #id;
  #confirmed;
  constructor(key, id, entries, confirmed) {
    this.#key = key;
    this.#id = id;
    this.#entries = entries;
    this.#confirmed = confirmed;
  }
  static create(suite) {
    return new Wallet(randomBytes(32), randomUUID(), [newRecord(suite)], 0);
  }
  static importLegacy(receives) {
    requireWallet(
      receives.length > 0 && receives.length <= MAX_RECORDS,
      "Choose between one and 64 receive records.",
    );
    const entries = receives.map(({ privateKey, nonce, commitment }) => {
      try {
        const key = createPrivateKey({
          key: privateKey,
          type: "pkcs8",
          format: "der",
        });
        const entry = record(key, Buffer.from(nonce), nodeSigner(key).suite);
        if (entry.owner.commitment !== commitment) throw new Error();
        return entry;
      } catch {
        throw new WalletError(
          "A signing key and nonce do not open their expected public commitment.",
        );
      }
    });
    requireWallet(
      new Set(entries.map((entry) => entry.owner.commitment)).size ===
        entries.length,
      "Each receive record must be distinct.",
    );
    return new Wallet(randomBytes(32), randomUUID(), entries, 0);
  }
  static async restore(archive, code) {
    let key, plaintext;
    const entries = [];
    try {
      if (
        typeof archive !== "string" ||
        archive.length > MAX_ARCHIVE ||
        !archive.startsWith(PROTECTED + "..")
      )
        throw new Error();
      const fields = archive.split(".");
      if (
        fields.length !== 5 ||
        fields[2].length !== 16 ||
        fields[4].length !== 22 ||
        /[^A-Za-z0-9_-]/.test(fields.slice(2).join(""))
      )
        throw new Error();
      // Reject non-canonical encodings, including modified unused tag bits.
      bytes(fields[4], 16, 16);
      const ciphertext = bytes(fields[3], 1, MAX_ARCHIVE);
      ciphertext.fill(0);
      key = decodeCode(code);
      ({ plaintext } = await compactDecrypt(archive, key, {
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      }));
      const data = JSON.parse(utf8.decode(plaintext));
      if (
        !exactFields(data, [
          "version",
          "chainId",
          "genesis",
          "walletId",
          "revision",
          "receives",
        ]) ||
        data.version !== 1 ||
        data.chainId !== CHAIN ||
        data.genesis !== GENESIS ||
        typeof data.walletId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          data.walletId,
        ) ||
        !Array.isArray(data.receives) ||
        data.receives.length < 1 ||
        data.receives.length > MAX_RECORDS ||
        data.revision !== data.receives.length
      )
        throw new Error();
      for (const item of data.receives) entries.push(restoreRecord(item));
      if (
        new Set(entries.map((entry) => entry.owner.commitment)).size !==
        entries.length
      )
        throw new Error();
      return new Wallet(key, data.walletId, entries, entries.length);
    } catch {
      key?.fill(0);
      for (const entry of entries) entry.nonce.fill(0);
      throw new WalletError(
        "Could not open this Testnet 1 backup. Check the file and its recovery code.",
      );
    } finally {
      plaintext?.fill(0);
    }
  }
  state() {
    return {
      wallet: {
        walletId: this.#id,
        revision: this.#entries.length,
        backedUp: this.#confirmed === this.#entries.length,
        accounts: this.#entries
          .slice(0, this.#confirmed)
          .map((entry) => ({ ...entry.descriptor })),
        pendingReceives: this.#entries.length - this.#confirmed,
      },
    };
  }
  recoveryCode() {
    return encodeCode(this.#key);
  }
  add(suite) {
    requireWallet(
      this.#entries.length < MAX_RECORDS,
      "This wallet already contains 64 receive requests.",
    );
    this.#entries.push(newRecord(suite));
  }
  async backup() {
    const revision = this.#entries.length;
    const source = Buffer.from(
      JSON.stringify({
        version: 1,
        chainId: CHAIN,
        genesis: GENESIS,
        walletId: this.#id,
        revision,
        receives: this.#entries.map(serialized),
      }),
    );
    try {
      const archive = await new CompactEncrypt(source)
        .setProtectedHeader(HEADER)
        .encrypt(this.#key);
      return {
        archive,
        filename: "p2party-testnet1-" + this.#id + "-r" + revision + ".jwe",
      };
    } finally {
      source.fill(0);
    }
  }
  async confirm(archive, code) {
    const recovered = await Wallet.restore(archive, code);
    try {
      requireWallet(
        recovered.#id === this.#id &&
          recovered.#entries.length === this.#entries.length &&
          timingSafeEqual(recovered.#key, this.#key) &&
          recovered.#entries.every(
            (entry, index) =>
              entry.owner.commitment ===
                this.#entries[index].owner.commitment &&
              entry.owner.suite === this.#entries[index].owner.suite &&
              entry.privateKey.equals(this.#entries[index].privateKey) &&
              timingSafeEqual(entry.nonce, this.#entries[index].nonce),
          ),
        "Choose the latest backup from this wallet.",
      );
      this.#confirmed = this.#entries.length;
    } finally {
      recovered.destroy();
    }
  }
  reviewTransfer(request) {
    requireWallet(
      exactFields(request, [
        "chainId",
        "genesis",
        "input",
        "recipient",
        "expiryHeight",
      ]) &&
        request.chainId === CHAIN &&
        request.genesis === GENESIS,
      "Choose a transfer request for Testnet 1.",
    );
    const { input, recipient, expiryHeight } = request;
    const isId = (value) =>
      typeof value === "string" &&
      value.length === 130 &&
      /^0x[0-9a-f]{128}$/.test(value);
    const isQuantity = (value) =>
      typeof value === "string" &&
      value.length <= 18 &&
      /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(value) &&
      "0x" + BigInt(value).toString(16) === value;
    requireWallet(
      exactFields(input, [
        "id",
        "suite",
        "commitment",
        "weight",
        "createdHeight",
        "spentHeight",
      ]) &&
        isId(input.id) &&
        isId(input.commitment) &&
        isQuantity(input.weight) &&
        isQuantity(input.createdHeight) &&
        input.spentHeight === null,
      "Provide the complete unspent unit from demos_getUnit.",
    );
    const weight = BigInt(input.weight);
    requireWallet(
      weight > 0n && (weight & (weight - 1n)) === 0n,
      "The input must be a whole native unit of valid weight.",
    );
    requireWallet(
      this.#entries
        .slice(0, this.#confirmed)
        .some(
          ({ owner }) =>
            owner.commitment === input.commitment &&
            owner.suite === input.suite,
        ),
      "This backup cannot spend the selected input.",
    );
    requireWallet(
      exactFields(recipient, ["suite", "commitment"]) &&
        isId(recipient.commitment) &&
        recipient.commitment !== input.commitment,
      "Provide a fresh full recipient commitment and suite.",
    );
    checkSuite(recipient.suite);
    requireWallet(
      isQuantity(expiryHeight) &&
        BigInt(expiryHeight) > BigInt(input.createdHeight),
      "Choose a finite expiry after the input creation height.",
    );
    return {
      chainId: CHAIN,
      genesis: GENESIS,
      inputId: input.id,
      source: input.commitment,
      sourceSuite: input.suite,
      weight: weight.toString(),
      recipient: { ...recipient },
      readHandle: readHandle(recipient),
      expiry: BigInt(expiryHeight).toString(),
    };
  }
  async signPayment(request) {
    this.reviewTransfer(request);
    return await this.#sign(
      CHAIN,
      request.input,
      request.recipient,
      BigInt(request.expiryHeight),
    );
  }
  async prove(commitment) {
    const entry = this.#entries
      .slice(0, this.#confirmed)
      .find((item) => item.owner.commitment === commitment);
    requireWallet(entry, "Select a receive request from a checked backup.");
    const signer = nodeSigner(entry.privateKey);
    const recipient = receiveOwner(signer, randomBytes(32));
    const inputId = "0x" + randomBytes(64).toString("hex");
    const input = {
      ...entry.owner,
      id: inputId,
      weight: "0x1",
      createdHeight: "0x0",
      spentHeight: null,
    };
    return this.#sign(PROOF_CHAIN, input, recipient, 1n);
  }
  async #sign(chainId, input, recipient, expiryHeight) {
    const entry = this.#entries
      .slice(0, this.#confirmed)
      .find(
        ({ owner }) =>
          owner.commitment === input.commitment && owner.suite === input.suite,
      );
    requireWallet(entry, "Choose a receive request from a checked backup.");
    const signer = nodeSigner(entry.privateKey);
    const wire = await signTransfer(
      { chainId, input, recipient, expiryHeight },
      signer,
      entry.nonce,
    );
    const { id: moveId, outputId, inputId } = transferIds(wire, chainId);
    // Verify independently with the public key, before telling the user the proof succeeded.
    const raw = Buffer.from(wire.slice(2), "hex");
    const bodyLength = 244 + signer.publicKey.length;
    const tag = Buffer.from("move/body");
    const digest = createHash("sha512")
      .update(Buffer.from([tag.length]))
      .update(tag)
      .update(raw.subarray(0, bodyLength))
      .digest();
    requireWallet(
      verify(
        null,
        digest,
        createPublicKey(entry.privateKey),
        raw.subarray(bodyLength),
      ),
      "The offline signature did not verify.",
    );
    return {
      ...entry.descriptor,
      moveId,
      outputId,
      wire,
      chainId,
      inputId,
      recipient,
    };
  }
  destroy() {
    this.#key.fill(0);
    for (const entry of this.#entries) entry.nonce.fill(0);
    this.#entries = [];
    this.#confirmed = 0;
  }
}
