import { describe, expect, test } from "bun:test";
import {
  AdmissionController,
  admissionAddress,
  admissionLimits,
} from "../../src/utils/admission";

describe("bounded signaling admission", () => {
  test("connection leases release exactly once and rate limits survive reconnects", () => {
    let now = 100000;
    const guard = new AdmissionController(
      { ...admissionLimits, connectionsPerIp: 1, attemptsPerIpPerMinute: 3 },
      () => now,
    );
    const first = guard.reserve("192.0.2.1", "first")!;
    expect(first).toBeDefined();
    expect(guard.reserve("192.0.2.1", "other")).toBeUndefined();
    first.release();
    first.release();
    expect(guard.reserve("192.0.2.1", "second")).toBeDefined();
    expect(guard.reserve("192.0.2.1", "third")).toBeUndefined();
    now += 60001;
    expect(guard.reserve("192.0.2.2", "third")).toBeDefined();
  });

  test("unproved users cannot consume a known identity's quota", () => {
    const guard = new AdmissionController({
      ...admissionLimits,
      connectionsPerIdentity: 1,
    });
    const unproved = guard.reserve("192.0.2.1", "victim")!;
    const actual = guard.reserve("192.0.2.2", "victim")!;
    expect(actual.authenticate()).toBe(true);
    expect(unproved.authenticate()).toBe(false);
    actual.release();
    expect(unproved.authenticate()).toBe(true);
  });

  test("identity message and room budgets survive socket replacement", () => {
    let now = 100000;
    const guard = new AdmissionController(
      {
        ...admissionLimits,
        messagesPerIdentityPerMinute: 2,
        roomMutationsPerIdentityPerMinute: 1,
      },
      () => now,
    );
    const first = guard.reserve("192.0.2.1", "identity")!;
    expect(first.authenticate()).toBe(true);
    expect(first.message()).toBe(true);
    expect(first.message()).toBe(true);
    expect(first.roomMutation()).toBe(true);
    first.release();
    const next = guard.reserve("192.0.2.2", "identity")!;
    expect(next.authenticate()).toBe(true);
    expect(next.message()).toBe(false);
    expect(next.roomMutation()).toBe(false);
    now += 60000;
    expect(next.message()).toBe(true);
    expect(next.roomMutation()).toBe(true);
  });

  test("the tracking map and global creation budget are bounded", () => {
    let now = 100000;
    const guard = new AdmissionController(
      { ...admissionLimits, trackedAddresses: 1, newIdentitiesPerMinute: 1 },
      () => now,
    );
    const lease = guard.reserve("192.0.2.1", "identity")!;
    lease.release();
    expect(guard.reserve("192.0.2.2", "other")).toBeUndefined();
    expect(guard.newIdentity()).toBe(true);
    expect(guard.newIdentity()).toBe(false);
    now += 60001;
    expect(guard.reserve("192.0.2.2", "other")).toBeDefined();
    expect(guard.newIdentity()).toBe(true);
  });

  test("table saturation examines at most sixteen entries per rejected newcomer", () => {
    const guard = new AdmissionController({
      ...admissionLimits,
      trackedAddresses: 100,
    });
    for (let i = 0; i < 100; i++)
      guard.reserve(`192.0.2.${i}`, String(i))!.release();
    const map = (guard as unknown as { ips: Map<string, unknown> }).ips;
    const entries = map.entries.bind(map);
    let examined = 0;
    map.entries = () => {
      const iterator = entries();
      const next = iterator.next.bind(iterator);
      iterator.next = () => {
        examined++;
        return next();
      };
      return iterator;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = examined;
      expect(guard.reserve(`198.51.100.${attempt}`, "new")).toBeUndefined();
      expect(examined - before).toBeLessThanOrEqual(16);
    }
  });

  test("only explicit loopback proxy trust accepts a client address header", () => {
    expect(admissionAddress("192.0.2.1", "198.51.100.5", true)).toBe(
      "192.0.2.1",
    );
    expect(admissionAddress("127.0.0.1", "198.51.100.5", false)).toBe(
      "127.0.0.1",
    );
    expect(admissionAddress("127.0.0.1", "198.51.100.5", true)).toBe(
      "198.51.100.5",
    );
    expect(
      admissionAddress("127.0.0.1", "198.51.100.5,192.0.2.1", true),
    ).toBeUndefined();
    expect(admissionAddress(undefined, "198.51.100.5", true)).toBeUndefined();
  });
});
