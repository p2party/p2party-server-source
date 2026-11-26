import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Before the signature is checked, a socket must learn nothing about whether
 * its key has an identity row: the same bytes, the same close, the same
 * database work. Servers before 0.1.4 stored random ids, and the server used
 * to look a key up and send the stored id, which marked the key as known to
 * anyone holding it.
 *
 * The check runs in a fresh process (preAuthProbe.ts), so that the recording
 * store replaces the shared Prisma client before any server module loads:
 * a lookup reinstated anywhere, behind any helper, is recorded. The store
 * holds a registered key, a key stored by an old server with a random id, and
 * a key never seen; the probe drives the real server and real WebSocket
 * clients through upgrade, challenge and a signature that does not verify.
 */
const probe = join(dirname(fileURLToPath(import.meta.url)), "preAuthProbe.ts");

const runProbe = async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", probe], {
    // Nothing from this process's environment, so no database URL: the
    // placeholder cannot reach anything even if the mock were bypassed.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL:
        "postgresql://unset:unset@127.0.0.1:1/unset?sslmode=disable",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<
    "registered" | "oldStyle" | "unregistered",
    {
      frames: string[];
      close: { code: number; reason: string };
      queries: string[];
    }
  >;
};

describe("pre-authentication responses", () => {
  test("unknown and known identities get the same pre-auth response", async () => {
    const observed = await runProbe();

    // No database work at all before the verdict, for any of the three.
    expect(observed.registered.queries).toEqual([]);
    expect(observed.oldStyle.queries).toEqual([]);
    expect(observed.unregistered.queries).toEqual([]);
    // Byte-identical frames, close code and reason.
    expect(observed.oldStyle).toEqual(observed.registered);
    expect(observed.unregistered).toEqual(observed.registered);
    expect(observed.registered).toEqual({
      frames: [
        '{"type":"peerId","peerId":"<derived peer id>","challenge":"<nonce>","protocolVersion":4,"message":"Connected to WebSocket server. Your client id is <derived peer id>"}',
        '{"type":"error","fromAction":"sendChallengeResponse","error":{"message":"Challenge response signature cannot be verified"}}',
      ],
      close: {
        code: 1008,
        reason: "Challenge response signature cannot be verified",
      },
      queries: [],
    });
  }, 30_000);
});
