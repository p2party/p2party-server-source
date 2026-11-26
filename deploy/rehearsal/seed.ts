/**
 * Rows the rehearsal writes into release 0.1.4's database, and what this
 * release's migrations must make of them.
 *
 *   bun seed.ts sql            the INSERTs, for the 0.1.4 schema
 *   bun seed.ts dump-sql       a query printing the rows as one JSON value
 *   bun seed.ts check <json>   compare such a dump with the expected result
 *
 * Every table of the 0.1.4 schema gets rows: Peer, Room, _PeerRooms,
 * Challenge, PendingSignal (_prisma_migrations is written by Prisma). Peer ids
 * are random-style ids, as 0.1.4 stored them. The expected result is written
 * from the documented derivation (the migration's header and
 * src/utils/peerIdentity.ts), computed here independently of both:
 *   - every peer whose key is 64 lowercase hex characters gets the derived id,
 *     and its memberships, challenges and queued signals follow it;
 *   - a peer with any other key is deleted with its memberships and
 *     challenges; a signal queued for it keeps the old id (no foreign key);
 *   - the routing claim (serverId) stays with the row;
 *   - Peer.socketGeneration is added empty, PendingSignal.kind as 'frame'.
 * The server may later change claims and queued signals at run time; `check`
 * reports those separately from the migration's own effects.
 */
import { createHash } from "node:crypto";

const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const SEED_WORKER = "rehearsal-seed-worker";

interface SeedPeer {
  label: string;
  id: string;
  publicKey: string;
  serverId: string | null;
}

export const PEERS: SeedPeer[] = [
  {
    label: "alpha",
    id: "a0000000-0000-4000-8000-000000000001",
    publicKey: sha256Hex("p2party rehearsal alpha"),
    serverId: SEED_WORKER,
  },
  {
    label: "bravo",
    id: "a0000000-0000-4000-8000-000000000002",
    publicKey: sha256Hex("p2party rehearsal bravo"),
    serverId: null,
  },
  {
    label: "charlie",
    id: "a0000000-0000-4000-8000-000000000003",
    publicKey: sha256Hex("p2party rehearsal charlie"),
    serverId: null,
  },
  {
    // Upper-case hex: no client can present it; the re-key deletes it.
    label: "delta",
    id: "a0000000-0000-4000-8000-000000000004",
    publicKey: sha256Hex("p2party rehearsal delta").toUpperCase(),
    serverId: null,
  },
];

export const ROOMS = [
  {
    id: "b0000000-0000-4000-8000-000000000001",
    identifier: "rehearsal-room-occupied",
    members: ["alpha", "bravo", "delta"],
  },
  {
    id: "b0000000-0000-4000-8000-000000000002",
    identifier: "rehearsal-room-empty",
    members: [] as string[],
  },
];

export const CHALLENGES = [
  {
    id: "c0000000-0000-4000-8000-000000000001",
    nonce: sha256Hex("p2party rehearsal nonce alpha"),
    peer: "alpha",
  },
  {
    id: "c0000000-0000-4000-8000-000000000004",
    nonce: sha256Hex("p2party rehearsal nonce delta"),
    peer: "delta",
  },
];

export const SIGNALS = [
  {
    id: "d0000000-0000-4000-8000-000000000002",
    peer: "bravo",
    payload: "rehearsal: queued for bravo",
  },
  {
    id: "d0000000-0000-4000-8000-000000000004",
    peer: "delta",
    payload: "rehearsal: queued for delta",
  },
];

const peer = (label: string): SeedPeer => {
  const found = PEERS.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`no seed peer ${label}`);
  return found;
};

