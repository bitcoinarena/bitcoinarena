#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# A SIGNER NODE VERIFIES A REAL STAKE LOCK (v4.6.2 §23.1 step 5), on stock fedimintd
# 0.12.0: 4 guardians, 3 of 4, one gateway, regtest - rehearsal step 1's setup.
#   deposit 3000000 msat; lock A at +144 and B at +150 blocks, each a POINT
#   image (the stake point) under the committee's DKG claim key; then one signer node,
#   its federation port the real blwp-stake-lock, is handed the locks.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> bash tools/signer-node-lock-regtest.sh
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
# (no quote marks inside ${...:?} - one there opened a quote and bash read on to line 38, "INVOICE: unbound variable")
: "${WASM_PKG:?WASM_PKG must name the nodejs build of blwp-lock-client - the round names its federation by the invite of this setup}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/signer-node-lock-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
say() { echo "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
fc() { HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/client "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT

t=$(date +%s)
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
INVITE=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
echo "$UP" | grep -q FEDERATION_READY || { say "$UP" | tail -15; say "THE FEDERATION DID NOT COME UP"; exit 1; }
say "federation up in $(( $(date +%s) - t )) s, $(grep -c fedimintd $P/pids) fedimintd processes"

RECV=$(fc module lnv2 receive 3000000 --gateway http://127.0.0.1:30170 2>&1)
INVOICE=$(echo "$RECV" | grep -oE 'lnbcrt[0-9a-z]+' | head -1); OP=$(echo "$RECV" | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$INVOICE" ] || { say "NO INVOICE: $(echo "$RECV" | tr -d '\n' | cut -c1-200)"; exit 1; }
PAY=$(timeout 120 $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:30107 --network=regtest payinvoice --force "$INVOICE" 2>&1 | grep -oE 'Payment status: [A-Z_]+' | tail -1)
RCV=$(fc module lnv2 await-receive "$OP" 2>&1 | tr -d '\n ')
say "DEPOSIT 3000000 msat: alice's $PAY; receive $RCV; ecash $(fc info 2>/dev/null | js 'o=>o.total_amount_msat') msat"

node $HERE/stake-lock-keys.mjs $P/keys.json >/dev/null || { say "NO KEYS"; exit 1; }
PREP=$(INVITE=$INVITE WASM_PKG=$WASM_PKG node $HERE/signer-node-lock-regtest.mjs prepare $P) || { say "NO STAKES"; exit 1; }
CLAIM=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$P/keys.json','utf8')).claimPk)")
NET=$(echo "$PREP" | js 'o=>o.net')
say "KEYS: claim_pk $CLAIM (2-of-2 DKG); net stake $NET msat"
for S in A:144 B:150; do
  N=${S%%:*}; D=${S##*:}
  PT=$(echo "$PREP" | js "o=>o.$N"); RF=$(echo "$PREP" | js "o=>o.${N}R")
  LOCK=$(HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client --amount-msat $NET --point $PT --claim-pk $CLAIM --refund-pk $RF --expiry-delta $D 2>&1)
  echo "$LOCK" | grep '"stored_contract_id"' | tail -1 > $P/lock-$N.json
  [ -s $P/lock-$N.json ] || { say "LOCK $N FAILED: $(echo "$LOCK" | tail -3 | tr -d '\n' | cut -c1-300)"; exit 1; }
  say "LOCK $N (+$D): $(cat $P/lock-$N.json | js 'o=>`${o.txid}:${o.out_idx} ids_match ${o.ids_match} expiration ${o.computed_expiration} at count ${o.block_count_at_lock}`')"
done
# THE FEE LOCKS (pick a, since 5a3b227): at 1000 sat the round mints fee locks, so the door takes no
# entry without one. Measured before: entry A refused 409 "an entry that brings no fee lock is not
# taken", and this script went on to exit 0. One per entry, its fee to H(F) under the claim key.
FEE=$(echo "$PREP" | js 'o=>o.fee')
for N in A B C; do
  FHASH=$(echo "$PREP" | js "o=>o.F$N"); RF=$(echo "$PREP" | js "o=>o.${N}R")
  LOCK=$(HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client --amount-msat $FEE --hash $FHASH --claim-pk $CLAIM --refund-pk $RF --expiry-delta 150 2>&1)
  echo "$LOCK" | grep '"stored_contract_id"' | tail -1 > $P/fee-$N.json
  [ -s $P/fee-$N.json ] || { say "FEE LOCK $N FAILED: $(echo "$LOCK" | tail -3 | tr -d '\n' | cut -c1-300)"; exit 1; }
  say "FEE LOCK $N ($FEE msat to H(F), +150): $(cat $P/fee-$N.json | js 'o=>`${o.txid}:${o.out_idx} ids_match ${o.ids_match} expiration ${o.computed_expiration}`')"
done

# THE SIGNER NODE. When it writes mine-now, two blocks are mined so the federation's
# count moves on.
( while [ ! -e $P/mine-now ]; do sleep 1; done; ADDR=$(bcn getnewaddress 2>/dev/null || echo bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080); bcn generatetoaddress 2 "$ADDR" >/dev/null 2>&1 ) &
MINER=$!
# the whole output kept and the exit passed on: a filter for JSON lines alone once hid the signer node's error behind exit 0
INVITE=$INVITE WASM_PKG=$WASM_PKG LOCK_BIN=$LOCK_BIN node $HERE/signer-node-lock-regtest.mjs signerNode $P $P/keys.json > $P/signerNode.log 2>&1
RC=$?
kill $MINER 2>/dev/null
grep -E '^\{' $P/signerNode.log | sed 's/^/SIGNER_NODE /'
[ $RC -eq 0 ] || { say "THE SIGNER_NODE STEP FAILED (exit $RC):"; grep -vE '^\{' $P/signerNode.log | tail -8; }
say "probe dir: $P"
exit $RC
