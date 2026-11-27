import { createHash } from "node:crypto";

// RFC 9162 tree shape over SHA-512 and the 64-byte IDs of validated moves.
// Level k holds the rightmost complete subtree of size 2^k, if present.
const branch = (left: Buffer, right: Buffer) =>
  createHash("sha512")
    .update(Buffer.from([1]))
    .update(left)
    .update(right)
    .digest();

export class ReceiptFrontier {
  private readonly levels: (Buffer | undefined)[] = [];
  append(moveId: Buffer) {
    if (moveId.length !== 64) throw new Error("Invalid move ID");
    let subtree = createHash("sha512")
      .update(Buffer.from([0]))
      .update(moveId)
      .digest();
    let level = 0;
    while (this.levels[level]) {
      subtree = branch(this.levels[level]!, subtree);
      this.levels[level++] = undefined;
    }
    this.levels[level] = subtree;
  }
  root(): Buffer {
    let result: Buffer | undefined;
    for (const left of this.levels) {
      if (left) result = result ? branch(left, result) : left;
    }
    return result ? Buffer.from(result) : createHash("sha512").digest();
  }
}
