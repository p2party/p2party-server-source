import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshDatabase,
  repositoryRoot,
  throwawayServerUrl,
  type ThrowawayDatabase,
} from "./db/throwawayPostgres";
import { bytes, ledgerConfig } from "../src/ledger/config";
import { ledgerRpc } from "../src/ledger/rpc";
import { LedgerStore } from "../src/ledger/store";
import { verifyPeer } from "../src/ledger/verifyPeer";

const verifier = process.env.P2PARTY_TEST_LEDGER_VERIFIER;
const fixture = process.env.P2PARTY_TEST_LEDGER_FIXTURE;

// Everything passed to the operator CLI is test-owned: its directories, keys,
// database and proposer URLs, and the genesis and native signing fixtures.
test.skipIf(!verifier || !fixture || !throwawayServerUrl)(
  "two local operators issue a durable checkpoint after independent replay and refuse a different valid fork",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "p2party-operators-"));
    const databases: ThrowawayDatabase[] = [];
    const stores: LedgerStore[] = [];
    const listeners: Bun.Server<undefined>[] = [];
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
            {
              id: v.ceilingId,
              weight: "0x8000000000000000",
              suite: 1,
              commitment: v.ceilingCommitment,
            },
          ],
        }),
      );
      const env = {
        PATH: process.env.PATH,
        LEDGER_ENABLED: "true",
        LEDGER_CHAIN_ID: v.chainId,
        LEDGER_GENESIS_FILE: genesis,
        LEDGER_VERIFIER: verifier,
      };
      const config = ledgerConfig(env)!;
      async function database() {
        const db = await freshDatabase([]);
        databases.push(db);
        const store = new LedgerStore(config, db.url);
        stores.push(store);
        return { db, store };
      }
      async function proposer() {
        const { store } = await database();
        await store.initialize();
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: ledgerRpc(store),
        });
        listeners.push(listener);
        return { store, rpc: new URL("/rpc", listener.url).href };
      }
      const main = await proposer(),
        fork = await proposer();
      const aliceDb = await database(),
        bobDb = await database(),
        forkDb = await database();
      const wire = (s: string) => bytes(s, (s.length - 2) / 2);
      await main.store.submit(wire(v.first));
      await fork.store.submit(wire(v.alternate));
      await fork.store.submit(wire(v.ceilingFirst));
      await forkDb.store.initialize("replica");
      const forkOne = await verifyPeer(forkDb.store, fork.rpc, 1n);
      const forkTwo = await verifyPeer(forkDb.store, fork.rpc, 2n);
      expect(forkTwo.height).toBe("0x2");

      async function cli(args: string[], db = aliceDb.db) {
        const p = Bun.spawn(["node", "tools/ledger-checkpoint.mjs", ...args], {
          cwd: repositoryRoot,
          env: { ...env, LEDGER_REPLICA_DATABASE_URL: db.url },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, out, err] = await Promise.all([
          p.exited,
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        return { code, out, err };
      }
      async function success(args: string[], db = aliceDb.db) {
        const result = await cli(args, db);
        if (result.code !== 0)
          throw new Error(`Local ${args[0]} failed: ${result.err}`);
        return result.out;
      }
      async function refused(args: string[], reason: RegExp, db = aliceDb.db) {
        const result = await cli(args, db);
        expect(result.code).not.toBe(0);
        expect(result.out).toBe("");
        expect(result.err).toMatch(reason);
      }
      function save(name: string, value: string) {
        const path = join(directory, name);
        writeFileSync(path, value, { mode: 0o600 });
        return path;
      }

      const alice = join(directory, "alice"),
        bob = join(directory, "bob");
      const aKey = JSON.parse(await success(["init", alice, "ml-dsa-65"]));
      const bKey = JSON.parse(
        await success(["init", bob, "slh-dsa-sha2-192s"]),
      );
      expect(aKey.keyId).not.toBe(bKey.keyId);
      await refused(["init", alice, "ml-dsa-65"], /exist/i);
      const policyArgs = [
        "policy",
        v.chainId,
        "0x" + config.genesisHash,
        join(alice, "public.pem"),
        join(bob, "public.pem"),
      ];
      const policy = save("policy", await success(policyArgs));
      await refused(
        [...policyArgs.slice(0, -1), join(alice, "public.pem")],
        /duplicate/i,
      );
      const aArgs = ["attest", alice, policy, main.rpc, "0x1"];
      const bArgs = ["attest", bob, policy, main.rpc, "0x1"];
      const [a1, a2, b1] = await Promise.all([
        success(aArgs),
        success(aArgs),
        success(bArgs, bobDb.db),
      ]);
      expect(a1).toBe(a2);
      expect(await success(bArgs, bobDb.db)).toBe(b1);
      const a = JSON.parse(a1),
        b = JSON.parse(b1);
      expect(a.suite).toBe(1);
      expect(b.suite).toBe(2);
      expect(a.keyId).toBe(aKey.keyId);
      expect(b.keyId).toBe(bKey.keyId);
      expect(a.checkpoint).toEqual(b.checkpoint);
      expect(a.checkpoint.historyHash).not.toBe(forkOne.historyHash);
      expect(a.checkpoint.logRoot).not.toBe(forkOne.logRoot);
      expect(await aliceDb.store.transfer(1n)).toEqual(
        await main.store.transfer(1n),
      );
      expect(await bobDb.store.transfer(1n)).toEqual(
        await main.store.transfer(1n),
      );
      const aliceWitness = save("alice-witness", a1),
        bobWitness = save("bob-witness", b1);
      const certText = await success([
        "combine",
        policy,
        bobWitness,
        aliceWitness,
      ]);
      const cert = save("certificate", certText);
      const offline = save("checkpoint", JSON.stringify(a.checkpoint));
      expect(
        JSON.parse(await success(["verify", policy, cert, main.rpc], bobDb.db)),
      ).toEqual(a.checkpoint);
      expect(
        JSON.parse(await success(["verify-file", policy, cert, offline])),
      ).toEqual(a.checkpoint);
      await refused(
        [
          "verify-file",
          policy,
          cert,
          save("fork-checkpoint", JSON.stringify(forkOne)),
        ],
        /checkpoint/i,
      );
      await refused(
        ["combine", policy, aliceWitness, aliceWitness],
        /duplicate/i,
      );
      const changed = JSON.parse(certText);
      changed.checkpoint.height = "0x0";
      await refused(
        [
          "verify-file",
          policy,
          save("tampered", JSON.stringify(changed)),
          offline,
        ],
        /signature|checkpoint/i,
      );
      await refused(
        ["verify", policy, cert, fork.rpc],
        /checkpoint/i,
        forkDb.db,
      );

      // The fork's native signatures and database are valid. The retained
      // operator journal still identifies the history this key approved.
      for (const height of ["0x1", "0x2"]) {
        await refused(
          ["attest", alice, policy, fork.rpc, height],
          /previous checkpoint/i,
          forkDb.db,
        );
      }
      expect(await success(aArgs)).toBe(a1);
      await main.store.submit(wire(v.second));
      const next = JSON.parse(
        await success(["attest", alice, policy, main.rpc, "0x2"]),
      );
      expect(next.checkpoint.height).toBe("0x2");
      await refused(aArgs, /below the operator's signed height/i);
      await refused(
        ["attest", bob, policy, main.rpc, "0x02"],
        /canonical ledger height/i,
        bobDb.db,
      );

      // A policy change cannot erase a key's existing signing history.
      const other = join(directory, "other");
      await success(["init", other, "ml-dsa-65"]);
      const nextPolicy = save(
        "other-policy",
        await success([...policyArgs.slice(0, -1), join(other, "public.pem")]),
      );
      await refused(["verify-file", nextPolicy, cert, offline], /policy/i);
      await refused(
        ["attest", alice, nextPolicy, fork.rpc, "0x2"],
        /previous checkpoint/i,
        forkDb.db,
      );
      // Both first-vote requests can verify their own valid replica histories.
      // The shared journal must commit exactly one before releasing its witness.
      const choices = [
        { rpc: main.rpc, db: aliceDb.db, checkpoint: a.checkpoint },
        { rpc: fork.rpc, db: forkDb.db, checkpoint: forkOne },
      ];
      const vote = (choice: (typeof choices)[number]) =>
        cli(["attest", other, nextPolicy, choice.rpc, "0x1"], choice.db);
      const attempts = await Promise.all(choices.map(vote));
      expect(attempts.map((attempt) => attempt.code).sort()).toEqual([0, 1]);
      const winner = attempts[0]!.code === 0 ? 0 : 1;
      const loser = attempts[1 - winner]!;
      expect(loser.out).toBe("");
      expect(loser.err).toMatch(/previous checkpoint|advanced the journal/i);
      expect(JSON.parse(attempts[winner]!.out).checkpoint).toEqual(
        choices[winner]!.checkpoint,
      );
      expect((await vote(choices[winner]!)).out).toBe(attempts[winner]!.out);

      const journal = join(bob, "witness.sqlite"),
        saved = join(directory, "bob-journal");
      renameSync(journal, saved);
      await refused(bArgs, /witness.sqlite|journal/i, bobDb.db);
      // A copied journal from another operator must also fail closed.
      renameSync(join(alice, "witness.sqlite"), journal);
      await refused(bArgs, /journal do not match/i, bobDb.db);
      renameSync(journal, join(alice, "witness.sqlite"));
      renameSync(saved, journal);
      expect(await success(bArgs, bobDb.db)).toBe(b1);
    } finally {
      await Promise.all(listeners.map((listener) => listener.stop(true)));
      await Promise.all(stores.map((s) => s.close()));
      await Promise.all(databases.map((db) => db.drop()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60000,
);
