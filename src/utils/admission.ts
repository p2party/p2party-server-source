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
/**
 * How many times one identity's last socket closing is announced to its rooms
 * (`peerLeft` with reason "offline") per minute, per process. One announcement
 * sends one frame to every online member of every room the identity is in, at
 * most roomsPerIdentity * (peersPerRoom - 1) frames (8,128 with the defaults).
 * Connection attempts are limited per source address, not per identity, so
 * without this a member reconnecting from many addresses could make the server
 * send that many frames for each socket it opens and closes. A close past the
 * limit is not announced; members then learn of it only from their own edge.
 */
export const MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE = 6;
/** The most frames one offline announcement can send: every room, full. */
export const MAX_FRAMES_PER_OFFLINE_ANNOUNCEMENT =
  admissionLimits.roomsPerIdentity * (admissionLimits.peersPerRoom - 1);
/**
 * Departure frames (`peerLeft`, "left" and "offline" alike) one source key —
 * the IPv4 address or IPv6 /64 the connection limits use — may cause per
 * minute, per process: what one identity may cause with its offline
 * announcements (6 * 8,128 = 48,768 with the defaults). Identities persist
 * and one source may create 6 a minute, so without it the frames one address
 * causes would grow with the identities it holds, up to the 60 connection
 * attempts a minute it may make (60 * 8,128 = 487,680). An announcement the
 * budget cannot hold whole is skipped whole.
 */
export const MAX_DEPARTURE_FRAMES_PER_SOURCE_PER_MINUTE =
  MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE *
  MAX_FRAMES_PER_OFFLINE_ANNOUNCEMENT;
/**
 * The same budget for a whole IPv6 /48, whose 65,536 /64s each have their own:
 * twice a source key's, the ratio of the creation shares
 * (MAX_SHARE_PERCENT_PER_IPV6_48 to MAX_CREATION_SHARE_PERCENT_PER_SOURCE).
 */
