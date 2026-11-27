import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshDatabase,
  throwawayServerUrl,
  type ThrowawayDatabase,
} from "./db/throwawayPostgres";
import { bytes, ledgerConfig } from "../src/ledger/config";
import { ledgerRpc } from "../src/ledger/rpc";
import { LedgerStore } from "../src/ledger/store";
import { verifyPeer } from "../src/ledger/verifyPeer";

const verifier = process.env.P2PARTY_TEST_LEDGER_VERIFIER;
const fixture = process.env.P2PARTY_TEST_LEDGER_FIXTURE;

test.skipIf(!verifier || !fixture || !throwawayServerUrl)(
  "a second database replays both suites, rejects a conflicting peer, and serves read-only receipts across restarts",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "p2party-replica-"));
    const databases: ThrowawayDatabase[] = [];
    const stores: LedgerStore[] = [];
    let stopListener: (() => Promise<void>) | undefined;
    try {
      const v = JSON.parse(
        execFileSync(fixture!, [], { encoding: "utf8", timeout: 20000 }),
      );
      const genesis = join(directory, "genesis.json");
      writeFileSync(
        genesis,
        JSON.stringify({
          version: 1,
          chainId: v.chainId,
          rpcChainId: 8123,
          spendSuites: [1, 2],
          receiveSuites: [1, 2],
          units: [
            {
              id: v.inputId,
              weight: "0x8",
              suite: 1,
              commitment: v.commitment,
            },
          ],
        }),
      );
      const env = {
        LEDGER_ENABLED: "true",
        LEDGER_CHAIN_ID: v.chainId,
        LEDGER_GENESIS_FILE: genesis,
        LEDGER_VERIFIER: verifier,
      };
      const config = ledgerConfig(env)!;
      databases.push(await freshDatabase([]));
      databases.push(await freshDatabase([]));
      const writer = new LedgerStore(config, databases[0]!.url);
      const follower = new LedgerStore(ledgerConfig(env)!, databases[1]!.url);
      stores.push(writer, follower);
      await writer.initialize();
      await follower.initialize("replica");
      await expect(writer.initialize("replica")).rejects.toThrow("role");
      await expect(follower.initialize()).rejects.toThrow("role");
      const serveWriter = ledgerRpc(writer);
      let fault:
        "none" | "genesis" | "output" | "signature" | "gap" | "past" | "large" =
        "none";
      const peer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const { method, params } = await req.clone().json();
          const response = await serveWriter(req);
          if (fault === "none") return response;
          const body = await response.json();
          if (fault === "genesis" && method === "demos_getGenesisHash")
            body.result = "0x" + "00".repeat(32);
          if (method === "demos_getTransferByHeight") {
            if (fault === "past" && params[0] === "0x1")
              body.result.id = "0x" + "00".repeat(64);
            if (params[0] === "0x2") {
              if (fault === "output")
                body.result.outputId = "0x" + "00".repeat(64);
              if (fault === "signature")
                body.result.wire =
                  body.result.wire.slice(0, -2) +
                  (body.result.wire.endsWith("aa") ? "bb" : "aa");
              if (fault === "gap") body.result = null;
              if (fault === "large") return new Response("x".repeat(40001));
            }
          }
          return Response.json(body);
        },
      });
      stopListener = async () => {
        await peer.stop(true);
      };
      const endpoint = new URL("/rpc", peer.url).href;
      const wire = (s: string) => bytes(s, (s.length - 2) / 2);
      const first = await writer.submit(wire(v.first));
      const checkpoint = await verifyPeer(follower, endpoint);
      expect(checkpoint.height).toBe("0x1");
      expect(await verifyPeer(follower, endpoint)).toEqual(checkpoint);
      const second = await writer.submit(wire(v.second));
      for (const mode of [
        "genesis",
        "output",
        "signature",
        "gap",
        "past",
        "large",
      ] as const) {
        fault = mode;
        await expect(verifyPeer(follower, endpoint)).rejects.toThrow();
        expect((await follower.head()).height).toBe("0x1");
        expect(await follower.transfer(2n)).toBeNull();
      }
      fault = "none";
      const replica = new LedgerStore(ledgerConfig(env)!, databases[1]!.url);
      stores.push(replica);
      await replica.initialize("replica");
      const agreed = await verifyPeer(replica, endpoint);
      let digest = createHash("sha512")
        .update("p2party/replay/v1\0")
        .update(Buffer.from(config.genesisHash, "hex"))
        .digest();
      for (const [height, id] of [
        [1, first],
        [2, second],
      ] as const) {
        const position = Buffer.alloc(8);
        position.writeBigUInt64BE(BigInt(height));
        digest = createHash("sha512")
          .update(digest)
          .update(position)
          .update(bytes(id, 64))
          .digest();
        expect(await replica.transfer(BigInt(height))).toEqual(
          await writer.transfer(BigInt(height)),
        );
      }
      expect(agreed.historyHash).toBe("0x" + digest.toString("hex"));
      expect(await verifyPeer(replica, endpoint, 1n)).toEqual(checkpoint);
      const end = (await writer.transfer(2n))!;
      expect(await replica.unit(bytes(end.outputId, 64))).toEqual(
        await writer.unit(bytes(end.outputId, 64)),
      );
      expect(await replica.unit(bytes(end.outputId, 64))).toMatchObject({
        weight: "0x8",
        spentHeight: null,
      });
      const cli = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "run",
          "src/ledger/verifyPeer.ts",
          endpoint,
        ],
        {
          env: { ...env, LEDGER_REPLICA_DATABASE_URL: databases[1]!.url },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, output] = await Promise.all([
        cli.exited,
        new Response(cli.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(output)).toEqual(agreed);
      const readReplica = ledgerRpc(replica, { readOnly: true });
      const response = await readReplica(
        new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([
            {
              jsonrpc: "2.0",
              id: 1,
              method: "demos_getTransferByHeight",
              params: ["0x2"],
            },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "demos_sendRawTransfer",
              params: [v.alternate],
            },
          ]),
        }),
      );
      const results = await response.json();
      expect(results[0].result).toEqual(end);
      expect(results[1].error.code).toBe(-32601);
    } finally {
      await stopListener?.();
      await Promise.all(stores.map((s) => s.close()));
      await Promise.all(databases.map((db) => db.drop()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  45000,
);
