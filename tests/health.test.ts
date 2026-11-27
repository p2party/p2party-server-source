import { describe, expect, test } from "bun:test";

import { SIGNALING_PROTOCOL_VERSION } from "../src/utils/signalingProtocol";
import { SERVER_VERSION } from "../src/version";

/**
 * The health route is the only thing an operator can reach without an Ed25519
 * key, so it is also the only way to confirm which build answered after a
 * rollout. Two properties matter: it reports the running protocol version, and
 * it does not turn the server into an open HTTP endpoint for anything else.
 */
describe("health endpoint", () => {
  const serve = () =>
    Bun.serve({
      port: 0,
      websocket: { message() {} },
      fetch(req) {
        const url = new URL(req.url, `http://${req.headers.get("host")}`);
        if (req.headers.get("upgrade") !== "websocket") {
          if (url.pathname === "/health")
            return Response.json({
              status: "ok",
              protocolVersion: SIGNALING_PROTOCOL_VERSION,
              version: SERVER_VERSION,
              serverId: "test-instance",
            });
          return new Response("Upgrade required", { status: 426 });
        }
        return new Response("unreachable");
      },
    });

  test("reports the running protocol and build version without auth", async () => {
    const server = serve();
    try {
      const res = await fetch(`http://localhost:${server.port}/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.protocolVersion).toBe(5);
      expect(body.version).toBe(SERVER_VERSION);
      // Distinguishes instances behind the load balancer.
      expect(typeof body.serverId).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  test("every other path still demands a WebSocket upgrade", async () => {
    const server = serve();
    try {
      for (const path of ["/", "/rooms", "/health/../admin"]) {
        const res = await fetch(`http://localhost:${server.port}${path}`);
        expect(res.status).toBe(426);
      }
    } finally {
      server.stop(true);
    }
  });
});
