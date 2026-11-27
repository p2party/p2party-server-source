import { Pool, type PoolClient } from "pg";
import { postgresConnection } from "../db/ssl";
import schema from "./schema.sql" with { type: "text" };
import { bytes, hex, hexQuantity, RpcError, type LedgerConfig } from "./config";
import { validateTransfer, type StoredUnit } from "./native";

const unitView = (u: StoredUnit) => ({
  id: hex(u.id),
  weight: hexQuantity(u.weight),
  suite: u.suite,
  commitment: hex(u.commitment),
  createdHeight: hexQuantity(u.created),
  spentHeight: u.spent === null ? null : hexQuantity(u.spent),
});
const rejected = () => new RpcError(-32010, "Transfer rejected");
export const busy = () => new RpcError(-32005, "Validator busy; retry");

export class LedgerStore {
  private readonly pool: Pool;
  constructor(
    readonly config: LedgerConfig,
    dbUrl: string,
  ) {
    this.pool = new Pool({
      ...postgresConnection(dbUrl),
      max: 4,
      connectionTimeoutMillis: 2500,
      statement_timeout: 5000,
      lock_timeout: 2000,
      idle_in_transaction_session_timeout: 5000,
      query_timeout: 6500,
    });
    this.pool.on("error", () =>
      console.error("p2party: idle ledger database connection failed"),
    );
  }
  close() {
    return this.pool.end();
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query("BEGIN");
      const result = await work(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      c.release(discard);
    }
  }
  async initialize() {
    const cfg = this.config;
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(1684368751, 1818584935)");
      await c.query(schema);
      const existing = await c.query<{
        chain_id: Buffer;
        genesis_hash: Buffer;
      }>(
        "SELECT chain_id,genesis_hash FROM p2party_ledger.chain WHERE singleton",
      );
      if (existing.rows[0]) {
        if (
          hex(existing.rows[0].chain_id) !== cfg.chainId ||
          existing.rows[0].genesis_hash.toString("hex") !== cfg.genesisHash
        )
          throw new Error("Configured genesis differs from the stored ledger");
        return;
      }
      await c.query("INSERT INTO p2party_ledger.chain VALUES(true,$1,$2,0)", [
        bytes(cfg.chainId, 32),
        Buffer.from(cfg.genesisHash, "hex"),
      ]);
      if (cfg.units.length)
        await c.query(
          `INSERT INTO p2party_ledger.units(id,weight,suite,commitment,created)
        SELECT decode(u.id,'hex'),u.weight,u.suite,decode(u.commitment,'hex'),0 FROM unnest($1::text[],$2::numeric[],$3::smallint[],$4::text[]) AS u(id,weight,suite,commitment)`,
          [
            cfg.units.map((u) => u.id.slice(2)),
            cfg.units.map((u) => BigInt(u.weight).toString()),
            cfg.units.map((u) => u.suite),
            cfg.units.map((u) => u.commitment.slice(2)),
          ],
        );
    });
  }
  async head() {
    const { rows } = await this.pool.query<{ height: string }>(
      "SELECT height FROM p2party_ledger.chain WHERE singleton",
    );
    return {
      chainId: this.config.chainId,
      height: hexQuantity(rows[0]!.height),
    };
  }
  async unit(id: Buffer) {
    const { rows } = await this.pool.query<StoredUnit>(
      "SELECT * FROM p2party_ledger.units WHERE id=$1",
      [id],
    );
    return rows[0] ? unitView(rows[0]) : null;
  }
  async unspent(
    suite: number,
    commitment: Buffer,
    limit: number,
    after: Buffer | null,
  ) {
    const { rows } = await this.pool.query<StoredUnit>(
      `SELECT * FROM p2party_ledger.units WHERE suite=$1 AND commitment=$2 AND spent IS NULL AND ($3::bytea IS NULL OR id>$3) ORDER BY id LIMIT $4`,
      [suite, commitment, after, limit],
    );
    return rows.map(unitView);
  }
  async transfer(key: Buffer | bigint) {
    const { rows } = await this.pool.query<{
      id: Buffer;
      height: string;
      input_id: Buffer;
      output_id: Buffer;
      wire: Buffer;
    }>(
      `SELECT * FROM p2party_ledger.transfers WHERE ${typeof key === "bigint" ? "height" : "id"}=$1`,
      [typeof key === "bigint" ? key.toString() : key],
    );
    const r = rows[0];
    return r
      ? {
          id: hex(r.id),
          height: hexQuantity(r.height),
          inputId: hex(r.input_id),
          outputId: hex(r.output_id),
          wire: hex(r.wire),
        }
      : null;
  }
  async submit(wire: Buffer) {
    // This unauthenticated field is only a lookup hint. The native verifier
    // authenticates the complete wire against the independently loaded unit.
    const inputId = wire.subarray(34, 98);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await this.pool.query<
        StoredUnit & { height: string; accepted: Buffer | null }
      >(
        `SELECT u.*,c.height, t.id AS accepted FROM p2party_ledger.units u CROSS JOIN p2party_ledger.chain c
         LEFT JOIN p2party_ledger.transfers t ON t.input_id=u.id AND t.wire=$2 WHERE c.singleton AND u.id=$1`,
        [inputId, wire],
      );
      const input = rows[0];
      if (!input) throw rejected();
      if (input.accepted) return hex(input.accepted);
      if (input.spent !== null) throw rejected();
      const height = BigInt(input.height) + 1n;
      if (height > (1n << 63n) - 1n)
        throw new RpcError(-32011, "Ledger height exhausted");
      const out = await validateTransfer(this.config, height, input, wire);
      try {
        const committed = await this.transaction(async (c) => {
          const head = await c.query(
            "UPDATE p2party_ledger.chain SET height=$1 WHERE singleton AND height=$2",
            [height.toString(), input.height],
          );
          if (!head.rowCount) return false;
          const spent = await c.query(
            "UPDATE p2party_ledger.units SET spent=$1 WHERE id=$2 AND spent IS NULL",
            [height.toString(), inputId],
          );
          if (spent.rowCount !== 1) throw rejected();
          await c.query(
            "INSERT INTO p2party_ledger.units(id,weight,suite,commitment,created) VALUES($1,$2,$3,$4,$5)",
            [
              out.outputId,
              input.weight,
              out.suite,
              out.commitment,
              height.toString(),
            ],
          );
          await c.query(
            "INSERT INTO p2party_ledger.transfers(id,height,input_id,output_id,wire) VALUES($1,$2,$3,$4,$5)",
            [out.id, height.toString(), inputId, out.outputId, wire],
          );
          return true;
        });
        if (committed) return hex(out.id);
      } catch (e) {
        if (e && typeof e === "object" && "code" in e) {
          if (e.code === "23505") throw rejected();
          if (
            e.code === "55P03" ||
            e.code === "57014" ||
            e.code === "40001" ||
            e.code === "40P01"
          )
            throw busy();
        }
        throw e;
      }
    }
    const accepted = await this.pool.query<{ id: Buffer }>(
      "SELECT id FROM p2party_ledger.transfers WHERE input_id=$1 AND wire=$2",
      [inputId, wire],
    );
    if (accepted.rows[0]) return hex(accepted.rows[0].id);
    throw busy();
  }
}
