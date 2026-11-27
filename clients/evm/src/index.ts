import type { Suite } from "./suites.js";
export const nativeCurrency = {
  name: "P2Party",
  symbol: "P2PARTY",
  decimals: 0,
} as const;
import {
  bytes,
  hex,
  quantity,
  transferIds,
  type Hex,
  type TransferReceipt,
  type Unit,
} from "./wire.js";
export {
  receiveOwner,
  readHandle,
  signTransfer,
  transferIds,
  type Hex,
  type Suite,
  type Owner,
  type Unit,
  type TransferReceipt,
  type LocalSigner,
} from "./wire.js";

export type NativeRpcSchema = [
  { Method: "demos_chainId"; Parameters: []; ReturnType: Hex },
  {
    Method: "demos_getHead";
    Parameters: [];
    ReturnType: { chainId: Hex; height: Hex };
  },
  { Method: "demos_getUnit"; Parameters: [id: Hex]; ReturnType: Unit | null },
  {
    Method: "demos_listUnspent";
    Parameters: [suite: Suite, commitment: Hex, limit: number, afterId?: Hex];
    ReturnType: Unit[];
  },
  { Method: "demos_sendRawTransfer"; Parameters: [wire: Hex]; ReturnType: Hex },
  {
    Method: "demos_getTransfer";
    Parameters: [id: Hex];
    ReturnType: TransferReceipt | null;
  },
  {
    Method: "demos_getTransferByHeight";
    Parameters: [height: Hex];
    ReturnType: TransferReceipt | null;
  },
];
export class LedgerProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
function paramsOf(params: readonly unknown[], min: number, max = min) {
  if (params.length < min || params.length > max)
    throw new LedgerProviderError(-32602, "Invalid parameter count");
}
/** Pin both the full native ledger ID used in signatures and the numeric provider network ID. */
export async function createLedgerTransport(options: {
  url: string;
  chainId: Hex;
  rpcChainId: number;
}) {
  const url = new URL(options.url);
  const chainId = hex(bytes(options.chainId, 32));
  if (!Number.isSafeInteger(options.rpcChainId) || options.rpcChainId < 1)
    throw new Error("Invalid numeric provider chain ID");
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  )
    throw new Error("Use an HTTPS ledger endpoint, or HTTP on loopback");
  let nextId = 0;
  async function rpc(method: string, params: readonly unknown[]) {
    const id = ++nextId;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      throw new LedgerProviderError(
        response.status === 429 ? -32005 : -32000,
        `Ledger HTTP ${response.status}`,
      );
    const reply = await response.json();
    if (
      !reply ||
      reply.jsonrpc !== "2.0" ||
      reply.id !== id ||
      "error" in reply === "result" in reply
    )
      throw new Error("Invalid ledger RPC response");
    if ("error" in reply)
      throw new LedgerProviderError(
        Number.isInteger(reply.error?.code) ? reply.error.code : -32603,
        typeof reply.error?.message === "string"
          ? reply.error.message
          : "Invalid RPC error",
      );
    return reply.result;
  }
  const [native, network] = await Promise.all([
    rpc("demos_chainId", []),
    rpc("eth_chainId", []),
  ]);
  if (native !== chainId || network !== `0x${options.rpcChainId.toString(16)}`)
    throw new Error("Ledger endpoint chain identity mismatch");
  async function head() {
    const h = await rpc("demos_getHead", []);
    if (h?.chainId !== chainId)
      throw new Error("Ledger endpoint chain identity mismatch");
    quantity(h.height);
    return h;
  }
  async function request({
    method,
    params = [],
  }: {
    method: string;
    params?: readonly unknown[] | object;
  }): Promise<any> {
    if (!Array.isArray(params))
      throw new LedgerProviderError(-32602, "Use positional parameters");
    switch (method) {
      case "eth_chainId":
        paramsOf(params, 0);
        return network;
      case "demos_chainId":
        paramsOf(params, 0);
        return chainId;
      case "eth_blockNumber":
        paramsOf(params, 0);
        return (await head()).height;
      case "demos_getHead":
        paramsOf(params, 0);
        return head();
      case "eth_getBalance":
        paramsOf(params, 1, 2);
        return rpc(method, params);
      case "demos_getUnit":
      case "demos_listUnspent":
        return rpc(method, params);
      case "demos_sendRawTransfer": {
        paramsOf(params, 1);
        const { id } = transferIds(params[0], chainId);
        if ((await rpc(method, params)) !== id)
          throw new Error("Validator returned an unexpected native move ID");
        return id;
      }
      case "demos_getTransfer":
      case "demos_getTransferByHeight": {
        paramsOf(params, 1);
        const r: TransferReceipt | null = await rpc(method, params);
        if (r === null) return null;
        const ids = transferIds(r.wire, chainId);
        quantity(r.height);
        if (
          r.id !== ids.id ||
          r.inputId !== ids.inputId ||
          r.outputId !== ids.outputId ||
          (method === "demos_getTransfer" ? r.id : r.height) !== params[0]
        )
          throw new Error("Invalid native transfer receipt");
        return r;
      }
      default:
        throw new LedgerProviderError(
          4200,
          `Unsupported provider method ${method}`,
        );
    }
  }
  return { request };
}
