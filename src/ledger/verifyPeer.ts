import { hasTransferHexLength } from "../../clients/evm/src/suites.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { ReceiptFrontier } from "./receiptFrontier";
import { bytes, hex, hexQuantity, ledgerConfig, quantity } from "./config";
import { ledgerRpc } from "./rpc";
import { LedgerStore } from "./store";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object from the peer");
  return value as Record<string, unknown>;
}

// The development command contacts the explicit local peer only. Each response
// is capped while streaming, including when no Content-Length is supplied.
function peerUrl(endpoint: string) {
  const url = new URL(endpoint);
  if (
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Supply the local peer's loopback RPC URL");
  return url;
}

function localPeer(endpoint: string) {
  const url = peerUrl(endpoint);
  let id = 0;
  return async (method: string, params: string[] = []) => {
    const requestId = ++id;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) throw new Error("Peer RPC unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 68 * 1024)
          throw new Error("Peer RPC response exceeds the receipt limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (
      result.id !== requestId ||
      result.jsonrpc !== "2.0" ||
      result.error ||
      !Object.hasOwn(result, "result")
    )
      throw new Error("Invalid peer RPC response");
    return result.result;
  };
}

export async function verifyPeer(
  store: LedgerStore,
  endpoint: string,
  through?: bigint,
  options: {
    anchor?: { height: bigint; historyHash: Buffer; logRoot: Buffer };
    record?: (id: Buffer) => void;
  } = {},
) {
  const ask = localPeer(endpoint);
  const head = object(await ask("demos_getHead"));
  const identity = await ask("demos_getGenesisHash");
  if (
    head.chainId !== store.config.chainId ||
    identity !== "0x" + store.config.genesisHash
  )
    throw new Error("Peer chain or genesis does not match local configuration");
  const peerHeight = quantity(head.height);
  const previous = quantity((await store.head()).height);
  if (peerHeight < previous)
    throw new Error("Peer head is behind the locally accepted history");
  const height = through ?? peerHeight;
  if (
    height < 0n ||
    height > peerHeight ||
    (through === undefined && height > 10000n)
  )
    throw new Error("Supply an available verification height for this peer");
  // Fixed-length SHA-512 chain. The initial digest binds the decoded genesis
  // (including suite policy), and each subsequent digest binds order and move.
  let digest = createHash("sha512")
    .update("p2party/replay/v1\0")
    .update(bytes(identity, 32))
    .digest();
  const anchor = options.anchor;
  if (
    anchor &&
    (anchor.height < 0n ||
      anchor.height > height ||
      anchor.historyHash.length !== 64 ||
      anchor.logRoot.length !== 64)
  )
    throw new Error("Previous checkpoint falls outside the requested history");
  if (anchor && anchor.height > previous)
    throw new Error(
      "Catch up the replica to the previous signed height before attesting",
    );
  const frontier = new ReceiptFrontier();
  const checkAnchor = (n: bigint) => {
    if (
      anchor?.height === n &&
      (!digest.equals(anchor.historyHash) ||
        !frontier.root().equals(anchor.logRoot))
    )
      throw new Error(
        "History disagrees with the operator's previous checkpoint",
      );
  };
  checkAnchor(0n);
  for (let n = 1n; n <= height; ++n) {
    const number = hexQuantity(n);
    const peer = object(await ask("demos_getTransferByHeight", [number]));
    if (
      peer.height !== number ||
      typeof peer.wire !== "string" ||
      !hasTransferHexLength(peer.wire.length)
    )
      throw new Error("Peer supplied an invalid receipt or a gap in history");
    const expected = {
      height: n,
      id: bytes(peer.id, 64),
      inputId: bytes(peer.inputId, 64),
      outputId: bytes(peer.outputId, 64),
    };
    const wire = bytes(peer.wire, (peer.wire.length - 2) / 2);
    if (n > previous) await store.submit(wire, expected);
    const local = await store.transfer(n);
    if (
      !local ||
      local.id !== peer.id ||
      local.wire !== peer.wire ||
      local.outputId !== peer.outputId ||
      local.inputId !== peer.inputId
    )
      throw new Error(
        "Peer history conflicts with the locally verified receipt at " + number,
      );
    const position = Buffer.alloc(8);
    position.writeBigUInt64BE(n);
    digest = createHash("sha512")
      .update(digest)
      .update(position)
      .update(expected.id)
      .digest();
    frontier.append(expected.id);
    checkAnchor(n);
    options.record?.(expected.id);
  }
  return {
    chainId: store.config.chainId,
    genesisHash: identity,
    height: hexQuantity(height),
    historyHash: hex(digest),
    logRoot: hex(frontier.root()),
  };
}

if (import.meta.main) {
  const [endpoint, ...args] = process.argv.slice(2);
  const database = process.env.LEDGER_REPLICA_DATABASE_URL;
  if (!endpoint || !database)
    throw new Error(
      "Supply a loopback RPC URL and LEDGER_REPLICA_DATABASE_URL",
    );
  peerUrl(endpoint);
  const targetHeight = args[0]?.startsWith("0x")
    ? quantity(args.shift())
    : undefined;
  let serve = false,
    exportPath: string | undefined;
  let anchor:
    { height: bigint; historyHash: Buffer; logRoot: Buffer } | undefined;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--serve" && !serve) serve = true;
    else if (
      flag === "--export-log" &&
      !exportPath &&
      args[0] &&
      !args[0].startsWith("--")
    )
      exportPath = args.shift();
    else if (flag === "--anchor" && !anchor)
      anchor = {
        height: quantity(args.shift()),
        historyHash: bytes(args.shift(), 64),
        logRoot: bytes(args.shift(), 64),
      };
    else
      throw new Error(
        "Expected optional height, --anchor HEIGHT HISTORY_HASH LOG_ROOT, --export-log NEW_FILE or --serve",
      );
  }
  const db = new URL(database);
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(db.hostname) ||
    database === process.env.DATABASE_URL
  )
    throw new Error("Use a separate loopback replica database");
  const config = ledgerConfig(process.env);
  if (!config)
    throw new Error(
      "Supply the ledger genesis, chain ID and native verifier and enable the ledger",
    );
  const store = new LedgerStore(config, database);
  try {
    await store.initialize("replica");
    // Publish a complete file only after every receipt and the prior anchor verified.
    const temp = exportPath
      ? exportPath + "." + randomUUID() + ".tmp"
      : undefined;
    const fd = temp ? openSync(temp, "wx", 0o600) : undefined;
    try {
      const verified = await verifyPeer(store, endpoint, targetHeight, {
        anchor,
        record:
          fd === undefined
            ? undefined
            : (id) => {
                // A short write is possible even for a regular file.
                const line = Buffer.from(hex(id) + "\n", "ascii");
                for (let offset = 0; offset < line.length;) {
                  const written = writeSync(
                    fd,
                    line,
                    offset,
                    line.length - offset,
                  );
                  if (!written) throw new Error("Incomplete receipt export");
                  offset += written;
                }
              },
      });
      if (fd !== undefined && temp && exportPath) {
        fsyncSync(fd);
        linkSync(temp, exportPath);
      }
      console.log(JSON.stringify(verified));
    } finally {
      if (fd !== undefined && temp) {
        try {
          closeSync(fd);
        } finally {
          unlinkSync(temp);
        }
      }
    }
    if (serve) {
      const read = ledgerRpc(store, { readOnly: true });
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          return ["/rpc", "/rpc/health"].includes(new URL(req.url).pathname)
            ? read(req)
            : new Response(null, { status: 404 });
        },
      });
      console.log(
        "Read-only replica listening at " + new URL("/rpc", listener.url),
      );
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      await listener.stop(true);
    }
  } finally {
    await store.close();
  }
}
