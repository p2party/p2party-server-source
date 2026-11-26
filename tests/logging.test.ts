import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { createHandlePeerAcceptsConnection } from "../src/utils/handlePeerAcceptsConnection";

import type { P2PartyWSClient } from "../src/wsServer";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "generated" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });

/** The argument text of every call to `callee(` in `source`, parentheses balanced. */
const callArguments = (source: string, callee: RegExp): string[] => {
  const found: string[] = [];
  for (const match of source.matchAll(callee)) {
    let depth = 1;
    let end = match.index! + match[0].length;
    for (; end < source.length && depth > 0; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")") depth--;
    }
    found.push(source.slice(match.index! + match[0].length, end - 1));
  }
  return found;
};

const FROM = "00000000-0000-4000-8000-0000000000f1";
const TO = "00000000-0000-4000-8000-0000000000f2";
const ROOM = "00000000-0000-4000-8000-0000000000f3";

const captureInfoLogs = async (body: () => Promise<unknown>) => {
  const lines: string[] = [];
  const spies = (["log", "info", "warn"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    await body();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines;
};

describe("operator logs", () => {
  test("info logs contain no full peer id", async () => {
    // Behaviour: the dropped-acceptance line names a pair of peers.
    const ws = {
      data: {
        peerId: FROM,
        publicKey: "ab".repeat(32),
        isVerified: true,
        isAuthenticating: false,
      },
      readyState: 1,
      send: () => {
        throw new Error("the drop path sends nothing");
      },
    } as unknown as P2PartyWSClient;
    const handle = createHandlePeerAcceptsConnection({} as never, {
      clients: new Map([[FROM, ws]]),
      findRoomPeers: (async () => false) as never,
      sendToPeer: async () => false,
    });

    const lines = await captureInfoLogs(async () => {
      await handle(FROM, TO, ROOM, ws);
      await handle(FROM, TO, ROOM, ws);
    });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(FROM);
      expect(line).not.toContain(TO);
      expect(line).not.toContain("ab".repeat(32));
    }
    const pair =
      /^peer acceptance dropped: no current room pair for ([0-9a-f]{8}) -> ([0-9a-f]{8})$/.exec(
        lines[0]!,
      );
    expect(pair).not.toBeNull();
    // A tag links lines about one peer and tells two peers apart.
    expect(pair![1]).not.toBe(pair![2]);
    expect(lines[1]).toBe(lines[0]!);

    // Structure: every info-level call in src passes peer ids and public
    // keys only through peerLogTag.
    const leaks: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      // Whole-line comments hold disabled code, not log calls.
      const source = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n");
      for (const args of callArguments(
        source,
        /\bconsole\.(?:log|info|warn|debug)\(/g,
      )) {
        const withoutTags = args.replace(/peerLogTag\([^()]*\)/g, "");
        if (/peerid|publickey/i.test(withoutTags))
          leaks.push(`${relative(srcRoot, file)}: ${args.trim()}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("a peer log tag is eight hex digits that do not reveal the id", async () => {
    const { peerLogTag } = await import("../src/utils/logTag");
    const tag = peerLogTag(FROM);
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(peerLogTag(FROM)).toBe(tag);
    expect(peerLogTag(TO)).not.toBe(tag);
    // Not a slice of the id or key: a per-boot salted HMAC.
    expect(FROM.replace(/-/g, "")).not.toContain(tag);
    expect(peerLogTag("ab".repeat(32))).not.toBe("abababab");
  });
});
