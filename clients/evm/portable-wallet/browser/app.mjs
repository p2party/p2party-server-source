import { installLegacyImport } from "./legacy-browser.mjs";
import { restoreWallet } from "./core.mjs";

if (window.top !== window.self) {
  const notice = document.createElement("p");
  notice.textContent = "Open the wallet tool directly in its own tab.";
  document.body.replaceChildren(notice);
} else {
  startWalletPage();
}
function startWalletPage() {
  installLegacyImport();
  const el = (id) => document.getElementById(id);
  const show = (id, yes) => {
    el(id).hidden = !yes;
  };
  const status = (message) => {
    el("status").textContent = message;
  };
  const suiteName = (id) => ({ 1: "ML-DSA-65", 2: "SLH-DSA-SHA2-192s" })[id];
  const storedKey = "p2party.testnet1.encrypted-wallet.v1";
  const maxArchive = 2 * 1024 * 1024;
  let wallet,
    selection,
    reviewed,
    signed,
    busy = false,
    generation = 0;
  const downloads = new Set();

  function normalizedArchive(text) {
    if (typeof text !== "string" || !text.length || text.length > maxArchive)
      throw Error("Choose an encrypted backup up to 2 MiB.");
    let value = text.trim();
    if (value.startsWith("{") || value.startsWith('"')) {
      try {
        const parsed = JSON.parse(value);
        value = typeof parsed === "string" ? parsed : parsed?.archive;
      } catch {
        throw Error("The pasted JSON does not contain an encrypted backup.");
      }
    }
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        value,
      )
    )
      throw Error(
        "Choose the backup file itself or paste its encrypted contents. A filename alone cannot open a wallet.",
      );
    return value;
  }
  function loadSaved() {
    try {
      return localStorage.getItem(storedKey);
    } catch {
      return null;
    }
  }
  function savedControls() {
    const saved = Boolean(loadSaved());
    show("saved-area", saved);
    show("use-saved", saved && !wallet && selection?.kind !== "saved");
  }
  function choose(source) {
    selection = source;
    el("chosen").textContent =
      source?.kind === "file"
        ? "Selected file · " + source.file.name
        : source?.kind === "text"
          ? "Encrypted contents selected."
          : source?.kind === "saved"
            ? "The saved backup is selected. Enter its recovery code."
            : "";
    savedControls();
  }
  function selectFile(file) {
    if (!file || file.size === 0 || file.size > maxArchive) {
      choose(null);
      throw Error("Choose one encrypted backup file up to 2 MiB.");
    }
    el("archive-text").value = "";
    choose({ kind: "file", file });
  }
  function pickText(text) {
    const archive = normalizedArchive(text);
    el("archive").value = "";
    el("archive-text").value = "";
    choose({ kind: "text", archive });
  }
  function resetPayment() {
    reviewed = signed = null;
    el("review-details").replaceChildren();
    show("review-panel", false);
    show("signed-panel", false);
  }
  function lock(message, focus) {
    generation++;
    busy = false;
    wallet?.lock();
    wallet = null;
    for (const url of downloads) URL.revokeObjectURL(url);
    downloads.clear();
    resetPayment();
    el("accounts").replaceChildren();
    el("accounts-count").textContent = "";
    el("restore-form").reset();
    el("review-form").reset();
    el("paste-panel").open = false;
    el("payment-panel").open = false;
    el("remember").checked = false;
    el("code").type = "password";
    el("show-code").textContent = "Show code";
    el("show-code").setAttribute("aria-pressed", "false");
    el("title").textContent = "Restore your wallet";
    el("intro").textContent =
      "Bring your encrypted backup and the recovery code you saved separately. This browser opens them offline.";
    show("overview", false);
    show("payment", false);
    show("restore", true);
    choose(loadSaved() ? { kind: "saved" } : null);
    status(message);
    if (focus) el("title").focus();
  }
  function run(action) {
    return async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      const token = generation;
      const button = event.submitter ?? event.currentTarget;
      if (button instanceof HTMLButtonElement) button.disabled = true;
      try {
        await action(token);
      } catch (err) {
        if (generation === token)
          status(
            err instanceof Error
              ? err.message
              : "The wallet could not complete this action.",
          );
      } finally {
        if (generation === token) busy = false;
        if (button instanceof HTMLButtonElement) button.disabled = false;
      }
    };
  }
  function detailsRow(list, term, value) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    list.append(dt, dd);
  }
  function displayWallet() {
    show("restore", false);
    show("overview", true);
    show("payment", true);
    el("title").textContent = "Your wallet";
    el("intro").textContent =
      "Inspect your restored receive requests or sign a Testnet 1 payment offline.";
    el("accounts-count").textContent =
      wallet.accounts.length +
      " restored receive " +
      (wallet.accounts.length === 1 ? "request" : "requests") +
      " · Backup revision " +
      wallet.revision;
    const accounts = el("accounts");
    accounts.replaceChildren();
    for (const account of wallet.accounts) {
      const item = document.createElement("details"),
        summary = document.createElement("summary"),
        list = document.createElement("dl"),
        button = document.createElement("button");
      summary.textContent =
        suiteName(account.suite) +
        " · " +
        account.readHandle.slice(0, 8) +
        "…" +
        account.readHandle.slice(-6);
      detailsRow(list, "Full receive commitment", account.commitment);
      detailsRow(list, "Public balance handle", account.readHandle);
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Verify spending access";
      button.addEventListener(
        "click",
        run(async (token) => {
          status("Checking this account’s signing key offline…");
          await wallet.prove(account.commitment);
          if (token === generation)
            status("Spending access verified for " + summary.textContent + ".");
        }),
      );
      item.append(summary, list, button);
      accounts.append(item);
    }
    savedControls();
    el("title").focus();
  }
  el("archive").addEventListener("change", () => {
    try {
      selectFile(el("archive").files[0]);
      status("");
    } catch (err) {
      status(err.message);
    }
  });
  el("archive-text").addEventListener("input", () => {
    el("archive").value = "";
    choose(el("archive-text").value ? { kind: "entry" } : null);
  });
  document.addEventListener("dragover", (event) => {
    if (!wallet) {
      event.preventDefault();
      el("drop").classList.add("is-over");
    }
  });
  document.addEventListener("dragleave", () =>
    el("drop").classList.remove("is-over"),
  );
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    el("drop").classList.remove("is-over");
    if (wallet || busy) return;
    try {
      if (event.dataTransfer.files.length > 1)
        throw Error("Choose one encrypted wallet file.");
      if (event.dataTransfer.files.length)
        selectFile(event.dataTransfer.files[0]);
      else pickText(event.dataTransfer.getData("text/plain"));
      status("");
      el("code").focus();
    } catch (err) {
      choose(null);
      status(err.message);
    }
  });
  document.addEventListener("paste", (event) => {
    if (wallet || busy || event.target === el("code")) return;
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    try {
      const files = data.files;
      if (files.length > 1) throw Error("Paste one encrypted wallet file.");
      if (files.length) selectFile(files[0]);
      else pickText(data.getData("text/plain"));
      status("");
      el("code").focus();
    } catch (err) {
      choose(null);
      el("archive-text").value = "";
      el("archive").value = "";
      status(err.message);
    }
  });
  el("show-code").addEventListener("click", () => {
    const reveal = el("code").type === "password";
    el("code").type = reveal ? "text" : "password";
    el("show-code").textContent = reveal ? "Hide code" : "Show code";
    el("show-code").setAttribute("aria-pressed", String(reveal));
  });
  el("use-saved").addEventListener("click", () => {
    el("archive").value = "";
    el("archive-text").value = "";
    choose({ kind: "saved" });
    el("code").focus();
  });
  el("forget").addEventListener("click", () => {
    try {
      localStorage.removeItem(storedKey);
    } catch {
      status(
        "This browser could not remove the saved backup. You can clear this site’s browser data.",
      );
      return;
    }
    if (selection?.kind === "saved") choose(null);
    else savedControls();
    status("The saved encrypted backup was removed from this browser.");
  });
  el("restore-form").addEventListener(
    "submit",
    run(async (token) => {
      const source = selection;
      const remember = el("remember").checked;
      const code = el("code").value.trim();
      el("code").value = "";
      el("code").type = "password";
      el("show-code").textContent = "Show code";
      el("show-code").setAttribute("aria-pressed", "false");
      if (!source) throw Error("Select your encrypted backup first.");
      const text =
        source.kind === "file"
          ? await source.file.text()
          : source.kind === "saved"
            ? loadSaved()
            : source.kind === "text"
              ? source.archive
              : el("archive-text").value;
      const archive = normalizedArchive(text);
      if (token !== generation) return;
      status("Opening the encrypted backup…");
      const restored = await restoreWallet(archive, code, (done, total) => {
        if (token === generation)
          status("Checking receive requests · " + done + " of " + total);
      });
      if (token !== generation) {
        restored.lock();
        return;
      }
      let message = "Wallet restored on this browser.";
      if (remember) {
        try {
          localStorage.setItem(storedKey, archive);
          message =
            "Wallet restored. Its encrypted backup is saved on this device.";
        } catch {
          message =
            "Wallet restored for this session. This browser could not save the encrypted backup.";
        }
      }
      wallet = restored;
      selection = null;
      el("restore-form").reset();
      el("remember").checked = false;
      el("chosen").textContent = "";
      displayWallet();
      status(message);
    }),
  );
  el("lock").addEventListener("click", () => lock("Wallet locked.", true));
  el("request").addEventListener("change", () => {
    resetPayment();
    status("");
  });
  el("review-form").addEventListener(
    "submit",
    run(async (token) => {
      resetPayment();
      const file = el("request").files[0];
      if (!file || file.size === 0 || file.size > 8192)
        throw Error("Choose an unsigned payment request up to 8 KiB.");
      let request;
      try {
        request = JSON.parse(await file.text());
      } catch {
        throw Error("Choose a valid JSON payment request.");
      }
      if (token !== generation || el("request").files[0] !== file) return;
      const info = wallet.reviewTransfer(request);
      reviewed = request;
      const list = el("review-details");
      for (const [label, value] of [
        ["Amount", info.weight + " P2PARTY"],
        ["Recipient commitment", info.recipient.commitment],
        ["Recipient suite", suiteName(info.recipient.suite)],
        ["Recipient read handle", info.readHandle],
        ["Source commitment", info.source],
        ["Source suite", suiteName(info.sourceSuite)],
        ["Input unit", info.inputId],
        ["Inclusive expiry height", info.expiry],
        ["Chain ID", info.chainId],
        ["Genesis fingerprint", info.genesis],
      ])
        detailsRow(list, label, value);
      show("review-panel", true);
      el("review-heading").focus();
      status("");
    }),
  );
  el("cancel").addEventListener("click", () => {
    el("review-form").reset();
    resetPayment();
    el("request").focus();
    status("Payment review cancelled.");
  });
  el("sign").addEventListener(
    "click",
    run(async (token) => {
      const request = reviewed;
      if (!request) return;
      status("Signing the reviewed payment offline…");
      const result = await wallet.signPayment(request);
      if (token !== generation || reviewed !== request) return;
      const { chainId, inputId, moveId, outputId, recipient, wire } = result;
      signed = { chainId, inputId, moveId, outputId, recipient, wire };
      reviewed = null;
      show("review-panel", false);
      show("signed-panel", true);
      el("signed-heading").focus();
      status("");
    }),
  );
  el("download").addEventListener("click", () => {
    if (!signed) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(signed) + "\n"], { type: "application/json" }),
    );
    downloads.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = "signed-" + signed.inputId.slice(2) + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      downloads.delete(url);
    }, 10000);
    status("Signed payment download started.");
  });
  window.addEventListener("pagehide", () => lock("", false));
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) lock("Wallet locked.", false);
  });
  show(
    "save-tool",
    location.protocol === "https:" || location.protocol === "http:",
  );
  lock("", false);
}
