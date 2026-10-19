#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# W5b ON A REAL FEDERATION: the signer nodes forfeit a qualifier's stake lock after
# the objection window, a loser's is refused and stays held, one signer node's
# signature is refused by the guardians, and the player redeems the forfeit
# from a later session holding only the seed and withdraws it - on the signer nodes'
# own claim key (nothing injected). Rehearsal step 1's setup: stock fedimintd
# 0.12.0, 4 guardians, 3 of 4, one gateway, regtest; then w5b.mjs.
#
#   FEDIMINT_BIN=<released v0.12.0> LOCK_BIN=<blwp-stake-lock, the signer nodes' port>
#     bash tools/w5b-regtest.sh
set -uo pipefail
: "${FEDIMINT_BIN:?}" ; : "${LOCK_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/w5b-XXXXXX)}
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
PROBE=$P INVITE=$INVITE LND_BIN=$L LOCK_BIN=$LOCK_BIN BITCOIN_BIN=$B node $HERE/w5b.mjs > $P/w5b.log 2>&1
code=$?
grep -E '^\{' $P/w5b.log | sed 's/^/W5B /'
echo "w5b exit $code; log: $P/w5b.log"
exit $code
