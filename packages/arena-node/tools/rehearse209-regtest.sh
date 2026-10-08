#!/bin/bash
# THE MIGRATION, REHEARSED (kanban #209 step 2): federation-hold-probe's setup with the patched fork's binaries (4 guardians,
# 3 of 4, disable_base_fees, two gateways; regtest), then rehearse209.mjs (the BLWP player and its sweep, the BLWP bonds
# carried, two processes on one client directory), then fee-split-regtest.mjs on the same federation (a paid Arena round
# on the new layout and network id, settled 5 / 2.5 / 2.5, the donor collecting). Nothing here reaches testnet4.
#
#   FEDIMINT_BIN=<fork release dir> WASM_WEB=<lock client web target> PHASE0_TREE=<phase0 checkout> bash tools/rehearse209-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-2400}
if [ -z "${REHEARSE_WRAPPED:-}" ]; then
  export REHEARSE_WRAPPED=1
  exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"
fi
: "${FEDIMINT_BIN:?}" ; : "${WASM_WEB:?}" ; : "${PHASE0_TREE:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/rehearse209-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
bcn() { $B/bitcoin-cli -datadir=$P/btc -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
t=$(date +%s)
UP=$(PROBE_DIR=$P SETUP_ONLY=1 SECOND_GATEWAY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH BITCOIN_BIN=$B LND_BIN=$L bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -25; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
INVITE=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
echo "federation up in $(( $(date +%s) - t )) s, invite ${INVITE:0:24}..."
COMMON="PROBE=$P INVITE=$INVITE GATEWAY=http://127.0.0.1:30170 LND_BIN=$L LOCK_BIN=$F/blwp-stake-lock WASM_WEB=$WASM_WEB BITCOIN_BIN=$B FEDIMINT_BIN=$F FEDIMINT_HOME=$FH"
env $COMMON PHASE0_TREE=$PHASE0_TREE node $HERE/rehearse209.mjs 2>&1 | grep --line-buffered -vE '^\s*$' | sed -u 's/^/REHEARSE /'
R1=${PIPESTATUS[0]}
echo "rehearse209.mjs exit $R1"
env $COMMON node $HERE/fee-split-regtest.mjs 2>&1 | grep --line-buffered -vE '^\s*$' | sed -u 's/^/ARENA-ROUND /'
R2=${PIPESTATUS[0]}
echo "fee-split-regtest.mjs exit $R2, facts $P/fee-split-facts.json"
exit $(( R1 || R2 ))
