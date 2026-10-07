#!/bin/bash
# A MARKET IN THE LIVE PAGE (kanban #206 slice 2): a fresh regtest bitcoind and market-live-stack.mjs - the bonded 2-of-2,
# a free market round of "btc-close", the page at 127.0.0.1:29600. No Lightning, no federation.
#   BUILD=<page dir> bash tools/market-live.sh
set -uo pipefail
: "${BUILD:?}"
P=${PROBE_DIR:-$(mktemp -d /tmp/market-live-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
RPC=${RPC:-30201}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$P/btc"
bcn() { "$B/bitcoin-cli" -regtest -datadir="$P/btc" -rpcport=$RPC "$@"; }
stop() { bcn stop >/dev/null 2>&1; sleep 3; pkill -f -- "-datadir=$P/btc" 2>/dev/null; }
trap stop EXIT
"$B/bitcoind" -regtest -datadir="$P/btc" -rpcport=$RPC -port=$((RPC+1)) -listen=0 -listenonion=0 -fallbackfee=0.0001 -txindex -daemon >/dev/null
for i in $(seq 1 60); do bcn getblockcount >/dev/null 2>&1 && break; sleep 1; done
echo "bitcoind up, datadir $P/btc"
env -u BLWP_LND -u BLWP_LND_MACAROON -u BLWP_LND_CERT -u BLWP_LND_READONLY \
  RT="$P/btc" RPCPORT=$RPC BUILD="$BUILD" BITCOIN_CLI="$B/bitcoin-cli" node "$HERE/market-live-stack.mjs"
