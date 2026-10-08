#!/bin/bash
# FEDERATION.md, THE REHEARSAL, STEP 3 (3a): "one settlement transaction:
# losers' locks ... in, payout contracts out; accepted; a 1-of-2 signature
# refused" - without fee locks (their claim hash and the §22A node slots are
# not decided).
#
# The committee cannot give the stock builder a Keypair, so it builds the raw
# transaction itself (tools/stake-lock --mode settle): two losers' locks in as
# Claim(P), one pre-expired payout lock out to a qualifier's key, valued at the
# inputs less the guardians' own LNv2 fees. The guardians want one BIP-340
# signature PER INPUT over the txid, each under that input's key
# (fedimint-core transaction.rs); both locks name the committee, so the
# committee signs the txid once (the repo's FROST 2-of-2) and it is listed
# twice.
#
#   0. SETUP     tools/stake-lock-step1.sh with STAY_UP=1 (a deposit and lock 1,
#                not re-measured), then lock 2 from the same client under the
#                same committee and player keys, with a new secret
#   1. REFUSED   (a) a 1-of-2 signature; (b) the 2-of-2 signature over a
#                settlement carrying a wrong secret for lock 2 - both while
#                the locks are stored
#   2. SETTLE    the 2-of-2 signature over the right settlement: accepted, the
#                locks gone, the payout stored
#   3. REFUSED   (c) the same settlement again: first the same bytes, then the
#                same claims under a new nonce with a new 2-of-2 signature
#
# Everything is stopped at the end: every process group and bitcoind.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> \
#     bash tools/stake-lock-step3.sh
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/stake-lock-step3-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
say() { echo "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1
  sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
k() { node -e "process.stdout.write(String(require(process.argv[1])[process.argv[2]]))" "$P/keys.json" "$1"; }
field() { echo "$1" | js "o=>o.$2"; }
rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1"; }
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(Buffer.from(process.argv[1],"hex")).digest("hex"))' "$1"; }

# ---- 0. SETUP: lock 1 (step 1, left running), then lock 2 ----
UP=$(STAY_UP=1 PROBE_DIR=$P FEDIMINT_BIN=$F FEDIMINT_HOME=$FH LOCK_BIN=$LOCK_BIN bash $HERE/stake-lock-step1.sh 2>&1)
echo "$UP" | grep -q "STEP1_STATE" && echo "$UP" | grep -q "STEP 1: ACCEPTED" \
  || { say "$UP" | tail -12; say "STEP 1 DID NOT LEAVE A LOCK"; exit 1; }
L1=$(cat $P/lock.json)
P1=$(k preimage)
P2=$(rnd 32); H2=$(sha $P2)
L2=$(HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client --amount-msat 980000 --hash $H2 \
  --claim-pk $(k claimPk) --refund-pk $(k refundPk) --expiry-delta 144 2>&1 | grep '"stored_contract_id"' | tail -1)
