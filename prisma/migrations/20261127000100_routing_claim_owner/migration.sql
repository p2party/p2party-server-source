-- The routing claim's owner token: Peer.serverId names the instance and
-- Peer.socketGeneration the socket. A release or restore compares both, so a
-- late release from a replaced socket cannot clear its successor's claim.
--
-- An instance that loses a claim to another instance is told to close the
-- replaced socket through the same queue as relayed frames.
--
-- Prisma does not run a migration in a transaction, so a failure between
-- these two statements leaves the first applied. Each adds its column only if
-- it is missing, so after `prisma migrate resolve --rolled-back` the migration
-- runs again cleanly.

-- AlterTable
ALTER TABLE "Peer" ADD COLUMN IF NOT EXISTS "socketGeneration" VARCHAR(36);

-- AlterTable
ALTER TABLE "PendingSignal" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(16) NOT NULL DEFAULT 'frame';
