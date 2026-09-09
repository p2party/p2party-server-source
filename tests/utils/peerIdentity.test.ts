import { describe, expect, test } from "bun:test";
import { createHandleConnection } from "../../src/utils/handleConnection";
import {
  createPersistVerifiedIdentity,
  provisionalPeerId,
} from "../../src/utils/peerIdentity";
import { isUUID } from "../../src/utils/formats";
import type { P2PartyWSClient } from "../../src/wsServer";

const key = "ab".repeat(32);
const socket = (verified = false, id = provisionalPeerId(key)) =>
  ({
    data: { peerId: id, publicKey: key, isVerified: verified },
    readyState: 1,
    send: () => 1,
    close: () => {},
  }) as unknown as P2PartyWSClient;

describe("proof-gated durable identity", () => {
  test("repeated unproved connections only read, and their stable candidate survives a new process", async () => {
    let reads = 0;
    const bootstrap = createHandleConnection({
      peer: {
        findUnique: async () => {
          reads++;
          return null;
        },
        upsert: () => {
          throw new Error("unauthenticated write attempted");
        },
      },
    } as never);
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => bootstrap(key, socket())),
    );
    expect(reads).toBe(12);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(provisionalPeerId(key));
    expect(isUUID(ids[0], 4)).toBe(true);
    expect(provisionalPeerId("cd".repeat(32))).not.toBe(ids[0]);
  });

  test("existing pre-release random peer IDs are preserved", async () => {
    const oldId = "00000000-0000-4000-8000-000000000001";
    const bootstrap = createHandleConnection({
      peer: { findUnique: async () => ({ id: oldId }) },
    } as never);
    expect(await bootstrap(key, socket())).toBe(oldId);
  });

  test("invalid proof or closed socket cannot start a persistence transaction", async () => {
    const persist = createPersistVerifiedIdentity({
      $transaction: () => {
        throw new Error("unexpected database call");
      },
    } as never);
    expect(await persist(socket(false))).toBe(false);
    const closed = socket(true);
    Object.assign(closed, { readyState: 3 });
    expect(await persist(closed)).toBe(false);
  });

  test("new identity capacity is checked in the same serializable transaction as insertion", async () => {
    let count = 0,
      writes = 0,
      isolation = "";
    const database = {
      $transaction: async (
        run: (tx: unknown) => unknown,
        options: { isolationLevel: string },
      ) => {
        isolation = options.isolationLevel;
        return run({
          peer: {
            findUnique: async () => null,
            count: async () => count,
            upsert: async () => {
              writes++;
            },
          },
        });
      },
    } as never;
    const persist = createPersistVerifiedIdentity(database, () => true, 2);
    expect(await persist(socket(true))).toBe(true);
    expect(isolation).toBe("Serializable");
    expect(writes).toBe(1);
    count = 2;
    await expect(persist(socket(true))).rejects.toThrow("capacity");
    expect(writes).toBe(1);
  });

  test("a rollout race with a different persisted ID refuses activation", async () => {
    let writes = 0;
    const persist = createPersistVerifiedIdentity({
      $transaction: async (run: (tx: unknown) => unknown) =>
        run({
          peer: {
            findUnique: async () => ({
              id: "00000000-0000-4000-8000-000000000001",
            }),
            upsert: async () => {
              writes++;
            },
          },
        }),
    } as never);
    await expect(persist(socket(true))).rejects.toThrow("reconnect required");
    expect(writes).toBe(0);
  });
});
