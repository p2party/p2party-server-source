-- Re-key every identity to the peer id derived from its public key.
--
-- The server binds each socket to provisionalPeerId(publicKey) before the
-- signature verdict (src/utils/peerIdentity.ts), so no connection-time path
-- reads or rewrites a stored id. Servers before 0.1.4 stored random ids; this
-- statement rewrites them once, before the new server starts:
--
--   id = UUIDv4 shape of the first 16 bytes of
--        SHA-256("p2party/signaling/peer-id/v1" || 0x00 || key bytes)
--   with byte 6 = (byte 6 & 0x0f) | 0x40 and byte 8 = (byte 8 & 0x3f) | 0x80.
--
-- sha256(), decode(), set_byte() and get_byte() are built in (PostgreSQL 11
-- and later); no extension is needed.
--
-- One statement, so it is all or nothing, and it touches only rows whose id
-- differs, so running it again changes nothing.
--   * "_PeerRooms"."A" and "Challenge"."peerId" follow through ON UPDATE
--     CASCADE, inside this statement.
--   * "PendingSignal"."targetPeerId" has no foreign key; queued rows are
--     re-addressed to the new id in the same statement.
--   * The routing claim ("serverId") is a column of the row and moves with it.
--   * A row whose key is not 64 lowercase hex characters is deleted, with its
--     memberships: the upgrade handler admits no other key, so no client can
--     ever present it, and an uppercase twin of a lowercase key would derive
--     the same id.
-- After that, two rows cannot derive the same id: keys are unique and decode
-- to distinct 32-byte strings, so equal ids would be a SHA-256 collision, and
-- the primary key would reject the statement as a whole.
WITH "removed" AS (
    DELETE FROM "Peer"
    WHERE "publicKey" !~ '^[0-9a-f]{64}$'
    RETURNING "id"
), "hashed" AS (
    SELECT
        "id" AS "oldId",
        substring(
            sha256(
                convert_to('p2party/signaling/peer-id/v1', 'UTF8')
                || decode('00', 'hex')
                || decode("publicKey", 'hex')
            )
            FROM 1 FOR 16
        ) AS "digest"
    FROM "Peer"
    WHERE "publicKey" ~ '^[0-9a-f]{64}$'
), "changed" AS (
    SELECT "oldId", "newId"
    FROM (
        SELECT
            "oldId",
            encode(
                set_byte(
                    set_byte("digest", 6, (get_byte("digest", 6) & 15) | 64),
                    8,
                    (get_byte("digest", 8) & 63) | 128
                ),
                'hex'
            )::uuid AS "newId"
        FROM "hashed"
    ) AS "derived"
    WHERE "oldId" <> "newId"
), "readdressed" AS (
    UPDATE "PendingSignal" AS "signal"
    SET "targetPeerId" = "changed"."newId"
    FROM "changed"
    WHERE "signal"."targetPeerId" = "changed"."oldId"
    RETURNING "signal"."id"
)
UPDATE "Peer"
SET "id" = "changed"."newId"
FROM "changed"
WHERE "Peer"."id" = "changed"."oldId";
