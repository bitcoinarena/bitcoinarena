#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md REHEARSAL ITEM 9 (c) ON A REAL FEDERATION: the 9 (b) shape, then the Withdraw press's spend of the player
# wallet through gateway B while gateway A is down (rehearsal-9c.mjs). Rehearsal step 1's setup: stock fedimintd 0.12.0, 4 guardians,
# 3 of 4, two gateways (SECOND_GATEWAY=1: B on carol's lnd), regtest.
#
#   FEDIMINT_BIN=<released v0.12.0> LOCK_BIN=<blwp-stake-lock, the signer nodes' port>
#     bash tools/rehearsal-9c-regtest.sh
set -uo pipefail
: "${FEDIMINT_BIN:?}" ; : "${LOCK_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/rehearsal9c-XXXXXX)}
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
UP=$(PROBE_DIR=$P SETUP_ONLY=1 SECOND_GATEWAY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
INVITE=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
echo "federation up in $(( $(date +%s) - t )) s, invite ${INVITE:0:24}..."
PROBE=$P INVITE=$INVITE LND_BIN=$L LOCK_BIN=$LOCK_BIN BITCOIN_BIN=$B node $HERE/rehearsal-9c.mjs > $P/rehearsal-9c.log 2>&1
code=$?
grep -E '^\{' $P/rehearsal-9c.log | sed 's/^/ITEM9C /'
echo "rehearsal-9c exit $code; log: $P/rehearsal-9c.log"
exit $code
