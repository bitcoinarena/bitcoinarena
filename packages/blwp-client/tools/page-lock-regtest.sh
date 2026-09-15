#!/bin/bash
# THE PAGE MAKES THE PLAYER'S STAKE LOCK, ON A REAL FEDERATION (W1b): rehearsal
# step 1's setup (stock fedimintd 0.12.0, 4 guardians, 3 of 4, one gateway,
# regtest) and the committee's claim key, as lock-client-regtest.sh (W1a) has
# them - then the built page in a headless Chrome joins a lock round from its
# link, is paid its deposit, locks, and hands the lock to both signer nodes.
#
#   FEDIMINT_BIN=<released v0.12.0> LOCK_BIN=<blwp-stake-lock, the signer nodes' port>
#     bash tools/page-lock-regtest.sh label=<built page dir> ...
#   e.g. before=<today's page> after=<this page> nolock=<this page>: each a
#   build/webgl with its template filled; `nolock` is served lock step off.
set -uo pipefail
: "${FEDIMINT_BIN:?}" ; : "${LOCK_BIN:?}"
[ $# -gt 0 ] || { echo "name at least one label=<page dir>"; exit 2; }
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/page-lock-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
NODE_TOOLS=$HERE/../../blwp-node/tools
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
t=$(date +%s)
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $NODE_TOOLS/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
INVITE=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
echo "federation up in $(( $(date +%s) - t )) s, invite ${INVITE:0:24}..."
PROBE=$P INVITE=$INVITE LND_BIN=$L LOCK_BIN=$LOCK_BIN GATEWAY=http://127.0.0.1:30170 WASM_PKG=${WASM_PKG:-} BITCOIN_BIN=$B \
  node $HERE/page-lock.mjs "$@" > $P/page-lock.log 2>&1
code=$?
grep -E '^\{' $P/page-lock.log | sed 's/^/W1B /'
echo "page-lock exit $code; log: $P/page-lock.log"
exit $code
