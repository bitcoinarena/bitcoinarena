#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md, THE REHEARSAL, STEP 4: "`Refund` after expiry by the player's
# key; before expiry refused".
#
# The stock rule (lnv2-server lib.rs:466-497): Refund passes only when the
# lock's expiration is at or below the guardians' block count, and the
# transaction must be signed by the lock's refund_pk. The guardians' block
# count is the THIRD-highest of four votes (lib.rs:746-765), and step 1
# measured it behind the bitcoin tip - so mining past the expiry is not
# enough: the run waits until the guardians' own count has reached it.
#
#   0. SETUP     tools/stake-lock-step1.sh with STAY_UP=1: the lock, expiring at
#                the guardians' count + 144 (step 1; not re-measured)
#   1. REFUSED   the player's Refund while ~144 blocks remain
#   2. EXPIRY    mine past it on the probe's bitcoind; poll the bitcoin height,
#                the guardians' count and the lock's blocks left until their
#                count reaches it - and if it stops moving, say so and stop
#   3. REFUSED   a Refund after expiry signed by a committee signer node's key, not
#                the player's
#   4. REFUND    the player's Refund after expiry: accepted, the lock gone, the
#                value back as the player's ecash
#
# Everything is stopped at the end: every process group and bitcoind.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> \
#     bash tools/stake-lock-step4.sh
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/stake-lock-step4-XXXXXX)}
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
field() { echo "$1" | js "o=>o.$2"; }

# ---- 0. SETUP: step 1, left running ----
UP=$(STAY_UP=1 PROBE_DIR=$P FEDIMINT_BIN=$F FEDIMINT_HOME=$FH LOCK_BIN=$LOCK_BIN bash $HERE/stake-lock-step1.sh 2>&1)
echo "$UP" | grep -q "STEP1_STATE" && echo "$UP" | grep -q "STEP 1: ACCEPTED" \
  || { say "$UP" | tail -12; say "STEP 1 DID NOT LEAVE A LOCK"; exit 1; }
OUTPOINT="$(l txid):$(l out_idx)"; CID=$(l stored_contract_id); EXP=$(l stored_expiration)
say "SETUP (step 1, not re-measured): lock $OUTPOINT, contract $CID, $(l amount_msat) msat, expires at block $EXP ($(l stored_blocks_left) left at the guardians' count $(l block_count_at_read)); refund_pk $(k refundPk)"
REFUND=(--mode redeem --witness refund --data-dir $P/client --outpoint $OUTPOINT --amount-msat $(l amount_msat) --hash $(k hash)
  --claim-pk $(k claimPk) --refund-pk $(k refundPk) --expiration $EXP)
refund() { HOME=$FH timeout 180 $LOCK_BIN "${REFUND[@]}" --signer-secret "$1" 2>&1 | grep '"mode":"redeem"' | tail -1; }
status() { HOME=$FH timeout 120 $LOCK_BIN --mode status --data-dir $P/client --outpoint $OUTPOINT 2>&1 | grep '"mode":"status"' | tail -1; }
show() { echo "$1" | js 'o=>`accepted ${o.accepted}; signer is the player ${o.signer_is_refund_pk}; guardians\x27 block count ${o.block_count_at_redeem} (expiry ${o.expiration}); before ${JSON.stringify(o.stored_before)}; after ${JSON.stringify(o.stored_after)}; txid ${o.txid}; error ${JSON.stringify(o.error)}`'; }

# ---- 1. REFUSED BEFORE EXPIRY ----
RB=$(refund $(k playerSecret)); HB=$(bcn getblockcount)
say "(before) the player's Refund, ~144 blocks left: $(show "$RB"); bitcoin height $HB"
E0=$(ecash)

# ---- 2. REACH EXPIRY: mine, then wait for the GUARDIANS' count ----
MINE=$(bcn -rpcwallet=probe getnewaddress)
H0=$(bcn getblockcount); C0=$(field "$(status)" block_count)
NEED=$(( EXP - C0 + 2 ))
bcn -rpcwallet=probe generatetoaddress $NEED $MINE >/dev/null
say "EXPIRY: mined $NEED blocks: bitcoin height $H0 -> $(bcn getblockcount); the guardians' count was $C0, expiry $EXP"
t=$(date +%s%3N); LAST=-1; SINCE=$t; REACHED=no
while [ $(( $(date +%s%3N) - t )) -lt 240000 ]; do
  ST=$(status); C=$(field "$ST" block_count)
  if [ "$C" != "$LAST" ]; then
    say "  +$(( $(date +%s%3N) - t )) ms: bitcoin height $(bcn getblockcount), the guardians' count $C, the lock $(echo "$ST" | js 'o=>JSON.stringify(o.stored)')"
    LAST=$C; SINCE=$(date +%s%3N)
  fi
  [ "$C" != "?" ] && [ "$C" -ge "$EXP" ] && { REACHED=yes; break; }
  # A COUNT THAT STOPS MOVING IS REPORTED, not retried: 60 s without a change.
  [ $(( $(date +%s%3N) - SINCE )) -gt 60000 ] && { say "  THE GUARDIANS' COUNT STOPPED at $C (bitcoin height $(bcn getblockcount), expiry $EXP) for 60 s"; break; }
  sleep 2
done
[ "$REACHED" = yes ] || { say "EXPIRY NOT REACHED BY THE GUARDIANS - step 4 not measured"; exit 1; }
say "  the guardians' count reached the expiry $(( $(date +%s%3N) - t )) ms after the mining returned"

# ---- 3. REFUSED AFTER EXPIRY: not the player's key ----
SIGNER_NODE=$(node -e "process.stdout.write(require(process.argv[1]).signerNodes[0].identity)" $P/keys.json)
RW=$(refund $SIGNER_NODE); HW=$(bcn getblockcount)
say "(wrong key) a Refund after expiry signed by committee signer node 1's key: $(show "$RW"); bitcoin height $HW"
E1=$(ecash)

# ---- 4. THE PLAYER'S REFUND ----
RR=$(refund $(k playerSecret)); HR=$(bcn getblockcount)
t=$(date +%s%3N); E2=$(ecash)
for i in $(seq 60); do [ "$E2" != "$E1" ] && break; sleep 1; E2=$(ecash); done
say "REFUND the player's key after expiry: $(show "$RR"); bitcoin height $HR"
say "  player's ecash $E0 -> $E1 (after the wrong key) -> $E2 msat: +$((E2 - E1)) for a $(l amount_msat) msat lock, $(( $(l amount_msat) - (E2 - E1) )) msat fees; the notes arrived $(( $(date +%s%3N) - t )) ms after the refund returned"

ok() { echo "$1" | js "o=>String($2)"; }
VERDICT="refused before expiry $(ok "$RB" '!o.accepted && o.stored_after!==null'), refused with another key $(ok "$RW" '!o.accepted && o.stored_after!==null'), refunded $(ok "$RR" 'o.accepted && o.stored_after===null && o.block_count_at_redeem >= o.expiration')"
say "STEP 4: $VERDICT"
echo "$VERDICT" | grep -q false && say "STEP 4 NOT MET" || say "STEP 4 MET: after expiry the lock came back on the player's own key; before expiry, and with another key, it did not"
say "probe dir: $P"
