"use strict";

const byId = (id) => document.getElementById(id);
const visible = (id, show) => {
  byId(id).hidden = !show;
};
const status = (message) => {
  byId("status").textContent = message;
};

function localSession() {
  const key = "p2party-local-wallet-session";
  let token = sessionStorage.getItem(key);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    sessionStorage.setItem(key, token);
  }
  return token;
}

async function api(action, body = {}) {
  const response = await fetch("/api/" + action, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-P2Party-Session": localSession(),
    },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error || "The companion could not complete this action.",
    );
  return result;
}

let busy = false;
function run(task) {
  return async (event) => {
    event?.preventDefault();
    if (busy) return;
    busy = true;
    status("Working…");
    const buttons = [...document.querySelectorAll("button")];
    for (const button of buttons) button.disabled = true;
    try {
      await task();
    } catch (error) {
      status(
        error instanceof TypeError
          ? "Cannot reach the local companion. Check that it is still running."
          : error.message,
      );
      if (!byId("unlock").hidden) byId("recovery").value = "";
    } finally {
      busy = false;
      for (const button of buttons) button.disabled = false;
    }
  };
}

let wallet = null;
let unlockMode = "restore";

function hideCode() {
  byId("code").textContent = "";
  visible("code", false);
  byId("reveal").textContent = "Show recovery code";
  byId("reveal").setAttribute("aria-expanded", "false");
}

function showDashboard(state) {
  wallet = state.wallet;
  byId("reported-total").textContent = "";
  byId("balance-form").reset();
  hideCode();
  byId("unlock-form").reset();
  visible("welcome", !wallet);
  visible("overview", Boolean(wallet));
  visible("lock-area", Boolean(wallet));
  visible("kit", false);
  visible("unlock", false);
  byId("account-list").replaceChildren();
  byId("lock-area").querySelector("details").open = false;
  status("");
  if (!wallet) return;
  const count = wallet.accounts.length;
  byId("account-count").textContent =
    count +
    (count === 1
      ? " confirmed receive request."
      : " confirmed receive requests.") +
    (wallet.pendingReceives
      ? " Save and check the updated backup to reveal new requests."
      : "");
  byId("lock-help").textContent = wallet.backedUp
    ? "Closing clears this wallet from the running companion. Bring your backup and code to reopen it."
    : "You have receive requests outside a checked backup. Save and check the file before closing.";
  for (const account of wallet.accounts) {
    const entry = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent =
      (account.suite === 1 ? "ML-DSA-65" : "SLH-DSA-SHA2-192s") +
      " · " +
      account.readHandle.slice(0, 8) +
      "…" +
      account.readHandle.slice(-6);
    entry.append(summary);
    const publicData = [
      ["Full receive commitment", account.commitment],
      ["Public balance handle", account.readHandle],
    ];
    for (const [label, value] of publicData) {
      const caption = document.createElement("p");
      caption.textContent = label;
      const data = document.createElement("code");
      data.textContent = value;
      entry.append(caption, data);
    }
    const help = document.createElement("p");
    help.textContent =
      "Check that this browser can sign for this request using a synthetic unit on a separate offline chain.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Check spending access";
    button.addEventListener(
      "click",
      run(async () => {
        const proof = await api("prove", { commitment: account.commitment });
        if (
          proof.suite !== account.suite ||
          proof.commitment !== account.commitment ||
          proof.readHandle !== account.readHandle
        ) {
          throw new Error(
            "The offline proof did not match the selected request.",
          );
        }
        status(
          "Spending access verified for " +
            account.readHandle +
            ". The companion signed an offline test transfer.",
        );
      }),
    );
    entry.append(help, button);
    byId("account-list").append(entry);
  }
}

