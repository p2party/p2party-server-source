-- AlterTable
ALTER TABLE "Peer" ADD COLUMN     "serverId" VARCHAR(36);

-- CreateTable
CREATE TABLE "PendingSignal" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetServerId" VARCHAR(36) NOT NULL,
    "targetPeerId" UUID NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "PendingSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingSignal_targetServerId_idx" ON "PendingSignal"("targetServerId");

-- CreateIndex
CREATE INDEX "Peer_serverId_idx" ON "Peer"("serverId");
