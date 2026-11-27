// Two profiles share only a public request. Every browser request is intercepted.
// The disposable checkpoint has one synthetic funded unit and can never enter the public validator.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  cp,
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import decodeQR from "qr/decode.js";
import { Wallet } from "../wallet.mjs";
import { assertVerified } from "../native-test-helpers.mjs";
import { catchupPage } from "./test-catchup-page.mjs";
const { chromium, firefox } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const host = "https://p2party.github.io/p2party-server/restore/";
const broker = "https://p2party.com/wallet/snapshot/";
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function contents(download) {
  return readFile(await download.path(), "utf8");
}
async function saveKit(page) {
  const event = page.waitForEvent("download");
  await page.locator("#kit-download").click();
  const file = await event;
  return { filename: file.suggestedFilename(), archive: await contents(file) };
}
async function openFromFile(page, kit, code, stage = false) {
  await page.locator(stage ? "#kit-file" : "#archive").setInputFiles({
    name: kit.filename,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(kit.archive),
  });
  await page.locator(stage ? "#kit-code" : "#code").fill(code);
  await button(
    page,
    stage ? "Check backup and open request" : "Restore wallet",
  ).click();
}
const waitContains = (page, id, text) =>
  page.waitForFunction(
    ({ id, text }) => document.getElementById(id)?.textContent.includes(text),
    { id, text },
    { timeout: 30000 },
  );
