#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md, THE REHEARSAL, STEP 5: "gateway A down: deposit and
# withdrawal go through B".
#
# Two gateways, each on its own lnd: A on bob's (as in steps 1-4), B on
# carol's (tools/federation-hold-probe.sh SECOND_GATEWAY=1). A is stopped for
# real. The stock client, NOT told which gateway to use, walks the
# federation's list and takes the first that answers a routing-info request
# (lnv2-client lib.rs, select_gateway) - so which gateway carried each
# payment is read off lnd, not assumed:
#
#   deposit     the invoice's payee is the gateway's lnd (bob = A, carol = B)
#   withdrawal  the lnd that holds the outgoing payment (bob's or carol's)
#
#   0. SETUP     stock fedimintd 0.12.0, 4 guardians 3 of 4; gateways A and B
#   1. A DOWN    its gatewayd process group stopped: port closed, a direct
#                request fails, a deposit naming A is refused; the guardians
#                still list both
#   2. DEPOSIT   no gateway named; alice pays; the player's ecash arrives
#   3. LOCK      part of it locked with the committee key (tools/stake-lock);
#                the contract the guardians stored is read back
#   4. WITHDRAW  no gateway named; the player pays an invoice of alice's lnd
#
# Everything is stopped at the end: every process group and bitcoind.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> \
#     bash tools/stake-lock-step5.sh [deposit-msat=2000000] [lock-msat=980000] [withdraw-sat=500]
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/stake-lock-step5-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
DEPOSIT_MSAT=${1:-2000000}
LOCK_MSAT=${2:-980000}
WITHDRAW_SAT=${3:-500}
HERE=$(cd "$(dirname "$0")" && pwd)
A=http://127.0.0.1:30170
say() { echo "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
fc() { HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/client "$@"; }
declare -A LRPC=([alice]=30107 [bob]=30110 [carol]=30113)
ln_() { local who=$1; shift; timeout 60 $L/lncli --lnddir=$P/$who --rpcserver=127.0.0.1:${LRPC[$who]} --network=regtest "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1
  sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
ecash() { fc info 2>/dev/null | js 'o=>Number(o.total_amount_msat)'; }
settled_ecash() {  # wait up to 60 s for the balance to move off $1
  local e; e=$(ecash); for i in $(seq 60); do [ "$e" != "$1" ] && break; sleep 1; e=$(ecash); done; echo "$e"
}
short() { tr -d '\n' | sed 's/  */ /g' | cut -c1-220; }

# ---- 0. SETUP: the federation and both gateways ----
t=$(date +%s)
UP=$(PROBE_DIR=$P SETUP_ONLY=1 SECOND_GATEWAY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q "FEDERATION_READY.*gateway_b=" || { say "$UP" | tail -15; say "THE FEDERATION WITH TWO GATEWAYS DID NOT COME UP"; exit 1; }
BOBKEY=$(ln_ bob getinfo | js 'o=>o.identity_pubkey'); CAROLKEY=$(ln_ carol getinfo | js 'o=>o.identity_pubkey')
who() { [ "$1" = "$BOBKEY" ] && echo "A (bob's lnd)" || { [ "$1" = "$CAROLKEY" ] && echo "B (carol's lnd)" || echo "neither ($1)"; }; }
say "SETUP in $(( $(date +%s) - t )) s: fedimintd $(HOME=$FH $F/fedimintd --version 2>/dev/null | head -1), $(grep -c fedimintd $P/pids) guardians, threshold $(fc config 2>/dev/null | js 'o=>{const n=Object.keys(o.global.api_endpoints).length;return n-Math.floor((n-1)/3)}')"
say "  gateway A $A on bob's lnd $BOBKEY; gateway B http://127.0.0.1:30180 on carol's lnd $CAROLKEY"
say "  the guardians' gateway list: $(fc module lnv2 gateways list 2>/dev/null | js 'o=>JSON.stringify(o)')"

# ---- 1. A DOWN, FOR REAL ----
APID=$(awk '$2=="gatewayd"{print $1}' $P/pids)
kill -TERM -- -$APID 2>/dev/null
for i in $(seq 30); do ss -ltn | awk '{print $4}' | grep -q ':30170$' || break; sleep 1; done
say "A DOWN: gatewayd process group $APID stopped; port 30170 $(ss -ltn | awk '{print $4}' | grep -q ':30170$' && echo 'STILL OPEN' || echo closed); A's processes left: $(ps -o pid= -g $APID 2>/dev/null | wc -l)"
say "  a direct request to A: $(HOME=$FH timeout 20 $F/gateway-cli -a $A --rpcpassword probe info 2>&1 | short)"
say "  a deposit naming A: $(fc module lnv2 receive $DEPOSIT_MSAT --gateway $A 2>&1 | short)"
say "  the guardians' gateway list now: $(fc module lnv2 gateways list 2>/dev/null | js 'o=>JSON.stringify(o)')"

# ---- 2. DEPOSIT, NO GATEWAY NAMED ----
E0=$(ecash)
RECV=$(fc module lnv2 receive $DEPOSIT_MSAT 2>&1)
INVOICE=$(echo "$RECV" | grep -oE 'lnbcrt[0-9a-z]+' | head -1)
OP=$(echo "$RECV" | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$INVOICE" ] || { say "NO INVOICE WITHOUT A NAMED GATEWAY: $(echo "$RECV" | short)"; exit 1; }
PAYEE=$(ln_ alice decodepayreq $INVOICE | js 'o=>o.destination')
PAY=$(timeout 120 $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:30107 --network=regtest payinvoice --force "$INVOICE" 2>&1 | grep -oE 'Payment status: [A-Z_]+' | tail -1)
RCV=$(fc module lnv2 await-receive "$OP" 2>&1 | tr -d '\n ')
E1=$(settled_ecash "$E0")
say "DEPOSIT (no gateway named): the invoice's payee is gateway $(who $PAYEE); alice's $PAY; receive $RCV; player's ecash $E0 -> $E1 msat (receive fee $((DEPOSIT_MSAT - (E1 - E0))) msat on $DEPOSIT_MSAT)"

# ---- 3. LOCK PART OF IT ----
KEYS=$(node $HERE/stake-lock-keys.mjs $P/keys.json)
CLAIM=$(echo "$KEYS" | js 'o=>o.claimPk'); REFUND=$(echo "$KEYS" | js 'o=>o.refundPk'); HASH=$(echo "$KEYS" | js 'o=>o.hash')
LOCK=$(HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client --amount-msat $LOCK_MSAT --hash $HASH \
  --claim-pk $CLAIM --refund-pk $REFUND --expiry-delta 144 2>&1 | grep '"stored_contract_id"' | tail -1)
E2=$(ecash)
say "LOCK from the B deposit: $(echo "$LOCK" | js 'o=>`${o.txid}:${o.out_idx}, stored contract ${o.stored_contract_id} (= computed: ${o.ids_match}), expires at block ${o.stored_expiration} (${o.stored_blocks_left} left at the guardians\x27 count ${o.block_count_at_read}), ${o.amount_msat} msat, claim_pk ${o.claim_pk}`')"
say "  player's ecash $E1 -> $E2 msat (lock $LOCK_MSAT + $((E1 - E2 - LOCK_MSAT)) msat fees)"

# ---- 4. WITHDRAW, NO GATEWAY NAMED ----
WINV=$(ln_ alice addinvoice --amt $WITHDRAW_SAT | js 'o=>o.payment_request'); WHASH=$(ln_ alice decodepayreq $WINV | js 'o=>o.payment_hash')
SOP=$(fc module lnv2 send "$WINV" 2>&1 | grep -oE '[0-9a-f]{64}' | head -1)
SENT=$(fc module lnv2 await-send "$SOP" 2>&1 | tr -d '\n ')
E3=$(settled_ecash "$E2")
VIA=$(for w in bob carol; do ln_ $w listpayments 2>/dev/null | js "o=>(o.payments||[]).some(p=>p.payment_hash==='$WHASH'&&p.status==='SUCCEEDED')?'$w':''"; done | tr -d '\n')
say "WITHDRAW (no gateway named): $WITHDRAW_SAT sat invoice of alice's lnd; send $SENT; alice's invoice $(ln_ alice lookupinvoice $WHASH | js 'o=>o.state'); paid out by $( [ "$VIA" = carol ] && echo "gateway B (carol's lnd)" || { [ "$VIA" = bob ] && echo "gateway A (bob's lnd)" || echo "no gateway lnd found ($VIA)"; } )"
say "  player's ecash $E2 -> $E3 msat: -$((E2 - E3)) for a $((WITHDRAW_SAT * 1000)) msat invoice ($((E2 - E3 - WITHDRAW_SAT * 1000)) msat fees)"

VERDICT="A down $( ss -ltn | awk '{print $4}' | grep -q ':30170$' && echo false || echo true), deposit via B $( [ "$PAYEE" = "$CAROLKEY" ] && [ "$E1" -gt "$E0" ] && echo true || echo false), lock stored $(echo "$LOCK" | js 'o=>String(o.ids_match===true)'), withdrawal via B $( [ "$VIA" = carol ] && [ "$E3" -lt "$E2" ] && echo true || echo false)"
say "STEP 5: $VERDICT"
echo "$VERDICT" | grep -q false && say "STEP 5 NOT MET" || say "STEP 5 MET: with gateway A down, the stock client deposited and withdrew through B on its own, and the deposit funded a stake lock the guardians hold"
say "probe dir: $P"
