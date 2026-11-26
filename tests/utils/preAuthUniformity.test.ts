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
 * a lookup reinstated anywhere, behind any helper, is recorded. Five states
 * are compared: a registered key, a key an old server stored with a random
 * id, a key never seen, a key with a live claim and a live authenticated
 * socket in the process's registry (a real login), and a key whose
 * per-identity admission bucket is full. The probe drives the real server and
 * real WebSocket clients through upgrade, challenge and a signature that does
 * not verify.
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
    "registered" | "oldStyle" | "unregistered" | "connected" | "atLimit",
    {
      frames: string[];
      close: { code: number; reason: string };
      queries: string[];
    }
  > & { connectedSessionUntouched: boolean };
};

describe("pre-authentication responses", () => {
  test("unknown and known identities get the same pre-auth response", async () => {
    const observed = await runProbe();

    const states = [
      "registered",
      "oldStyle",
      "unregistered",
      "connected",
      "atLimit",
    ] as const;
    // No database work at all before the verdict, in any state.
    for (const state of states)
      expect(observed[state].queries, state).toEqual([]);
    // Byte-identical frames, close code and reason.
    for (const state of states)
      expect(observed[state], state).toEqual(observed.registered);
    // And the connected identity's live session was left alone.
    expect(observed.connectedSessionUntouched).toBe(true);
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
