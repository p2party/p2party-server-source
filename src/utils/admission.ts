import { isIP } from "node:net";

const integer = (
  name: string,
  fallback: number,
  max: number,
  min = 1,
): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max || Number(raw) < min)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(raw);
};

export const admissionLimits = Object.freeze({
  connections: integer("MAX_CONNECTIONS", 2048, 100000),
  connectionsPerIp: integer("MAX_CONNECTIONS_PER_IP", 32, 10000),
  connectionsPerIdentity: integer("MAX_CONNECTIONS_PER_IDENTITY", 4, 100, 2),
  attemptsPerIpPerMinute: integer(
    "CONNECTION_ATTEMPTS_PER_IP_PER_MINUTE",
    60,
    10000,
  ),
  messagesPerIdentityPerMinute: integer(
    "MESSAGES_PER_IDENTITY_PER_MINUTE",
    2400,
    100000,
  ),
  roomMutationsPerIdentityPerMinute: integer(
    "ROOM_MUTATIONS_PER_IDENTITY_PER_MINUTE",
    60,
    10000,
  ),
  trackedAddresses: integer("MAX_TRACKED_ADDRESSES", 10000, 100000),
  newIdentitiesPerMinute: integer("NEW_IDENTITIES_PER_MINUTE", 120, 10000),
  newMembershipsPerMinute: integer("NEW_MEMBERSHIPS_PER_MINUTE", 600, 100000),
  persistentIdentities: integer("MAX_PERSISTENT_IDENTITIES", 100000, 10000000),
  /** Retention period: the identity ceiling counts identities seen inside it. */
  membershipTtlDays: integer("MEMBERSHIP_TTL_DAYS", 90, 3650),
  roomsPerIdentity: integer("MAX_ROOMS_PER_IDENTITY", 64, 1000),
  peersPerRoom: integer("MAX_PEERS_PER_ROOM", 128, 10000),
  authenticationTimeoutMs: integer("AUTHENTICATION_TIMEOUT_MS", 15000, 60000),
});

/**
 * No single source key may take more than this share of a process-wide
 * creation budget (new identities, new memberships) in one window.
 */
export const MAX_CREATION_SHARE_PERCENT_PER_SOURCE = 5;

/** At least one creation per window, so a small configured budget stays usable. */
const sourceShare = (budget: number): number =>
  Math.max(
    1,
    Math.floor((budget * MAX_CREATION_SHARE_PERCENT_PER_SOURCE) / 100),
  );

/**
 * The accounting key for a client address: an IPv4 address as is, an IPv6
 * address by its /64 prefix, and an IPv4-mapped IPv6 address as its IPv4
 * address. One subscriber or host usually holds a whole /64, so keying on the
 * full IPv6 address would give it 2^64 separate budgets.
 */
