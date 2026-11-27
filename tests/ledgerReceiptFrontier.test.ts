import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ReceiptFrontier } from "../src/ledger/receiptFrontier";

const sha = (...items: Buffer[]) => {
  const h = createHash("sha512");
  for (const item of items) h.update(item);
  return h.digest();
};

// RFC 9162 recursive split is independent of the incremental frontier.
function tree(ids: Buffer[]): Buffer {
  if (!ids.length) return sha();
  if (ids.length === 1) return sha(Buffer.from([0]), ids[0]!);
  const split = 2 ** Math.floor(Math.log2(ids.length - 1));
  return sha(
    Buffer.from([1]),
    tree(ids.slice(0, split)),
    tree(ids.slice(split)),
  );
}
test("every receipt prefix matches the recursive log root, including incomplete subtrees", () => {
  const ids: Buffer[] = [],
    frontier = new ReceiptFrontier();
  expect(frontier.root()).toEqual(tree([]));
  expect(() => frontier.append(Buffer.alloc(63))).toThrow();
  for (let i = 0; i < 257; ++i) {
    const id = sha(Buffer.from("receipt-fixture/" + i));
    ids.push(id);
    frontier.append(id);
    expect(frontier.root()).toEqual(tree(ids));
    frontier.root().fill(0);
  }
});
