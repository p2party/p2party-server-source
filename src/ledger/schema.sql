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
  suite smallint NOT NULL CHECK (suite IN (1,2)),
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
  wire bytea NOT NULL CHECK (octet_length(wire) IN (5505,16516))
);

-- Existing validator databases receive a transactional application-side Keccak backfill.
ALTER TABLE p2party_ledger.units ADD COLUMN IF NOT EXISTS read_handle bytea
  CHECK (octet_length(read_handle)=20);
CREATE INDEX IF NOT EXISTS units_read_handle ON p2party_ledger.units (read_handle);