[ -n "$L2" ] && [ "$(field "$L2" ids_match)" = true ] || { say "LOCK 2 FAILED: $L2"; exit 1; }
for n in 1 2; do eval "L=\$L$n"; say "LOCK $n: $(field "$L" txid):$(field "$L" out_idx), contract $(field "$L" stored_contract_id), expires at block $(field "$L" stored_expiration) ($(field "$L" stored_blocks_left) left at count $(field "$L" block_count_at_read)), $(field "$L" amount_msat) msat, claim_pk $(field "$L" claim_pk)"; done
OP1="$(field "$L1" txid):$(field "$L1" out_idx)"; OP2="$(field "$L2" txid):$(field "$L2" out_idx)"
QSECRET=$(rnd 32)
QPK=$(cd $HERE/.. && node --input-type=module -e "import { secp256k1 } from '@noble/curves/secp256k1.js'; process.stdout.write(Buffer.from(secp256k1.getPublicKey(Buffer.from(process.argv[1], 'hex'), true)).toString('hex'))" $QSECRET)
[ ${#QPK} -eq 66 ] || { say "NO QUALIFIER KEY: $QPK"; exit 1; }
say "QUALIFIER key $QPK"

settle() {  # $1 locks, $2 nonce, [$3 signature]
  HOME=$FH timeout 180 $LOCK_BIN --mode settle --data-dir $P/client --claim-pk $(k claimPk) \
    --locks "$1" --qualifier-pk $QPK --nonce $2 ${3:+--signature $3} 2>&1 | grep '"mode":"settle"' | tail -1
}
sign() { node $HERE/stake-lock-forfeit.mjs $P/keys.json $1 $2 | js 'o=>o.signature'; }
show() { echo "$1" | js 'o=>`accepted ${o.accepted}; signature verifies under claim_pk ${o.signature_verifies_under_claim_pk} (listed ${o.signatures_listed}x); block count ${o.block_count_at_submit}; locks before ${JSON.stringify(o.locks_before)}; after ${JSON.stringify(o.locks_after)}; payout ${JSON.stringify(o.payout_stored)}; txid ${o.txid}; error ${JSON.stringify(o.error)}`'; }
GOOD="$OP1:$P1:980000,$OP2:$P2:980000"
BAD="$OP1:$P1:980000,$OP2:$(rnd 32):980000"

# ---- 1. REFUSED WHILE THE LOCKS ARE STORED ----
NA=$(rnd 8); TA=$(settle "$GOOD" $NA)
say "SETTLEMENT (as built): $(echo "$TA" | js 'o=>`in ${o.input_msat} msat over ${o.inputs.length} locks; fee rule base ${o.fee_base_msat} msat + ${o.fee_ppm} ppm per item; input fees ${o.input_fees_msat}; payout ${o.payout_msat}; output fee ${o.output_fee_msat}; unspent ${o.unspent_msat}`')"
RA=$(settle "$GOOD" $NA $(sign $(field "$TA" message_hex) 1))
say "(a) 1-of-2 signature: $(show "$RA")"
NB=$(rnd 8); TB=$(settle "$BAD" $NB)
RB=$(settle "$BAD" $NB $(sign $(field "$TB" message_hex) 1,2))
say "(b) 2-of-2 signature, a wrong secret for lock 2: $(show "$RB")"

# ---- 2. THE SETTLEMENT ----
NS=$(rnd 8); TS=$(settle "$GOOD" $NS); SIGS=$(sign $(field "$TS" message_hex) 1,2)
RS=$(settle "$GOOD" $NS $SIGS)
say "SETTLE 2-of-2 signature: $(show "$RS")"
say "  payout contract $(field "$RS" payout_contract_id) at $(field "$RS" txid):0, $(field "$RS" payout_msat) msat to the qualifier; the guardians stored it after $(field "$RS" payout_wait_ms) ms"
say "  fees: $(field "$RS" input_msat) in - $(field "$RS" payout_msat) out = $(( $(field "$RS" input_msat) - $(field "$RS" payout_msat) )) msat ($(field "$RS" input_fees_msat) on the inputs, $(field "$RS" output_fee_msat) on the output, $(field "$RS" unspent_msat) unspent)"

# ---- 3. REFUSED AFTER ----
RC1=$(settle "$GOOD" $NS $SIGS)
say "(c1) the same settlement bytes again: $(show "$RC1")"
NC=$(rnd 8); TC=$(settle "$GOOD" $NC)
RC2=$(settle "$GOOD" $NC $(sign $(field "$TC" message_hex) 1,2))
say "(c2) the same claims, a new nonce, a new 2-of-2 signature: $(show "$RC2")"

ok() { echo "$1" | js "o=>String($2)"; }
VERDICT="refused (a) $(ok "$RA" '!o.accepted'), refused (b) $(ok "$RB" '!o.accepted'), settled $(ok "$RS" 'o.accepted && o.locks_after.every(x=>x===null) && o.payout_stored!==null && o.payout_stored.blocks_left===0'), refused (c2) $(ok "$RC2" '!o.accepted')"
say "STEP 3a: $VERDICT; (c1) accepted $(ok "$RC1" 'o.accepted')"
echo "$VERDICT" | grep -q false && say "STEP 3a NOT MET" || say "STEP 3a MET: one committee signature settled both losers' locks into one payout, and the three wrong settlements were refused"
say "probe dir: $P"
