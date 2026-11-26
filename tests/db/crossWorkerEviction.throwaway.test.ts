import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { provisionalPeerId } from "../../src/utils/peerIdentity";
import {
  describeWithThrowawayPostgres,
  freshDatabase,
  repositoryRoot,
  type ThrowawayDatabase,
} from "./throwawayPostgres";

import type { Subprocess } from "bun";

/** A free port from the operating system's ephemeral range (above 5000). */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

interface Worker {
  port: number;
  serverId: string;
  process: Subprocess;
}

/** The real server, as its own process, on `databaseUrl`; no .env is read. */
const startWorker = async (databaseUrl: string): Promise<Worker> => {
  const port = freePort();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "run",
      join(repositoryRoot, "src", "index.ts"),
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: databaseUrl,
        PORT: String(port),
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  for (let attempt = 0; attempt < 200; attempt++) {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.json() as Promise<{ serverId: string }>,
      () => undefined,
    );
    if (health) return { port, serverId: health.serverId, process: child };
    await Bun.sleep(50);
  }
  child.kill();
  throw new Error("worker did not become healthy");
};

const identity = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x!,
    "base64url",
  ).toString("hex");
  return { key, privateKey };
};

/** A client that authenticates on `port`; resolves once the server says so. */
const login = (port: number, id: ReturnType<typeof identity>) =>
  new Promise<{
    ws: WebSocket;
    generation: string;
    closed: Promise<{ code: number; reason: string }>;
  }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?publickey=${id.key}`);
    let markClosed!: (close: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      markClosed = done;
    });
    ws.onclose = (event) => {
      markClosed({ code: event.code, reason: event.reason });
      reject(new Error(`closed before login: ${String(event.code)}`));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as {
        type: string;
        peerId?: string;
        challenge?: string;
        challengeId?: string;
      };
      if (frame.type === "peerId")
        ws.send(
          JSON.stringify({
            type: "challenge",
            fromPeerId: frame.peerId,
            challenge: frame.challenge,
            signature: sign(
              null,
              new Uint8Array(Buffer.from(frame.challenge!, "hex")),
              id.privateKey,
            ).toString("hex"),
            protocolVersion: 4,
          }),
        );
      if (frame.type === "challenge")
        resolve({ ws, generation: frame.challengeId!, closed });
    };
  });

let database: ThrowawayDatabase | undefined;
const workers: Worker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.process.kill();
    await worker.process.exited;
  }
  await database?.drop();
  database = undefined;
});

describeWithThrowawayPostgres("cross-worker session fencing", () => {
  test("a login on another worker evicts the older socket with the contract code", async () => {
    database = await freshDatabase();
    const first = await startWorker(database.url);
    workers.push(first);
    const second = await startWorker(database.url);
    workers.push(second);
    expect(second.serverId).not.toBe(first.serverId);

    const id = identity();
    const peerId = provisionalPeerId(id.key);
    const older = await login(first.port, id);
    expect(
      await database.prisma.peer.findUnique({
        where: { id: peerId },
        select: { serverId: true, socketGeneration: true },
      }),
    ).toEqual({ serverId: first.serverId, socketGeneration: older.generation });

    const newer = await login(second.port, id);

    // The first worker is told through its queue and closes the older
    // socket with the contract's replacement close.
    expect(await older.closed).toEqual({
      code: 1008,
      reason: "Replaced by a newer session for this identity",
    });
    expect(newer.ws.readyState).toBe(WebSocket.OPEN);
    expect(
      await database.prisma.peer.findUnique({
        where: { id: peerId },
        select: { serverId: true, socketGeneration: true },
      }),
    ).toEqual({
      serverId: second.serverId,
      socketGeneration: newer.generation,
    });
    // The first worker deletes the eviction row once its drain has closed the
    // socket, which can be just after the client sees the close.
    let queued = await database.prisma.pendingSignal.count();
    for (let attempt = 0; attempt < 100 && queued > 0; attempt++) {
      await Bun.sleep(20);
      queued = await database.prisma.pendingSignal.count();
    }
    expect(queued).toBe(0);
    newer.ws.close();
  }, 60_000);
});