byId("balance-form").addEventListener(
  "submit",
  run(async () => {
    byId("reported-total").textContent = "";
    const file = byId("snapshot").files[0];
    if (!file || !file.size || file.size > 128 * 1024)
      throw new Error("Choose a replica snapshot up to 128 KiB.");
    let snapshot;
    try {
      snapshot = JSON.parse(await file.text());
    } catch {
      throw new Error("Choose a replica snapshot in JSON format.");
    }
    const report = await api("balance", { snapshot });
    byId("reported-total").textContent =
      "Snapshot reports " +
      report.amount +
      " P2PARTY at height " +
      report.height +
      " for the confirmed requests in this wallet. The snapshot is unverified.";
    status("");
  }),
);

function openKit() {
  hideCode();
  visible("unlock", false);
  visible("kit", true);
  visible("confirm-step", !wallet.backedUp);
  visible("restore-step", wallet.backedUp);
  byId("kit-heading").textContent = wallet.backedUp
    ? "Move to another browser"
    : "Save your recovery kit";
  byId("kit-heading").focus();
  status("");
}

function openUnlock(mode) {
  unlockMode = mode;
  hideCode();
  byId("unlock-form").reset();
  visible("welcome", false);
  visible("kit", false);
  visible("unlock", true);
  const restoring = mode === "restore";
  byId("unlock-heading").textContent = restoring
    ? "Restore my wallet"
    : "Check my backup";
  byId("submit-unlock").textContent = restoring
    ? "Restore wallet"
    : "Confirm backup";
  byId("unlock-heading").focus();
  status("");
}

byId("create-form").addEventListener(
  "submit",
  run(async () => {
    const { state } = await api("create", {
      suite: Number(byId("create-suite").value),
    });
    showDashboard(state);
    openKit();
  }),
);
byId("start-restore").addEventListener("click", () => openUnlock("restore"));
byId("add-form").addEventListener(
  "submit",
  run(async () => {
    const { state } = await api("add", {
      suite: Number(byId("add-suite").value),
    });
    showDashboard(state);
    openKit();
  }),
);
byId("move").addEventListener("click", openKit);
byId("start-confirm").addEventListener("click", () => openUnlock("confirm"));
byId("close-kit").addEventListener("click", () => showDashboard({ wallet }));
byId("cancel-unlock").addEventListener("click", () => {
  showDashboard({ wallet });
  if (unlockMode === "confirm") openKit();
});

byId("reveal").addEventListener(
  "click",
  run(async () => {
    if (!byId("code").hidden) hideCode();
    else {
      const { recoveryCode } = await api("backup", { showRecoveryCode: true });
      byId("code").textContent = recoveryCode;
      visible("code", true);
      byId("reveal").textContent = "Hide recovery code";
      byId("reveal").setAttribute("aria-expanded", "true");
    }
    status("");
  }),
);
byId("download").addEventListener(
  "click",
  run(async () => {
    const { archive, filename } = await api("backup");
    const url = URL.createObjectURL(
      new Blob([archive], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.download = filename;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    status("Backup download started. Keep the recovery code separately.");
  }),
);
byId("unlock-form").addEventListener(
  "submit",
  run(async () => {
    const file = byId("archive").files[0];
    if (!file || !file.size || file.size > 2 * 1024 * 1024)
      throw new Error("Choose a wallet backup file up to 2 MiB.");
    const archive = await file.text();
    const recoveryCode = byId("recovery").value.trim();
    const { state } = await api(unlockMode, { archive, recoveryCode });
    showDashboard(state);
    status(
      unlockMode === "restore"
        ? "Wallet restored. Open a receive request to check spending access."
        : "Backup checked. Your receive requests are ready.",
    );
    byId("wallet-heading").setAttribute("tabindex", "-1");
    byId("wallet-heading").focus();
  }),
);
byId("lock").addEventListener(
  "click",
  run(async () => {
    const { state } = await api("lock");
    showDashboard(state);
    status("Wallet closed on this browser.");
  }),
);
window.addEventListener("pagehide", () => {
  hideCode();
  byId("unlock-form").reset();
});
run(async () => showDashboard(await api("state")))();
