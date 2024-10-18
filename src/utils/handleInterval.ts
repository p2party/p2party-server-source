import type { P2PartyWSClient } from "../wsServer";

// Configuration for ping-pong mechanism
export const PING_INTERVAL = 10000; // Send ping every 10 seconds
export const PONG_TIMEOUT = 5000; // Wait 5 seconds for pong response

const handleInterval = async (ws: P2PartyWSClient) => {
  return setInterval(() => {
    if (!ws.data.isAlive) {
      console.log("Client did not respond to ping. Terminating connection.");
      clearInterval(ws.data.pingInterval);
      ws.close();

      return;
    }

    // Send custom "ping" message
    ws.send(JSON.stringify({ type: "ping" }));

    // Set a timeout to wait for the "pong"
    ws.data.isAlive = false;

    // Set a timeout for pong response
    ws.data.pongTimeout = setTimeout(() => {
      if (!ws.data.isAlive) {
        console.log("Client did not respond to pong in time. Terminating.");
        clearInterval(ws.data.pingInterval);
        ws.close();
      }
    }, PONG_TIMEOUT);
  }, PING_INTERVAL);
};

export default handleInterval;
