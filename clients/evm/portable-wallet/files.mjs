import { open, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { WalletError } from "./wallet.mjs";

// Limit the read itself, including when a regular file grows after it was opened.
export async function readLimited(path, max) {
  const fd = await open(path, "r");
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > max)
      throw new WalletError("Choose a regular file within the supported size.");
    const buf = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buf.length) {
      const { bytesRead } = await fd.read(buf, used, buf.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used !== stat.size) {
      buf.fill(0);
      throw new WalletError("A selected file changed while it was being read.");
    }
    return buf.subarray(0, used);
  } finally {
    await fd.close();
  }
}

// Publish only a complete file and never replace an existing payment or credential.
export async function writeNew(path, data) {
  const tmp = join(dirname(path), ".p2party-" + randomUUID() + ".tmp");
  const fd = await open(tmp, "wx", 0o600);
  try {
    try {
      await fd.writeFile(data);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await link(tmp, path);
  } finally {
    await unlink(tmp);
  }
}
