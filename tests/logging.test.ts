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

/**
 * Names that must never reach an info-level log except through peerLogTag:
 * peer ids and public keys, room identifiers and locators (the room URL or
 * capability), client addresses, and TURN usernames and credentials.
 */
const SENSITIVE_NAME =
  /peerid|publickey|room(url|id|token|identifier)|\bidentifier\b|capability|locator|address|\bip\b|requestip|real-?ip|username|credential|secret/i;

/**
 * The info-level calls in `source` whose arguments name something sensitive.
 * String literals are dropped first (their text is the message, not data),
 * except the `${...}` expressions inside template literals.
 */
const sensitiveLogCalls = (source: string): string[] => {
  // Whole-line comments hold disabled code, not log calls.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return callArguments(
    code,
    /\bconsole\.(?:log|info|warn|debug|error)\(/g,
  ).filter((args) => {
    const expressions = args
      .replace(/peerLogTag\([^()]*\)/g, "")
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")
      .replace(/`(?:[^`\\]|\\.)*`/g, (literal) =>
        [...literal.matchAll(/\$\{([^}]*)\}/g)].map(([, e]) => e).join(" "),
      );
    return SENSITIVE_NAME.test(expressions);
  });
};

/**
 * Console calls in `source` that pass a caught value on raw. A Prisma
 * validation error's message quotes the query's arguments (peer ids, room
 * ids), so a caught value reaches a log only through describeError, which
 * keeps its class and a database code. Caught values are the bindings of
 * `catch (x)`, of `.catch((x) => ...)` and of `.on("error", (x) => ...)`, and
 * the conventional names error, err and cause.
 */
const rawCaughtValueCalls = (source: string): string[] => {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const names = new Set(["error", "err", "cause"]);
  for (const pattern of [
    /\bcatch\s*\(\s*(\w+)/g,
    /\.catch\(\s*\(?\s*(\w+)\b/g,
    /\.on\(\s*"error"\s*,\s*\(?\s*(\w+)\b/g,
  ])
    for (const [, name] of code.matchAll(pattern)) names.add(name!);
  const caught = new RegExp(`\\b(?:${[...names].join("|")})\\b`);
  return callArguments(
    code,
    /\bconsole\.(?:log|info|warn|debug|error|trace|dir)\(/g,
  ).filter((args) =>
    caught.test(
      args
        .replace(/describeError\([^()]*\)/g, "")
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")
        .replace(/`(?:[^`\\]|\\.)*`/g, (literal) =>
          [...literal.matchAll(/\$\{([^}]*)\}/g)].map(([, e]) => e).join(" "),
        ),
    ),
  );
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

    // Structure: no info-level call in src names a peer id, public key, room
    // identifier or locator, address or TURN credential, except peer ids
    // through peerLogTag.
    const leaks = sourceFiles(srcRoot).flatMap((file) =>
      sensitiveLogCalls(readFileSync(file, "utf8")).map(
        (args) => `${relative(srcRoot, file)}: ${args.trim()}`,
      ),
    );
    expect(leaks).toEqual([]);
  });

  test("the log scan flags each kind of sensitive argument", () => {
    // The scan above is only as good as this: each line must be caught.
    for (const leaking of [
      'console.log("joined", roomUrl);',
      "console.info(`room ${room.identifier}`);",
      'console.warn("from", ws.remoteAddress);',
      'console.log("ip", server.requestIP(req));',
      "console.log(`turn ${turnCredentials.username}`);",
      'console.debug("key", ws.data.publicKey);',
      'console.log("peer", fromPeerId);',
      'console.error("failed", roomUrl);',
    ])
      expect(sensitiveLogCalls(leaking), leaking).toHaveLength(1);
    for (const clean of [
      'console.log("Client has connected", peerLogTag(ws.data.peerId));',
      'console.warn("room id and address are words in a message");',
      "console.info(`cleared ${String(cleared.length)} server id(s)`);",
    ])
      expect(sensitiveLogCalls(clean), clean).toEqual([]);
  });

  test("no log line passes a caught value on raw", () => {
    const leaks = sourceFiles(srcRoot).flatMap((file) =>
      rawCaughtValueCalls(readFileSync(file, "utf8")).map(
        (args) => `${relative(srcRoot, file)}: ${args.trim()}`,
      ),
    );
    expect(leaks).toEqual([]);
  });

  test("the caught-value scan flags each way of passing one on", () => {
    for (const leaking of [
      'try {} catch (error) { console.error("failed", error); }',
      'try {} catch (failure) { console.error("failed", failure.message); }',
      "try {} catch (e) { console.warn(`failed: ${e}`); }",
      'void run().catch((reason) => console.error("failed", String(reason)));',
      'client.on("error", (problem) => { console.error("listen", problem); });',
      "console.error(error);",
    ])
      expect(rawCaughtValueCalls(leaking), leaking).toHaveLength(1);
    for (const clean of [
      'try {} catch (error) { console.error("failed", describeError(error)); }',
      'console.error("an error message with the word error in it");',
      "console.info(`cleared ${String(cleared.length)} server id(s)`);",
    ])
      expect(rawCaughtValueCalls(clean), clean).toEqual([]);
  });

  test("describeError keeps a class and a database code, never a message", async () => {
    const { describeError, ServerRefusal } =
      await import("../src/utils/logError");
    const validation = Object.assign(
      new (class PrismaClientValidationError extends Error {})(
        `Invalid \`prisma.peer.findFirst()\` invocation: { id: "${FROM}" }`,
      ),
      { clientVersion: "7.9.0" },
    );
    expect(describeError(validation)).toBe("PrismaClientValidationError");
    const known = Object.assign(
      new (class PrismaClientKnownRequestError extends Error {})(
        `Unique constraint failed on publicKey ${"ab".repeat(32)}`,
      ),
      { code: "P2002", meta: { target: ["publicKey"] } },
    );
    expect(describeError(known)).toBe("PrismaClientKnownRequestError P2002");
    expect(
      describeError(Object.assign(new Error("x"), { code: "40001" })),
    ).toBe("Error 40001");
    // A code that is not a short code is dropped, like the message.
    expect(describeError(Object.assign(new Error("x"), { code: FROM }))).toBe(
      "Error",
    );
    expect(describeError(`${FROM} as a thrown string`)).toBe(
      "non-Error string",
    );
    expect(describeError(null)).toBe("null");
    // This server's own refusals are fixed sentences and keep them.
    class Refused extends ServerRefusal {}
    expect(describeError(new Refused("Room member capacity reached"))).toBe(
      "Refused: Room member capacity reached",
    );
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
