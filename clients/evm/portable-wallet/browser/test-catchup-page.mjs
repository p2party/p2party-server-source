// Public-only loopback fixture for browser origin tests. The real signer
// independently verifies every delivered transaction and the resulting state.
import { randomBytes } from "node:crypto";
import { CHAIN } from "../format.mjs";
import { CANONICAL_GENESIS } from "../snapshot.mjs";
export function catchupPage({
  snapshot,
  headMoveId,
  wires = [],
  fail = false,
}) {
  const nonce = randomBytes(32).toString("hex"),
    kind = "p2party.wallet.catchup.";
  const start = {
    type: kind + "start.v1",
    nonce,
    chainId: CHAIN,
    genesisHash: CANONICAL_GENESIS,
    fromHeight: "0x3",
    headHeight: snapshot.height,
    headMoveId,
  };
  const done = { type: kind + "done.v1", nonce, snapshot };
  const page = {
    type: kind + "page.v1",
    nonce,
    afterHeight: "0x3",
    receipts: wires,
  };
  return (
    '<script>const target="https://p2party.github.io",nonce=' +
    JSON.stringify(nonce) +
    ";" +
    "let page=" +
    JSON.stringify(wires.length ? page : null) +
    ';window.onmessage=e=>{if(e.origin!==target||e.source!==opener||e.data.type!=="p2party.wallet.catchup.ack.v1"||e.data.nonce!==nonce)return;' +
    "if(page){opener.postMessage(page,target);page=null;}else opener.postMessage(" +
    JSON.stringify(done) +
    ",target);};" +
    "opener.postMessage(" +
    JSON.stringify(fail ? { type: kind + "unavailable", nonce } : start) +
    ",target);<\/script>"
  );
}
