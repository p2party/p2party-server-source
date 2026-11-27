import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  freshDatabase,
  repositoryRoot,
  throwawayServerUrl,
  type ThrowawayDatabase,
} from "./db/throwawayPostgres";

const verifier = process.env.P2PARTY_TEST_LEDGER_VERIFIER,
  fixture = process.env.P2PARTY_TEST_LEDGER_FIXTURE;
const enabled = Boolean(verifier && fixture && throwawayServerUrl);
const children = new Set<Bun.Subprocess>();
let db: ThrowawayDatabase | undefined, dir: string | undefined;
async function stop(p: Bun.Subprocess) {
  p.kill("SIGTERM");
  await p.exited;
  children.delete(p);
}
afterEach(async () => {
  await Promise.all([...children].map(stop));
  if (db) await db.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  db = undefined;
  dir = undefined;
});
function launch(dbUrl: string, env: Record<string, string> = {}) {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port!;
  probe.stop(true);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "run",
      join(repositoryRoot, "src/index.ts"),
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: dbUrl,
        PORT: String(port),
        SIGNALING_BIND_HOST: "127.0.0.1",
        SIGNALING_HOST: `127.0.0.1:${port}`,
        ...env,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  children.add(child);
  return { child, url: `http://127.0.0.1:${port}` };
}
function checkLedger(dbUrl: string, env: Record<string, string>) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "run",
      join(repositoryRoot, "src/index.ts"),
      "--check-ledger-state",
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: dbUrl,
        SIGNALING_HOST: "localhost",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8000,
    },
  ).exitCode;
}
async function ready(w: ReturnType<typeof launch>) {
  for (let i = 0; i < 160; i++) {
    if (w.child.exitCode !== null)
      throw new Error(`worker exited ${w.child.exitCode}`);
    const r = await fetch(w.url + "/health").catch(() => null);
    if (r?.ok) return w;
    await Bun.sleep(50);
  }
  throw new Error("worker did not start");
}
const post = (url: string, body: unknown) =>
  fetch(url + "/rpc", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const rpc = async (url: string, method: string, ...params: unknown[]) =>
  (
    await post(url, { jsonrpc: "2.0", id: 1, method, params })
  ).json() as Promise<any>;

test.skipIf(!enabled)(
  "two signaling workers validate both native suites and atomically persist transfers across restart",
  async () => {
    db = await freshDatabase();
    dir = mkdtempSync(join(tmpdir(), "ledger-node-test-"));
    const v = JSON.parse(
      execFileSync(fixture!, [], { encoding: "utf8", timeout: 20000 }),
    );
    const genesis = {
      version: 1,
      chainId: v.chainId,
      rpcChainId: 8123,
      spendSuites: [1, 2],
      receiveSuites: [1, 2],
      units: [
        { id: v.inputId, weight: "0x8", suite: 1, commitment: v.commitment },
        {
          id: v.ceilingId,
          weight: "0x8000000000000000",
          suite: 1,
          commitment: v.ceilingCommitment,
        },
      ],
    };
    const file = join(dir, "genesis.json");
    writeFileSync(file, JSON.stringify(genesis));
    const env = {
      LEDGER_ENABLED: "true",
      LEDGER_CORS_ORIGINS: "https://wallet.example",
      LEDGER_CHAIN_ID: v.chainId,
      LEDGER_GENESIS_FILE: file,
      LEDGER_VERIFIER: verifier!,
    };
    const disabled = await ready(launch(db.url));
    expect((await post(disabled.url, {})).status).toBe(404);
    expect((await fetch(disabled.url + "/rpc/health")).status).toBe(404);
    expect(checkLedger(db.url, env)).toBe(0);
    expect(
      (
        await db.client.query(
          "SELECT to_regnamespace('p2party_ledger') IS NULL AS absent",
        )
      ).rows[0].absent,
    ).toBe(true);
    await stop(disabled.child);
    const [a, b] = await Promise.all([
      ready(launch(db.url, env)),
      ready(launch(db.url, env)),
    ]);
    const identity = await db.client.query(
      "SELECT encode(genesis_hash, 'hex') AS hash FROM p2party_ledger.chain",
    );
    const genesisHash = "0x" + identity.rows[0].hash;
    expect(await rpc(a.url, "demos_getGenesisHash")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: genesisHash,
    });
    expect((await rpc(b.url, "demos_getGenesisHash", 0)).error.code).toBe(
      -32602,
    );
    expect((await rpc(a.url, "demos_chainId")).result).toBe(v.chainId);
    expect((await rpc(a.url, "eth_chainId")).result).toBe("0x1fbb");
    expect((await rpc(a.url, "demos_getHead")).result).toEqual({
      chainId: v.chainId,
      height: "0x0",
    });
    expect((await rpc(a.url, "demos_getUnit", v.inputId)).result.weight).toBe(
      "0x8",
    );
    expect(
      (await rpc(a.url, "demos_listUnspent", 1, v.commitment, 1)).result,
    ).toHaveLength(1);
    expect(
      (await rpc(a.url, "demos_listUnspent", 1, v.commitment, 1, v.inputId))
        .result,
    ).toEqual([]);
    expect(
      (await rpc(a.url, "demos_listUnspent", 1, v.commitment, 65)).error.code,
    ).toBe(-32602);
    expect(
      (await rpc(a.url, "eth_sendRawTransaction", v.first)).error.code,
    ).toBe(-32601);
    expect(
      (
        await post(
          a.url,
          Array(9).fill({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post(a.url, [{ jsonrpc: "2.0", method: "demos_getHead" }])).status,
    ).toBe(204);
    const corrupted =
      v.first.slice(0, -2) + (v.first.endsWith("ab") ? "cd" : "ab");
    expect(
      (await rpc(a.url, "demos_sendRawTransfer", corrupted)).error.code,
    ).toBe(-32010);
    const responses = await Promise.all([
      rpc(a.url, "demos_sendRawTransfer", v.first),
      rpc(b.url, "demos_sendRawTransfer", v.first),
    ]);
    expect(responses.filter((x) => x.result)).toHaveLength(2);
    expect(responses[0].result).toBe(responses[1].result);
    const id = responses.find((x) => x.result).result;
    const expected = createHash("sha512")
      .update(Buffer.from([7]))
      .update("move/id")
      .update(Buffer.from(v.first.slice(2), "hex"))
      .digest("hex");
    expect(id).toBe("0x" + expected);
    expect(
      (await rpc(a.url, "demos_sendRawTransfer", v.alternate)).error.code,
    ).toBe(-32010);
    const receipt = (await rpc(b.url, "demos_getTransfer", id)).result;
    expect(receipt).toMatchObject({
      id,
      height: "0x1",
      inputId: v.inputId,
      wire: v.first,
    });
    expect(
      (await rpc(a.url, "demos_getTransferByHeight", "0x1")).result,
    ).toEqual(receipt);
    expect(
      (await rpc(a.url, "demos_getUnit", v.inputId)).result.spentHeight,
    ).toBe("0x1");
    expect(
      (await rpc(a.url, "demos_listUnspent", 1, v.commitment, 1)).result,
    ).toEqual([]);
    expect(
      (await rpc(a.url, "demos_sendRawTransfer", v.reuse)).error.code,
    ).toBe(-32010);
    expect((await rpc(b.url, "demos_getHead")).result.height).toBe("0x1");
    expect(
      (await rpc(a.url, "demos_getUnit", receipt.outputId)).result.spentHeight,
    ).toBeNull();
    await Promise.all([stop(a.child), stop(b.child)]);
    const restarted = await ready(launch(db.url, env));
    expect((await rpc(restarted.url, "demos_getTransfer", id)).result).toEqual(
      receipt,
    );
    expect(
      (await rpc(restarted.url, "demos_sendRawTransfer", v.second)).result,
    ).toMatch(/^0x[0-9a-f]{128}$/);
    expect((await rpc(restarted.url, "demos_getHead")).result.height).toBe(
      "0x2",
    );
    expect(
      (await rpc(restarted.url, "demos_sendRawTransfer", v.first)).result,
    ).toBe(id);
    const competing = await ready(launch(db.url, env));
    const winner = await Promise.all([
      rpc(restarted.url, "demos_sendRawTransfer", v.ceilingFirst),
      rpc(competing.url, "demos_sendRawTransfer", v.ceilingAlternate),
    ]);
    expect(winner.filter((x) => x.result)).toHaveLength(1);
    expect(winner.filter((x) => x.error?.code === -32010)).toHaveLength(1);
    const capReceipt = (
      await rpc(competing.url, "demos_getTransferByHeight", "0x3")
    ).result;
    expect(
      (await rpc(competing.url, "demos_getUnit", capReceipt.outputId)).result
        .weight,
    ).toBe("0x8000000000000000");
    const browserOrigin = "https://wallet.example";
    const preflight = await fetch(restarted.url + "/rpc", {
      method: "OPTIONS",
      headers: {
        Origin: browserOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      browserOrigin,
    );
    expect(preflight.headers.has("access-control-allow-credentials")).toBe(
      false,
    );
    const browser = await fetch(restarted.url + "/rpc", {
      method: "POST",
      headers: { origin: browserOrigin, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_chainId" }),
    });
    expect(browser.headers.get("access-control-allow-origin")).toBe(
      browserOrigin,
    );
    expect((await browser.json()).result).toBe("0x1fbb");
    const denied = await fetch(restarted.url + "/rpc", {
      method: "OPTIONS",
      headers: {
        origin: "https://another.example",
        "access-control-request-method": "POST",
      },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);
    expect(await (await fetch(restarted.url + "/rpc/health")).json()).toEqual({
      status: "ok",
      chainId: v.chainId,
      rpcChainId: "0x1fbb",
      height: "0x3",
    });
    writeFileSync(file, JSON.stringify({ ...genesis, rpcChainId: 8124 }));
    expect(checkLedger(db.url, env)).not.toBe(0);
    const wrong = launch(db.url, env);
    expect(await wrong.child.exited).not.toBe(0);
    children.delete(wrong.child);
    expect((await rpc(restarted.url, "eth_chainId")).result).toBe("0x1fbb");
    expect((await rpc(restarted.url, "demos_getGenesisHash")).result).toBe(
      genesisHash,
    );
    expect(
      (await db.client.query("SELECT count(*) FROM p2party_ledger.transfers"))
        .rows[0].count,
    ).toBe("3");
  },
  45000,
);
