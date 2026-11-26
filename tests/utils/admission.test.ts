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

  test("one /64 shares one bucket", () => {
    const guard = new AdmissionController({
      ...admissionLimits,
      connectionsPerIp: 2,
    });
    const source = (remote: string) => admissionAddress(remote, null, false)!;
    expect(guard.reserve(source("2001:db8:aaaa:bbbb::1"), "a")).toBeDefined();
    expect(
      guard.reserve(source("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff"), "b"),
    ).toBeDefined();
    // Same /64 written with upper case and without compression.
    expect(
      guard.reserve(source("2001:DB8:AAAA:BBBB:0:0:0:3"), "c"),
    ).toBeUndefined();
    expect(guard.reserve(source("2001:db8:aaaa:bbbc::1"), "d")).toBeDefined();
    expect((guard as unknown as { ips: Map<string, unknown> }).ips.size).toBe(
      2,
    );
  });

  test("one /64 cannot hold the global socket pool", () => {
    const guard = new AdmissionController(
      {
        ...admissionLimits,
        connections: 2048,
        connectionsPerIp: 32,
        attemptsPerIpPerMinute: 100000,
      },
      () => 100000,
    );
    let held = 0;
    // The audit scenario: 64 addresses of one /64, 32 sockets each.
    for (let address = 1; address <= 64; address++)
      for (let socket = 0; socket < 32; socket++)
        if (
          guard.reserve(
            admissionAddress(
              `2001:db8:aaaa:bbbb::${address.toString(16)}`,
              null,
              false,
            )!,
            "aa".repeat(32),
          )
        )
          held++;
    expect(held).toBe(32);
    expect(guard.reserve("198.51.100.7", "bb".repeat(32))).toBeDefined();
  });

  test("one-shot upgrades from one /64 cannot fill the address table", () => {
    const guard = new AdmissionController(
      { ...admissionLimits, trackedAddresses: 10000 },
      () => 100000,
    );
    for (let i = 0; i < 10000; i++)
      guard
        .reserve(
          admissionAddress(
            `2001:db8:aaaa:bbbb:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`,
            null,
            false,
          )!,
          "aa".repeat(32),
        )
        ?.release();
    expect((guard as unknown as { ips: Map<string, unknown> }).ips.size).toBe(
      1,
    );
    expect(guard.reserve("198.51.100.7", "bb".repeat(32))).toBeDefined();
  });

  test("ipv4-mapped address shares the ipv4 bucket", () => {
    const source = (remote: string) => admissionAddress(remote, null, false)!;
    const plainFirst = new AdmissionController({
      ...admissionLimits,
      connectionsPerIp: 1,
    });
    expect(plainFirst.reserve(source("192.0.2.1"), "a")).toBeDefined();
    expect(plainFirst.reserve(source("::ffff:192.0.2.1"), "b")).toBeUndefined();
    expect(plainFirst.reserve(source("::ffff:c000:201"), "c")).toBeUndefined();
    expect(plainFirst.reserve(source("192.0.2.2"), "d")).toBeDefined();

    const mappedFirst = new AdmissionController({
      ...admissionLimits,
      connectionsPerIp: 1,
    });
    // A dual-stack listener reports the mapped form; the trusted local proxy
    // header may carry it as well.
    expect(
      mappedFirst.reserve(
        admissionAddress("127.0.0.1", "::ffff:198.51.100.5", true)!,
        "a",
      ),
    ).toBeDefined();
    expect(mappedFirst.reserve(source("198.51.100.5"), "b")).toBeUndefined();
  });

  test("one key cannot exhaust the global creation budget", () => {
    let now = 100000;
    const guard = new AdmissionController(
      {
        ...admissionLimits,
        newIdentitiesPerMinute: 120,
        newMembershipsPerMinute: 600,
      },
      () => now,
    );
    const proved = (remote: string, identity: string) => {
      const lease = guard.reserve(
        admissionAddress(remote, null, false)!,
        identity,
      )!;
      expect(lease.authenticate()).toBe(true);
      return lease;
    };
    // Two sockets of one /64 are one key.
    const attacker = [
      proved("2001:db8:aaaa:bbbb::1", "attacker-1"),
      proved("2001:db8:aaaa:bbbb::2", "attacker-2"),
    ];
    let identities = 0,
      memberships = 0;
    for (let i = 0; i < 120; i++)
      if (attacker[i % 2]!.newIdentity()) identities++;
    for (let i = 0; i < 600; i++)
      if (attacker[i % 2]!.newMembership()) memberships++;
    // 5% of 120 and of 600.
    expect(identities).toBe(6);
    expect(memberships).toBe(30);

    const victim = proved("198.51.100.7", "victim");
    expect(victim.newIdentity()).toBe(true);
    expect(victim.newMembership()).toBe(true);

    // Many keys together still stop at the process-wide budget.
    let admitted = identities + 1;
    for (let key = 10; key < 60; key++) {
      const lease = proved(`198.51.100.${key}`, `identity-${key}`);
      for (let i = 0; i < 6; i++) if (lease.newIdentity()) admitted++;
    }
    expect(admitted).toBe(120);

    // An unproved socket creates nothing.
    const unproved = guard.reserve("203.0.113.1", "unproved")!;
    now += 60000;
    expect(unproved.newIdentity()).toBe(false);
    expect(unproved.newMembership()).toBe(false);
    // The next window restores the key's share.
    expect(attacker[0]!.newIdentity()).toBe(true);
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
