#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE LOBBY AND FREE PLAY, IN A REAL BROWSER (M3.3-34). A fresh regtest
# bitcoind and nothing else: no Lightning, no federation, no wallet. The
# Daily's 2-of-2 is stood up on it with its bonds, census and published round,
# stake 0, and the tool keeps a free round joinable; lobby-page.mjs opens the
# built page on the LOBBY link (no round named) and plays.
#
#   BUILD=<built webgl dir> bash tools/lobby-regtest.sh
set -uo pipefail
: "${BUILD:?}"
P=${PROBE_DIR:-$(mktemp -d /tmp/lobby-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
RPC=30201
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$P/btc"
bcn() { "$B/bitcoin-cli" -regtest -datadir="$P/btc" -rpcport=$RPC "$@"; }
stop() { bcn stop >/dev/null 2>&1; sleep 3; pkill -f -- "-datadir=$P/btc" 2>/dev/null; }
trap stop EXIT
"$B/bitcoind" -regtest -datadir="$P/btc" -rpcport=$RPC -port=30202 -listen=0 -listenonion=0 \
  -fallbackfee=0.0001 -txindex -daemon >/dev/null
for i in $(seq 1 60); do bcn getblockcount >/dev/null 2>&1 && break; sleep 1; done
bcn getblockcount >/dev/null || { echo "bitcoind did not come up"; exit 1; }
echo "bitcoind up, datadir $P/btc"
# No ARENA_LND* in the environment: these daemons reach no Lightning.
env -u ARENA_LND -u ARENA_LND_MACAROON -u ARENA_LND_CERT -u ARENA_LND_READONLY \
  RT="$P/btc" RPCPORT=$RPC PROBE="$P" BUILD="$BUILD" BITCOIN_CLI="$B/bitcoin-cli" \
  node "$HERE/lobby-page.mjs" > "$P/lobby.log" 2>&1
code=$?
grep -E '^\{' "$P/lobby.log" | sed 's/^/LOBBY /'
echo "lobby exit $code; log: $P/lobby.log; screens in $P"
exit $code