export const admissionKey = (address: string): string => {
  const bare = (
    address.startsWith("[") && address.endsWith("]")
      ? address.slice(1, -1)
      : address
  ).split("%")[0]!;
  if (isIP(bare) !== 6) return bare;
  // URL canonicalization: lower-case hex groups, at most one "::", and any
  // dotted IPv4 tail rewritten as two hex groups.
  const canonical = new URL(`http://[${bare}]`).hostname.slice(1, -1);
  const [head, tail] = canonical.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const words = (
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill("0"),
          ...right,
        ]
  ).map((group) => parseInt(group, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return [
      words[6]! >> 8,
      words[6]! & 0xff,
      words[7]! >> 8,
      words[7]! & 0xff,
    ].join(".");
  return `${words
    .slice(0, 4)
    .map((word) => word.toString(16))
    .join(":")}::/64`;
};

interface Bucket {
  start: number;
  count: number;
  active: number;
  messages: number;
  rooms: number;
}
type Creation = "identity" | "membership";
interface CreationWindow {
  start: number;
  count: number;
  /** Creations per source key in this window; at most `count` entries. */
  bySource: Map<string, number>;
}
export interface AdmissionLease {
  release(): void;
  authenticate(): boolean;
  message(): boolean;
  roomMutation(): boolean;
  /** Charge one new durable identity to this socket's source key, then the process. */
  newIdentity(): boolean;
  /** Charge one new room membership to this socket's source key, then the process. */
  newMembership(): boolean;
}

/** Fixed windows and inactive-bucket expiry keep admission accounting bounded. */
export class AdmissionController {
  /** Keyed by `admissionKey`, not by the raw address. */
  private ips = new Map<string, Bucket>();
  private identities = new Map<string, Bucket>();
  private connections = 0;
  private created: Record<Creation, CreationWindow> = {
    identity: { start: 0, count: 0, bySource: new Map() },
    membership: { start: 0, count: 0, bySource: new Map() },
  };
  private sweeps = new WeakMap<
    Map<string, Bucket>,
    MapIterator<[string, Bucket]>
  >();
  constructor(
    private readonly limits = admissionLimits,
    private readonly now = Date.now,
  ) {}

  private bucket(map: Map<string, Bucket>, key: string): Bucket | undefined {
    const now = this.now();
    let bucket = map.get(key);
    if (!bucket && map.size >= this.limits.trackedAddresses) {
      let sweep = this.sweeps.get(map);
      if (!sweep) {
        sweep = map.entries();
        this.sweeps.set(map, sweep);
      }
      // At most 16 inspections per request, even when many IPv6 addresses fill
      // the table. A full table may refuse newcomers until its bounded sweep
      // reaches an expired entry; it never turns rejection into an O(n) scan.
      for (let step = 0; step < 16; step++) {
        const entry = sweep.next();
        if (entry.done) {
          this.sweeps.delete(map);
          break;
        }
        const [address, value] = entry.value;
        if (!value.active && now - value.start >= 60000) map.delete(address);
      }
      if (map.size >= this.limits.trackedAddresses) return undefined;
    }
    if (!bucket) {
      bucket = { start: now, count: 0, active: 0, messages: 0, rooms: 0 };
      map.set(key, bucket);
    } else if (now - bucket.start >= 60000) {
      bucket.start = now;
      bucket.count = 0;
      bucket.messages = 0;
      bucket.rooms = 0;
    }
    return bucket;
  }

  reserve(ip: string, identity: string): AdmissionLease | undefined {
    if (this.connections >= this.limits.connections) return undefined;
    const source = admissionKey(ip);
    const address = this.bucket(this.ips, source);
    if (
      !address ||
      ++address.count > this.limits.attemptsPerIpPerMinute ||
      address.active >= this.limits.connectionsPerIp
    )
      return undefined;
    // A public key is public: unproved sockets must never reserve its identity
    // quota, otherwise anyone could lock a known user's key out of the service.
    let key: Bucket | undefined;
    address.active++;
    this.connections++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        address.active--;
        if (key) key.active--;
        this.connections--;
      },
      authenticate: () => {
        if (released) return false;
        if (key) return true;
        const candidate = this.bucket(this.identities, identity);
        if (
          !candidate ||
          candidate.active >= this.limits.connectionsPerIdentity
        )
          return false;
        key = candidate;
        key.active++;
        return true;
      },
      message: () =>
        !released &&
        ++this.bucket(
          key ? this.identities : this.ips,
          key ? identity : source,
        )!.messages <= this.limits.messagesPerIdentityPerMinute,
      roomMutation: () =>
        !released &&
        !!key &&
        ++this.bucket(this.identities, identity)!.rooms <=
          this.limits.roomMutationsPerIdentityPerMinute,
      // Creation needs a proved socket; unproved ones only read.
      newIdentity: () => !released && !!key && this.create("identity", source),
      newMembership: () =>
        !released && !!key && this.create("membership", source),
    };
  }

  private create(kind: Creation, source?: string): boolean {
    const now = this.now();
    const budget =
      kind === "identity"
        ? this.limits.newIdentitiesPerMinute
        : this.limits.newMembershipsPerMinute;
    let window = this.created[kind];
    if (now - window.start >= 60000)
      window = this.created[kind] = {
        start: now,
        count: 0,
        bySource: new Map(),
      };
    // The source's share is checked first and tied to the process window, so
    // no key can take more than its share of any one window. A refusal
    // charges nothing.
    const used = source === undefined ? 0 : (window.bySource.get(source) ?? 0);
    if (source !== undefined && used >= sourceShare(budget)) return false;
    if (window.count >= budget) return false;
    if (source !== undefined) window.bySource.set(source, used + 1);
    window.count++;
    return true;
  }

  /** Process-wide budget only, for callers that hold no socket lease. */
  newIdentity(): boolean {
    return this.create("identity");
  }

  /** Process-wide budget only, for callers that hold no socket lease. */
  newMembership(): boolean {
    return this.create("membership");
  }
}

export const admission = new AdmissionController();

/** Only a loopback proxy may supply the address; arbitrary forwarded headers never win. */
export const admissionAddress = (
  remote: string | undefined,
  forwarded: string | null,
  trustLocalProxy: boolean,
): string | undefined => {
  if (!remote || !isIP(remote)) return undefined;
  const loopback =
    remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const address = trustLocalProxy && loopback ? forwarded : remote;
  if (!address || !isIP(address)) return undefined;
  return isIP(address) === 6
    ? new URL(`http://[${address}]`).hostname
    : address;
};
