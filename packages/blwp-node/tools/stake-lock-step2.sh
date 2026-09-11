#!/bin/bash
# FEDERATION.md, THE REHEARSAL, STEP 2: "the committee's forfeit, redeemed by
# the player".
#
# A forfeit is a BIP-340 signature by the lock's claim_pk over its contract id;
# the guardians spend the lock with Cancel(sig) and want the TRANSACTION
# signed by the lock's refund_pk (lnv2-server lib.rs:491-497). So the
# committee only signs; the player's own client redeems.
#
#   0. SETUP     tools/stake-lock-step1.sh with STAY_UP=1: stock fedimintd
#                0.12.0, 4 guardians 3 of 4, one gateway, a deposit and the
#                lock (step 1; not re-measured here)
#   1. FORFEIT   both committee seats sign the contract id (the repo's FROST
#                2-of-2, tools/stake-lock-forfeit.mjs); checked locally
#   2. REFUSED   (a) a forfeit signed by one seat alone, (b) the 2-of-2
#                forfeit in a transaction signed by a committee seat's key -
#                both submitted while the lock is still there
#   3. REDEEM    the player's client spends the lock with the 2-of-2 forfeit,
#                signed by the player's key; the value returns as ecash
#   4. REFUSED   (c) the same redeem again, after it succeeded
#
# Everything is stopped at the end: every process group and bitcoind.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> \
#     bash tools/stake-lock-step2.sh
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/stake-lock-step2-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
say() { echo "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
fc() { HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/client "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1
  sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
ecash() { fc info 2>/dev/null | js 'o=>Number(o.total_amount_msat)'; }
k() { node -e "process.stdout.write(String(require(process.argv[1])[process.argv[2]]))" "$P/keys.json" "$1"; }
l() { node -e "process.stdout.write(String(require(process.argv[1])[process.argv[2]]))" "$P/lock.json" "$1"; }

# ---- 0. SETUP: step 1, left running ----
UP=$(STAY_UP=1 PROBE_DIR=$P FEDIMINT_BIN=$F FEDIMINT_HOME=$FH LOCK_BIN=$LOCK_BIN bash $HERE/stake-lock-step1.sh 2>&1)
echo "$UP" | grep -q "STEP1_STATE" && echo "$UP" | grep -q "STEP 1: ACCEPTED" \
  || { say "$UP" | tail -12; say "STEP 1 DID NOT LEAVE A LOCK"; exit 1; }
OUTPOINT="$(l txid):$(l out_idx)"; CID=$(l stored_contract_id); EXP=$(l stored_expiration)
say "SETUP (step 1, not re-measured): lock $OUTPOINT, contract $CID, expires at block $EXP"
REDEEM=(--mode redeem --data-dir $P/client --outpoint $OUTPOINT --amount-msat $(l amount_msat) --hash $(k hash)
  --claim-pk $(k claimPk) --refund-pk $(k refundPk) --expiration $EXP)
redeem() { HOME=$FH timeout 180 $LOCK_BIN "${REDEEM[@]}" --forfeit-sig "$1" --signer-secret "$2" 2>&1 | grep '"mode":"redeem"' | tail -1; }
show() { echo "$1" | js 'o=>`accepted ${o.accepted}; forfeit verifies under claim_pk ${o.forfeit_verifies_under_claim_pk}; signer is the player ${o.signer_is_refund_pk}; block count ${o.block_count_at_redeem}; before ${JSON.stringify(o.stored_before)}; after ${JSON.stringify(o.stored_after)}; txid ${o.txid}; error ${JSON.stringify(o.error)}`'; }

# ---- 1. THE COMMITTEE'S FORFEIT ----
F2=$(node $HERE/stake-lock-forfeit.mjs $P/keys.json $CID 1,2); SIG2=$(echo "$F2" | js 'o=>o.signature')
F1=$(node $HERE/stake-lock-forfeit.mjs $P/keys.json $CID 1); SIG1=$(echo "$F1" | js 'o=>o.signature')
say "FORFEIT 2 of 2: $SIG2 - verifies under claim_pk $(k claimPk): $(echo "$F2" | js 'o=>o.verifiesUnderClaimPk')"
say "  one seat alone: $SIG1 - verifies: $(echo "$F1" | js 'o=>o.verifiesUnderClaimPk')"
E0=$(ecash)

# ---- 2. REFUSED WHILE THE LOCK IS THERE ----
RA=$(redeem $SIG1 $(k playerSecret))
say "(a) 1-of-2 forfeit, signed by the player: $(show "$RA")"
SEAT=$(node -e "process.stdout.write(require(process.argv[1]).seats[0].identity)" $P/keys.json)
RB=$(redeem $SIG2 $SEAT)
say "(b) 2-of-2 forfeit, transaction signed by committee seat 1's key: $(show "$RB")"
E1=$(ecash)

# ---- 3. THE PLAYER'S REDEEM ----
RR=$(redeem $SIG2 $(k playerSecret))
# THE REDEEMED ECASH ARRIVES AFTER ACCEPTANCE, not with it: the client issues
# the notes once the guardians have signed them. Measured first: read at
# once, the balance had not moved; read after (c) it had. So it is waited for.
t=$(date +%s%3N); E2=$(ecash)
for i in $(seq 60); do [ "$E2" != "$E1" ] && break; sleep 1; E2=$(ecash); done
say "  (the redeemed ecash showed up $(( $(date +%s%3N) - t )) ms after the redeem returned)"
say "REDEEM 2-of-2 forfeit, signed by the player: $(show "$RR")"
say "  player's ecash $E0 -> $E1 (after a, b) -> $E2 msat: +$((E2 - E1)) for a $(l amount_msat) msat lock, $(( $(l amount_msat) - (E2 - E1) )) msat fees"

# ---- 4. REFUSED AFTER ----
RC=$(redeem $SIG2 $(k playerSecret))
E3=$(ecash)
say "(c) the same redeem again: $(show "$RC")"
say "  player's ecash after (c): $E3 msat"

ok() { echo "$1" | js "o=>String($2)"; }
VERDICT="refused (a) $(ok "$RA" '!o.accepted'), refused (b) $(ok "$RB" '!o.accepted'), redeemed $(ok "$RR" 'o.accepted && o.stored_after===null && o.block_count_at_redeem < o.expiration'), refused (c) $(ok "$RC" '!o.accepted')"
say "STEP 2: $VERDICT"
echo "$VERDICT" | grep -q false && say "STEP 2 NOT MET" || say "STEP 2 MET: the guardians took the player's redeem of the committee's 2-of-2 forfeit and refused all three"
say "probe dir: $P"
