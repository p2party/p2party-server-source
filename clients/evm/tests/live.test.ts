import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  freshDatabase,
  repositoryRoot,
  throwawayServerUrl,
} from "../../../tests/db/throwawayPostgres";

test("ethers and viem use both native signature suites on a real HTTP validator", async () => {
  const verifier = process.env.P2PARTY_TEST_LEDGER_VERIFIER;
  if (!throwawayServerUrl || !verifier)
    throw new Error(
      "Set P2PARTY_TEST_POSTGRES_URL and P2PARTY_TEST_LEDGER_VERIFIER to isolated test fixtures",
    );
  const db = await freshDatabase();
  try {
    const runner = Bun.spawn(
      [
        "node",
        fileURLToPath(new URL("./live.mjs", import.meta.url)),
        process.execPath,
        repositoryRoot,
      ],
      {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: db.url,
          LEDGER_VERIFIER: verifier,
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    expect(await runner.exited).toBe(0);
  } finally {
    await db.drop();
  }
}, 60000);
