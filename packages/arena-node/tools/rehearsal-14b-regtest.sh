#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md REHEARSAL 14B ON REGTEST (§23A.4, kanban #322 / #326): absence attestations signed by each guardian's node from
# its OWN fedimintd's view (src/absence-producer.js), not by the script.
#   1. federation-hold-probe's 4 guardians (3 of 4), SETUP_ONLY.
#   2. a pass: every guardian sees the other three; nothing signed.
#   3. g3 stops. Blocks are mined and the passes repeat until g0, g1, g2 each name peer 3 absent and sign (the first at once).
#   4. abandon_blocks more, a pass: the second attestations span the clock; the abandonment proof stands with 3 signers.
#   5. g2 stops too: the federation halts (2 of 4). Five seats observe it (src/halts.js) over the guardians' sockets, abandon_blocks
#      apart; the halt proof names the session, the halt height, g2 and g3 ABANDONED.
# Heavy (4 fedimintd, 2 lnd, a gatewayd, bitcoind): the test host load rule applies. Nothing here reaches testnet4.
#   FEDIMINT_BIN=<fork bin dir> bash tools/rehearsal-14b-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-2400}
if [ -z "${R14B_WRAPPED:-}" ]; then export R14B_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/r14b-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
BTC_ARGS="-datadir=$P/btc -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp"
bcn() { $B/bitcoin-cli $BTC_ARGS "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
cl() { local d=$1; shift; HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/$d "$@"; }
mine() { bcn -rpcwallet=probe generatetoaddress $1 "$(bcn -rpcwallet=probe getnewaddress)" >/dev/null; }
r14b() { (cd $HERE/.. && P=$P BITCOIN_CLI=$B/bitcoin-cli BTC_ARGS="$BTC_ARGS -rpcwallet=probe" FED=$FED RUNNING=$1 node tools/rehearsal-14b.mjs $2); }
t0=$(date +%s)

UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH BITCOIN_BIN=$B LND_BIN=$L bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" > $P/setup.log
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
FED=$(cl client info | js 'o=>o.federation_id')
for g in 0 1 2 3; do printf probe > $P/g$g/admin-password; done
echo "{\"step\":\"federation up\",\"federation\":\"$FED\",\"height\":$(bcn getblockcount),\"s\":$(( $(date +%s) - t0 ))}"

# ---- 2. ALL SEEN ----
mine 1; sleep 20
r14b 0,1,2,3 pass

# ---- 3. G3 STOPS ----
pid=$(grep " fedimintd-3\$" $P/pids | cut -d' ' -f1); kill -TERM -- -$pid 2>/dev/null; sleep 3
echo "{\"step\":\"g3 stopped\",\"height\":$(bcn getblockcount),\"s\":$(( $(date +%s) - t0 ))}"
for i in $(seq 40); do
  mine 1; sleep 15
  R=$(r14b 0,1,2 pass); echo "$R"
  [ "$(echo "$R" | grep -c '"signed":\[{')" -ge 3 ] && break
done
echo "{\"step\":\"first attestations\",\"height\":$(bcn getblockcount),\"s\":$(( $(date +%s) - t0 ))}"
PEER=3 r14b 0,1,2 proof | sed 's/^/  /'

# ---- 4. ABANDON_BLOCKS LATER ----
mine 11; sleep 20
r14b 0,1,2 pass
PEER=3 r14b 0,1,2 proof
# ---- 5. THE HALT ----
pid=$(grep " fedimintd-2\$" $P/pids | cut -d' ' -f1); kill -TERM -- -$pid 2>/dev/null; sleep 3
echo "{\"step\":\"g2 stopped: 2 of 4 left\",\"height\":$(bcn getblockcount),\"s\":$(( $(date +%s) - t0 ))}"
r14b 0,1 halt
echo "{\"step\":\"done\",\"s\":$(( $(date +%s) - t0 ))}"
