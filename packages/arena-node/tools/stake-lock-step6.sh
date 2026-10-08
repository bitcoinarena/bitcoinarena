#!/bin/bash
# FEDERATION.md, THE REHEARSAL, STEP 6: "one guardian down: everything still
# completes".
#
# "Everything" is every path the rehearsal has already shown. With guardian 3
# stopped BEFORE any money moves, all six run on three guardians of four:
#
#   1. DEPOSIT     through a live gateway, none named (step 5's way)
#   2. LOCK        four stake locks, one committee and one player, four secrets;
#                  each contract read back as the guardians stored it (step 1)
#   3. FORFEIT     lock 1: the committee's 2-of-2 forfeit, redeemed by the
#                  player (step 2)
#   4. SETTLE      locks 2 and 3: one committee-signed settlement into one
#                  pre-expired payout (step 3a)
#   5. REFUND      lock 4: mined past its expiry, the guardians' own count
#                  waited for, then the player's Refund (step 4)
#   6. WITHDRAW    through a live gateway, none named (step 5)
#
# No refusals here - those were steps 1-5. Every operation is timed.
# THE VOTE WITH ONE GUARDIAN DOWN: the guardians' block count is the
# third-highest of four votes (lnv2-server lib.rs:746-765). Guardian 3's vote
# freezes when it stops; if the count later rises past the count read at that
# moment, three votes stand above the frozen one - the third-highest is then a
# live guardian's. That is read off the count, not assumed.
#
# Everything is stopped at the end: every process group and bitcoind.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> \
#     bash tools/stake-lock-step6.sh [deposit-msat=5000000] [lock-msat=980000] [withdraw-sat=500]
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/stake-lock-step6-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
DEPOSIT_MSAT=${1:-5000000}
LOCK_MSAT=${2:-980000}
WITHDRAW_SAT=${3:-500}
DOWN=3
HERE=$(cd "$(dirname "$0")" && pwd)
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
settled_ecash() { local e; e=$(ecash); for i in $(seq 60); do [ "$e" != "$1" ] && break; sleep 1; e=$(ecash); done; echo "$e"; }
now() { date +%s%3N; }
short() { tr -d '\n' | sed 's/  */ /g' | cut -c1-200; }
k() { node -e "process.stdout.write(String(require(process.argv[1])[process.argv[2]]))" "$P/keys.json" "$1"; }
field() { echo "$1" | js "o=>o.$2"; }
rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1"; }
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(Buffer.from(process.argv[1],"hex")).digest("hex"))' "$1"; }
open_port() { ss -ltn | awk '{print $4}' | grep -q ":$1\$" && echo open || echo closed; }
T0=$(now)

