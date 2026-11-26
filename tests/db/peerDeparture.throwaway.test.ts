import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";

import { releasePeer } from "../../src/pubsub";
import {
  createAnnounceOffline,
  createAnnounceRoomLeave,
  createRetireClosedSocket,
} from "../../src/utils/handlePeers";
import { provisionalPeerId } from "../../src/utils/peerIdentity";
import {
  describeWithThrowawayPostgres,
  freshDatabase,
  type ThrowawayDatabase,
} from "./throwawayPostgres";

import type { P2PartyWSClient } from "../../src/wsServer";

const WORKER_1 = "11111111-1111-4111-8111-111111111111";
const WORKER_2 = "22222222-2222-4222-8222-222222222222";

const member = () => {
  const publicKey = randomBytes(32).toString("hex");
  return { id: provisionalPeerId(publicKey), publicKey };
};

const socketOf = (
  peer: { id: string; publicKey: string },
  socketGeneration: string,
) => {
  const sent: string[] = [];
  const ws = {
    data: {
      peerId: peer.id,
      publicKey: peer.publicKey,
      isVerified: true,
      isAuthenticating: false,
      socketGeneration,
      challengeNonce: "",
      challengeId: "",
      isAlive: true,
    },
    readyState: 1,
    send: (frame: string) => {
      sent.push(frame);
      return 1;
    },
    close: () => {},
  } as unknown as P2PartyWSClient;
  return { ws, sent };
};

let database: ThrowawayDatabase | undefined;
afterEach(async () => {
  await database?.drop();
  database = undefined;
});

describeWithThrowawayPostgres(
  "departure announcements against PostgreSQL",
  () => {
    test("the membership reads reach online members only, and a successor's claim silences offline", async () => {
      database = await freshDatabase();
      const db = database;
      const leaver = member();
      const local = member();
      const remote = member();
      const offline = member();
      const leaverGeneration = randomUUID();
      const claims: [typeof leaver, string | null, string | null][] = [
        [leaver, WORKER_1, leaverGeneration],
        [local, WORKER_1, randomUUID()],
        [remote, WORKER_2, randomUUID()],
        [offline, null, null],
      ];
      for (const [peer, serverId, socketGeneration] of claims)
        await db.prisma.peer.create({
          data: { ...peer, lastPing: 0, serverId, socketGeneration },
        });
      const shared = await db.prisma.room.create({
        data: {
          identifier: randomBytes(64).toString("hex"),
          peers: {
            connect: [leaver, local, remote, offline].map(({ id }) => ({ id })),
          },
        },
      });
      const pair = await db.prisma.room.create({
        data: {
          identifier: randomBytes(64).toString("hex"),
          peers: { connect: [leaver, local].map(({ id }) => ({ id })) },
        },
      });

      const localSocket = socketOf(local, randomUUID());
      const leaverSocket = socketOf(leaver, leaverGeneration);
      const clients = new Map<string, P2PartyWSClient>([
        [local.id, localSocket.ws],
        [leaver.id, leaverSocket.ws],
      ]);
      const routed: { toPeerId: string; serverId: string; roomId: string }[] =
        [];
      const dependencies = {
        clients,
        sendToPeerOnServer: async (
          toPeerId: string,
          serverId: string,
          payload: string,
        ) => {
          routed.push({
            toPeerId,
            serverId,
            roomId: (JSON.parse(payload) as { roomId: string }).roomId,
          });
          return true;
        },
      };
      const roomsOf = (sent: string[]) =>
        sent.map((frame) => {
          const { type, roomId, peerId, reason } = JSON.parse(frame) as Record<
            string,
            string
          >;
          return { type, roomId, peerId, reason };
        });

      // A leave of the shared room: the online members, never the leaver.
      expect(
        await createAnnounceRoomLeave(db.prisma, dependencies)(
          shared.id,
          leaver.id,
          leaverGeneration,
        ),
      ).toBe(2);
      expect(roomsOf(localSocket.sent)).toEqual([
        {
          type: "peerLeft",
          roomId: shared.id,
          peerId: leaver.id,
          reason: "left",
        },
      ]);
      expect(routed).toEqual([
        { toPeerId: remote.id, serverId: WORKER_2, roomId: shared.id },
      ]);

      // The last socket closing: the real release clears the claim, then every
      // room the identity is in is told.
      localSocket.sent.length = 0;
      routed.length = 0;
      const retire = createRetireClosedSocket({
        clients,
        release: (peerId, socketGeneration) =>
          releasePeer(peerId, socketGeneration, db.prisma, WORKER_1),
        announceOffline: createAnnounceOffline(db.prisma, dependencies),
      });
      expect(await retire(leaverSocket.ws)).toBe(3);
      expect(
        roomsOf(localSocket.sent).sort((a, b) =>
          a.roomId.localeCompare(b.roomId),
        ),
      ).toEqual(
        [shared.id, pair.id].sort().map((roomId) => ({
          type: "peerLeft",
          roomId,
          peerId: leaver.id,
          reason: "offline",
        })),
      );
      expect(routed).toEqual([
        { toPeerId: remote.id, serverId: WORKER_2, roomId: shared.id },
      ]);
      expect(
        await db.prisma.peer.findUnique({
          where: { id: leaver.id },
          select: { serverId: true },
        }),
      ).toEqual({ serverId: null });

      // A successor committed on another worker before the membership read.
      localSocket.sent.length = 0;
      await db.prisma.peer.update({
        where: { id: leaver.id },
        data: { serverId: WORKER_2, socketGeneration: randomUUID() },
      });
      expect(
        await createAnnounceOffline(db.prisma, dependencies)(
          leaver.id,
          leaverGeneration,
        ),
      ).toBe(0);
      expect(localSocket.sent).toEqual([]);
    }, 60_000);
  },
);
