// Make one operator-authorized transfer from the fixed public testnet genesis.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createLedgerTransport,
  signTransfer,
} from "../../clients/evm/dist/index.js";
import { nodeSigner } from "../../clients/evm/dist/node.js";

const [inputId, suiteText, commitment] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !/^0x[0-9a-f]{128}$/.test(inputId ?? "") ||
  !["1", "2"].includes(suiteText) ||
  !/^0x[0-9a-f]{128}$/.test(commitment ?? "") ||
  process.stdin.isTTY
) {
  throw new Error(
    "Pipe the decrypted operator vault to grant-unit.mjs GENESIS_UNIT_ID RECIPIENT_SUITE RECIPIENT_COMMITMENT",
  );
}
const genesis = JSON.parse(
  readFileSync(new URL("./genesis.json", import.meta.url), "utf8"),
);
const entry = genesis.units.find((u) => u.id === inputId);
if (!entry)
  throw new Error("Selected input is outside the published testnet genesis");
const transport = await createLedgerTransport({
  url: "https://signaling.p2party.com/rpc",
  chainId: genesis.chainId,
  rpcChainId: genesis.rpcChainId,
});
const rpc = (method, ...params) => transport.request({ method, params });
const recipient = { suite: Number(suiteText), commitment };
const input = await rpc("demos_getUnit", inputId);
if (
  !input ||
  input.commitment !== entry.commitment ||
  input.suite !== entry.suite ||
  input.weight !== entry.weight
) {
  throw new Error("The live input differs from the published genesis");
}
function matches(output) {
  return (
    output &&
    output.suite === recipient.suite &&
    output.commitment === commitment &&
    output.weight === input.weight
  );
}
async function receipt() {
  const unit = await rpc("demos_getUnit", inputId);
  if (unit?.spentHeight == null) return null;
  const move = await rpc("demos_getTransferByHeight", unit.spentHeight);
  if (
    !move ||
    move.inputId !== inputId ||
    !matches(await rpc("demos_getUnit", move.outputId))
  ) {
    throw new Error(
      "This genesis unit has already funded a different recipient",
    );
  }
  return { moveId: move.id, outputId: move.outputId, height: move.height };
}
let result = await receipt();
if (!result) {
  const custody = JSON.parse(readFileSync(0, "utf8"));
  if (custody.chainId !== genesis.chainId)
    throw new Error("Wrong operator vault");
  const selected = custody.keys.find((k) => k.id === inputId);
  if (!selected) throw new Error("Missing key for the selected input");
  const key = createPrivateKey({
    key: Buffer.from(selected.pkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const wire = await signTransfer(
    { chainId: genesis.chainId, input, recipient, expiryHeight: 0n },
    nodeSigner(key),
    Buffer.from(selected.nonce, "hex"),
  );
  try {
    await rpc("demos_sendRawTransfer", wire);
  } catch (error) {
    if (!(await receipt())) throw error;
  }
  result = await receipt();
  if (!result) throw new Error("Grant receipt has not been confirmed");
}
console.log(JSON.stringify(result));
