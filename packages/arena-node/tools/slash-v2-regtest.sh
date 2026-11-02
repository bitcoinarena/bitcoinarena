#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# SLASHING RULE V2 ON ITS OWN REGTEST (§5A.3, kanban #978): federation-hold-probe's four guardians (3 of 4), then tools/slash-v2-regtest.mjs. All of it in one fresh
# directory, ports 30101.. (never a live stack's, all under 32768). Nothing here reaches testnet4.
#   FEDIMINT_BIN=<patched fork bin dir> FEDIMINT_HOME=<its home> STAKE_LOCK_BIN=<bin> bash tools/slash-v2-regtest.sh <log>
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1800}
if [ -z "${SV2_WRAPPED:-}" ]; then export SV2_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
LOG=${1:?the log file}
: "${FEDIMINT_BIN:?}" "${STAKE_LOCK_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/sv2-XXXXXX")}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE_BIN:-$(command -v node)}
BTC="$B/bitcoin-cli -datadir=$P/btc -regtest -rpcport=30101 -rpcuser=arena -rpcpassword=arena"
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  $BTC stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
: > "$LOG"
echo "{\"step\":\"start\",\"dir\":\"$P\",\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\"}" >> "$LOG"
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH BITCOIN_BIN=$B LND_BIN=$L bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" > $P/setup.log
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15 >> "$LOG"; echo '{"step":"THE FEDERATION DID NOT COME UP"}' >> "$LOG"; exit 1; }
echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2- > $P/invite-code
echo "{\"step\":\"federation up\",\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\"}" >> "$LOG"
( cd "$HERE/.." && BITCOIN_CLI="$BTC -rpcwallet=probe" STAKE_LOCK_BIN=$STAKE_LOCK_BIN CLIENT_DIR=$P/client FEDIMINT_CLI=$F/fedimint-cli INVITE_FILE=$P/invite-code WORK_DIR=$P \
  FORK_HOME=$FH "$NODE" tools/slash-v2-regtest.mjs ) >> "$LOG" 2>&1
RC=$?
echo "{\"step\":\"end\",\"exit\":$RC,\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\"}" >> "$LOG"
exit $RC
