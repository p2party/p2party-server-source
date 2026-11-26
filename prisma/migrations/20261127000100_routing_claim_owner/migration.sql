-- The routing claim's owner token: Peer.serverId names the instance and
-- Peer.socketGeneration the socket. A release or restore compares both, so a
-- late release from a replaced socket cannot clear its successor's claim.
-- AlterTable
ALTER TABLE "Peer" ADD COLUMN     "socketGeneration" VARCHAR(36);

-- An instance that loses a claim to another instance is told to close the
-- replaced socket through the same queue as relayed frames.
-- AlterTable
ALTER TABLE "PendingSignal" ADD COLUMN     "kind" VARCHAR(16) NOT NULL DEFAULT 'frame';
