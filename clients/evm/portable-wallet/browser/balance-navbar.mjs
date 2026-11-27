import {
  initialBalance,
  isPublicBalance,
  readSnapshotFile,
  requestPublicSnapshot,
  presentPublicBalance,
  publicBridgeAvailable,
} from "./balance.mjs";

// Amount, height and source live in this session only. Signing has no dependency on this component.
export function installWalletBalance() {
  const el = (id) => document.getElementById(id);
  const dialog = el("balance-dialog");
  let wallet,
    observation,
    operation,
    stale = false;
  const status = (s) => {
    el("balance-status").textContent = s;
  };
  function render() {
    const amount = observation && observation.amount + " P2PARTY";
    el("balance-button").textContent = amount || "Balance";
    el("balance-button").setAttribute(
      "aria-label",
      observation
        ? "Wallet balance, " +
            amount +
            " reported at height " +
            observation.height
        : "Wallet balance",
    );
    el("balance-amount").textContent =
      amount || (wallet ? "Unavailable" : "Locked");
    let description = "Unlock your wallet to check its receive requests.";
    if (wallet)
      description = observation
        ? observation.description
        : "Import a complete public snapshot to check this wallet.";
    if (stale && observation)
      description =
        "Showing the last known report. A newer balance could not be established.";
    el("balance-explanation").textContent = description;
    el("balance-meta").hidden = !observation;
    el("balance-scope").hidden = !observation;
    el("balance-tools").hidden = !wallet;
    el("balance-height").textContent = observation?.height ?? "";
    el("balance-source").textContent = observation?.source ?? "";
    const observed = observation?.observedAt;
    el("balance-observed-label").hidden = el("balance-observed").hidden =
      !observed;
    el("balance-observed").textContent = observed
      ? new Date(observed).toLocaleString()
      : "";
    const when = el("balance-time");
    when.textContent = observation ? observation.checked.toLocaleString() : "";
    if (observation) when.dateTime = observation.checked.toISOString();
    else when.removeAttribute("datetime");
    const hosted = publicBridgeAvailable();
    el("balance-refresh").disabled = !hosted || Boolean(operation);
    el("balance-present").disabled =
      !hosted || Boolean(operation) || stale || !observation?.verifiedReport;
    el("balance-share-help").textContent =
      stale || !observation?.verifiedReport
        ? "Refresh against the public validator to share a verified amount and height. Imported reports stay in this wallet."
        : "Share only your displayed amount and snapshot height with p2party.com. You can confirm or decline in the website tab.";
    el("balance-import").disabled = Boolean(operation);
    el("balance-refresh-help").textContent = hosted
      ? "Opens p2party.com for the same public snapshot everyone receives."
      : "Open the hosted wallet for live refresh and website display, or import a snapshot below.";
  }
  function cancel() {
    operation?.abort();
    operation = null;
  }
  function clear() {
    cancel();
    wallet = null;
    observation = null;
    stale = false;
    if (dialog.open) dialog.close();
    el("balance-form").reset();
    el("balance-offline").open = false;
    el("balance-website").open = false;
    status("");
    render();
  }
  function record(value, source, description) {
    observation = {
      ...value,
      source,
      description,
      verifiedReport: isPublicBalance(value) ? value : null,
      checked: new Date(),
    };
    stale = false;
  }
  async function run(work, source, description) {
    if (!wallet || operation) return;
    const controller = new AbortController();
    operation = controller;
    render();
    status(
      source
        ? "Checking the public snapshot…"
        : "Waiting for confirmation on p2party.com…",
    );
    try {
      const result = await work(controller.signal);
      if (operation !== controller) return;
      if (source) {
        record(result, source, description);
        status("Balance checked against the complete snapshot.");
      } else status("The total was accepted by p2party.com.");
    } catch (error) {
      if (operation !== controller) return;
      if (source) stale = Boolean(observation);
      status(
        error?.message ||
          (source
            ? "The balance snapshot is unavailable."
            : "The total could not be shared."),
      );
    } finally {
      if (operation === controller) {
        operation = null;
        render();
      }
    }
  }
  el("balance-button").addEventListener("click", () => dialog.showModal());
  el("balance-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (operation) {
      cancel();
      status("Action cancelled.");
      render();
    }
  });
  el("balance-refresh").addEventListener("click", () => {
    run(
      (signal) => requestPublicSnapshot(wallet, observation, signal),
      "Public snapshot from p2party.com",
      "This browser matched your receive requests against the published snapshot. The network may have advanced.",
    );
  });
  el("balance-present").addEventListener("click", () => {
    const report = observation?.verifiedReport;
    if (!report || stale || !publicBridgeAvailable()) return;
    run((signal) => presentPublicBalance(report, signal));
  });
  el("balance-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const file = el("balance-file").files[0];
    run(
      async (signal) => {
        if (!file || !file.size || file.size > 128 * 1024)
          throw Error("Choose a Testnet 1 snapshot file up to 128 KiB.");
        let snapshot;
        try {
          snapshot = JSON.parse(await file.text());
        } catch {
          throw Error("Choose a valid JSON snapshot from a trusted replica.");
        }
        signal.throwIfAborted();
        return readSnapshotFile(wallet, snapshot, observation);
      },
      "Imported replica file",
      "This file reports the amount available at its stated height. Its source and freshness depend on the replica you chose.",
    );
  });
  return {
    lock: clear,
    unlock(session) {
      clear();
      wallet = session;
      try {
        record(
          initialBalance(wallet),
          "Snapshot bundled with this release",
          "This historical balance uses the snapshot included with the wallet. Refresh it or import a newer file.",
        );
      } catch {
        status(
          "The included checkpoint is unavailable. Try refreshing or importing a snapshot.",
        );
      }
      render();
    },
  };
}
