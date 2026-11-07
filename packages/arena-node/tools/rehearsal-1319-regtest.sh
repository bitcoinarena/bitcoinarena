#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# A HALT PROVEN ON REAL GUARDIANS, "ANSWERING" = SIGNING (spec §23A.5, RULED 2026-11-07 kanban #1289; kanban #1319): a private
# bitcoind and five fedimintd in setup mode, each in its own systemd user scope r1319-g<N> (so iptables can cut one guardian's P2P by
# its cgroup), founded by rehearsal 20's sortition (four seated, one alternate), then tools/rehearsal-1319.mjs. Needs sudo (iptables).
#   FEDIMINT_BIN=<fork bin dir> bash tools/rehearsal-1319-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1800}
if [ -z "${R1319_WRAPPED:-}" ]; then export R1319_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/r1319-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
RPC=30101
BTC_ARGS="-datadir=$P/btc -regtest -rpcport=$RPC -rpcuser=arena -rpcpassword=arena"
bcn() { $B/bitcoin-cli $BTC_ARGS "$@"; }
mkdir -p $P/btc $FH; : > $P/pids
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for g in 0 1 2 3 4; do systemctl --user stop r1319-g$g.scope 2>/dev/null; done
  sudo -n iptables -D INPUT -j R1319 2>/dev/null; sudo -n iptables -D OUTPUT -j R1319 2>/dev/null; sudo -n iptables -F R1319 2>/dev/null; sudo -n iptables -X R1319 2>/dev/null
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; echo "GAVE UP waiting for $what"; exit 1; }
t0=$(date +%s)
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=arena -rpcpassword=arena -port=30102 -listen=0 -listenonion=0 -fallbackfee=0.0001 -txindex -daemon >/dev/null
until_ bitcoind 60 bcn getblockcount
bcn createwallet probe >/dev/null
bcn -rpcwallet=probe generatetoaddress 150 "$(bcn -rpcwallet=probe getnewaddress)" >/dev/null
for g in 0 1 2 3 4; do
  base=$((30120 + g * 10)); mkdir -p $P/g$g
  ( export HOME=$FH FM_DATA_DIR=$P/g$g FM_BITCOIN_NETWORK=regtest \
      FM_BITCOIND_URL=http://127.0.0.1:$RPC FM_BITCOIND_USERNAME=blwp FM_BITCOIND_PASSWORD=blwp \
      FM_BIND_P2P=127.0.0.1:$base FM_BIND_API=127.0.0.1:$((base+1)) FM_BIND_UI=127.0.0.1:$((base+2)) \
      FM_BIND_METRICS=127.0.0.1:$((base+3)) FM_P2P_URL=fedimint://127.0.0.1:$base FM_API_URL=ws://127.0.0.1:$((base+1)) \
      FM_ENABLE_IROH=false FM_PASSWORD_API=probe FM_PASSWORD_UI=probe FM_DISABLE_BASE_FEES=1
    setsid nohup systemd-run --user --scope -q -u r1319-g$g $F/fedimintd > $P/g$g/fedimintd.out 2>&1 < /dev/null & echo "$! fedimintd-$g" >> $P/pids )
  up() { grep -q "Setup UI running" $P/g$g/fedimintd.out 2>/dev/null; }
  until_ "guardian $g" 180 up
done
echo "{\"step\":\"five guardians in setup mode\",\"height\":$(bcn getblockcount),\"s\":$(( $(date +%s) - t0 ))}"
(cd $HERE/.. && P=$P BITCOIN_CLI=$B/bitcoin-cli BTC_ARGS="$BTC_ARGS -rpcwallet=probe" FEDIMINT_BIN=$F FEDIMINT_HOME=$FH NODES=5 node tools/rehearsal-20.mjs) || exit 1
(cd $HERE/.. && P=$P BITCOIN_CLI=$B/bitcoin-cli BTC_ARGS="$BTC_ARGS -rpcwallet=probe" node tools/rehearsal-1319.mjs)
echo "{\"step\":\"done\",\"s\":$(( $(date +%s) - t0 ))}"
