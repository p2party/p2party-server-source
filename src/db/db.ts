import { sql } from "bun";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

export type Challenge = {
  id: string;
  nonce: string;
  signature: string | null;
  peerId: string;
  createdAt: string;
  updatedAt: string;
  peer: Peer;
};

export type Peer = {
  id: string;
  publicKey: string;
  lastPing: number;
  createdAt: string;
  updatedAt: string;
  challenges: Challenge[];
};

export type Room = {
  id: string;
  identifier: string;
  createdAt: string;
  updatedAt: string;
  peers: Peer[];
};

// Setup
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("Missing DATABASE_URL");

const isSQLite = dbUrl.startsWith("sqlite:");
// const isPostgres = dbUrl.startsWith("postgres://");

let sqlite: Database | null = null;

if (isSQLite) {
  const dbPath = resolve(process.cwd(), dbUrl.replace("sqlite:", ""));
  const isNew = !existsSync(dbPath);
  sqlite = new Database(dbPath, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  if (isNew) {
    const schema = readFileSync("src/db/schema.sqlite.sql", "utf8");
    const query = sqlite.query(`${schema}`);
    query.run();
    // sqlite.exec(schema);
  }
}

// Prisma-like API
export const db = {
  disconnect: async () => {
    if (!isSQLite) {
      await sql.end();
    } else {
      sqlite?.close();
    }
  },

  room: {
    create: async ({
      data,
    }: {
      data: {
        id?: string;
        identifier: string;
        peers?: {
          connect: {
            id: string;
          };
        };
      };
    }) => {
      const id = data.id ?? crypto.randomUUID();

      const insertRoom = isSQLite
        ? `INSERT INTO room (id, createdAt, updatedAt, identifier)
           VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`
        : `INSERT INTO room (id, createdAt, updatedAt, identifier)
           VALUES ($1, now(), now(), $2)`;

      if (isSQLite) {
        sqlite!.query(insertRoom).run(id, data.identifier);
      } else {
        await sql(insertRoom, id, data.identifier);
      }

      if (data.peers?.connect?.id) {
        const insertJoin = isSQLite
          ? `INSERT OR IGNORE INTO _RoomToPeer (A, B) VALUES (?, ?)`
          : `INSERT INTO _RoomToPeer (A, B) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`;

        if (isSQLite) {
          sqlite!.query(insertJoin).run(id, data.peers.connect.id);
        } else {
          await sql(insertJoin, id, data.peers.connect.id);
        }
      }

      return await db.room.findUnique({
        where: { id },
        include: { peers: true },
      });
    },

    update: async ({
      where,
      data,
    }: {
      where: { id?: string; identifier?: string };
      data: {
        peers?: {
          connect: {
            id: string;
          };
        };
      };
    }) => {
      const field = where.id ? "id" : "identifier";
      const value = where.id ?? where.identifier ?? "";

      // Get room ID
      let roomId: string | undefined = where.id;

      if (!roomId) {
        const query = isSQLite
          ? `SELECT id FROM room WHERE ${field} = ? LIMIT 1`
          : `SELECT id FROM room WHERE ${field} = $1 LIMIT 1`;

        if (isSQLite) {
          const result = sqlite!.query(query).get(value) as Room;
          roomId = result?.id;
        } else {
          const [result] = await sql(query, value);
          roomId = result?.id;
        }
      }

      if (!roomId) throw new Error("Room not found");

      // Insert into join table
      if (data.peers?.connect?.id) {
        const insert = isSQLite
          ? `INSERT OR IGNORE INTO _RoomToPeer (A, B) VALUES (?, ?)`
          : `INSERT INTO _RoomToPeer (A, B) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`;

        if (isSQLite) {
          sqlite!.query(insert).run(roomId, data.peers.connect.id);
        } else {
          await sql(insert, roomId, data.peers.connect.id);
        }
      }

      return await db.room.findUnique({
        where: { id: roomId },
        include: { peers: true },
      });
    },

    findUnique: async ({
      where,
      include,
    }: {
      where: { id?: string; identifier?: string };
      include?: {
        peers?:
          | true
          | {
              include?: {
                challenges?: true;
              };
            };
      };
    }) => {
      const field = where.id ? "id" : "identifier";
      const value = where.id ?? where.identifier ?? "";

      const roomQuery = isSQLite
        ? `SELECT * FROM room WHERE ${field} = ? LIMIT 1`
        : `SELECT * FROM room WHERE ${field} = $1 LIMIT 1`;
      const room: Room = isSQLite
        ? sqlite!.query(roomQuery).get(value)
        : (await sql(roomQuery, where.id))[0];
      if (!room) return null;

      if (include?.peers) {
        const peerQuery = isSQLite
          ? `SELECT peer.* FROM peer
           JOIN _RoomToPeer ON _RoomToPeer.B = peer.id
           WHERE _RoomToPeer.A = ?`
          : `SELECT peer.* FROM peer
           JOIN _RoomToPeer ON _RoomToPeer.B = peer.id
           WHERE _RoomToPeer.A = $1`;

        const peers: Peer[] = isSQLite
          ? sqlite!.query(peerQuery).all(room.id)
          : await sql(peerQuery, room.id);

        const includeChallenges =
          typeof include.peers === "object" &&
          include.peers.include?.challenges === true;

        if (includeChallenges) {
          for (const peer of peers) {
            const challengesQuery = isSQLite
              ? `SELECT * FROM challenge WHERE peerId = ?`
              : `SELECT * FROM challenge WHERE peerId = $1`;

            peer.challenges = isSQLite
              ? sqlite!.query(challengesQuery).all(peer.id)
              : await sql(challengesQuery, peer.id);
          }
        }

        room.peers = peers;
      }

      return room;
    },
  },

  peer: {
    create: async ({
      data,
    }: {
      data: {
        id?: string;
        lastPing: number;
        publicKey: string;
        challenges?: { create: { nonce: string } };
      };
    }) => {
      const id = data.id ?? crypto.randomUUID();

      const insertPeer = isSQLite
        ? `INSERT INTO peer (id, createdAt, updatedAt, lastPing, publicKey)
           VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`
        : `INSERT INTO peer (id, createdAt, updatedAt, lastPing, publicKey)
           VALUES ($1, now(), now(), $2, $3)`;

      if (isSQLite) {
        sqlite!.query(insertPeer).run(id, data.lastPing, data.publicKey);
      } else {
        await sql(insertPeer, id, data.lastPing, data.publicKey);
      }

      if (data.challenges?.create) {
        const { nonce } = data.challenges.create;
        const challengeId = crypto.randomUUID();

        const insertChallenge = isSQLite
          ? `INSERT INTO challenge (id, createdAt, updatedAt, nonce, peerId)
             VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`
          : `INSERT INTO challenge (id, createdAt, updatedAt, nonce, peerId)
             VALUES ($1, now(), now(), $2, $3)`;

        if (isSQLite) {
          sqlite!.query(insertChallenge).run(challengeId, nonce, id);
        } else {
          await sql(insertChallenge, challengeId, nonce, id);
        }
      }

      return await db.peer.findUnique({
        where: { id },
        include: { challenges: true },
      });
    },

    findUnique: async ({
      where,
      include,
    }: {
      where: { id?: string; publicKey?: string };
      include?: { challenges?: boolean };
    }) => {
      const field = where.id ? "id" : "publicKey";
      const value = where.id ?? where.publicKey ?? "";

      const peerQuery = isSQLite
        ? `SELECT * FROM peer WHERE ${field} = ? LIMIT 1`
        : `SELECT * FROM peer WHERE ${field} = $1 LIMIT 1`;

      const peer: Peer = isSQLite
        ? sqlite!.query(peerQuery).get(value)
        : (await sql(peerQuery, value))[0];

      if (!peer) return null;

      if (include?.challenges) {
        const challengesQuery = isSQLite
          ? `SELECT * FROM challenge WHERE peerId = ?`
          : `SELECT * FROM challenge WHERE peerId = $1`;

        const challenges: Challenge[] = isSQLite
          ? sqlite!.query(challengesQuery).all(peer.id)
          : await sql(challengesQuery, peer.id);

        peer.challenges = challenges;
      }

      return peer;
    },
  },

  challenge: {
    update: async ({
      where,
      data,
    }: {
      where: { id?: string; nonce?: string };
      data: { signature: string };
    }) => {
      const field = where.id ? "id" : "nonce";
      const value = where.id ?? where.nonce ?? "";

      const updateQuery = isSQLite
        ? `UPDATE challenge SET signature = ?, updatedAt = CURRENT_TIMESTAMP WHERE ${field} = ?`
        : `UPDATE challenge SET signature = $1, updatedAt = now() WHERE ${field} = $2`;

      if (isSQLite) {
        sqlite!.query(updateQuery).run(data.signature, value);
      } else {
        await sql(updateQuery, data.signature, value);
      }

      // Return the updated challenge
      const selectQuery = isSQLite
        ? `SELECT * FROM challenge WHERE ${field} = ? LIMIT 1`
        : `SELECT * FROM challenge WHERE ${field} = $1 LIMIT 1`;

      return isSQLite
        ? sqlite!.query(selectQuery).get(value)
        : ((await sql(selectQuery, value))[0] ?? null);
    },

    findUnique: async ({
      where,
      include,
    }: {
      where: { id?: string; nonce?: string };
      include?: { peer?: boolean };
    }) => {
      const field = where.id ? "id" : "nonce";
      const value = where.id ?? where.nonce ?? "";

      const challengeQuery = isSQLite
        ? `SELECT * FROM challenge WHERE ${field} = ? LIMIT 1`
        : `SELECT * FROM challenge WHERE ${field} = $1 LIMIT 1`;

      const challenge: Challenge = isSQLite
        ? sqlite!.query(challengeQuery).get(value)
        : (await sql(challengeQuery, value))[0];

      if (!challenge) return null;

      if (include?.peer) {
        const peerQuery = isSQLite
          ? `SELECT * FROM peer WHERE id = ? LIMIT 1`
          : `SELECT * FROM peer WHERE id = $1 LIMIT 1`;

        const peer: Peer = isSQLite
          ? sqlite!.query(peerQuery).get(challenge.peerId)
          : (await sql(peerQuery, challenge.peerId))[0];

        challenge.peer = peer;
      }

      return challenge;
    },
  },
};