async function signRequest(page, request, inputId) {
  const recipient = JSON.parse(request).recipient;
  if (
    !(await page.locator("#payment-panel").evaluate((details) => details.open))
  )
    await page.locator("#payment-heading").click();
  await page.locator("#payer-request").fill(request);
  assert.equal(await page.locator("#payer-source").inputValue(), inputId);
  await page.locator("#payer-expiry").fill("32");
  await button(page, "Review this request").click();
  await page.locator("#review-panel:visible").waitFor();
  assert.ok(
    (await page.locator("#review-details").textContent()).includes(
      recipient.commitment,
    ),
  );
  await button(page, "Sign this payment").click();
  await page.locator("#signed-panel:visible").waitFor();
  const paymentDownload = page.waitForEvent("download");
  await button(page, "Download signed payment").click();
  const payment = JSON.parse(await contents(await paymentDownload));
  assert.equal(payment.inputId, inputId);
  assert.deepEqual(payment.recipient, recipient);
  return payment;
}
async function provision() {
  const wallet = Wallet.create(1),
    paymentKit = await wallet.backup(),
    code = wallet.recoveryCode();
  await wallet.confirm(paymentKit.archive, code);
  const account = wallet.state().wallet.accounts[0];
  wallet.destroy();
  const checkpoint = JSON.parse(
    await readFile(join(root, "browser/balance-checkpoint.json"), "utf8"),
  );
  const prefix = JSON.parse(
    await readFile(join(root, "browser/checkpoint-history.json"), "utf8"),
  );
  const slot = checkpoint.snapshot.units.findIndex((u) =>
    prefix.every((r) => r.outputId !== u.id),
  );
  const unit = {
    id: "0x" + randomBytes(64).toString("hex"),
    suite: account.suite,
    commitment: account.commitment,
    weight: "0x1",
  };
  checkpoint.snapshot.units[slot] = unit;
  const dir = await mkdtemp(join(tmpdir(), "p2party-offline-receive-"));
  try {
    await cp(join(root, "browser"), join(dir, "browser"), { recursive: true });
    for (const name of ["format.mjs", "snapshot.mjs"])
      await cp(join(root, name), join(dir, name));
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    await writeFile(
      join(dir, "browser", "balance-checkpoint.json"),
      JSON.stringify(checkpoint),
    );
    execFileSync(process.execPath, [join(dir, "browser/build.mjs")], {
      env: process.env,
    });
    return {
      html: await readFile(join(dir, "browser/restore-wallet.html")),
      paymentKit,
      code,
      unit,
      slot,
      baseline: checkpoint.snapshot,
      baselineTip: prefix.at(-1).id,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test(
  "receive offline then restore and synchronize a validated one-unit payment",
  { timeout: 280000 },
  async (t) => {
    assert.ok(
      process.env.P2PARTY_WALLET_VERIFIER,
      "Set P2PARTY_WALLET_VERIFIER to the built native verifier",
    );
    const fixture = await provision();
    const official = await readFile(
      process.env.P2PARTY_WALLET_HTML ||
        join(root, "browser/restore-wallet.html"),
    );
    for (const [engine, browserType] of [
      ["chromium", chromium],
      ["firefox", firefox],
    ]) {
      await t.test(engine, { timeout: 120000 }, async (t) => {
        const executablePath =
          engine === "firefox"
            ? process.env.P2PARTY_FIREFOX_PATH
            : process.env.P2PARTY_CHROMIUM_PATH;
        const browser = await browserType.launch({
          headless: true,
          ...(executablePath ? { executablePath } : {}),
        });
        t.after(() => browser.close());
        let tip = fixture.baselineTip,
          snapshot = structuredClone(fixture.baseline),
          wires = [],
          unavailable = false;
        const reads = [],
          unexpected = [];
        async function profile(html) {
          const context = await browser.newContext({
            acceptDownloads: true,
            viewport: { width: 360, height: 805 },
            serviceWorkers: "block",
          });
          await context.route("**/*", async (route) => {
            const req = route.request(),
              url = req.url().split("#")[0];
            if (url === host)
              return route.fulfill({ contentType: "text/html", body: html });
            if (url === broker) {
              reads.push({
                method: req.method(),
                data: req.postData(),
                ref: req.headers().referer,
              });
              return route.fulfill({
                contentType: "text/html",
                body: catchupPage({
                  snapshot,
                  headMoveId: tip,
                  wires,
                  fail: unavailable,
                }),
              });
            }
            unexpected.push(url);
            return route.abort();
          });
          const page = await context.newPage();
          await page.goto(host + "#receive");
          return { context, page };
        }
        const receiver = await profile(official);
        await button(receiver.page, "Create a wallet").click();
        await receiver.page.locator("#receive-kit:visible").waitFor();
        assert.equal(
          await receiver.page.locator("#request-public-data").isVisible(),
          false,
        );
        const firstKit = await saveKit(receiver.page);
        await button(receiver.page, "Show recovery code").click();
        const recovery = await receiver.page
          .locator("#new-wallet-code")
          .textContent();
        assert.ok(recovery.startsWith("P2W1-"));
        await button(receiver.page, "Hide recovery code").click();
        await openFromFile(receiver.page, firstKit, "wrong-code", true);
        await waitContains(receiver.page, "receive-status", "Could not open");
        assert.equal(
          await receiver.page.locator("#request-public-data").isVisible(),
          false,
        );
        await openFromFile(receiver.page, firstKit, recovery, true);
        await receiver.page.locator("#receive-public:visible").waitFor();
        const firstRequest = await receiver.page
          .locator("#receive-text")
          .inputValue();

        await receiver.page.locator("#receive-suite").selectOption("2");
        await button(receiver.page, "Create a receive request").click();
        await receiver.page.locator("#receive-kit:visible").waitFor();
        assert.equal(
          await receiver.page.locator("#request-public-data").isVisible(),
          false,
        );
        const finalKit = await saveKit(receiver.page);
        await openFromFile(receiver.page, firstKit, recovery, true);
        await waitContains(
          receiver.page,
          "receive-status",
          "exact updated backup",
        );
        await openFromFile(receiver.page, finalKit, recovery, true);
        await receiver.page.locator("#receive-public:visible").waitFor();
        const request = await receiver.page
          .locator("#receive-text")
          .inputValue();
        assert.notEqual(request, firstRequest);
        const receipt = JSON.parse(request);
        assert.equal(receipt.recipient.suite, 2);
        assert.deepEqual(Object.keys(receipt.recipient).sort(), [
          "commitment",
          "suite",
        ]);
        await receiver.page.locator("#receive-qr summary").click();
        await receiver.page.waitForFunction(
          () => document.getElementById("request-qr").naturalWidth > 0,
        );
        const image = await receiver.page
          .locator("#request-qr")
          .evaluate((img) => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const { width, height, data } = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            return { width, height, data: Array.from(data) };
          });
        assert.equal(
          decodeQR({ ...image, data: Uint8Array.from(image.data) }),
          request,
        );
        const publicDownload = receiver.page.waitForEvent("download");
        await receiver.page.locator("#download-receive").click();
        assert.equal(await contents(await publicDownload), request);
        assert.equal(
          await receiver.page.evaluate(() => localStorage.length),
          0,
        );
        await receiver.context.close();

        // The receiver has no open context when the payer signs and the fixture accepts it.
        const payer = await profile(fixture.html);
        await openFromFile(payer.page, fixture.paymentKit, fixture.code);
        await payer.page.locator("#overview:visible").waitFor();
        assert.equal(
          await payer.page.locator("#balance-button").textContent(),
          "1 P2PARTY",
        );
        const payment = await signRequest(payer.page, request, fixture.unit.id);
        assertVerified(payment, fixture.unit, 4n);
        tip = payment.moveId;
        wires = [payment.wire];
        snapshot = {
          ...snapshot,
          height: "0x4",
          units: snapshot.units.map((u, i) =>
            i === fixture.slot
              ? { id: payment.outputId, ...receipt.recipient, weight: "0x1" }
              : u,
          ),
        };
        assert.equal(reads.length, 0);
        await payer.context.close();

        const recovered = await profile(fixture.html);
        await openFromFile(recovered.page, finalKit, recovery);
        await recovered.page.locator("#receive-public:visible").waitFor();
        assert.equal(
          await recovered.page.locator("#receive-text").inputValue(),
          request,
        );
        assert.equal(
          await recovered.page.locator("#balance-button").textContent(),
          "0 P2PARTY",
        );
        unavailable = true;
        await button(recovered.page, "Sync with validator").click();
        await waitContains(
          recovered.page,
          "receive-observation",
          "latest check failed",
        );
        unavailable = false;
        await button(recovered.page, "Sync with validator").click();
        await waitContains(
          recovered.page,
          "receive-observation",
          "Payment received and unspent at height 4",
        );
        assert.equal(
          await recovered.page.locator("#balance-button").textContent(),
          "1 P2PARTY",
        );
        assert.equal(
          await recovered.page.locator("#request-public-data").isVisible(),
          false,
        );
        assert.equal(
          await recovered.page.locator("#payer-source").inputValue(),
          payment.outputId,
        );
        assert.equal(
          await recovered.page.evaluate(
            () => localStorage.length + sessionStorage.length,
          ),
          0,
        );
        // Spend the newly discovered unit, then check that restoring an older session
        // recovers both receipt and spend heights at the new head.
        const next = await signRequest(
          recovered.page,
          firstRequest,
          payment.outputId,
        );
        assertVerified(next, payment.recipient, 5n);
        await recovered.context.close();
        tip = next.moveId;
        wires = [payment.wire, next.wire];
        snapshot = {
          ...snapshot,
          height: "0x5",
          units: snapshot.units.map((u, i) =>
            i === fixture.slot
              ? { id: next.outputId, ...next.recipient, weight: "0x1" }
              : u,
          ),
        };
        const again = await profile(fixture.html);
        await openFromFile(again.page, finalKit, recovery);
        await again.page.locator("#receive-public:visible").waitFor();
        await button(again.page, "Sync with validator").click();
        await waitContains(
          again.page,
          "receive-observation",
          "Payment received, then spent at height 5",
        );
        await waitContains(
          again.page,
          "receive-observation",
          "Received at height 4. Spent at height 5.",
        );
        assert.equal(
          await again.page.locator("#request-public-data").isVisible(),
          false,
        );
        await again.page.locator("#receive-account").selectOption("0");
        await waitContains(
          again.page,
          "receive-observation",
          "Payment received and unspent at height 5",
        );
        assert.equal(
          await again.page.locator("#payer-source").inputValue(),
          next.outputId,
        );
        assert.deepEqual(unexpected, []);
        assert.equal(reads.length, 3);
        assert.ok(reads.every((r) => r.method === "GET" && !r.data && !r.ref));
        await again.context.close();
      });
    }
  },
);
