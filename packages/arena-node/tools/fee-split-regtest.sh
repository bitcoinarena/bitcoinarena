#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE 10% ON A REAL FEDERATION: federation-hold-probe's setup with the patched fork's binaries (4 guardians,
# 3 of 4, disable_base_fees as FEDERATION.md runs it - a signer node refuses a round on a federation with a base fee - and two
# gateways, §23.6, on bob's and carol's lnds; regtest), then fee-split-regtest.mjs: a paid round of nextblock and
# one of a game with its own dev key, settled by two signer nodes, and that dev's donor client collecting its share.
#
#   FEDIMINT_BIN=<the fork's release dir> WASM_WEB=<the page's lock client (web target)> bash tools/fee-split-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1500}
if [ -z "${FEE_SPLIT_WRAPPED:-}" ]; then
  export FEE_SPLIT_WRAPPED=1
  exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"
fi
: "${FEDIMINT_BIN:?}" ; : "${WASM_WEB:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/fee-split-XXXXXX)}
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
echo "$UP" | grep -iE "gateway|guardian" | tail -4
echo "federation up in $(( $(date +%s) - t )) s, invite ${INVITE:0:24}..."
PROBE=$P INVITE=$INVITE GATEWAY=http://127.0.0.1:30170 LND_BIN=$L LOCK_BIN=$F/blwp-stake-lock WASM_WEB=$WASM_WEB BITCOIN_BIN=$B \
  FEDIMINT_BIN=$F FEDIMINT_HOME=$FH \
  node $HERE/fee-split-regtest.mjs 2>&1 | grep --line-buffered -vE '^\s*$' | sed -u 's/^/LIVE /'
RC=${PIPESTATUS[0]}
echo "driver exit $RC, facts $P/fee-split-facts.json"
exit $RC
