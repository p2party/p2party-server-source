// Exercise the exported HTML with genuine companion archives and OpenSSL's native verifier.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { CHAIN, GENESIS } from "../format.mjs";
import { CANONICAL_GENESIS } from "../snapshot.mjs";
import { assertVerified } from "../native-test-helpers.mjs";

const { chromium, firefox } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const { Wallet } = await import(
  process.env.P2PARTY_ARCHIVE_WRITER
    ? pathToFileURL(resolve(process.env.P2PARTY_ARCHIVE_WRITER)).href
    : "../wallet.mjs"
);
const artifact =
  process.env.P2PARTY_WALLET_HTML ||
  fileURLToPath(new URL("./restore-wallet.html", import.meta.url));
const verifier = process.env.P2PARTY_WALLET_VERIFIER;
const freshId = () => "0x" + randomBytes(64).toString("hex");
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function message(page, substring) {
  await page.waitForFunction(
    (s) => document.getElementById("status").textContent.includes(s),
    substring,
    { timeout: 120000 },
  );
}
function verifyNative(output, request) {
  assert.deepEqual(output.recipient, request.recipient);
  assert.equal(output.chainId, CHAIN);
  assert.equal(output.inputId, request.input.id);
  assertVerified(output, request.input);
}
async function pasteOrDrop(page, eventType, contents, asFile) {
  await page.evaluate(
    ({ eventType, contents, asFile }) => {
      const dt = new DataTransfer();
      if (asFile)
        dt.items.add(
          new File([contents], "wallet.jwe", {
            type: "application/octet-stream",
          }),
        );
      else dt.setData("text/plain", contents);
      const e = new Event(eventType, { bubbles: true, cancelable: true });
      Object.defineProperty(
        e,
        eventType === "paste" ? "clipboardData" : "dataTransfer",
        { value: dt },
      );
      document.getElementById("drop").dispatchEvent(e);
    },
    { eventType, contents, asFile },
  );
}
async function signIn(page, code) {
  await page.getByLabel("Recovery code", { exact: true }).fill(code);
  await button(page, "Restore wallet").click();
  await page
    .getByRole("heading", { name: "Your wallet", exact: true })
    .waitFor({ timeout: 120000 });
}
async function lockedBalance(page) {
  const trigger = page.getByRole("button", {
    name: "Wallet balance",
    exact: true,
  });
  assert.equal(await trigger.textContent(), "Balance");
  await trigger.click();
  await page.getByRole("dialog", { name: "Wallet balance" }).waitFor();
  assert.equal(await page.locator("#balance-amount").textContent(), "Locked");
  assert.equal(await page.locator("#balance-meta").isVisible(), false);
  await page.keyboard.press("Escape");
  assert.equal(
    await trigger.evaluate((node) => node === document.activeElement),
    true,
  );
}
async function importSnapshot(page, snapshot, expected) {
  await page.locator("#balance-file").setInputFiles({
    name: "snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await button(page, "Check snapshot").click();
  await page.waitForFunction(
    (text) =>
      document.getElementById("balance-status").textContent.includes(text),
    expected,
  );
}
async function checkWalletBalance(page, accounts) {
  const trigger = page.locator("#balance-button");
  assert.equal(await trigger.textContent(), "0 P2PARTY");
  await trigger.click();
  assert.equal(await page.locator("#balance-height").textContent(), "3");
  assert.equal(
    await page.locator("#balance-source").textContent(),
    "Snapshot bundled with this release",
  );
  assert.equal(
    await page.locator("#balance-amount").textContent(),
    "0 P2PARTY",
  );
  const units = Array.from({ length: 128 }, () => ({
    id: freshId(),
    suite: 1,
    commitment: freshId(),
    weight: "0x1",
  }));
  for (const [i, account] of accounts.entries())
    Object.assign(units[i], {
      commitment: account.commitment,
      suite: account.suite,
    });
  const snapshot = {
    version: 1,
    chainId: CHAIN,
    genesisHash: CANONICAL_GENESIS,
    height: "0x4",
    units,
  };
  await page.locator("#balance-offline summary").click();
  await importSnapshot(page, snapshot, "Balance checked");
  assert.equal(await trigger.textContent(), "2 P2PARTY");
  assert.match(
    await trigger.getAttribute("aria-label"),
    /reported at height 4/,
  );
  assert.equal(
    await page.locator("#balance-source").textContent(),
    "Imported replica file",
  );
  assert.equal(await page.locator("#balance-height").textContent(), "4");
  assert.ok(await page.locator("#balance-time").getAttribute("datetime"));
  // Even a same-height substitution affecting only someone else's unit is a
  // conflicting snapshot; retaining the old observation avoids treating it as a refresh.
  const other = structuredClone(snapshot);
  other.units[127].id = freshId();
  await page.locator("#balance-file").setInputFiles({
    name: "conflict.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(other)),
  });
  await button(page, "Check snapshot").click();
  await page.waitForFunction(() =>
    document
      .getElementById("balance-explanation")
      .textContent.includes("last known"),
  );
  assert.equal(await trigger.textContent(), "2 P2PARTY");
  assert.equal(await page.locator("#balance-height").textContent(), "4");
  snapshot.height = "0x5";
  for (let i = 0; i < accounts.length; i++)
    snapshot.units[i].commitment = freshId();
  await importSnapshot(page, snapshot, "Balance checked");
  assert.equal(await trigger.textContent(), "0 P2PARTY");
  assert.equal(await page.locator("#balance-height").textContent(), "5");
  await importSnapshot(page, { ...snapshot, height: "0x4" }, "older");
  assert.equal(await page.locator("#balance-height").textContent(), "5");
  assert.equal(await trigger.textContent(), "0 P2PARTY");
  await button(page, "Close").click();
}
// Route the real origin names to test fixtures locally. The signer runs the
// release bytes without contacting either public site or generating a transfer.
async function hostedBalance(context, html, filename, archive, code, accounts) {
  const signerOrigin = "https://p2party.github.io";
  const signer = signerOrigin + "/p2party-server/restore/";
  const site = "https://p2party.com";
  const checkpoint = JSON.parse(
    await readFile(
      new URL("./balance-checkpoint.json", import.meta.url),
      "utf8",
    ),
  );
  const payload = {
    type: "p2party.wallet.snapshot.v1",
    chainId: CHAIN,
    genesisHash: CANONICAL_GENESIS,
    fromHeight: checkpoint.snapshot.height,
    headHeight: checkpoint.snapshot.height,
    receipts: [],
    snapshot: checkpoint.snapshot,
  };
  const requests = [];
  let failRefresh = false;
  const nonce = randomBytes(32).toString("hex");
  await context.setOffline(false);
  await context.route(signer, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await context.route(site + "/**", async (route) => {
    const req = route.request();
    requests.push({
      url: req.url(),
      method: req.method(),
      referer: req.headers()["referer"],
    });
    const path = new URL(req.url()).pathname;
    let body;
    if (path === "/wallet/snapshot/") {
      const reply = failRefresh
        ? { type: "p2party.wallet.snapshot.error.v1" }
        : payload;
      body =
        "<script>opener.postMessage(" +
        JSON.stringify(reply) +
        "," +
        JSON.stringify(signerOrigin) +
        ");<\/script>";
    } else if (path === "/wallet/") {
      body =
        '<pre id="offer"></pre><button id="accept">Confirm display</button><script>' +
        "const target=" +
        JSON.stringify(signerOrigin) +
        ",nonce=" +
        JSON.stringify(nonce) +
        ";" +
        'window.addEventListener("message",e=>{if(e.origin===target && e.source===opener){document.getElementById("offer").textContent=JSON.stringify(e.data);}});' +
        'opener.postMessage({type:"p2party.balance.request.v1",nonce},target);' +
        'document.getElementById("accept").onclick=()=>opener.postMessage({type:"p2party.balance.accepted.v1",nonce},target);<\/script>';
    } else {
      await route.abort();
      return;
    }
    await route.fulfill({ contentType: "text/html", body });
  });
  const page = await context.newPage();
  await page.goto(signer);
  await page.locator("#archive").setInputFiles({
    name: filename,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(archive),
  });
  await signIn(page, code);
  const trigger = page.locator("#balance-button");
  assert.equal(await trigger.textContent(), "0 P2PARTY");
  assert.deepEqual(requests, []);
  await trigger.click();
  await button(page, "Refresh balance").click();
  await page.waitForFunction(
    () =>
      document.getElementById("balance-source").textContent ===
      "Public snapshot from p2party.com",
  );
  assert.equal(await page.locator("#balance-height").textContent(), "3");
  await page.locator("#balance-website summary").click();
  assert.equal(requests.length, 1);
  const pending = page.waitForEvent("popup");
  await button(page, "Show total on p2party.com").click();
  const display = await pending;
  await display.waitForFunction(
    () => document.getElementById("offer")?.textContent,
  );
  assert.deepEqual(JSON.parse(await display.locator("#offer").textContent()), {
    type: "p2party.balance.offer.v1",
    nonce,
    amount: "0",
    height: "3",
  });
  await button(display, "Confirm display").click();
  await page.waitForFunction(() =>
    document.getElementById("balance-status").textContent.includes("accepted"),
  );
  failRefresh = true;
  await button(page, "Refresh balance").click();
  await page.waitForFunction(() =>
    document
      .getElementById("balance-explanation")
      .textContent.includes("last known"),
  );
  assert.equal(await trigger.textContent(), "0 P2PARTY");
  assert.ok(await button(page, "Show total on p2party.com").isDisabled());
  const manual = structuredClone(checkpoint.snapshot);
  manual.height = "0x4";
  Object.assign(manual.units[0], {
    suite: accounts[0].suite,
    commitment: accounts[0].commitment,
  });
  await page.locator("#balance-offline summary").click();
  await importSnapshot(page, manual, "Balance checked");
  assert.equal(await trigger.textContent(), "1 P2PARTY");
  assert.ok(await button(page, "Show total on p2party.com").isDisabled());
  assert.deepEqual(
    requests.map((r) => [new URL(r.url).pathname, r.method]),
    [
      ["/wallet/snapshot/", "GET"],
      ["/wallet/", "GET"],
      ["/wallet/snapshot/", "GET"],
    ],
  );
  assert.ok(requests.every((r) => !r.referer && !new URL(r.url).search));
  await display.close();
  await page.close();
}
async function eachSuite(page, accounts) {
  for (const [i, account] of accounts.entries()) {
    const entry = page.locator("#accounts details").nth(i);
    await entry.locator("summary").click();
    assert.equal(
      await entry.locator("dd").first().textContent(),
      account.commitment,
    );
    assert.equal(
      await entry.locator("dd").last().textContent(),
      account.readHandle,
    );
    await button(entry, "Verify spending access").click();
    await message(page, "Spending access verified");
    const recipient = accounts[1 - i];
    const request = {
      chainId: CHAIN,
      genesis: GENESIS,
      input: {
        id: freshId(),
        suite: account.suite,
        commitment: account.commitment,
        weight: "0x1",
        createdHeight: "0x0",
        spentHeight: null,
      },
      recipient: { suite: recipient.suite, commitment: recipient.commitment },
      expiryHeight: "0x10",
    };
    if (!(await page.locator("#payment-panel").evaluate((e) => e.open)))
      await page.locator("#payment-heading").click();
    await page.locator("#request").setInputFiles({
      name: "request.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(request)),
    });
    await button(page, "Review payment").click();
    await page.getByRole("heading", { name: "Review this payment" }).waitFor();
    assert.ok(
      (await page.locator("#review-details").textContent()).includes(
        recipient.commitment,
      ),
    );
    assert.equal(
      await button(page, "Download signed payment").isVisible(),
      false,
    );
    await button(page, "Sign this payment").click();
    await page
      .getByRole("heading", { name: "Payment signed" })
      .waitFor({ timeout: 120000 });
    const download = page.waitForEvent("download");
    await button(page, "Download signed payment").click();
    const file = await download;
    assert.equal(
      file.suggestedFilename(),
      "signed-" + request.input.id.slice(2) + ".json",
    );
    verifyNative(
      JSON.parse(await readFile(await file.path(), "utf8")),
      request,
    );
  }
}

test(
  "restore a companion backup and sign both suites in Chromium and Firefox",
  { timeout: 480000 },
  async (t) => {
    assert.ok(verifier, "Set P2PARTY_WALLET_VERIFIER to demos-ledger-verify.");
    const html = await readFile(artifact);
    const server = createServer((req, res) => {
      if (
        req.url === "/restore/" ||
        req.url === "/restore/restore-wallet.html"
      ) {
        res.writeHead(200, {
          "content-type": "text/html",
          "cache-control": "no-cache",
        });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const hosted = "http://127.0.0.1:" + server.address().port + "/restore/";
    const source = Wallet.create(1);
    source.add(2);
    const { archive, filename } = await source.backup(),
      code = source.recoveryCode();
    await source.confirm(archive, code);
    const accounts = source.state().wallet.accounts;
    source.destroy();
    for (const [engine, browserType] of [
      ["chromium", chromium],
      ["firefox", firefox],
    ]) {
      await t.test(engine, { timeout: 225000 }, async (t) => {
        const directory = await mkdtemp(
          join(tmpdir(), "p2party-restore-browser-"),
        );
        const executablePath =
          engine === "firefox"
            ? process.env.P2PARTY_FIREFOX_PATH
            : process.env.P2PARTY_CHROMIUM_PATH;
        const context = await browserType.launchPersistentContext(directory, {
          ...(executablePath ? { executablePath } : {}),
          headless: true,
          viewport: { width: 320, height: 760 },
          acceptDownloads: true,
          serviceWorkers: "block",
        });
        t.after(async () => {
          await context.close();
          await rm(directory, { recursive: true, force: true });
        });
        const attempted = [],
          errors = [];
        await context.route("**/*", async (route) => {
          const url = route.request().url();
          if (
            url.startsWith("file:") ||
            (route.request().isNavigationRequest() && url === hosted) ||
            url === hosted + "restore-wallet.html"
          )
            return route.continue();
          attempted.push(url);
          return route.abort();
        });
        const page = context.pages()[0];
        page.on("pageerror", (err) => errors.push(err.message));
        await page.goto(hosted);
        await lockedBalance(page);
        await pasteOrDrop(page, "paste", filename, false);
        await message(page, "filename alone");
        await page.locator("#archive").setInputFiles({
          name: filename,
          mimeType: "application/octet-stream",
          buffer: Buffer.from(archive),
        });
        assert.equal(await page.locator("#remember").isChecked(), false);
        await page.locator("#code").fill("incorrect");
        await button(page, "Restore wallet").click();
        await message(page, "Could not open");
        assert.equal(await page.locator("#code").inputValue(), "");
        await signIn(page, code);
        assert.equal(
          await page.evaluate(
            () => localStorage.length + sessionStorage.length,
          ),
          0,
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        const offlineCopy = page.waitForEvent("download");
        await page
          .getByRole("link", { name: "Download the offline wallet tool" })
          .click();
        assert.deepEqual(
          await readFile(await (await offlineCopy).path()),
          html,
        );
        await context.setOffline(true);
        await checkWalletBalance(page, accounts);
        await eachSuite(page, accounts);
        await context.setOffline(false);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await button(page, "Lock wallet").click();
        await lockedBalance(page);
        if (engine === "chromium") {
          await pasteOrDrop(page, "drop", archive, true);
        } else {
          await pasteOrDrop(page, "paste", archive, true);
        }
        await signIn(page, code);
        await button(page, "Lock wallet").click();
        await pasteOrDrop(
          page,
          "paste",
          JSON.stringify({
            archive,
            filename,
            unused: "discarded-wrapper-field",
          }),
          false,
        );
        await page.locator("#remember").check();
        await signIn(page, code);
        assert.deepEqual(
          await page.evaluate(() => Object.values(localStorage)),
          [archive],
        );
        await page.reload();
        await page.locator("#restore:visible").waitFor();
        assert.equal(await page.locator("#code").inputValue(), "");
        assert.equal(await page.locator("#accounts").textContent(), "");
        assert.equal(await page.locator("#remember").isChecked(), false);
        await signIn(page, code);
        await page.goto("about:blank");
        await page.goBack();
        await page.locator("#restore:visible").waitFor();
        assert.equal(await page.locator("#code").inputValue(), "");
        await button(page, "Forget saved wallet").click();
        assert.equal(
          await page.evaluate(
            () => localStorage.length + sessionStorage.length,
          ),
          0,
        );
        assert.deepEqual(await context.cookies(), []);
        // Open a downloaded copy, disconnect, and deny browser persistence.
        const local = await context.newPage();
        await local.addInitScript(() =>
          Object.defineProperty(Storage.prototype, "setItem", {
            value: () => {
              throw new DOMException("Denied", "SecurityError");
            },
          }),
        );
        await local.goto(pathToFileURL(artifact).href);
        await context.setOffline(true);
        await local.locator("#archive").setInputFiles({
          name: filename,
          mimeType: "application/octet-stream",
          buffer: Buffer.from(archive),
        });
        await local.locator("#remember").check();
        await signIn(local, code);
        await message(local, "for this session");
        const entry = local.locator("#accounts details").first();
        await entry.locator("summary").click();
        await button(entry, "Verify spending access").click();
        await message(local, "Spending access verified");
        await hostedBalance(context, html, filename, archive, code, accounts);
        assert.deepEqual(attempted, []);
        assert.deepEqual(errors, []);
      });
    }
  },
);
