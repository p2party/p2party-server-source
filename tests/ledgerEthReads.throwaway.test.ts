import { expect, test } from "bun:test";
import { bytes, type LedgerConfig } from "../src/ledger/config";
import { ethRead } from "../src/ledger/ethReads";
import { LedgerStore } from "../src/ledger/store";
import { freshDatabase, throwawayServerUrl } from "./db/throwawayPostgres";

const address = "0xcd251d0976773ce76c45672266ff523e46ba0bc5";
test.skipIf(!throwawayServerUrl)(
  "indexed historical reads migrate the previous native schema and reject ambiguous handles",
  async () => {
    const db = await freshDatabase([]);
    const config: LedgerConfig = {
      chainId: "0x" + "01".repeat(32),
      rpcChainId: 8123,
      spendMask: 3,
      receiveMask: 3,
      units: [
        {
          id: "0x" + "01".repeat(64),
          commitment: "0x" + "0a".repeat(64),
          suite: 1,
          weight: "0x8",
        },
        {
          id: "0x" + "02".repeat(64),
          commitment: "0x" + "0b".repeat(64),
          suite: 2,
          weight: "0x10",
        },
      ],
      genesisHash: "1c".repeat(32),
      verifier: "/unused",
      corsOrigins: [],
    };
    const store = new LedgerStore(config, db.url);
    try {
      await store.preflight();
      expect(
        (await db.client.query("SELECT to_regnamespace('p2party_ledger') AS n"))
          .rows[0].n,
      ).toBeNull();
      await store.initialize();
      await store.preflight();
      await db.client.query(
        "ALTER TABLE p2party_ledger.units DROP COLUMN read_handle",
      );
      await store.preflight();
      await store.initialize();
      expect(
        await ethRead(store, "eth_getBalance", [address, "earliest"]),
      ).toBe("0x8");
      await db.client.query("UPDATE p2party_ledger.chain SET height=2");
      await db.client.query(
        "UPDATE p2party_ledger.units SET spent=1 WHERE id=$1",
        [bytes(config.units[0].id, 64)],
      );
      expect(await ethRead(store, "eth_getBalance", [address, "0x0"])).toBe(
        "0x8",
      );
      expect(await ethRead(store, "eth_getBalance", [address, "latest"])).toBe(
        "0x0",
      );
      expect(
        await ethRead(store, "eth_getBalance", ["0x" + "00".repeat(20), "0x1"]),
      ).toBe("0x0");
      await expect(
        ethRead(store, "eth_getBalance", [address, "0x3"]),
      ).rejects.toHaveProperty("code", -32001);
      await expect(
        ethRead(store, "eth_getBalance", [address, "finalized"]),
      ).rejects.toHaveProperty("code", -32602);
      // A 160-bit collision is impractical to generate. Force the stored derived handle on this disposable ledger.
      await db.client.query(
        "UPDATE p2party_ledger.units SET created=2, read_handle=$1 WHERE id=$2",
        [bytes(address, 20), bytes(config.units[1].id, 64)],
      );
      expect(await ethRead(store, "eth_getBalance", [address, "0x1"])).toBe(
        "0x0",
      );
      await expect(
        ethRead(store, "eth_getBalance", [address, "latest"]),
      ).rejects.toHaveProperty("code", -32004);
      expect(await store.unit(bytes(config.units[0].id, 64))).toMatchObject({
        commitment: config.units[0].commitment,
      });
      const mismatch = new LedgerStore(
        { ...config, genesisHash: "ff".repeat(32) },
        db.url,
      );
      try {
        await expect(mismatch.preflight()).rejects.toThrow(/genesis/);
      } finally {
        await mismatch.close();
      }
    } finally {
      await store.close();
      await db.drop();
    }
  },
  30000,
);
