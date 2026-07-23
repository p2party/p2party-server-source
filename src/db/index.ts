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
  peer?: Peer;
};

export type Peer = {
  id: string;
  publicKey: string;
  lastPing: number;
  createdAt: string;
  updatedAt: string;
  challenges?: Challenge[];
};

export type Room = {
  id: string;
  identifier: string;
  createdAt: string;
  updatedAt: string;
  peers?: Peer[];
};

const dbPath = resolve(process.cwd(), process.env.DATABASE_URL ?? "dev.db");
const isNew = !existsSync(dbPath);
const sqlite = new Database(dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");

if (isNew) {
  const schema = readFileSync("src/db/schema.sqlite.sql", "utf8");
  console.log(schema);
  sqlite.exec(schema);
}

export const db = {
  disconnect: () => {
    sqlite.close();
  },

  room: {
    create: ({
      data,
    }: {
      data: {
        id?: string;
        identifier: string;
        peers?: { connect: { id: string } };
      };
    }) => {
      const id = data.id ?? crypto.randomUUID();
      sqlite
        .query(
          `INSERT INTO room (id, createdAt, updatedAt, identifier)
        VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        )
        .run(id, data.identifier);

      if (data.peers?.connect?.id) {
        sqlite
          .query(`INSERT OR IGNORE INTO _RoomToPeer (A, B) VALUES (?, ?)`)
          .run(id, data.peers.connect.id);
      }

      return db.room.findUnique({ where: { id }, include: { peers: true } });
    },

    update: ({
      where,
      data,
    }: {
      where: { id?: string; identifier?: string };
      data: { peers?: { connect: { id: string } } };
    }) => {
      const field = where.id ? "id" : "identifier";
      const value = where.id ?? where.identifier ?? "";
      if (!value)
        throw new Error("Room where clause must include id or identifier");

      const result = sqlite
        .query(`SELECT id FROM room WHERE ${field} = ? LIMIT 1`)
        .get(value) as Room;
      const roomId = result?.id;
      if (!roomId) throw new Error("Room not found");

      if (data.peers?.connect?.id) {
        sqlite
          .query(`INSERT OR IGNORE INTO _RoomToPeer (A, B) VALUES (?, ?)`)
          .run(roomId, data.peers.connect.id);
      }

      return db.room.findUnique({
        where: { id: roomId },
        include: { peers: true },
      });
    },

    findUnique: ({
      where,
      include,
    }: {
      where: { id?: string; identifier?: string };
      include?: { peers?: true | { include?: { challenges?: true } } };
    }) => {
      const field = where.id ? "id" : "identifier";
      const value = where.id ?? where.identifier ?? "";
      if (!value) return null;

      const room = sqlite
        .query(`SELECT * FROM room WHERE ${field} = ? LIMIT 1`)
        .get(value) as Room;
      if (!room) return null;

      if (include?.peers) {
        const peers = sqlite
          .query(
            `SELECT peer.* FROM peer
          JOIN _RoomToPeer ON _RoomToPeer.B = peer.id
          WHERE _RoomToPeer.A = ?`,
          )
          .all(room.id) as Peer[];

        const includeChallenges =
          typeof include.peers === "object" &&
          include.peers.include?.challenges;
        if (includeChallenges) {
          for (const peer of peers) {
            peer.challenges = sqlite
              .query(`SELECT * FROM challenge WHERE peerId = ?`)
              .all(peer.id) as Challenge[];
          }
        }

        room.peers = peers;
      }

      return room;
    },
  },

  peer: {
    create: ({
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
      sqlite
        .query(
          `INSERT INTO peer (id, createdAt, updatedAt, lastPing, publicKey)
        VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
      `,
        )
        .run(id, data.lastPing, data.publicKey);

      if (data.challenges?.create) {
        const challengeId = crypto.randomUUID();
        sqlite
          .query(
            `INSERT INTO challenge (id, createdAt, updatedAt, nonce, peerId)
          VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
          )
          .run(challengeId, data.challenges.create.nonce, id);
      }

      return db.peer.findUnique({
        where: { id },
        include: { challenges: true },
      });
    },

    findUnique: ({
      where,
      include,
    }: {
      where: { id?: string; publicKey?: string };
      include?: { challenges?: boolean };
    }) => {
      const field = where.id ? "id" : "publicKey";
      const value = where.id ?? where.publicKey ?? "";
      if (!value) return null;

      const peer = sqlite
        .query(`SELECT * FROM peer WHERE ${field} = ? LIMIT 1`)
        .get(value) as Peer;
      if (!peer) return null;

      if (include?.challenges) {
        peer.challenges = sqlite
          .query(`SELECT * FROM challenge WHERE peerId = ?`)
          .all(peer.id) as Challenge[];
      }

      return peer;
    },
  },

  challenge: {
    update: ({
      where,
      data,
    }: {
      where: { id?: string; nonce?: string };
      data: { signature: string };
    }) => {
      const field = where.id ? "id" : "nonce";
      const value = where.id ?? where.nonce;
      if (!value)
        throw new Error("Challenge where clause must include id or nonce");

      sqlite
        .query(
          `UPDATE challenge SET signature = ?, updatedAt = CURRENT_TIMESTAMP WHERE ${field} = ?`,
        )
        .run(data.signature, value);

      return (
        (sqlite
          .query(`SELECT * FROM challenge WHERE ${field} = ? LIMIT 1`)
          .get(value) as Challenge) ?? null
      );
    },

    findUnique: ({
      where,
      include,
    }: {
      where: { id?: string; nonce?: string };
      include?: { peer?: boolean };
    }) => {
      const field = where.id ? "id" : "nonce";
      const value = where.id ?? where.nonce;
      if (!value) return null;

      const challenge = sqlite
        .query(`SELECT * FROM challenge WHERE ${field} = ? LIMIT 1`)
        .get(value) as Challenge;
      if (!challenge) return null;

      if (include?.peer) {
        challenge.peer = sqlite
          .query(`SELECT * FROM peer WHERE id = ? LIMIT 1`)
          .get(challenge.peerId) as Peer;
      }

      return challenge;
    },
  },
};
