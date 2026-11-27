import checkpoint from "./balance-checkpoint.json" with { type: "json" };
import { WalletError, exactFields } from "../format.mjs";
import { snapshotFingerprint } from "../snapshot.mjs";
import { verifyPublicHistory } from "./public-ledger.mjs";

// Provenance is local object identity. Imported JSON cannot mark its amount as replay-verified.
const publicReports = new WeakSet();
export const isPublicBalance = (report) => publicReports.has(report);
function publicReport(fields) {
  const report = Object.freeze(fields);
  publicReports.add(report);
  return report;
}
const SITE = "https://p2party.com";
const SIGNER = "https://p2party.github.io";
const floor = {
  height: BigInt(checkpoint.snapshot.height).toString(),
  fingerprint: snapshotFingerprint(checkpoint.snapshot),
};
export function publicBridgeAvailable() {
  return globalThis.location?.origin === SIGNER && window.top === window.self;
}
export function initialBalance(wallet) {
  return publicReport({
    ...wallet.balance(checkpoint.snapshot),
    observedAt: checkpoint.observedAt,
  });
}
function compareHead(before, next) {
  if (!before) return;
  if (BigInt(next.height) < BigInt(before.height))
    throw new WalletError(
      "This snapshot is older than the balance already checked.",
    );
  if (next.height === before.height && next.fingerprint !== before.fingerprint)
    throw new WalletError(
      "Two snapshots disagree at the same height. The previous balance was kept.",
    );
}
export function readSnapshotFile(wallet, snapshot, previous) {
  const report = wallet.balance(snapshot);
  compareHead(floor, report);
  compareHead(previous, report);
  return report;
}

function openExchange(url, signal, timeout, closeWhenDone, onMessage) {
  if (!publicBridgeAvailable())
    throw new WalletError(
      "Open the published wallet for a live check, or import a snapshot file here.",
    );
  signal?.throwIfAborted();
  const popup = window.open(url, "_blank", "popup,width=580,height=650");
  if (!popup)
    throw new WalletError(
      "The browser blocked the new window. Allow it for this check or use a public snapshot file.",
    );
  return new Promise((resolve, reject) => {
    let done = false,
      timer,
      poll;
    function finish(err, value) {
      if (done) return;
      done = true;
      window.removeEventListener("message", receive);
      signal?.removeEventListener("abort", aborted);
      clearTimeout(timer);
      clearInterval(poll);
      if (closeWhenDone) {
        try {
          popup.close();
        } catch {}
      }
      if (err) reject(err);
      else resolve(value);
    }
    function aborted() {
      finish(new WalletError("Balance action cancelled."));
    }
    function receive(event) {
      if (event.origin !== SITE || event.source !== popup || done) return;
      try {
        onMessage(event.data, popup, finish);
      } catch {
        finish(
          new WalletError(
            "The public balance window returned an invalid response.",
          ),
        );
      }
    }
    window.addEventListener("message", receive);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return aborted();
    timer = setTimeout(
      () =>
        finish(
          new WalletError(
            "The public balance window expired. Try again or import a snapshot.",
          ),
        ),
      timeout,
    );
    poll = setInterval(() => {
      try {
        if (popup.closed)
          finish(
            new WalletError(
              "The public balance window closed before it finished.",
            ),
          );
      } catch {
        finish(
          new WalletError(
            "This browser isolated the balance window. Use the public snapshot file.",
          ),
        );
      }
    }, 500);
  });
}
export async function requestPublicSnapshot(wallet, previous, signal) {
  const payload = await openExchange(
    SITE + "/wallet/snapshot/",
    signal,
    45000,
    true,
    (data, popup, finish) => {
      if (data?.type === "p2party.wallet.snapshot.v1") finish(null, data);
      if (data?.type === "p2party.wallet.snapshot.error.v1")
        finish(
          new WalletError(
            "The public validator could not supply a current snapshot. The previous balance was kept.",
          ),
        );
    },
  );
  const snapshot = await verifyPublicHistory(checkpoint, payload, signal);
  signal?.throwIfAborted();
  return publicReport({
    ...readSnapshotFile(wallet, snapshot, previous),
    observedAt: new Date().toISOString(),
  });
}
export async function presentPublicBalance(report, signal) {
  if (!isPublicBalance(report))
    throw new WalletError(
      "Refresh against the public validator before sharing this total.",
    );
  let nonce;
  return openExchange(
    SITE + "/wallet/#show-balance",
    signal,
    90000,
    false,
    (data, popup, finish) => {
      if (!exactFields(data, ["type", "nonce"])) return;
      if (
        data.type === "p2party.balance.request.v1" &&
        !nonce &&
        typeof data.nonce === "string" &&
        data.nonce.length === 64 &&
        /^[0-9a-f]{64}$/.test(data.nonce)
      ) {
        nonce = data.nonce;
        // Only after the explicit action and a challenge from the intended fresh window.
        popup.postMessage(
          {
            type: "p2party.balance.offer.v1",
            nonce,
            amount: report.amount,
            height: report.height,
          },
          SITE,
        );
      } else if (nonce && nonce === data.nonce) {
        if (data.type === "p2party.balance.accepted.v1") finish(null);
        if (data.type === "p2party.balance.declined.v1")
          finish(
            new WalletError("The site did not save the displayed balance."),
          );
      }
    },
  );
}
