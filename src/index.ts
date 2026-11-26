import { P2PartyWS } from "./wsServer";
import { startupDatabaseCheck } from "./db/schemaCheck";
import { assertSecureTurnSecret } from "./utils/socketAuth";
import { peerLogTag } from "./utils/logTag";
import { describeError } from "./utils/logError";
import { initPubSub, shutdownPubSub } from "./pubsub";
import { startRoomRetention } from "./utils/roomRetention";

import type {
  P2PartyWSMsg,
  P2PartyWSClient,
  P2PartyWSEvents,
} from "./wsServer";

export const pingMilliseconds = 20000;

const configuredPort = process.env.PORT;
const port =
  configuredPort === undefined ? 3001 : Number.parseInt(configuredPort, 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535");
assertSecureTurnSecret(process.env.COTURN_SECRET);

const events: P2PartyWSEvents = {
  // Peers appear in the journal only as per-boot tags, never by stable id.
  open: (ws: P2PartyWSClient) => {
    console.log("Client has connected", peerLogTag(ws.data.peerId));
  },

  message: (_ws: P2PartyWSClient, _msg: P2PartyWSMsg) => {
    // console.log(`Received message: ${msg} from ${ws.data.peerId}`);
  },

  close: (ws: P2PartyWSClient) => {
    console.log("Client has disconnected:", peerLogTag(ws.data.peerId));
  },
};

// The database must be at exactly the schema this binary was built for before
// anything else touches it: on an empty, older, newer or half-migrated
// database, or one that does not answer within the startup bound, the process
// exits with one line saying what it found and what to run, and never opens
// the listener. systemd's Restart=always then only repeats that refusal. The
// check runs on its own bounded connection, not on the Prisma pool.
const startup = await startupDatabaseCheck(process.env.DATABASE_URL ?? "");
if (startup.refusal) {
  console.error(startup.refusal);
  process.exit(1);
}
if (startup.rekeyed)
  console.warn(
    `p2party: startup re-keyed ${String(startup.rekeyed)} identity row(s) to their derived id`,
  );

// Cross-instance routing must be live before the first socket is accepted:
// a peer that connects before this process can be reached by the others is a
// peer whose signals they silently drop. initPubSub throws rather than starting
// degraded, because the degraded mode is invisible at runtime.
await initPubSub();
const roomRetention = startRoomRetention();

new P2PartyWS(port, events);

// Release this instance's peer claims and routing rows on the way out, so a
// reconnecting peer is not routed to a process that no longer exists.
const shutdown = (signal: NodeJS.Signals) => {
  clearInterval(roomRetention);
  void shutdownPubSub()
    .catch((error: unknown) => {
      console.error("p2party: shutdown failed", describeError(error));
    })
    .finally(() => {
      process.exit(signal === "SIGTERM" ? 0 : 130);
    });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// setInterval(() => bws.publish("Published to all"), 3000);

// // Heartbeat mechanism
// const interval = setInterval(async () => {
//   for (const ws of server.websocketClients) {
//     const client = await prisma.peer.findUnique({
//       where: { id: ws.peerId },
//     });
//
//     if (!client) {
//       ws.send(
//         JSON.stringify({
//           type: "error",
//           fromAction: "ping",
//           error: {
//             message: `Could not find client with peer id ${ws.peerId}`,
//           },
//         } as WebSocketMessageError),
//       );
//       ws.close();
//       continue;
//     }
//
//     if (
//       !ws.isAlive ||
//       Date.now() - Number(client.lastPing) > pingMilliseconds
//     ) {
//       ws.send(
//         JSON.stringify({
//           type: "error",
//           fromAction: "ping",
//           error: {
//             message: `WebSocket of client with id ${ws.peerId} will terminate`,
//           },
//         } as WebSocketMessageError),
//       );
//       ws.close();
//       continue;
//     }
//
//     ws.isAlive = false;
//     ws.send("ping"); // Custom ping message
//   }
// }, 10000);
//
// // Handle server close
// server.on("close", () => {
//   clearInterval(interval);
//   prisma.$disconnect();
// });
//
// return server;
