#!/bin/sh
set -eu
: "${P2PARTY_NATIVE_BIN:?Set P2PARTY_NATIVE_BIN to the directory of built libdemos ledger tools}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
bun build tools/ordering/peer.mjs --target=node --format=esm --outfile="$dir/peer.mjs"
bun build tools/ordering/peer-network.test.mjs --target=node --format=esm --outfile="$dir/test.mjs"
P2PARTY_PEER_BUNDLE="$dir/peer.mjs" node --test "$dir/test.mjs"
