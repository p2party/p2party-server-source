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
  roomsPerIdentity: integer("MAX_ROOMS_PER_IDENTITY", 64, 1000),
  peersPerRoom: integer("MAX_PEERS_PER_ROOM", 128, 10000),
  authenticationTimeoutMs: integer("AUTHENTICATION_TIMEOUT_MS", 15000, 60000),
});

/**
 * One source key (an IPv4 address or an IPv6 /64) may take at most this share
 * of a process-wide creation budget (new identities, new memberships) in one
 * window.
 */
export const MAX_CREATION_SHARE_PERCENT_PER_SOURCE = 5;
/**
 * One IPv6 /48 may take at most this share of a process-wide creation budget
 * in one window, and of the process-wide socket pool. A /48 holds 65,536 /64s,
 * so without it twenty /64s at 5% each would exhaust a budget.
 */
export const MAX_SHARE_PERCENT_PER_IPV6_48 = 10;

/** At least one unit, so a small configured budget stays usable. */
const share = (budget: number, percent: number): number =>
  Math.max(1, Math.floor((budget * percent) / 100));

export interface AdmissionSources {
  /** The IPv4 address, or the /64 prefix of an IPv6 address. */
  key: string;
  /** The /48 prefix of an IPv6 address; IPv4, mapped or not, has none. */
  block?: string;
}

/**
 * Accounting keys for a client address. An IPv4-mapped IPv6 address counts as
 * its IPv4 address. One subscriber or host usually holds a whole /64, so
 * keying on the full IPv6 address would give it 2^64 separate budgets.
 */
export const admissionSources = (address: string): AdmissionSources => {
  const bare = (
    address.startsWith("[") && address.endsWith("]")
      ? address.slice(1, -1)
      : address
  ).split("%")[0]!;
  if (isIP(bare) !== 6) return { key: bare };
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
    return {
      key: [
        words[6]! >> 8,
        words[6]! & 0xff,
        words[7]! >> 8,
        words[7]! & 0xff,
      ].join("."),
    };
  const groups = words.map((word) => word.toString(16));
  return {
    key: `${groups.slice(0, 4).join(":")}::/64`,
    block: `${groups.slice(0, 3).join(":")}::/48`,
  };
};

interface Bucket {
  start: number;
  count: number;
  active: number;
  messages: number;
  rooms: number;
}

/**
 * Rate and socket buckets. A newcomer to a full table evicts the least
 * recently used idle bucket (no open socket), so a full table neither refuses
 * newcomers nor stops counting them. Buckets with open sockets are never
 * evicted; the table exceeds its capacity only by those, which
 * MAX_CONNECTIONS bounds. Each operation is O(1) amortized.
 */
class BucketTable {
  private buckets = new Map<string, Bucket>();
  /** Idle buckets, least recently used first. */
  private idle = new Map<string, Bucket>();
  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.buckets.size;
  }

  has(key: string): boolean {
    return this.buckets.has(key);
  }

  /** The key's bucket, created if needed, with its window rolled at `now`. */
  use(key: string, now: number): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      while (this.buckets.size >= this.capacity) {
        const leastRecent = this.idle.keys().next();
        if (leastRecent.done) break;
        this.idle.delete(leastRecent.value);
        this.buckets.delete(leastRecent.value);
      }
      bucket = { start: now, count: 0, active: 0, messages: 0, rooms: 0 };
      this.buckets.set(key, bucket);
    } else if (now - bucket.start >= 60000) {
      bucket.start = now;
      bucket.count = 0;
      bucket.messages = 0;
      bucket.rooms = 0;
    }
    if (bucket.active === 0) {
      // Re-inserting moves the key to the most recently used end.
      this.idle.delete(key);
      this.idle.set(key, bucket);
    }
    return bucket;
  }

  open(key: string, bucket: Bucket): void {
    if (bucket.active++ === 0) this.idle.delete(key);
  }

  close(key: string, bucket: Bucket): void {
    if (--bucket.active === 0) this.idle.set(key, bucket);
  }
}

