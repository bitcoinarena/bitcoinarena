#!/bin/bash
# FEDERATION.md REHEARSAL 20b (the seat wiring), A FOUNDING BY SORTITION ON REGTEST (§23A.2, kanban #320): a private bitcoind and six fedimintd in setup
# mode, then tools/rehearsal-20.mjs - the six seats' founding.js draws four, the silent one is replaced by an alternate after
# founding_window, the four seated run the DKG and the federation answers. Heavy (6 fedimintd): the test host load rule applies.
#   FEDIMINT_BIN=<fork bin dir> bash tools/rehearsal-20-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1800}
if [ -z "${R20B_WRAPPED:-}" ]; then export R20B_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/r20-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
RPC=30101
BTC_ARGS="-datadir=$P/btc -regtest -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp"
bcn() { $B/bitcoin-cli $BTC_ARGS "$@"; }
mkdir -p $P/btc $FH; : > $P/pids
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; echo "GAVE UP waiting for $what"; exit 1; }
t0=$(date +%s)
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp -port=30102 -listen=0 -listenonion=0 -fallbackfee=0.0001 -txindex -daemon >/dev/null
until_ bitcoind 60 bcn getblockcount
bcn createwallet probe >/dev/null
bcn -rpcwallet=probe generatetoaddress 150 "$(bcn -rpcwallet=probe getnewaddress)" >/dev/null
for g in 0 1 2 3 4 5; do
  base=$((30120 + g * 10)); mkdir -p $P/g$g
  ( export HOME=$FH FM_DATA_DIR=$P/g$g FM_BITCOIN_NETWORK=regtest \
      FM_BITCOIND_URL=http://127.0.0.1:$RPC FM_BITCOIND_USERNAME=blwp FM_BITCOIND_PASSWORD=blwp \
      FM_BIND_P2P=127.0.0.1:$base FM_BIND_API=127.0.0.1:$((base+1)) FM_BIND_UI=127.0.0.1:$((base+2)) \
      FM_BIND_METRICS=127.0.0.1:$((base+3)) FM_P2P_URL=fedimint://127.0.0.1:$base FM_API_URL=ws://127.0.0.1:$((base+1)) \
      FM_ENABLE_IROH=false FM_PASSWORD_API=probe FM_PASSWORD_UI=probe FM_DISABLE_BASE_FEES=1
    setsid nohup $F/fedimintd > $P/g$g/fedimintd.out 2>&1 < /dev/null & echo "$! fedimintd-$g" >> $P/pids )
  up() { grep -q "Setup UI running" $P/g$g/fedimintd.out 2>/dev/null; }
  until_ "guardian $g" 180 up
done
echo "{\"step\":\"six guardians in setup mode\",\"height\":$(bcn getblockcount),\"s\":$(( $(date +%s) - t0 ))}"
(cd $HERE/.. && P=$P BITCOIN_CLI=$B/bitcoin-cli BTC_ARGS="$BTC_ARGS -rpcwallet=probe" FEDIMINT_BIN=$F FEDIMINT_HOME=$FH NODES=6 node tools/rehearsal-20b.mjs)
echo "{\"step\":\"done\",\"s\":$(( $(date +%s) - t0 ))}"