/** The documented derivation, written independently of the server's code. */
export function derivedPeerId(publicKey: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from("p2party/signaling/peer-id/v1", "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(publicKey, "hex"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

const rekeyed = (seed: SeedPeer) => /^[0-9a-f]{64}$/.test(seed.publicKey);
const idAfter = (seed: SeedPeer) =>
  rekeyed(seed) ? derivedPeerId(seed.publicKey) : null;

const quote = (value: string | null) =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

export function seedSql(): string {
  const now = "CURRENT_TIMESTAMP";
  const lines = ["BEGIN;"];
  for (const seed of PEERS) {
    lines.push(
      `INSERT INTO "Peer" ("id", "createdAt", "updatedAt", "lastPing", "publicKey", "serverId") VALUES (${quote(seed.id)}, ${now}, ${now}, (extract(epoch FROM clock_timestamp()) * 1000)::bigint, ${quote(seed.publicKey)}, ${quote(seed.serverId)});`,
    );
  }
  for (const room of ROOMS) {
    lines.push(
      `INSERT INTO "Room" ("id", "createdAt", "updatedAt", "identifier") VALUES (${quote(room.id)}, ${now}, ${now}, ${quote(room.identifier)});`,
    );
    for (const member of room.members) {
      lines.push(
        `INSERT INTO "_PeerRooms" ("A", "B") VALUES (${quote(peer(member).id)}, ${quote(room.id)});`,
      );
    }
  }
  for (const challenge of CHALLENGES) {
    lines.push(
      `INSERT INTO "Challenge" ("id", "createdAt", "updatedAt", "nonce", "signature", "peerId") VALUES (${quote(challenge.id)}, ${now}, ${now}, ${quote(challenge.nonce)}, NULL, ${quote(peer(challenge.peer).id)});`,
    );
  }
  for (const signal of SIGNALS) {
    lines.push(
      `INSERT INTO "PendingSignal" ("id", "createdAt", "targetServerId", "targetPeerId", "payload") VALUES (${quote(signal.id)}, ${now}, ${quote(SEED_WORKER)}, ${quote(peer(signal.peer).id)}, ${quote(signal.payload)});`,
    );
  }
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

/** One JSON value with every seeded table, whatever columns it has now. */
export const DUMP_SQL = `SELECT json_build_object(
  'peers', (SELECT coalesce(jsonb_agg(to_jsonb(p) - 'createdAt' - 'updatedAt' - 'lastPing' ORDER BY p."publicKey"), '[]') FROM "Peer" p),
  'rooms', (SELECT coalesce(jsonb_agg(jsonb_build_object('identifier', r.identifier, 'members', (SELECT coalesce(jsonb_agg(m."A" ORDER BY m."A"), '[]') FROM "_PeerRooms" m WHERE m."B" = r.id)) ORDER BY r.identifier), '[]') FROM "Room" r),
  'challenges', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'peerId', c."peerId") ORDER BY c.id), '[]') FROM "Challenge" c),
  'pending', (SELECT coalesce(jsonb_agg(to_jsonb(s) - 'createdAt' ORDER BY s.id), '[]') FROM "PendingSignal" s)
);`;

interface Dump {
  peers: Record<string, unknown>[];
  rooms: { identifier: string; members: string[] }[];
  challenges: { id: string; peerId: string }[];
  pending: Record<string, unknown>[];
}

/** Lines "ok|differs|runtime: ..." comparing a dump with the expectation. */
export function checkDump(dump: Dump): { lines: string[]; failed: boolean } {
  const lines: string[] = [];
  let failed = false;
  const report = (ok: boolean, text: string) => {
    lines.push(`${ok ? "ok     " : "DIFFERS"} ${text}`);
    if (!ok) failed = true;
  };
  const runtime = (text: string) => lines.push(`runtime ${text}`);

  for (const seed of PEERS) {
    const row = dump.peers.find((p) => p.publicKey === seed.publicKey);
    const expected = idAfter(seed);
    if (expected === null) {
      report(row === undefined, `peer ${seed.label} (non-hex key) is deleted`);
      continue;
    }
    report(
      row?.id === expected,
      `peer ${seed.label}: id ${String(row?.id)} is the derived id ${expected}`,
    );
    if (row && "socketGeneration" in row) {
      report(
        row.socketGeneration === null,
        `peer ${seed.label}: socketGeneration added empty`,
      );
    } else {
      report(false, `peer ${seed.label}: has the socketGeneration column`);
    }
    if (row && row.serverId !== seed.serverId) {
      runtime(
        `peer ${seed.label}: routing claim ${String(seed.serverId)} -> ${String(row.serverId)} (changed after the migration, by a server)`,
      );
    } else if (row) {
      lines.push(
        `ok      peer ${seed.label}: routing claim ${String(seed.serverId)} kept`,
      );
    }
  }
  report(
    dump.peers.length === PEERS.filter(rekeyed).length,
    `${String(dump.peers.length)} peer rows (expected ${String(PEERS.filter(rekeyed).length)})`,
  );

  for (const room of ROOMS) {
    const row = dump.rooms.find((r) => r.identifier === room.identifier);
    const expected = room.members
      .map((label) => idAfter(peer(label)))
      .filter((id): id is string => id !== null)
      .sort();
    report(
      row !== undefined &&
        JSON.stringify([...row.members].sort()) === JSON.stringify(expected),
      `room ${room.identifier}: members ${JSON.stringify(row?.members ?? null)} = ${JSON.stringify(expected)}`,
    );
  }

  for (const challenge of CHALLENGES) {
    const row = dump.challenges.find((c) => c.id === challenge.id);
    const expected = idAfter(peer(challenge.peer));
    report(
      expected === null ? row === undefined : row?.peerId === expected,
      expected === null
        ? `challenge of ${challenge.peer} deleted with its peer`
        : `challenge of ${challenge.peer} follows to ${expected}`,
    );
  }

  for (const signal of SIGNALS) {
    const row = dump.pending.find((s) => s.id === signal.id);
    const seed = peer(signal.peer);
    const expected = idAfter(seed) ?? seed.id;
    if (row === undefined) {
      runtime(`signal for ${signal.peer}: removed (not by the migration)`);
      continue;
    }
    report(
      row.targetPeerId === expected,
      `signal for ${signal.peer}: targetPeerId ${String(row.targetPeerId)} = ${expected}`,
    );
    report(row.kind === "frame", `signal for ${signal.peer}: kind 'frame'`);
  }
  return { lines, failed };
}

if (import.meta.main) {
  const [command, dumpPath] = process.argv.slice(2);
  if (command === "sql") {
    process.stdout.write(seedSql());
  } else if (command === "dump-sql") {
    process.stdout.write(`${DUMP_SQL}\n`);
  } else if (command === "check" && dumpPath !== undefined) {
    const text = (await Bun.file(dumpPath).text()).trim();
    const { lines, failed } = checkDump(JSON.parse(text) as Dump);
    console.log(lines.join("\n"));
    process.exit(failed ? 1 : 0);
  } else {
    console.error("usage: bun seed.ts sql | dump-sql | check <dump.json>");
    process.exit(2);
  }
}
