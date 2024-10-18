-- CreateTable
CREATE TABLE "room" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "identifier" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "peer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastPing" INTEGER NOT NULL,
    "publicKey" TEXT
);

-- CreateTable
CREATE TABLE "room_peer" (
    "roomId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,

    PRIMARY KEY ("roomId", "peerId"),
    CONSTRAINT "room_peer_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "room" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "room_peer_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "peer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "challenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "nonce" TEXT NOT NULL,
    "signature" TEXT,
    "peerId" TEXT NOT NULL,
    CONSTRAINT "challenge_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "peer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "room_identifier_key" ON "room"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "peer_publicKey_key" ON "peer"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_nonce_key" ON "challenge"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_signature_key" ON "challenge"("signature");
