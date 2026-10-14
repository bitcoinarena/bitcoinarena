#!/bin/bash
# FEDERATION.md REHEARSAL 17, LIQUIDATION ON REGTEST (§23A.5, kanban #326 / #323): "a 4-guardian federation (3 of 4) with notes
# in three wallets at 90% of its cap; two guardians abandon, attested and slashed into the escrow; the federation halts for
# abandon_blocks; the two seated guardians publish the spent set; each wallet's client presents its notes ... and is paid at
# face from the escrow; a note already spent is refused; the remainder goes 75% / 25%; then the same with no spent set
# published, paid pro rata, the rate shown".
#   1. federation-hold-probe's 4 guardians (3 of 4) and one gateway - fedimintd from the fork WITH the blwp_spent_nonces
#      patch (tools/fedimint-spent-nonces.patch); the chain half (bonds, proofs, slashes, claims) is tools/rehearsal-17.mjs.
#   2. p1, p2, p3 each paid in PAY_MSAT over LNv2: 3 x 300,000 sat = 90 % of the cap of 4 bonds of 500,000 sat.
#   3. p3 sends 100,000 sat of notes to p1 (mintv2 send, out of band), p1 receives (reissues) them: those nonces are spent; p3 keeps the string.
#   4. g3 stops (abandoned, slashed); then g2 stops: the federation is HALTED (2 seated, 2f + 1 = 3).
#   5. g0 and g1, still seated, each give their copy of the spent set (their own guardian, through spent-set-producer.js).
#   6. every wallet hands over its notes, the federation halted; the claims and the tables.
# Heavy (4 fedimintd, 2 lnd, a gatewayd, bitcoind): the test host load rule applies. Nothing here reaches testnet4.
#   FEDIMINT_BIN=<patched fork bin dir> bash tools/rehearsal-17-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-2400}
if [ -z "${R17_WRAPPED:-}" ]; then export R17_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/r17-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
PAY_MSAT=${PAY_MSAT:-300000000}       # 300,000 sat per wallet
SPEND_MSAT=${SPEND_MSAT:-100000000}   # what p3 hands to p1
BTC_ARGS="-datadir=$P/btc -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp"
bcn() { $B/bitcoin-cli $BTC_ARGS "$@"; }
bc() { bcn -rpcwallet=probe "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
ln_() { $L/lncli --lnddir=$P/$1 --rpcserver=127.0.0.1:$2 --network=regtest "${@:3}"; }
alice() { ln_ alice 30107 "$@"; }
cl() { local d=$1; shift; HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/$d "$@"; }
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; echo "GAVE UP waiting for $what"; exit 1; }
ecash() { cl $1 info 2>/dev/null | js 'o=>Number(o.total_amount_msat)'; }
r17() { (cd $HERE/.. && P=$P BITCOIN_CLI=$B/bitcoin-cli BTC_ARGS="$BTC_ARGS -rpcwallet=probe" FEDIMINT_CLI=$F/fedimint-cli FEDIMINT_HOME=$FH FED=${FED:-} INVITE=${INV:-} \
  node tools/rehearsal-17.mjs "$@"); }
gstop() { local pid=$(grep " fedimintd-$1\$" $P/pids | cut -d' ' -f1); kill -TERM -- -$pid 2>/dev/null; sleep 3; echo "{\"step\":\"g$1 stopped\",\"height\":$(bcn getblockcount)}"; }
session() { cl client dev api session_count null --peer-id 0 2>/dev/null | js 'o=>Number(o.value!==undefined?o.value:o)'; }
t0=$(date +%s)

# ---- 1. THE FEDERATION, ONE GATEWAY ----
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH BITCOIN_BIN=$B LND_BIN=$L bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" > $P/setup.log
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
INV=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
FED=$(cl client info | js 'o=>o.federation_id')
for g in 0 1 2 3; do printf probe > $P/g$g/admin-password; done   # as a seat's guardian dir keeps it
echo "{\"step\":\"federation up\",\"federation\":\"$FED\",\"s\":$(( $(date +%s) - t0 ))}"
r17 bonds || exit 1

