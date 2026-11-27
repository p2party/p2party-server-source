CREATE SCHEMA IF NOT EXISTS p2party_ledger;
CREATE TABLE IF NOT EXISTS p2party_ledger.chain (
  singleton boolean PRIMARY KEY CHECK (singleton),
  chain_id bytea NOT NULL CHECK (octet_length(chain_id)=32),
  genesis_hash bytea NOT NULL CHECK (octet_length(genesis_hash)=32),
  height bigint NOT NULL CHECK (height>=0)
);
CREATE TABLE IF NOT EXISTS p2party_ledger.units (
  id bytea PRIMARY KEY CHECK (octet_length(id)=64),
  weight numeric(20,0) NOT NULL CHECK (weight > 0 AND weight <= 9223372036854775808),
  suite smallint NOT NULL CONSTRAINT units_known_suite_v2 CHECK (suite IN (1,2,3,4)),
  commitment bytea UNIQUE NOT NULL CHECK (octet_length(commitment)=64),
  read_handle bytea NOT NULL CHECK (octet_length(read_handle)=20),
  created bigint NOT NULL CHECK (created>=0),
  spent bigint CHECK (spent>created)
);
CREATE TABLE IF NOT EXISTS p2party_ledger.transfers (
  height bigint PRIMARY KEY CHECK (height>0),
  id bytea UNIQUE NOT NULL CHECK (octet_length(id)=64),
  input_id bytea UNIQUE NOT NULL REFERENCES p2party_ledger.units(id),
  output_id bytea UNIQUE NOT NULL REFERENCES p2party_ledger.units(id),
  wire bytea NOT NULL CONSTRAINT transfers_known_size_v2 CHECK (octet_length(wire) IN (5505,16516,7463,30100))
);

-- An existing version-one database has PostgreSQL's generated constraint
-- names. Replace them once, inside initialize()'s locked transaction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='p2party_ledger.units'::regclass AND conname='units_suite_check') THEN
    ALTER TABLE p2party_ledger.units DROP CONSTRAINT units_suite_check,
      ADD CONSTRAINT units_known_suite_v2 CHECK (suite IN (1,2,3,4));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='p2party_ledger.transfers'::regclass AND conname='transfers_wire_check') THEN
    ALTER TABLE p2party_ledger.transfers DROP CONSTRAINT transfers_wire_check,
      ADD CONSTRAINT transfers_known_size_v2 CHECK (octet_length(wire) IN (5505,16516,7463,30100));
  END IF;
END $$;

-- Existing validator databases receive a transactional application-side Keccak backfill.
ALTER TABLE p2party_ledger.units ADD COLUMN IF NOT EXISTS read_handle bytea
  CHECK (octet_length(read_handle)=20);
CREATE INDEX IF NOT EXISTS units_read_handle ON p2party_ledger.units (read_handle);
