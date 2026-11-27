import {
  bytes,
  hexQuantity,
  invalidParams,
  quantity,
  RpcError,
} from "./config";
import { LedgerStore, busy } from "./store";
import { ethRead } from "./ethReads";

const responseHeaders = { "cache-control": "no-store" };
const maxBody = 68 * 1024;
const json = (v: unknown) => Response.json(v, { headers: responseHeaders });
async function readBody(request: Request) {
  if (Number(request.headers.get("content-length")) > maxBody)
    throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const buffer = Buffer.allocUnsafe(maxBody);
  let length = 0,
    expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 5000);
  try {
    while (true) {
      const part = await reader.read();
      if (expired) throw new RpcError(-32005, "Request timed out");
      if (part.done) break;
      length += part.value.length;
      if (length > maxBody) {
        void reader.cancel().catch(() => {});
        throw new RangeError();
      }
      buffer.set(part.value, length - part.value.length);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
}

function argumentsOf(params: unknown, min: number, max = min): unknown[] {
  const p = params === undefined ? [] : params;
  if (!Array.isArray(p) || p.length < min || p.length > max)
    throw invalidParams();
  return p;
}
async function call(store: LedgerStore, method: string, params: unknown) {
  switch (method) {
    case "demos_getGenesisHash":
      argumentsOf(params, 0);
      return "0x" + store.config.genesisHash;
    case "demos_chainId":
      argumentsOf(params, 0);
      return store.config.chainId;
    case "eth_chainId":
      argumentsOf(params, 0);
      return hexQuantity(store.config.rpcChainId);
    case "eth_blockNumber":
    case "eth_getBalance":
      return ethRead(store, method, params);
    case "demos_getHead":
      argumentsOf(params, 0);
      return store.head();
    case "demos_getUnit":
      return store.unit(bytes(argumentsOf(params, 1)[0], 64));
    case "demos_getTransfer":
      return store.transfer(bytes(argumentsOf(params, 1)[0], 64));
    case "demos_getTransferByHeight":
      return store.transfer(quantity(argumentsOf(params, 1)[0]));
    case "demos_listUnspent": {
      const [suite, commitment, limit, after] = argumentsOf(params, 3, 4);
      if (
        (suite !== 1 && suite !== 2) ||
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 64
      )
        throw invalidParams();
      return store.unspent(
        suite,
        bytes(commitment, 64),
        limit,
        after === undefined ? null : bytes(after, 64),
      );
    }
    case "demos_sendRawTransfer": {
      const [raw] = argumentsOf(params, 1);
      if (
        typeof raw !== "string" ||
        (raw.length !== 2 + 5505 * 2 && raw.length !== 2 + 16516 * 2)
      )
        throw invalidParams();
      return store.submit(bytes(raw, (raw.length - 2) / 2));
    }
    default:
      throw new RpcError(-32601, "Method not found");
  }
}
const failure = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
async function reply(store: LedgerStore, req: unknown) {
  if (req === null || typeof req !== "object" || Array.isArray(req))
    return failure(null, -32600, "Invalid request");
  const { jsonrpc, id, method, params } = req as Record<string, unknown>;
  if (
    jsonrpc !== "2.0" ||
    typeof method !== "string" ||
    method.length > 80 ||
    (id !== null &&
      id !== undefined &&
      !(typeof id === "string" && id.length <= 128) &&
      !(typeof id === "number" && Number.isSafeInteger(id)))
  )
    return failure(null, -32600, "Invalid request");
  try {
    const result = await call(store, method, params);
    return id === undefined ? undefined : { jsonrpc: "2.0", id, result };
  } catch (e) {
    if (id === undefined) return;
    return e instanceof RpcError
      ? failure(id, e.code, e.message)
      : failure(id, -32603, "Internal error");
  }
}
export function ledgerRpc(store: LedgerStore) {
  let inFlight = 0;
  const dispatch = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === "/rpc/health") {
      if (request.method !== "GET")
        return new Response(null, {
          status: 405,
          headers: { ...responseHeaders, Allow: "GET" },
        });
      if (inFlight >= 8)
        return new Response(null, { status: 429, headers: responseHeaders });
      inFlight++;
      try {
        return json({
          status: "ok",
          rpcChainId: hexQuantity(store.config.rpcChainId),
          ...(await store.head()),
        });
      } catch {
        return Response.json(
          { status: "unavailable" },
          { status: 503, headers: responseHeaders },
        );
      } finally {
        inFlight--;
      }
    }
    if (request.method === "OPTIONS") {
      const method = request.headers.get("access-control-request-method");
      const headers =
        request.headers
          .get("access-control-request-headers")
          ?.split(",")
          .map((h) => h.trim().toLowerCase()) ?? [];
      if (
        (method && method !== "POST") ||
        headers.some((h) => h !== "content-type")
      )
        return new Response(null, { status: 403, headers: responseHeaders });
      return new Response(null, {
        status: 204,
        headers: {
          ...responseHeaders,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "Content-Type",
          "access-control-max-age": "600",
          vary: "Access-Control-Request-Method, Access-Control-Request-Headers",
        },
      });
    }
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { ...responseHeaders, Allow: "POST, OPTIONS" },
      });
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return new Response(null, { status: 415, headers: responseHeaders });
    if (inFlight >= 8)
      return Response.json(
        failure(null, busy().code, "Validator busy; retry"),
        { status: 429, headers: { ...responseHeaders, "retry-after": "1" } },
      );
    inFlight++;
    try {
      let input: unknown;
      try {
        input = await readBody(request);
      } catch (e) {
        if (e instanceof RangeError)
          return new Response(null, { status: 413, headers: responseHeaders });
        if (e instanceof RpcError)
          return new Response(null, { status: 408, headers: responseHeaders });
        return json(failure(null, -32700, "Parse error"));
      }
      if (Array.isArray(input)) {
        if (!input.length || input.length > 8)
          return json(failure(null, -32600, "Invalid request"));
        const results = [];
        for (const item of input) {
          const r = await reply(store, item);
          if (r !== undefined) results.push(r);
        }
        return results.length
          ? json(results)
          : new Response(null, { status: 204, headers: responseHeaders });
      }
      const result = await reply(store, input);
      return result === undefined
        ? new Response(null, { status: 204, headers: responseHeaders })
        : json(result);
    } finally {
      inFlight--;
    }
  };
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const wildcard = store.config.corsOrigins.includes("*");
    if (
      origin &&
      !wildcard &&
      !store.config.corsOrigins.includes(origin) &&
      origin !== new URL(request.url).origin
    )
      return new Response(null, {
        status: 403,
        headers: { ...responseHeaders, Vary: "Origin" },
      });
    const response = await dispatch(request);
    if (wildcard) response.headers.set("access-control-allow-origin", "*");
    else {
      response.headers.append("vary", "Origin");
      if (origin && store.config.corsOrigins.includes(origin))
        response.headers.set("access-control-allow-origin", origin);
    }
    return response;
  };
}
