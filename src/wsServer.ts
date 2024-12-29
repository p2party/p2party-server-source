import { isUUID } from "class-validator";

import handleConnection from "./utils/handleConnection";
import handleMessage from "./utils/handleMessage";
import handleInterval from "./utils/handleInterval";

import type { Server, ServerWebSocket } from "bun";

export type P2PartyWSMsg = string | ArrayBufferView;

/** ServerWebSocket with an additional property for client id */
export type P2PartyWSClient = ServerWebSocket<{
  isAlive: boolean;
  pingInterval: Timer;
  pongTimeout: Timer;
  peerId: string;
  publicKey: string;
}>;

/** Interface that defines the event handlers for a BunnyWS server */
export interface P2PartyWSEvents {
  open: (ws: P2PartyWSClient) => void;
  message: (ws: P2PartyWSClient, msg: P2PartyWSMsg) => void;
  close: (ws: P2PartyWSClient) => void;
}

export const wsClients = new Map<string, P2PartyWSClient>();

export class P2PartyWS {
  private server: Server;

  /**
   * @param port - The port number to listen on
   * @param events - An object containing event handlers
   */
  constructor(port: number, events: P2PartyWSEvents) {
    this.server = Bun.serve({
      websocket: {
        open: async (ws: P2PartyWSClient) => {
          const { publicKey } = ws.data;

          const peerId = await handleConnection(publicKey, ws);

          if (isUUID(peerId)) {
            ws.data.isAlive = true;
            ws.data.peerId = peerId;
            // Start pinging the client at regular intervals
            ws.data.pingInterval = await handleInterval(ws);

            if (ws.readyState === 1) {
              ws.subscribe("global");
              wsClients.set(peerId, ws);
              events.open(ws);
            }
          }
        },

        message: async (ws: P2PartyWSClient, message: P2PartyWSMsg) => {
          await handleMessage(ws, message, events);

          events.message(ws, message);
        },

        close: async (ws: P2PartyWSClient, _code: number, _message: string) => {
          ws.unsubscribe("global");
          clearTimeout(ws.data.pongTimeout);
          clearInterval(ws.data.pingInterval);
          wsClients.delete(ws.data.peerId);
          ws.terminate();
          events.close(ws);
        },

        idleTimeout: 60, // 60 seconds
        maxPayloadLength: 1024 * 1024, // 1mb
        backpressureLimit: 5 * 1024 * 1024, // 5mb max backlog
        closeOnBackpressureLimit: true, // close if backlog
      },

      fetch(req: Request, server: Server) {
        if (req.headers.get("upgrade") !== "websocket") {
          return new Response("Upgrade required", { status: 426 });
        }

        const url = new URL(req.url, `http://${req.headers.get("host")}`);

        if (!url.searchParams.has("publickey")) {
          return new Response("Forbidden", { status: 403 });
        }

        const p = url.searchParams.get("publickey");

        // if (!p || p.length !== 1100) { // RSA 4096
        if (!p || p.length !== 64) {
          // curve 25519
          return new Response("Forbidden", { status: 403 });
        }

        if (
          server.upgrade(req, {
            data: { publicKey: p! },
          })
        )
          return; // do not return a Response

        return new Response("Upgrade failed", { status: 500 });
      },
      port,
    });
  }
  /** Publishes a message to all connected clients */
  publish(msg: P2PartyWSMsg, compress?: boolean): number {
    return this.server.publish("global", msg, compress);
  }
}
