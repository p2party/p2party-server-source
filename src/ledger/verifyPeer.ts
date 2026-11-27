import { createHash } from "node:crypto";
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
        if (size > 40_000)
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
  for (let n = 1n; n <= height; ++n) {
    const number = hexQuantity(n);
    const peer = object(await ask("demos_getTransferByHeight", [number]));
    if (
      peer.height !== number ||
      typeof peer.wire !== "string" ||
      ![2 + 5505 * 2, 2 + 16516 * 2].includes(peer.wire.length)
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
  }
  return {
    chainId: store.config.chainId,
    genesisHash: identity,
    height: hexQuantity(height),
    historyHash: hex(digest),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const serve = args.at(-1) === "--serve";
  if (serve) args.pop();
  const [endpoint, through] = args;
  const database = process.env.LEDGER_REPLICA_DATABASE_URL;
  if (!endpoint || !database || args.length > 2)
    throw new Error(
      "Usage: bun run ledger:verify-peer LOCAL_RPC_URL [THROUGH_HEIGHT_HEX] [--serve]; configure LEDGER_REPLICA_DATABASE_URL",
    );
  peerUrl(endpoint);
  const targetHeight = through === undefined ? undefined : quantity(through);
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
    console.log(
      JSON.stringify(await verifyPeer(store, endpoint, targetHeight)),
    );
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
