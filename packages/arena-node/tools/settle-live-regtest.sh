#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE WHOLE SETTLEMENT ON A REAL FEDERATION (W4): rehearsal step 1's setup (stock
# fedimintd 0.12.0, 4 guardians, 3 of 4, one gateway, regtest), then
# settle-live-regtest.mjs - two signer nodes, a winner and a loser, a 100 sat round and a
# 1000 sat round, each settled by the signer nodes' one committee signature.
#
#   FEDIMINT_BIN=<released v0.12.0> LOCK_BIN=<blwp-stake-lock, the signer nodes' port>
#   WASM_PKG=<wasm-bindgen --target nodejs output of blwp-lock-client>
#     bash tools/settle-live-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-900}
if [ -z "${SETTLE_LIVE_WRAPPED:-}" ]; then
  export SETTLE_LIVE_WRAPPED=1
  exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"
fi
: "${FEDIMINT_BIN:?}" ; : "${LOCK_BIN:?}" ; : "${WASM_PKG:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/settle-live-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=arena -rpcpassword=arena "$@"; }
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
PROBE=$P INVITE=$INVITE GATEWAY=http://127.0.0.1:30170 LND_BIN=$L LOCK_BIN=$LOCK_BIN WASM_PKG=$WASM_PKG BITCOIN_BIN=$B \
  FEDIMINT_BIN=$F FEDIMINT_HOME=$FH \
  node $HERE/settle-live-regtest.mjs 2>&1 | grep --line-buffered -E '^\{|Error|panicked' | sed -u 's/^/LIVE /'
# the driver's own exit, not the filter's: a pipeline ending in sed ends 0 whatever the driver did
RC=${PIPESTATUS[0]}
# W6_KILL=1: the driver was SIGKILLed after the guardians answered; the signer nodes start again, same federation.
if [ "${W6_KILL:-}" = "1" ]; then
  PROBE=$P LOCK_BIN=$LOCK_BIN node $HERE/settle-live-w6-resume.mjs 2>&1 | grep --line-buffered -E '^\{|Error|panicked' | sed -u 's/^/LIVE /'
  RC=${PIPESTATUS[0]}
fi
echo "probe dir: $P (driver exit $RC)"
exit $RC
