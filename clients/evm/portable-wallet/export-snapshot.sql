-- Export the whole public unspent set and its corresponding head in one MVCC statement.
-- Example: psql -XAt -v ON_ERROR_STOP=1 -d verified_replica -f export-snapshot.sql > snapshot.json
SELECT json_build_object(
  'version', 1,
  'chainId', '0x' || encode(chain_id, 'hex'),
  'genesisHash', '0x' || encode(genesis_hash, 'hex'),
  'height', '0x' || to_hex(height),
  'units', (SELECT json_agg(json_build_object(
    'id', '0x' || encode(id, 'hex'), 'suite', suite,
    'commitment', '0x' || encode(commitment, 'hex'), 'weight', '0x' || to_hex(weight::bigint)
  ) ORDER BY id) FROM p2party_ledger.units WHERE spent IS NULL)
)
FROM p2party_ledger.chain WHERE singleton;
