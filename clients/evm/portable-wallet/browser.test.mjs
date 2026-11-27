// Start two local companions and two independent Chromium profiles. No live RPC.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { CANONICAL_GENESIS } from "./snapshot.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE ?? "playwright",
);
const directory = await mkdtemp(join(tmpdir(), "p2party-portable-e2e-"));
const processes = [];
const profiles = [];
const external = [];
const errors = [];

async function launchCompanion() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./serve.mjs", import.meta.url))],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  processes.push(child);
  const lines = createInterface({ input: child.stdout });
  try {
    const signal = AbortSignal.timeout(15_000);
    const [line] = await Promise.race([
      once(lines, "line", { signal }),
      once(child, "exit", { signal }).then(() => {
        throw new Error("Companion exited before printing its address.");
      }),
    ]);
    const origin = /^P2Party wallet (http:\/\/127\.0\.0\.1:\d+)\/?$/u.exec(
      line,
    )?.[1];
    assert.ok(origin, "Companion must start on an ephemeral loopback port.");
    return origin;
  } finally {
    lines.close();
  }
}

async function browserProfile(name, origin, width) {
  const context = await chromium.launchPersistentContext(
    join(directory, name),
    {
      headless: true,
      viewport: { width, height: 820 },
      acceptDownloads: true,
      serviceWorkers: "block",
    },
  );
  profiles.push(context);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    external.push(url.origin);
    return route.abort();
  });
  const page = context.pages()[0];
  page.on("pageerror", () => errors.push("Unexpected browser error"));
  await page.goto(origin);
  await page.getByRole("heading", { name: "Open on this device" }).waitFor();
  return page;
}

const button = (page, name) => page.getByRole("button", { name, exact: true });

async function exportKit(page, filename) {
  const downloading = page.waitForEvent("download");
  await button(page, "Download encrypted backup").click();
  const download = await downloading;
  const archive = join(directory, filename);
  await download.saveAs(archive);
  await button(page, "Show recovery code").click();
  await page.locator("#code:visible").waitFor();
  const recoveryCode = await page.locator("#code").textContent();
  assert.ok(
    recoveryCode && recoveryCode.length >= 32,
    "Generated recovery code must be present.",
  );
  await button(page, "Hide recovery code").click();
  assert.equal(await page.locator("#code").textContent(), "");
  return { archive, recoveryCode };
}

async function enterKit(page, kit, action) {
  await page.getByLabel("Encrypted backup file").setInputFiles(kit.archive);
  await page
    .getByLabel("Recovery code", { exact: true })
    .fill(kit.recoveryCode);
  await button(page, action).click();
}

async function verifySpending(page, index) {
  const entry = page.locator("#account-list details").nth(index);
  await entry.locator("summary").click();
  const publicCommitment = await entry.locator("code").first().textContent();
  const publicHandle = await entry.locator("code").last().textContent();
  const result = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/prove",
  );
  await entry.getByRole("button", { name: "Check spending access" }).click();
  const response = await result;
  assert.ok(response.ok());
  const proof = await response.json();
  assert.equal(proof.commitment, publicCommitment);
  assert.equal(proof.readHandle, publicHandle);
  assert.ok(proof.moveId && proof.outputId && proof.wire && proof.chainId);
  await page
    .getByRole("status")
    .getByText(/Spending access verified/)
    .waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  return { publicCommitment, publicHandle };
}

try {
  const firstOrigin = await launchCompanion();
  const secondOrigin = await launchCompanion();
  assert.notEqual(firstOrigin, secondOrigin);
  const first = await browserProfile("old-profile", firstOrigin, 1100);
  const second = await browserProfile("new-profile", secondOrigin, 360);

  await first.getByText("Create a new wallet", { exact: true }).click();
  await button(first, "Create wallet").click();
  await first
    .getByRole("heading", { name: "Save your recovery kit" })
    .waitFor();
  assert.equal(await first.locator("#account-list details").count(), 0);
  const initialKit = await exportKit(first, "first-encrypted-wallet");
  await button(first, "Check my backup").click();
  await enterKit(first, initialKit, "Confirm backup");
  await first
    .getByText("Backup checked. Your receive requests are ready.")
    .waitFor();
  const originalFirst = await verifySpending(first, 0);

  await first.getByText("Add a receive request", { exact: true }).click();
  await first.getByLabel("Signing suite", { exact: true }).selectOption("2");
  await button(first, "Create receive request").click();
  await first
    .getByRole("heading", { name: "Save your recovery kit" })
    .waitFor();
  const updatedKit = await exportKit(first, "updated-encrypted-wallet");
  await button(first, "Check my backup").click();
  await enterKit(first, updatedKit, "Confirm backup");
  await first
    .getByText("Backup checked. Your receive requests are ready.")
    .waitFor();
  const originalSecond = await verifySpending(first, 1);
  await button(first, "Move to another browser").click();
  await first.locator("#restore-step:visible").waitFor();
  const kitToCarry = await exportKit(first, "portable-encrypted-wallet");

  // Lose access to the old wallet process before restoring on the other one.
  const exited = once(processes[0], "exit");
  processes[0].kill();
  await exited;
  await button(second, "Restore my wallet").click();
  await enterKit(
    second,
    { archive: kitToCarry.archive, recoveryCode: "incorrect" },
    "Restore wallet",
  );
  await second.waitForFunction(
    () =>
      !document.querySelector("#submit-unlock").disabled &&
      document.querySelector("#status").textContent !== "Working…",
  );
  assert.ok(await second.locator("#unlock").isVisible());
  assert.ok(!(await second.locator("#overview").isVisible()));
  await enterKit(second, kitToCarry, "Restore wallet");
  await second
    .getByText(
      "Wallet restored. Open a receive request to check spending access.",
    )
    .waitFor();
  await second.reload();
  await second.getByText("2 confirmed receive requests.").waitFor();
  assert.deepEqual(await verifySpending(second, 0), originalFirst);
  assert.deepEqual(await verifySpending(second, 1), originalSecond);

  // Every wallet can use the same whole-chain snapshot. Fabricate holdings solely in this local test.
  const genesis = JSON.parse(
    await readFile(
      new URL("../../../deploy/testnet/genesis.json", import.meta.url),
    ),
  );
  Object.assign(genesis.units[0], {
    suite: 1,
    commitment: originalFirst.publicCommitment,
  });
  Object.assign(genesis.units[1], {
    suite: 2,
    commitment: originalSecond.publicCommitment,
  });
  const snapshot = {
    version: 1,
    chainId: genesis.chainId,
    genesisHash: CANONICAL_GENESIS,
    height: "0x20",
    units: genesis.units,
  };
  await second.getByText("Check my total locally", { exact: true }).click();
  await second
    .getByLabel("Replica snapshot (.json)")
    .setInputFiles({
      name: "snapshot.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(snapshot)),
    });
  await button(second, "Read snapshot").click();
  await second
    .getByText(
      "Snapshot reports 2 P2PARTY at height 32 for the confirmed requests in this wallet. The snapshot is unverified.",
    )
    .waitFor();

  // Another profile on this same local server also starts empty.
  const guest = await browserProfile("other-profile", secondOrigin, 360);
  assert.ok(!(await guest.locator("#overview").isVisible()));
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS independent browser profiles restored both signing suites and signed offline after the source companion stopped; local snapshot balance, same-host session isolation and mobile width passed.",
  );
} finally {
  await Promise.allSettled(profiles.map((profile) => profile.close()));
  await Promise.allSettled(
    processes.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }),
  );
  await rm(directory, { recursive: true, force: true });
}