type Creation = "identity" | "membership";
interface CreationWindow {
  start: number;
  count: number;
  /** Creations per source key and per /48 in this window; at most 2 * `count` entries. */
  bySource: Map<string, number>;
}
export interface AdmissionLease {
  release(): void;
  authenticate(): boolean;
  message(): boolean;
  roomMutation(): boolean;
  /** Charge one new durable identity to this socket's source key and /48, then the process. */
  newIdentity(): boolean;
  /** Charge one new room membership to this socket's source key and /48, then the process. */
  newMembership(): boolean;
}

/** Fixed windows and least-recently-used eviction keep admission accounting bounded. */
export class AdmissionController {
  /** Keyed by `AdmissionSources.key`, not by the raw address. */
  private ips: BucketTable;
  /** IPv6 /48 prefixes. */
  private blocks: BucketTable;
  private identities: BucketTable;
  private connections = 0;
  private created: Record<Creation, CreationWindow> = {
    identity: { start: 0, count: 0, bySource: new Map() },
    membership: { start: 0, count: 0, bySource: new Map() },
  };
  constructor(
    private readonly limits = admissionLimits,
    private readonly now = Date.now,
  ) {
    this.ips = new BucketTable(limits.trackedAddresses);
    this.blocks = new BucketTable(limits.trackedAddresses);
    this.identities = new BucketTable(limits.trackedAddresses);
  }

  reserve(ip: string, identity: string): AdmissionLease | undefined {
    if (this.connections >= this.limits.connections) return undefined;
    const now = this.now();
    const sources = admissionSources(ip);
    const address = this.ips.use(sources.key, now);
    const block =
      sources.block === undefined
        ? undefined
        : this.blocks.use(sources.block, now);
    if (
      ++address.count > this.limits.attemptsPerIpPerMinute ||
      address.active >= this.limits.connectionsPerIp ||
      (block &&
        block.active >=
          share(this.limits.connections, MAX_SHARE_PERCENT_PER_IPV6_48))
    )
      return undefined;
    // A public key is public: unproved sockets must never reserve its identity
    // quota, otherwise anyone could lock a known user's key out of the service.
    let key: Bucket | undefined;
    this.ips.open(sources.key, address);
    if (block) this.blocks.open(sources.block!, block);
    this.connections++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.ips.close(sources.key, address);
        if (block) this.blocks.close(sources.block!, block);
        if (key) this.identities.close(identity, key);
        this.connections--;
      },
      authenticate: () => {
        if (released) return false;
        if (key) return true;
        const candidate = this.identities.use(identity, this.now());
        if (candidate.active >= this.limits.connectionsPerIdentity)
          return false;
        key = candidate;
        this.identities.open(identity, key);
        return true;
      },
      message: () =>
        !released &&
        ++(key
          ? this.identities.use(identity, this.now())
          : this.ips.use(sources.key, this.now())
        ).messages <= this.limits.messagesPerIdentityPerMinute,
      roomMutation: () =>
        !released &&
        !!key &&
        ++this.identities.use(identity, this.now()).rooms <=
          this.limits.roomMutationsPerIdentityPerMinute,
      // Creation needs a proved socket; unproved ones only read.
      newIdentity: () => !released && !!key && this.create("identity", sources),
      newMembership: () =>
        !released && !!key && this.create("membership", sources),
    };
  }

  private create(kind: Creation, sources?: AdmissionSources): boolean {
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
    // The source key and its /48 are checked before the process budget, and
    // their counts belong to the process window, so neither can take more
    // than its share of any one window. A refusal charges nothing.
    const charges: [string, number][] = [];
    if (sources) {
      charges.push([
        sources.key,
        share(budget, MAX_CREATION_SHARE_PERCENT_PER_SOURCE),
      ]);
      if (sources.block !== undefined)
        charges.push([
          sources.block,
          share(budget, MAX_SHARE_PERCENT_PER_IPV6_48),
        ]);
    }
    for (const [source, limit] of charges)
      if ((window.bySource.get(source) ?? 0) >= limit) return false;
    if (window.count >= budget) return false;
    for (const [source] of charges)
      window.bySource.set(source, (window.bySource.get(source) ?? 0) + 1);
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
