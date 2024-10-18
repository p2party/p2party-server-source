/*
  Warnings:

  - You are about to alter the column `lastPing` on the `peer` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_peer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastPing" BIGINT NOT NULL,
    "publicKey" TEXT
);
INSERT INTO "new_peer" ("createdAt", "id", "lastPing", "publicKey", "updatedAt") SELECT "createdAt", "id", "lastPing", "publicKey", "updatedAt" FROM "peer";
DROP TABLE "peer";
ALTER TABLE "new_peer" RENAME TO "peer";
CREATE UNIQUE INDEX "peer_publicKey_key" ON "peer"("publicKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
