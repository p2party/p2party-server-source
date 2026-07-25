-- CreateTable
CREATE TABLE "Peer" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastPing" BIGINT NOT NULL,
    "publicKey" TEXT NOT NULL,

    CONSTRAINT "Peer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "identifier" VARCHAR(128) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Challenge" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nonce" VARCHAR(64) NOT NULL,
    "signature" TEXT,
    "peerId" UUID NOT NULL,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PeerRooms" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_PeerRooms_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Peer_publicKey_key" ON "Peer"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "Room_identifier_key" ON "Room"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Challenge_nonce_key" ON "Challenge"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "Challenge_signature_key" ON "Challenge"("signature");

-- CreateIndex
CREATE INDEX "_PeerRooms_B_index" ON "_PeerRooms"("B");

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "Peer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PeerRooms" ADD CONSTRAINT "_PeerRooms_A_fkey" FOREIGN KEY ("A") REFERENCES "Peer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PeerRooms" ADD CONSTRAINT "_PeerRooms_B_fkey" FOREIGN KEY ("B") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
