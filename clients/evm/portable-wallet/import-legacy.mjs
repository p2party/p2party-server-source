import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet, WalletError } from "./wallet.mjs";
import { readLimited, writeNew } from "./files.mjs";

export async function importLegacy(args) {
  const [kitPath, codePath, ...pairs] = args;
  if (
    !kitPath ||
    !codePath ||
    resolve(kitPath) === resolve(codePath) ||
    !pairs.length ||
    pairs.length > 128 ||
    pairs.length % 2
  )
    throw new WalletError(
      "Usage: node import-legacy.mjs NEW_KIT.jwe NEW_CODE_FILE RECEIVE_FOLDER EXPECTED_FULL_COMMITMENT [RECEIVE_FOLDER EXPECTED_FULL_COMMITMENT ...]",
    );
  const receives = [];
  let wallet;
  try {
    for (let i = 0; i < pairs.length; i += 2) {
      const item = { commitment: pairs[i + 1] };
      receives.push(item);
      item.privateKey = await readLimited(join(pairs[i], "key.pk8"), 12 * 1024);
      item.nonce = await readLimited(join(pairs[i], "nonce"), 32);
    }
    wallet = Wallet.importLegacy(receives);
    const { archive } = await wallet.backup();
    const recoveryCode = wallet.recoveryCode();
    await wallet.confirm(archive, recoveryCode);
    // A crash before writing the second file leaves only the code and all original receive folders.
    await writeNew(codePath, recoveryCode + "\n");
    try {
      await writeNew(kitPath, archive);
    } catch (error) {
      await unlink(codePath);
      throw error;
    }
    return wallet.state().wallet.accounts.length;
  } finally {
    for (const item of receives) {
      item.privateKey?.fill(0);
      item.nonce?.fill(0);
    }
    wallet?.destroy();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const n = await importLegacy(process.argv.slice(2));
    console.log(
      "Saved a checked encrypted backup for " +
        n +
        " receive request(s). Keep the separate code file offline.",
    );
  } catch (error) {
    console.error(
      error instanceof WalletError
        ? error.message
        : "Could not read the inputs or create new output files. Existing files are preserved.",
    );
    process.exitCode = 1;
  }
}
