import { expect, test } from "bun:test";
import { ledgerConfig, bytes, quantity } from "../src/ledger/config";
import { ledgerRpc } from "../src/ledger/rpc";
import type { LedgerStore } from "../src/ledger/store";

const rpc = () => ledgerRpc({ config: { rpcChainId: 77 } } as LedgerStore);
const request = (body: BodyInit) =>
  new Request("http://localhost/rpc", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
  });
test("ledger startup requires explicit opt-in, chain identity and native verifier", () => {
  expect(ledgerConfig({})).toBeUndefined();
  expect(
    ledgerConfig({ LEDGER_ENABLED: "false", LEDGER_VERIFIER: "/missing" }),
  ).toBeUndefined();
  expect(() => ledgerConfig({ LEDGER_ENABLED: "yes" })).toThrow();
  expect(() => ledgerConfig({ LEDGER_ENABLED: "true" })).toThrow();
  for (const invalid of ["0x", "0x00", "0x-1", "0X1", "0x8000000000000000"])
    expect(() => quantity(invalid)).toThrow();
  expect(() => bytes("0xAZ", 1)).toThrow();
});
test("RPC bounds transport, batch size and malformed values", async () => {
  const handle = rpc();
  expect((await handle(new Request("http://localhost/rpc"))).status).toBe(405);
  expect(
    (
      await handle(
        new Request("http://localhost/rpc", { method: "POST", body: "{}" }),
      )
    ).status,
  ).toBe(415);
  expect((await handle(request("x".repeat(68 * 1024 + 1)))).status).toBe(413);
  expect(
    (await (await handle(request(Uint8Array.from([255])))).json()).error.code,
  ).toBe(-32700);
  expect(
    (await (await handle(request(JSON.stringify(Array(9).fill({}))))).json())
      .error.code,
  ).toBe(-32600);
  const result = await (
    await handle(
      request(
        JSON.stringify([
          { jsonrpc: "2.0", method: "eth_chainId", params: [], id: 3 },
          { jsonrpc: "2.0", method: "unknown", id: "x" },
          { jsonrpc: "2.0", method: "eth_chainId" },
        ]),
      ),
    )
  ).json();
  expect(result).toEqual([
    { jsonrpc: "2.0", id: 3, result: "0x4d" },
    {
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32601, message: "Method not found" },
    },
  ]);
  expect(
    (
      await (
        await handle(
          request(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_chainId",
              params: [0],
            }),
          ),
        )
      ).json()
    ).error.code,
  ).toBe(-32602);
});
test("unfinished bodies share the same admission cap as signature verification", async () => {
  const handle = rpc();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const reads = Array.from({ length: 8 }, () =>
    handle(
      request(
        new ReadableStream<Uint8Array>({
          start(c) {
            controllers.push(c);
          },
        }),
      ),
    ),
  );
  try {
    expect((await handle(request("{}"))).status).toBe(429);
  } finally {
    for (const c of controllers) c.close();
    await Promise.all(reads);
  }
  expect((await handle(request("{}"))).status).toBe(200);
});
