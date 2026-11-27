import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { exactFields, MAX_ARCHIVE, Wallet, WalletError } from "./wallet.mjs";

import { reportedBalance } from "./snapshot.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
]);
const schemas = {
  state: [[]],
  balance: [["snapshot"]],
  create: [["suite"]],
  add: [["suite"]],
  backup: [[], ["showRecoveryCode"]],
  confirm: [["archive", "recoveryCode"]],
  restore: [["archive", "recoveryCode"]],
  prove: [["commitment"]],
  lock: [[], ["discardPending"]],
};
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
function reply(response, status, body, contentType = "application/json") {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": contentType,
  });
  response.end(
    contentType === "application/json" ? JSON.stringify(body) : body,
  );
}
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_ARCHIVE + 16384)
      throw new WalletError("Choose a wallet backup file up to 2 MiB.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new WalletError("Invalid wallet request.");
  }
}
export async function startCompanion() {
  const sessions = new Map();
  let active = false;
  let port;
  async function dispatch(token, action, data) {
    const wallet = sessions.get(token);
    if (action === "state") return wallet?.state() ?? { wallet: null };
    if (action === "create" || action === "restore") {
      if (wallet)
        throw new WalletError(
          "Close your current wallet before opening another.",
        );
      if (sessions.size >= 16)
        throw new WalletError(
          "Close an unused wallet or restart the local companion.",
        );
      const next =
        action === "create"
          ? Wallet.create(data.suite)
          : await Wallet.restore(data.archive, data.recoveryCode);
      sessions.set(token, next);
      return action === "create"
        ? { state: next.state(), recoveryCode: next.recoveryCode() }
        : { state: next.state() };
    }
    if (!wallet) throw new WalletError("Open your wallet first.");
    switch (action) {
      case "balance":
        return reportedBalance(data.snapshot, wallet.state().wallet.accounts);
      case "add":
        wallet.add(data.suite);
        break;
      case "backup": {
        const result = await wallet.backup();
        return data.showRecoveryCode === true
          ? { ...result, recoveryCode: wallet.recoveryCode() }
          : result;
      }
      case "confirm":
        await wallet.confirm(data.archive, data.recoveryCode);
        break;
      case "prove":
        return wallet.prove(data.commitment);
      case "lock":
        if (!wallet.state().wallet.backedUp && data.discardPending !== true)
          throw new WalletError(
            "Check your latest backup before closing the wallet.",
          );
        wallet.destroy();
        sessions.delete(token);
        return { state: { wallet: null } };
    }
    return { state: wallet.state() };
  }
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 },
    async (req, res) => {
      try {
        if (req.headers.host !== "127.0.0.1:" + port)
          return reply(res, 403, {
            error: "Open the companion at its local address.",
          });
        if (req.method === "GET" && assets.has(req.url)) {
          const [file, mime] = assets.get(req.url);
          return reply(
            res,
            200,
            await readFile(new URL("./public/" + file, import.meta.url)),
            mime,
          );
        }
        const action = req.url.startsWith("/api/") ? req.url.slice(5) : "";
        if (req.method !== "POST" || !Object.hasOwn(schemas, action))
          return reply(res, 404, { error: "Unknown wallet action." });
        if (
          req.headers.origin !== "http://127.0.0.1:" + port ||
          (req.headers["sec-fetch-site"] &&
            req.headers["sec-fetch-site"] !== "same-origin")
        )
          return reply(res, 403, {
            error: "Open the companion at its local address.",
          });
        const token = req.headers["x-p2party-session"];
        if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token))
          return reply(res, 403, {
            error: "Refresh the local companion to start a session.",
          });
        if (req.headers["content-type"] !== "application/json")
          return reply(res, 415, { error: "Use a JSON wallet request." });
        if (active)
          return reply(res, 409, {
            error: "The companion is busy. Try again.",
          });
        active = true;
        try {
          const data = await body(req);
          if (!schemas[action].some((names) => exactFields(data, names)))
            throw new WalletError("Invalid wallet request.");
          reply(res, 200, await dispatch(token, action, data));
        } finally {
          active = false;
        }
      } catch (error) {
        if (!res.headersSent)
          reply(res, error instanceof WalletError ? 400 : 500, {
            error:
              error instanceof WalletError
                ? error.message
                : "The local companion could not complete this action.",
          });
      }
    },
  );
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 128;
  server.setTimeout(15000, (socket) => socket.destroy());
  server.once("close", () => {
    for (const wallet of sessions.values()) wallet.destroy();
    sessions.clear();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = await startCompanion();
  console.log("P2Party wallet http://127.0.0.1:" + server.address().port + "/");
}
