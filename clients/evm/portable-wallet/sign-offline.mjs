import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet, WalletError, MAX_ARCHIVE } from "./wallet.mjs";
import { readLimited, writeNew } from "./files.mjs";

export async function signOffline(args, approve) {
  const [kitPath, codePath, requestPath, outputDirectory] = args;
  if (args.length !== 4 || !outputDirectory)
    throw new WalletError(
      "Usage: node sign-offline.mjs KIT.jwe CODE_FILE UNSIGNED_REQUEST.json TRUSTED_OUTPUT_DIRECTORY",
    );
  const code = await readLimited(codePath, 128);
  let wallet;
  try {
    wallet = await Wallet.restore(
      (await readLimited(kitPath, MAX_ARCHIVE)).toString("utf8"),
      code.toString("utf8").trim(),
    );
    const request = JSON.parse(
      (await readLimited(requestPath, 8192)).toString("utf8"),
    );
    const summary = wallet.reviewTransfer(request);
    if (!(await approve(summary))) throw new WalletError("Signing cancelled.");
    const result = await wallet.signPayment(request);
    // One file per input prevents accidentally replacing a previously signed payment in this directory.
    const path = join(
      outputDirectory,
      "signed-" + result.inputId.slice(2) + ".json",
    );
    await writeNew(
      path,
      JSON.stringify({
        chainId: result.chainId,
        inputId: result.inputId,
        moveId: result.moveId,
        outputId: result.outputId,
        recipient: result.recipient,
        wire: result.wire,
      }) + "\n",
    );
    return { moveId: result.moveId, path };
  } finally {
    code.fill(0);
    wallet?.destroy();
  }
}

async function approve(summary) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new WalletError(
      "Use an interactive terminal to review and authorize a payment.",
    );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(
      [
        "Offline payment on P2Party Testnet 1 (valueless units)",
        "Chain ID: " + summary.chainId,
        "Genesis SHA-256: " + summary.genesis,
        "Whole input: " + summary.inputId,
        "Source suite: " + summary.sourceSuite,
        "Source commitment: " + summary.source,
        "Amount: " + summary.weight + " P2PARTY",
        "Recipient suite: " + summary.recipient.suite,
        "Recipient commitment: " + summary.recipient.commitment,
        "Recipient read handle: " + summary.readHandle,
        "Inclusive expiry height: " + summary.expiry,
        "Verify the recipient's full commitment independently. Anyone with the signed file can submit this payment.",
      ].join("\n"),
    );
    const confirm =
      "SIGN " + summary.weight + " " + summary.recipient.commitment.slice(-12);
    return (
      (await terminal.question('Type "' + confirm + '" to sign: ')) === confirm
    );
  } finally {
    terminal.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { moveId } = await signOffline(process.argv.slice(2), approve);
    console.log(
      "Saved signed native payment " + moveId + " in the selected directory.",
    );
  } catch (error) {
    console.error(
      error instanceof WalletError
        ? error.message
        : "Could not read the request or save a new signed file. Check for an existing payment for this input.",
    );
    process.exitCode = 1;
  }
}
