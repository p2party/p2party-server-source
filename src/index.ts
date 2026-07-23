import { P2PartyWS } from "./wsServer";
import { assertSecureTurnSecret } from "./utils/socketAuth";

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
  open: (ws: P2PartyWSClient) => {
    console.log("Client has connected", ws.data.peerId);
  },

  message: (_ws: P2PartyWSClient, _msg: P2PartyWSMsg) => {
    // console.log(`Received message: ${msg} from ${ws.data.peerId}`);
  },

  close: (ws: P2PartyWSClient) => {
    console.log("Client has disconnected:", ws.data.peerId);
  },
};

new P2PartyWS(port, events);
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
