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

interface Bucket {
  start: number;
  count: number;
  active: number;
  messages: number;
  rooms: number;
}
export interface AdmissionLease {
  release(): void;
  authenticate(): boolean;
  message(): boolean;
  roomMutation(): boolean;
}

/** Fixed windows and inactive-bucket expiry keep admission accounting bounded. */
export class AdmissionController {
  private ips = new Map<string, Bucket>();
  private identities = new Map<string, Bucket>();
  private connections = 0;
  private creations = { start: 0, count: 0 };
  private memberships = { start: 0, count: 0 };
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
    const address = this.bucket(this.ips, ip);
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
        ++this.bucket(key ? this.identities : this.ips, key ? identity : ip)!
          .messages <= this.limits.messagesPerIdentityPerMinute,
      roomMutation: () =>
        !released &&
        !!key &&
        ++this.bucket(this.identities, identity)!.rooms <=
          this.limits.roomMutationsPerIdentityPerMinute,
    };
  }

  newIdentity(): boolean {
    const now = this.now();
    if (now - this.creations.start >= 60000)
      this.creations = { start: now, count: 0 };
    return ++this.creations.count <= this.limits.newIdentitiesPerMinute;
  }

  newMembership(): boolean {
    const now = this.now();
    if (now - this.memberships.start >= 60000)
      this.memberships = { start: now, count: 0 };
    return ++this.memberships.count <= this.limits.newMembershipsPerMinute;
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
