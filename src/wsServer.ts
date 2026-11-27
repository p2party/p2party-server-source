import { requireSignalingHost } from "./utils/loginProof";
import {
  admission,
  admissionAddress,
  admissionLimits,
  type AdmissionLease,
} from "./utils/admission";

import handleConnection from "./utils/handleConnection";
import handleMessage from "./utils/handleMessage";
import {
  closeSocketMessageQueue,
  type SocketMessage,
} from "./utils/socketMessageQueue";
import { handleSocketMessageIngress } from "./utils/socketMessageIngress";
import { isCurrentVerifiedSocket } from "./utils/socketAuth";
import { retireClosedSocketAndAnnounce } from "./utils/handlePeers";
import { SERVER_ID } from "./pubsub";
import {
  PROTOCOL_VERSION_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION_MISMATCH_REASON,
  SIGNALING_PROTOCOL_VERSION,
} from "./utils/signalingProtocol";
import { SERVER_VERSION } from "./version";

import type { Server, ServerWebSocket } from "bun";
import type { SocketAuthState } from "./utils/socketAuth";

export type P2PartyWSMsg = SocketMessage;

export interface P2PartyWSData extends SocketAuthState {
  legacyUpgrade?: boolean;
  isAlive: boolean;
  pingInterval?: Timer;
  pongTimeout?: Timer;
  messageQueue?: P2PartyWSMsg[];
  messageQueueBytes?: number;
  messageDrain?: Promise<void>;
  messageQueueClosed?: boolean;
  admission?: AdmissionLease;
  authenticationTimeout?: Timer;
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
  constructor(
    port: number,
    events: P2PartyWSEvents,
    signalingHost = requireSignalingHost(process.env.SIGNALING_HOST),
  ) {
    this.server = Bun.serve({
      websocket: {
        open: (ws: P2PartyWSClient) => {
          if (ws.data.legacyUpgrade) {
            ws.close(
              PROTOCOL_VERSION_MISMATCH_CLOSE_CODE,
              PROTOCOL_VERSION_MISMATCH_REASON,
            );
            return;
          }
          ws.data.authenticationTimeout = setTimeout(() => {
            if (!isCurrentVerifiedSocket(wsClients, ws))
              ws.close(1013, "Authentication timed out");
          }, admissionLimits.authenticationTimeoutMs);
          handleConnection(ws);
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
          ws.data.admission?.release();
          if (ws.data.authenticationTimeout)
            clearTimeout(ws.data.authenticationTimeout);
          ws.unsubscribe("global");
          if (ws.data.pongTimeout) clearTimeout(ws.data.pongTimeout);
          if (ws.data.pingInterval) clearInterval(ws.data.pingInterval);
          // A reconnect can replace this peer's registry entry before the old
          // socket's close event runs, or be committing its own claim while it
          // does. Never evict that successor or clear its claim.
          // releasePeer is guarded on SERVER_ID for the same reason: it must not
          // clear a claim another instance has already taken. Only a release
          // that cleared the claim, so the identity's last socket closed,
          // announces the identity offline to its rooms (handlePeers.ts).
          await retireClosedSocketAndAnnounce(ws);
          ws.terminate();
          events.close(ws);
        },

        idleTimeout: 60, // 60 seconds
        maxPayloadLength: 1024 * 1024, // 1mb
        // backpressureLimit: 100 * 1024 * 1024, // 10mb max backlog
        // closeOnBackpressureLimit: true, // close if backlog
      },

      fetch(req: Request, server: Server<P2PartyWSData>) {
        const url = new URL(req.url);

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
                protocolVersion: SIGNALING_PROTOCOL_VERSION,
                version: SERVER_VERSION,
                serverId: SERVER_ID,
              },
              { headers: { "cache-control": "no-store" } },
            );
          }

          return new Response("Upgrade required", { status: 426 });
        }

        const address = admissionAddress(
          server.requestIP(req)?.address,
          req.headers.get("x-real-ip"),
          process.env.TRUST_LOCAL_PROXY === "true",
        );
        const lease = address ? admission.reserve(address) : undefined;
        if (!lease)
          return new Response("Signaling admission limit reached", {
            status: 429,
            headers: { "retry-after": "60" },
          });

        if (
          server.upgrade(req, {
            data: {
              publicKey: "",
              legacyUpgrade: url.searchParams.has("publickey"),
              admission: lease,
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

        lease.release();
        return new Response("Upgrade failed", { status: 500 });
      },
      port,
    });

    function handleMessageWithEvents(
      ws: P2PartyWSClient,
      message: P2PartyWSMsg,
    ) {
      return handleMessage(ws, message, events, signalingHost);
    }
  }
  /** Publishes a message to all connected clients */
  publish(msg: P2PartyWSMsg, compress?: boolean): number {
    return this.server.publish("global", msg, compress);
  }
}
