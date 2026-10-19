#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# KANBAN #156 MEASURE 1: a local regtest federation (federation-hold-probe.sh's setup: 4 guardians, 3 of 4, one gateway,
# regtest), then donation-image-regtest.mjs. No testnet, no bond. Stops everything it started on exit.
#   FEDIMINT_BIN=<dir with fedimintd gatewayd fedimint-cli gateway-cli> WASM_DIR=<built web-target lock client> bash donation-image-regtest.sh
set -uo pipefail
: "${FEDIMINT_BIN:?}" ; : "${WASM_DIR:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$(mktemp -d /tmp/fedimint-home-XXXXXX)}
P=${PROBE_DIR:-$(mktemp -d /tmp/donation-image-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
NODE_TOOLS=$HERE/../../arena-node/tools
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
PROBE=$P INVITE=$INVITE GATEWAY=http://127.0.0.1:30170 LND_BIN=$L WASM_DIR=$WASM_DIR \
  node $HERE/donation-image-regtest.mjs 2>&1 | grep -E '^\{|Error|panicked'
RC=${PIPESTATUS[0]}
echo "probe dir: $P"
exit $RC