# ---- SETUP: four guardians, both gateways (step 5's) ----
UP=$(PROBE_DIR=$P SETUP_ONLY=1 SECOND_GATEWAY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q "FEDERATION_READY.*gateway_b=" || { say "$UP" | tail -15; say "THE FEDERATION DID NOT COME UP"; exit 1; }
BOBKEY=$(ln_ bob getinfo | js 'o=>o.identity_pubkey'); CAROLKEY=$(ln_ carol getinfo | js 'o=>o.identity_pubkey')
gwname() { [ "$1" = "$BOBKEY" ] && echo "A (bob's lnd)" || { [ "$1" = "$CAROLKEY" ] && echo "B (carol's lnd)" || echo "neither ($1)"; }; }
say "SETUP in $(( ($(now) - T0) / 1000 )) s: fedimintd $(HOME=$FH $F/fedimintd --version 2>/dev/null | head -1), threshold $(fc config 2>/dev/null | js 'o=>{const n=Object.keys(o.global.api_endpoints).length;return n-Math.floor((n-1)/3)+" of "+n}'); gateways $(fc module lnv2 gateways list 2>/dev/null | js 'o=>JSON.stringify(o)')"

# ---- GUARDIAN 3 DOWN, BEFORE ANY MONEY MOVES ----
GPID=$(awk -v g="fedimintd-$DOWN" '$2==g{print $1}' $P/pids)
API=$((30121 + DOWN * 10))
kill -TERM -- -$GPID 2>/dev/null
for i in $(seq 30); do [ "$(open_port $API)" = closed ] && break; sleep 1; done
say "GUARDIAN $DOWN DOWN: process group $GPID stopped, $(ps -o pid= -g $GPID 2>/dev/null | wc -l) processes left; its API port $API $(open_port $API)"
say "  a direct admin request to guardian $DOWN: $(fc --our-id $DOWN --password probe admin audit 2>&1 | short)"
say "  the other three API ports: 30121 $(open_port 30121), 30131 $(open_port 30131), 30141 $(open_port 30141)"

# ---- 1. DEPOSIT ----
E0=$(ecash); t=$(now)
RECV=$(fc module lnv2 receive $DEPOSIT_MSAT 2>&1)
INVOICE=$(echo "$RECV" | grep -oE 'lnbcrt[0-9a-z]+' | head -1); OP=$(echo "$RECV" | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$INVOICE" ] || { say "NO INVOICE: $(echo "$RECV" | short)"; exit 1; }
PAYEE=$(ln_ alice decodepayreq $INVOICE | js 'o=>o.destination')
PAY=$(timeout 120 $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:30107 --network=regtest payinvoice --force "$INVOICE" 2>&1 | grep -oE 'Payment status: [A-Z_]+' | tail -1)
RCV=$(fc module lnv2 await-receive "$OP" 2>&1 | tr -d '\n ')
E1=$(settled_ecash "$E0"); D1=$(( $(now) - t ))
say "1 DEPOSIT (${D1} ms): gateway $(gwname $PAYEE); alice's $PAY; receive $RCV; ecash $E0 -> $E1 msat (receive fee $((DEPOSIT_MSAT - (E1 - E0))) msat on $DEPOSIT_MSAT)"

# ---- 2. FOUR LOCKS ----
KEYS=$(node $HERE/stake-lock-keys.mjs $P/keys.json)
CLAIM=$(k claimPk); REFUND=$(k refundPk)
declare -A PRE LJ
PRE[1]=$(k preimage); for n in 2 3 4; do PRE[$n]=$(rnd 32); done
t=$(now)
for n in 1 2 3 4; do
  tn=$(now)
  LJ[$n]=$(HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client --amount-msat $LOCK_MSAT --hash $(sha ${PRE[$n]}) \
    --claim-pk $CLAIM --refund-pk $REFUND --expiry-delta 144 2>&1 | grep '"stored_contract_id"' | tail -1)
  [ -n "${LJ[$n]}" ] && [ "$(field "${LJ[$n]}" ids_match)" = true ] || { say "LOCK $n FAILED: ${LJ[$n]}"; exit 1; }
  say "2 LOCK $n ($(( $(now) - tn )) ms): $(field "${LJ[$n]}" txid):$(field "${LJ[$n]}" out_idx), stored contract $(field "${LJ[$n]}" stored_contract_id) (= computed), expires at block $(field "${LJ[$n]}" stored_expiration) ($(field "${LJ[$n]}" stored_blocks_left) left at count $(field "${LJ[$n]}" block_count_at_read))"
done
E2=$(ecash)
say "  four locks in $(( $(now) - t )) ms; ecash $E1 -> $E2 msat (4 x $LOCK_MSAT + $((E1 - E2 - 4 * LOCK_MSAT)) msat fees); claim_pk $CLAIM; refund_pk $REFUND"
op() { echo "$(field "${LJ[$1]}" txid):$(field "${LJ[$1]}" out_idx)"; }
REDEEM_ARGS() { echo --mode redeem --data-dir $P/client --outpoint $(op $1) --amount-msat $LOCK_MSAT --hash $(sha ${PRE[$1]}) --claim-pk $CLAIM --refund-pk $REFUND --expiration $(field "${LJ[$1]}" stored_expiration); }
rshow() { echo "$1" | js 'o=>`accepted ${o.accepted}; count ${o.block_count_at_redeem}; before ${JSON.stringify(o.stored_before)}; after ${JSON.stringify(o.stored_after)}; txid ${o.txid}; error ${JSON.stringify(o.error)}`'; }

# ---- 3. FORFEIT ON LOCK 1 ----
t=$(now)
SIG1=$(node $HERE/stake-lock-forfeit.mjs $P/keys.json $(field "${LJ[1]}" stored_contract_id) 1,2 | js 'o=>o.signature')
RF=$(HOME=$FH timeout 180 $LOCK_BIN $(REDEEM_ARGS 1) --witness cancel --forfeit-sig $SIG1 --signer-secret $(k playerSecret) 2>&1 | grep '"mode":"redeem"' | tail -1)
E3=$(settled_ecash "$E2"); D3=$(( $(now) - t ))
say "3 FORFEIT lock 1, 2-of-2, redeemed by the player (${D3} ms): $(rshow "$RF"); ecash $E2 -> $E3 msat (+$((E3 - E2)), $((LOCK_MSAT - (E3 - E2))) msat fees)"

# ---- 4. SETTLE LOCKS 2 AND 3 ----
t=$(now)
QPK=$(cd $HERE/.. && node --input-type=module -e "import { secp256k1 } from '@noble/curves/secp256k1.js'; process.stdout.write(Buffer.from(secp256k1.getPublicKey(Buffer.from(process.argv[1], 'hex'), true)).toString('hex'))" $(rnd 32))
LOCKS="$(op 2):${PRE[2]}:$LOCK_MSAT,$(op 3):${PRE[3]}:$LOCK_MSAT"; NONCE=$(rnd 8)
settle() { HOME=$FH timeout 180 $LOCK_BIN --mode settle --data-dir $P/client --claim-pk $CLAIM --locks "$LOCKS" --qualifier-pk $QPK --nonce $NONCE ${1:+--signature $1} 2>&1 | grep '"mode":"settle"' | tail -1; }
TS=$(settle); SIGS=$(node $HERE/stake-lock-forfeit.mjs $P/keys.json $(field "$TS" message_hex) 1,2 | js 'o=>o.signature')
RS=$(settle $SIGS); D4=$(( $(now) - t ))
say "4 SETTLE locks 2 and 3 (${D4} ms): $(echo "$RS" | js 'o=>`accepted ${o.accepted}; count ${o.block_count_at_submit}; locks before ${JSON.stringify(o.locks_before)}; after ${JSON.stringify(o.locks_after)}; payout ${JSON.stringify(o.payout_stored)} = contract ${o.payout_contract_id}, ${o.payout_msat} msat to ${o.qualifier_pk}; fees ${o.input_fees_msat}+${o.output_fee_msat} msat; txid ${o.txid}; error ${JSON.stringify(o.error)}`')"

# ---- 5. REFUND LOCK 4 AFTER EXPIRY ----
EXP4=$(field "${LJ[4]}" stored_expiration)
status() { HOME=$FH timeout 120 $LOCK_BIN --mode status --data-dir $P/client --outpoint $(op 4) 2>&1 | grep '"mode":"status"' | tail -1; }
C_STOP=$(field "$(status)" block_count)
t=$(now)
NEED=$(( EXP4 - C_STOP + 2 ))
bcn -rpcwallet=probe generatetoaddress $NEED $(bcn -rpcwallet=probe getnewaddress) >/dev/null
say "5 EXPIRY: the guardians' count $C_STOP (read with guardian $DOWN down); mined $NEED blocks, bitcoin height -> $(bcn getblockcount); lock 4 expires at $EXP4"
tw=$(now); LAST=-1; SINCE=$tw; REACHED=no
while [ $(( $(now) - tw )) -lt 240000 ]; do
  ST=$(status); C=$(field "$ST" block_count)
  [ "$C" != "$LAST" ] && { say "  +$(( $(now) - tw )) ms: bitcoin height $(bcn getblockcount), the guardians' count $C, lock 4 $(echo "$ST" | js 'o=>JSON.stringify(o.stored)')"; LAST=$C; SINCE=$(now); }
  [ "$C" != "?" ] && [ "$C" -ge "$EXP4" ] && { REACHED=yes; break; }
  [ $(( $(now) - SINCE )) -gt 60000 ] && { say "  THE GUARDIANS' COUNT STOPPED at $C (bitcoin height $(bcn getblockcount), expiry $EXP4) for 60 s"; break; }
  sleep 2
done
[ "$REACHED" = yes ] || { say "EXPIRY NOT REACHED BY THE GUARDIANS - step 6 not complete"; exit 1; }
say "  the count moved $C_STOP -> $C with guardian $DOWN's vote frozen: three votes stand above it, so the third-highest is a live guardian's"
RR=$(HOME=$FH timeout 180 $LOCK_BIN $(REDEEM_ARGS 4) --witness refund --signer-secret $(k playerSecret) 2>&1 | grep '"mode":"redeem"' | tail -1)
E5=$(settled_ecash "$E3"); D5=$(( $(now) - t ))
say "5 REFUND lock 4 by the player (${D5} ms incl. mining and the wait): $(rshow "$RR"); ecash $E3 -> $E5 msat (+$((E5 - E3)), $((LOCK_MSAT - (E5 - E3))) msat fees)"

# ---- 6. WITHDRAW ----
t=$(now)
WINV=$(ln_ alice addinvoice --amt $WITHDRAW_SAT | js 'o=>o.payment_request'); WHASH=$(ln_ alice decodepayreq $WINV | js 'o=>o.payment_hash')
SOP=$(fc module lnv2 send "$WINV" 2>&1 | grep -oE '[0-9a-f]{64}' | head -1)
SENT=$(fc module lnv2 await-send "$SOP" 2>&1 | tr -d '\n ')
E6=$(settled_ecash "$E5"); D6=$(( $(now) - t ))
VIA=$(for w in bob carol; do ln_ $w listpayments 2>/dev/null | js "o=>(o.payments||[]).some(p=>p.payment_hash==='$WHASH'&&p.status==='SUCCEEDED')?'$w':''"; done | tr -d '\n')
say "6 WITHDRAW (${D6} ms): $WITHDRAW_SAT sat to alice's lnd; send $SENT; alice's invoice $(ln_ alice lookupinvoice $WHASH | js 'o=>o.state'); paid by $( [ "$VIA" = carol ] && echo "gateway B (carol's lnd)" || { [ "$VIA" = bob ] && echo "gateway A (bob's lnd)" || echo "no gateway lnd found"; } ); ecash $E5 -> $E6 msat (-$((E5 - E6)), $((E5 - E6 - WITHDRAW_SAT * 1000)) msat fees)"

say "  guardian $DOWN still down at the end: API port $API $(open_port $API), $(ps -o pid= -g $GPID 2>/dev/null | wc -l) processes"
ok() { echo "$1" | js "o=>String($2)"; }
VERDICT="deposit $( [ "$E1" -gt "$E0" ] && echo true || echo false), 4 locks true, forfeit $(ok "$RF" 'o.accepted && o.stored_after===null'), settle $(ok "$RS" 'o.accepted && o.locks_after.every(x=>x===null) && o.payout_stored!==null && o.payout_stored.blocks_left===0'), refund $(ok "$RR" 'o.accepted && o.stored_after===null'), withdraw $( [ -n "$VIA" ] && [ "$E6" -lt "$E5" ] && echo true || echo false), guardian $DOWN down $( [ "$(open_port $API)" = closed ] && echo true || echo false)"
say "STEP 6: $VERDICT"
echo "$VERDICT" | grep -q false && say "STEP 6 NOT MET" || say "STEP 6 MET: with guardian $DOWN down, deposit, four locks, the forfeit, the settlement, the refund after expiry and the withdrawal all completed on three of four"
say "total $(( ($(now) - T0) / 1000 )) s; probe dir: $P"
