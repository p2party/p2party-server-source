import { P2PartyWS } from "./wsServer";

import type {
  P2PartyWSMsg,
  P2PartyWSClient,
  P2PartyWSEvents,
} from "./wsServer";

export const pingMilliseconds = 20000;

const events: P2PartyWSEvents = {
  open: (ws: P2PartyWSClient) => {
    console.log("Client has connected", ws.data.peerId);
  },

  message: (ws: P2PartyWSClient, msg: P2PartyWSMsg) => {
    console.log(`Received message: ${msg} from ${ws.data.peerId}`);
  },

  close: (ws: P2PartyWSClient) => {
    console.log("Client has disconnected:", ws.data.peerId);
  },
};

new P2PartyWS(3001, events);
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