export const MAX_DEPARTURE_FRAMES_PER_IPV6_48_PER_MINUTE =
  (MAX_DEPARTURE_FRAMES_PER_SOURCE_PER_MINUTE * MAX_SHARE_PERCENT_PER_IPV6_48) /
  MAX_CREATION_SHARE_PERCENT_PER_SOURCE;

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
  /** Offline announcements of this identity in the window. */
  offline: number;
  /** Departure frames this source key or /48 caused in the window. */
  departures: number;
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
      bucket = {
        start: now,
        count: 0,
        active: 0,
        messages: 0,
        rooms: 0,
        offline: 0,
        departures: 0,
      };
      this.buckets.set(key, bucket);
    } else if (now - bucket.start >= 60000) {
      bucket.start = now;
      bucket.count = 0;
      bucket.messages = 0;
      bucket.rooms = 0;
      bucket.offline = 0;
      bucket.departures = 0;
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
  /** Creations in this window charged without a lease (process budget only). */
  leaseless: number;
}
export interface AdmissionLease {
  release(): void;
  authenticate(): boolean;
  message(): boolean;
  roomMutation(): boolean;
  /**
   * Charge one offline announcement to this socket's identity; false past
   * MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE. Valid after release(),
   * since the close handler releases the lease before it learns whether the
   * socket was its identity's last. A socket that never authenticated has no
   * identity to charge and is refused.
   */
  offlineAnnouncement(): boolean;
  /**
   * Charge `frames` departure frames to this socket's source key and /48, all
   * or nothing: false, with nothing charged, when either budget
   * (MAX_DEPARTURE_FRAMES_PER_SOURCE_PER_MINUTE,
   * MAX_DEPARTURE_FRAMES_PER_IPV6_48_PER_MINUTE) cannot hold them. Valid after
   * release(), like offlineAnnouncement().
   */
  departureFrames(frames: number): boolean;
  /** Charge one new durable identity to this socket's source key and /48, then the process. */
  newIdentity(): boolean;
  /**
   * Give back this socket's identity charge: its insert did not win, or was
   * undone. A no-op once the window it was charged to has ended.
   */
  refundIdentity(): void;
  /** Whether newMembership() would succeed now. Charges nothing. */
  canAddMembership(): boolean;
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
    identity: { start: 0, count: 0, bySource: new Map(), leaseless: 0 },
    membership: { start: 0, count: 0, bySource: new Map(), leaseless: 0 },
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
    let identityCharge: CreationWindow | undefined;
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
      offlineAnnouncement: () =>
        !!key &&
        ++this.identities.use(identity, this.now()).offline <=
          MAX_OFFLINE_ANNOUNCEMENTS_PER_IDENTITY_PER_MINUTE,
      departureFrames: (frames) => {
        const now = this.now();
        // Looked up again rather than captured: a bucket evicted while idle
        // is replaced by a new one under the same key.
        const source = this.ips.use(sources.key, now);
        const prefix =
          sources.block === undefined
            ? undefined
            : this.blocks.use(sources.block, now);
        if (
          source.departures + frames >
            MAX_DEPARTURE_FRAMES_PER_SOURCE_PER_MINUTE ||
          (prefix &&
            prefix.departures + frames >
              MAX_DEPARTURE_FRAMES_PER_IPV6_48_PER_MINUTE)
        )
          return false;
        source.departures += frames;
        if (prefix) prefix.departures += frames;
        return true;
      },
      // Creation needs a proved socket; unproved ones only read.
      newIdentity: () => {
        if (released || !key) return false;
        identityCharge = this.charge("identity", sources);
        return identityCharge !== undefined;
      },
      refundIdentity: () => {
        if (identityCharge) this.refund("identity", identityCharge, sources);
        identityCharge = undefined;
      },
      canAddMembership: () =>
        !released && !!key && this.create("membership", sources, false),
      newMembership: () =>
        !released && !!key && this.create("membership", sources),
    };
  }

  /** With `charge` false, only reports whether the creation would be admitted. */
  private create(
    kind: Creation,
    sources?: AdmissionSources,
    charge = true,
  ): boolean {
    return charge
      ? this.charge(kind, sources) !== undefined
      : this.admits(kind, sources);
  }

  private admits(kind: Creation, sources?: AdmissionSources): boolean {
    const window = this.window(kind);
    const limits = this.charges(kind, sources);
    return (
      limits.every(
        ([source, limit]) => (window.bySource.get(source) ?? 0) < limit,
      ) && window.count < this.budget(kind)
    );
  }

  /** Charge one creation; the window charged, or undefined when refused. */
  private charge(
    kind: Creation,
    sources?: AdmissionSources,
  ): CreationWindow | undefined {
    if (!this.admits(kind, sources)) return undefined;
    const window = this.window(kind);
    for (const [source] of this.charges(kind, sources))
      window.bySource.set(source, (window.bySource.get(source) ?? 0) + 1);
    window.count++;
    if (!sources) window.leaseless++;
    return window;
  }

  /** Undo one charge, if the window it was made in is still the current one. */
  private refund(
    kind: Creation,
    window: CreationWindow,
    sources?: AdmissionSources,
  ): void {
    if (this.created[kind] !== window || window.count === 0) return;
    window.count--;
    if (!sources) window.leaseless = Math.max(0, window.leaseless - 1);
    for (const [source] of this.charges(kind, sources)) {
      const count = (window.bySource.get(source) ?? 0) - 1;
      if (count > 0) window.bySource.set(source, count);
      else window.bySource.delete(source);
    }
  }

  private budget(kind: Creation): number {
    return kind === "identity"
      ? this.limits.newIdentitiesPerMinute
      : this.limits.newMembershipsPerMinute;
  }

  /** The kind's current window, started afresh once a minute has passed. */
  private window(kind: Creation): CreationWindow {
    const now = this.now();
    if (now - this.created[kind].start >= 60000)
      this.created[kind] = {
        start: now,
        count: 0,
        bySource: new Map(),
        leaseless: 0,
      };
    return this.created[kind];
  }

  /**
   * The source key and its /48, with each one's share of the budget. They are
   * checked before the process budget, and their counts belong to the process
   * window, so neither can take more than its share of any one window.
   */
  private charges(
    kind: Creation,
    sources?: AdmissionSources,
  ): [string, number][] {
    const budget = this.budget(kind);
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
    return charges;
  }

  /** Process-wide budget only, for callers that hold no socket lease. */
  newIdentity(): boolean {
    return this.create("identity");
  }

  /** Give back one leaseless identity charge of the current window. */
  refundIdentity(): void {
    const window = this.created.identity;
    if (window.leaseless > 0) this.refund("identity", window);
  }

  /** Process-wide budget only, for callers that hold no socket lease. Charges nothing. */
  canAddMembership(): boolean {
    return this.create("membership", undefined, false);
  }

  /** Process-wide budget only, for callers that hold no socket lease. */
  newMembership(): boolean {
    return this.create("membership");
  }
}

export const admission = new AdmissionController();

/**
 * The bracketed canonical form of an IPv6 address, or undefined when URL
 * parsing rejects it. node:net accepts some forms URL does not, such as a zone
 * id (`fe80::1%en0`) or a dotted IPv4 tail after `::` in a non-mapped address.
 */
const canonicalIpv6 = (address: string): string | undefined => {
  try {
    return new URL(`http://[${address}]`).hostname;
  } catch {
    return undefined;
  }
};

/**
 * Only a loopback proxy may supply the address; arbitrary forwarded headers
 * never win. Undefined refuses the upgrade, for unparseable input of any kind.
 */
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
  return isIP(address) === 6 ? canonicalIpv6(address) : address;
};
