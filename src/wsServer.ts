import { isUUID } from "class-validator";

import handleConnection from "./utils/handleConnection";
import handleMessage from "./utils/handleMessage";
import handleInterval from "./utils/handleInterval";
import {
  closeSocketMessageQueue,
  type SocketMessage,
} from "./utils/socketMessageQueue";
import { handleSocketMessageIngress } from "./utils/socketMessageIngress";
import { unregisterSocketIfCurrent } from "./utils/socketAuth";
import { releasePeer, SERVER_ID } from "./pubsub";
import { PROTOCOL_VERSION } from "./utils/protocolV4";
import { SERVER_VERSION } from "./version";

import type { Server, ServerWebSocket } from "bun";
import type { SocketAuthState } from "./utils/socketAuth";

export type P2PartyWSMsg = SocketMessage;

export interface P2PartyWSData extends SocketAuthState {
  isAlive: boolean;
  pingInterval?: Timer;
  pongTimeout?: Timer;
  messageQueue?: P2PartyWSMsg[];
  messageQueueBytes?: number;
  messageDrain?: Promise<void>;
  messageQueueClosed?: boolean;
}

/** ServerWebSocket with server-bound identity and authentication state. */
export type P2PartyWSClient = ServerWebSocket<P2PartyWSData>;

/** Interface that defines the event handlers for a BunnyWS server */
export interface P2PartyWSEvents {
  open: (ws: P2PartyWSClient) => void;
  message: (ws: P2PartyWSClient, msg: P2PartyWSMsg) => void;
  close: (ws: P2PartyWSClient) => void;
}

export const wsClients = new Map<string, P2PartyWSClient>();

export class P2PartyWS {
  private server: Server<P2PartyWSData>;

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
            // Start pinging the client at regular intervals
            ws.data.pingInterval = await handleInterval(ws);
          }
        },

        message: (ws: P2PartyWSClient, message: P2PartyWSMsg) =>
          handleSocketMessageIngress(
            wsClients,
            ws,
            message,
            handleMessageWithEvents,
          ),

        close: async (ws: P2PartyWSClient, _code: number, _message: string) => {
          closeSocketMessageQueue(ws);
          ws.unsubscribe("global");
          if (ws.data.pongTimeout) clearTimeout(ws.data.pongTimeout);
          if (ws.data.pingInterval) clearInterval(ws.data.pingInterval);
          // A reconnect can replace this peer's registry entry before the old
          // socket's close event runs. Never evict that authenticated successor.
          // releasePeer is guarded on SERVER_ID for the same reason: it must not
          // clear a claim another instance has already taken.
          if (unregisterSocketIfCurrent(wsClients, ws))
            await releasePeer(ws.data.peerId);
          ws.terminate();
          events.close(ws);
        },

        idleTimeout: 60, // 60 seconds
        maxPayloadLength: 1024 * 1024, // 1mb
        // backpressureLimit: 100 * 1024 * 1024, // 10mb max backlog
        // closeOnBackpressureLimit: true, // close if backlog
      },

      fetch(req: Request, server: Server<P2PartyWSData>) {
        const url = new URL(req.url, `http://${req.headers.get("host")}`);

        if (req.headers.get("upgrade") !== "websocket") {
          // Everything else here needs an authenticated socket, which means a
          // deploy could not be verified without a valid Ed25519 key. Report
          // the two things an operator has to check after a rollout, and
          // nothing that describes who is using the service: no peer counts,
          // no room counts, no identities.
          //
          // serverId distinguishes instances behind the load balancer, so
          // repeated calls confirm every worker was actually replaced rather
          // than one answering every time.
          if (url.pathname === "/health") {
            return Response.json(
              {
                status: "ok",
                protocolVersion: PROTOCOL_VERSION,
                version: SERVER_VERSION,
                serverId: SERVER_ID,
              },
              { headers: { "cache-control": "no-store" } },
            );
          }

          return new Response("Upgrade required", { status: 426 });
        }

        if (!url.searchParams.has("publickey")) {
          return new Response("Forbidden", { status: 403 });
        }

        const p = url.searchParams.get("publickey");

        if (!p || !/^[0-9a-f]{64}$/.test(p)) {
          return new Response("Forbidden", { status: 403 });
        }

        if (
          server.upgrade(req, {
            data: {
              publicKey: p,
              peerId: "",
              challengeNonce: "",
              challengeId: "",
              socketGeneration: "",
              isVerified: false,
              isAuthenticating: false,
              isAlive: true,
            },
          })
        )
          return; // do not return a Response

        return new Response("Upgrade failed", { status: 500 });
      },
      port,
    });

    function handleMessageWithEvents(
      ws: P2PartyWSClient,
      message: P2PartyWSMsg,
    ) {
      return handleMessage(ws, message, events);
    }
  }
  /** Publishes a message to all connected clients */
  publish(msg: P2PartyWSMsg, compress?: boolean): number {
    return this.server.publish("global", msg, compress);
  }
}
