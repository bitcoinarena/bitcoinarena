#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md REHEARSAL 26, A SUCCESSION FOUNDED BY NOTICE ON REGTEST (§23A.2 + §23A.6 step 1, kanban #326): a private bitcoind with
# cookie auth (as a node reads its chain), then tools/rehearsal-26.mjs - five arena nodes that start every fedimintd themselves (setup
# mode, then a guardian-next beside a running guardian), an old federation of four founded, a departure notice, and its successor
# founded with three seated first and one drawn. Heavy (up to 8 fedimintd): the test host load rule applies. Never testnet4.
#   FEDIMINT_BIN=<fork bin dir> FEDIMINT_HOME=<home> BITCOIN_BIN=<bitcoind dir> bash tools/rehearsal-26-regtest.sh
# Ports: bitcoind 30101/30102, nodes 20110..20150, their guardians +1000..+4000, the guardians-next +5000..+8000 (25110..28130).
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1800}
if [ -z "${R26_WRAPPED:-}" ]; then export R26_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/r26-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
RPC=30101
BTC_ARGS="-datadir=$P/btc -regtest -rpcport=$RPC"
bcn() { $B/bitcoin-cli $BTC_ARGS "$@"; }
mkdir -p $P/btc $FH; : > $P/pids
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM $pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL $pid 2>/dev/null; done
}
trap stop EXIT
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; echo "GAVE UP waiting for $what"; exit 1; }
t0=$(date +%s)
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -port=30102 -listen=0 -listenonion=0 -fallbackfee=0.0001 -txindex -daemon >/dev/null
until_ bitcoind 60 bcn getblockcount
bcn createwallet probe >/dev/null
bcn -rpcwallet=probe generatetoaddress 150 "$(bcn -rpcwallet=probe getnewaddress)" >/dev/null
echo "{\"step\":\"bitcoind\",\"height\":$(bcn getblockcount),\"cookie\":$([ -f $P/btc/regtest/.cookie ] && echo true || echo false),\"s\":$(( $(date +%s) - t0 ))}"
cd $HERE/.. && P=$P BITCOIN_CLI=$B/bitcoin-cli BTC_ARGS="$BTC_ARGS -rpcwallet=probe" FEDIMINT_BIN=$F FEDIMINT_HOME=$FH \
  BITCOIND_URL=http://127.0.0.1:$RPC BITCOIND_COOKIE=$P/btc/regtest/.cookie node tools/rehearsal-26.mjs &
R=$!; echo "$R rehearsal-26" >> $P/pids
wait $R; CODE=$?
echo "{\"step\":\"done\",\"exit\":$CODE,\"s\":$(( $(date +%s) - t0 ))}"
