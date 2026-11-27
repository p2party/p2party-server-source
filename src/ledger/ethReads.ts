import { bytes, invalidParams, quantity } from "./config";
import type { LedgerStore } from "./store";

export async function ethRead(
  store: LedgerStore,
  method: "eth_blockNumber" | "eth_getBalance",
  params: unknown,
) {
  const args = params === undefined ? [] : params;
  if (!Array.isArray(args)) throw invalidParams();
  if (method === "eth_blockNumber") {
    if (args.length !== 0) throw invalidParams();
    return (await store.head()).height;
  }
  if (
    args.length < 1 ||
    args.length > 2 ||
    typeof args[0] !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(args[0])
  )
    throw invalidParams();
  const tag = args.length === 1 ? "latest" : args[1];
  const height =
    tag === "latest" ? null : tag === "earliest" ? 0n : quantity(tag);
  return store.balance(bytes(args[0].toLowerCase(), 20), height);
}
