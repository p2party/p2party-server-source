/*
  Warnings:

  - You are about to drop the `room_peer` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "room_peer";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "_PeerToRoom" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_PeerToRoom_A_fkey" FOREIGN KEY ("A") REFERENCES "peer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PeerToRoom_B_fkey" FOREIGN KEY ("B") REFERENCES "room" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "_PeerToRoom_AB_unique" ON "_PeerToRoom"("A", "B");

-- CreateIndex
CREATE INDEX "_PeerToRoom_B_index" ON "_PeerToRoom"("B");
