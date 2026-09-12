#!/bin/bash
# ENTRY_VOID (§16) ON A REAL FEDERATION: an on-time first mark that missed a
# down seat is ENTRY_VOID at both seats, and the stake lock is forfeited to the
# player at once (§23.2) - redeemed from the seed before its expiry and
# withdrawn. Stock fedimintd 0.12.0, 4 guardians, one gateway, regtest; the
# Daily's 2-of-2 on it, the seats making their own claim key; then outage.mjs.
#
#   FEDIMINT_BIN=<released v0.12.0> LOCK_BIN=<blwp-stake-lock> bash tools/outage-regtest.sh
set -uo pipefail
: "${FEDIMINT_BIN:?}" ; : "${LOCK_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/outage-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
t=$(date +%s)
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
INVITE=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
echo "federation up in $(( $(date +%s) - t )) s, invite ${INVITE:0:24}..."
PROBE=$P INVITE=$INVITE LND_BIN=$L LOCK_BIN=$LOCK_BIN BITCOIN_BIN=$B node $HERE/${OUTAGE_SCRIPT:-outage.mjs} > $P/outage.log 2>&1
code=$?
grep -E '^\{' $P/outage.log | sed 's/^/OUTAGE /'
echo "outage exit $code; log: $P/outage.log"
exit $code