# ---- 2. THREE WALLETS AT 90 % OF THE CAP ----
for p in p1 p2 p3; do
  mkdir -p $P/$p; cl $p join "$INV" >/dev/null
  R=$(cl $p module lnv2 receive $PAY_MSAT --gateway http://127.0.0.1:30170 2>&1)
  INVOICE=$(echo "$R" | grep -oE 'lnbcrt[0-9a-z]+' | head -1); OP=$(echo "$R" | grep -oE '[0-9a-f]{64}' | head -1)
  alice payinvoice --force "$INVOICE" > $P/$p-pay.out 2>&1
  cl $p module lnv2 await-receive "$OP" > /dev/null 2>&1
done
echo "{\"step\":\"wallets funded\",\"p1\":$(ecash p1),\"p2\":$(ecash p2),\"p3\":$(ecash p3)}"

# ---- 3. A NOTE SPENT: p3 hands notes to p1, p1 reissues them ----
mkdir -p $P/claims
S0=$(session)
SPENT=$(cl p3 module mintv2 send $SPEND_MSAT 2>$P/p3-spend.err); echo "$SPENT" > $P/p3-spend.out   # a halted client logs WARN lines: stderr apart
NOTES=$(echo "$SPENT" | js 'o=>typeof o==="string"?o:""')
[ -n "$NOTES" ] && [ "$NOTES" != '?' ] || { echo "{\"step\":\"p3 spend FAILED\",\"said\":$(echo "$SPENT" | tail -3 | js 'o=>JSON.stringify(o)' 2>/dev/null || echo null)}"; tail -5 $P/p3-spend.out; exit 1; }
printf '%s' "$NOTES" > $P/claims/p3-spent.ecash
REISSUE=$(cl p1 module mintv2 receive "$NOTES" 2>&1 | tr -d '\n' | cut -c1-200)
sessioned() { local s=$(session); [ "$s" != '?' ] && [ "$s" -ge $(( S0 + 2 )) ]; }
until_ "two sessions after the reissue" 300 sessioned
echo "{\"step\":\"p3 handed $SPEND_MSAT msat to p1, reissued\",\"reissue\":$(printf '%s' "$REISSUE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'),\"p1\":$(ecash p1),\"p3\":$(ecash p3),\"sessionBefore\":$S0,\"sessionNow\":$(session)}"

# ---- 4. g3 ABANDONS (slashed), THEN g2: HALTED ----
gstop 3
r17 abandon 3 0,1,2 || exit 1
# ---- 4b. A RECEIVE STILL IN ISSUANCE AT THE HALT (spec §23A.5 "Notes still in issuance at the halt"): p2 hands itself notes and
# g2 stops PEND_DELAY s after the receive went in - the transaction accepted on three, its new notes short of a third share
PEND=$(cl p2 module mintv2 send ${PEND_MSAT:-50000000} 2>$P/p2-pend.err | js 'o=>typeof o==="string"?o:""')
[ -n "$PEND" ] && [ "$PEND" != '?' ] || { echo '{"step":"p2 self-send FAILED"}'; exit 1; }
( cl p2 module mintv2 receive "$PEND" > $P/p2-pend-receive.out 2>&1 & )
sleep ${PEND_DELAY:-1}
gstop 2
r17 abandon 2 0,1 || exit 1
sleep 5
echo "{\"step\":\"p2's receive at the halt\",\"said\":$(head -c 300 $P/p2-pend-receive.out | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')}"

# ---- 5. THE SEATED GUARDIANS' SPENT SET ----
r17 spentset 0,1 || exit 1

# ---- 5b. THE ISSUED SET (one answering guardian's recovery items) AND p2'S PENDING OUTPUTS, the federation halted ----
cl client dev api recovery_slice '[0,1000000]' --peer-id 0 --module mintv2 > $P/claims/issued.json 2>$P/issued.err
echo "{\"step\":\"issued set from g0\",\"bytes\":$(wc -c < $P/claims/issued.json),\"head\":$(head -c 240 $P/claims/issued.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')}"
cl p2 module mintv2 pending-outputs > $P/claims/p2-pending.json 2>$P/p2-pending.err
echo "{\"step\":\"p2's pending outputs\",\"said\":$(head -c 400 $P/claims/p2-pending.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')}"

# ---- 6. EVERY WALLET HANDS OVER ITS NOTES, THE FEDERATION HALTED ----
for p in p1 p2 p3; do
  have=$(ecash $p); t=$(date +%s%N 2>/dev/null || date +%s)
  H=$(cl $p module mintv2 send $have 2>$P/$p-handover.err); echo "$H" > $P/$p-handover.out
  N=$(echo "$H" | js 'o=>typeof o==="string"?o:""')
  if [ -n "$N" ] && [ "$N" != '?' ]; then printf '%s' "$N" > $P/claims/$p.ecash; ok=true; else ok=false; fi
  echo "{\"step\":\"$p hands over its notes, halted\",\"msat\":$have,\"ok\":$ok,\"warnings\":$(grep -c WARN $P/$p-handover.err),\"said\":$( (cat $P/$p-handover.err; cat $P/$p-handover.out) | tail -c 160 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')}"
done
r17 claims
echo "{\"step\":\"done\",\"s\":$(( $(date +%s) - t0 )),\"dir\":\"$P\"}"
