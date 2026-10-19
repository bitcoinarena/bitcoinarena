#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md, THE REHEARSAL, STEP 7: "no single key and no macaroon moves a
# round's money".
#
# The only way to move a stake lock (an OutgoingContract) is a fedimint
# Transaction that spends it at process_input (lnv2-server lib.rs:468); its
# witness needs claim_pk (Claim/Cancel) and/or a tx signed by refund_pk
# (Cancel/Refund). So this shows, on one live federation:
#
#   A. NO MACAROON HAS A PATH (source, not a submission): the only lnv2 admin
#      endpoints are add/remove-gateway (lib.rs:705-724) - neither spends a
#      contract; gatewayd has no command that touches a foreign contract; one
#      guardian is 1 of 4, below threshold 3. A gateway's or a guardian's
#      credential is never an input to a lock's witness. A guardian admin call
#      (audit) and a gateway call (info) are run to show they answer but offer
#      no spend.
#   B. A WRONG KEY IS REFUSED (real submissions against one live lock):
#      1. Cancel, forfeit signed by 1 of 2 committee signer nodes  -> forfeit invalid
#      2. Cancel, valid 2-of-2 forfeit, tx signed by a committee SIGNER NODE's key,
#         not the player -> tx signature invalid (lnd/guardian private keys
#         cannot be extracted and need not be: the check is against refund_pk,
#         so any non-player key fails identically; a committee insider's own
#         key is used as that key)
#      3. Refund before expiry, the player's key            -> locktime not passed
#      4. Claim (settle) with a wrong secret                -> preimage invalid
#      5. a second spend of an already-redeemed lock        -> no contract found
#   Then the LEGITIMATE paths still work on the same federation: the 2-of-2
#   forfeit redeemed by the player, one committee settlement, and the player's
#   own post-expiry refund.
#
# B1/B3/B4/B5 confirm steps 2/3a/4 on one lock; the step-7 addition is A and
# B2 together - no outside credential, and no single insider key, moves it.
#
# Everything is stopped at the end: every process group and bitcoind.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> \
#     bash tools/stake-lock-step7.sh
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/stake-lock-step7-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
DEPOSIT_MSAT=5000000
LOCK_MSAT=980000
WITHDRAW_SAT=500
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
signer_node_secret() { node -e "process.stdout.write(String(require(process.argv[1]).signerNodes[Number(process.argv[2])].identity))" "$P/keys.json" "$1"; }
field() { echo "$1" | js "o=>o.$2"; }
rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1"; }
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(Buffer.from(process.argv[1],"hex")).digest("hex"))' "$1"; }
T0=$(now)

# ---- SETUP: four guardians, both gateways ----
UP=$(PROBE_DIR=$P SETUP_ONLY=1 SECOND_GATEWAY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q "FEDERATION_READY.*gateway_b=" || { say "$UP" | tail -15; say "THE FEDERATION DID NOT COME UP"; exit 1; }
say "SETUP in $(( ($(now) - T0) / 1000 )) s: fedimintd $(HOME=$FH $F/fedimintd --version 2>/dev/null | head -1), threshold $(fc config 2>/dev/null | js 'o=>{const n=Object.keys(o.global.api_endpoints).length;return n-Math.floor((n-1)/3)+" of "+n}'); gateways $(fc module lnv2 gateways list 2>/dev/null | js 'o=>JSON.stringify(o)')"

# ---- A. NO MACAROON HAS A PATH ----
say "A NO MACAROON MOVES A LOCK (source: lnv2-server lib.rs:468 is the only spend; admin endpoints lib.rs:705-724 are add/remove-gateway only; gatewayd has no foreign-contract command):"
say "  a guardian admin credential (guardian 0) answers admin audit but has no spend endpoint: $(fc --our-id 0 --password probe admin audit 2>&1 | short)"
say "  a gateway credential answers info but has no spend endpoint: $(HOME=$FH timeout 60 $F/gateway-cli -a http://127.0.0.1:30170 --rpcpassword probe info 2>&1 | js 'o=>`gateway_id ${(o.gateway_id||"?").slice(0,16)}, ${(o.federations||[]).length} federation(s)`' 2>/dev/null || echo answered)"

# ---- DEPOSIT AND FOUR LOCKS ----
E0=$(ecash)
RECV=$(fc module lnv2 receive $DEPOSIT_MSAT 2>&1); INVOICE=$(echo "$RECV" | grep -oE 'lnbcrt[0-9a-z]+' | head -1); OP=$(echo "$RECV" | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$INVOICE" ] || { say "NO INVOICE: $(echo "$RECV" | short)"; exit 1; }
timeout 120 $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:30107 --network=regtest payinvoice --force "$INVOICE" >/dev/null 2>&1
fc module lnv2 await-receive "$OP" >/dev/null 2>&1
E1=$(settled_ecash "$E0")
say "DEPOSIT $DEPOSIT_MSAT msat -> ecash $E1 msat (fee $((DEPOSIT_MSAT - (E1 - E0))))"
node $HERE/stake-lock-keys.mjs $P/keys.json >/dev/null
CLAIM=$(k claimPk); REFUND=$(k refundPk)
declare -A PRE LJ
PRE[1]=$(k preimage); for n in 2 3 4; do PRE[$n]=$(rnd 32); done
for n in 1 2 3 4; do
  LJ[$n]=$(HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client --amount-msat $LOCK_MSAT --hash $(sha ${PRE[$n]}) \
    --claim-pk $CLAIM --refund-pk $REFUND --expiry-delta 144 2>&1 | grep '"stored_contract_id"' | tail -1)
  [ -n "${LJ[$n]}" ] && [ "$(field "${LJ[$n]}" ids_match)" = true ] || { say "LOCK $n FAILED: ${LJ[$n]}"; exit 1; }
done
say "FOUR LOCKS at $LOCK_MSAT msat, expiry block $(field "${LJ[1]}" stored_expiration); claim_pk $CLAIM; refund_pk $REFUND"
op() { echo "$(field "${LJ[$1]}" txid):$(field "${LJ[$1]}" out_idx)"; }
RA() { echo --mode redeem --data-dir $P/client --outpoint $(op $1) --amount-msat $LOCK_MSAT --hash $(sha ${PRE[$1]}) --claim-pk $CLAIM --refund-pk $REFUND --expiration $(field "${LJ[$1]}" stored_expiration); }
redeem() { HOME=$FH timeout 180 $LOCK_BIN $(RA $1) "${@:2}" 2>&1 | grep '"mode":"redeem"' | tail -1; }
rshow() { echo "$1" | js 'o=>`accepted ${o.accepted}; after ${JSON.stringify(o.stored_after)}; error ${JSON.stringify(o.error)}`'; }
CID1=$(field "${LJ[1]}" stored_contract_id)
SIG1_1=$(node $HERE/stake-lock-forfeit.mjs $P/keys.json $CID1 1 | js 'o=>o.signature')
SIG1_12=$(node $HERE/stake-lock-forfeit.mjs $P/keys.json $CID1 1,2 | js 'o=>o.signature')

say ""
say "B WRONG KEYS AND SPENDS, EACH REFUSED (real submissions against live locks):"
# B1: one-signer node forfeit on lock 1
B1=$(redeem 1 --witness cancel --forfeit-sig $SIG1_1 --signer-secret $(k playerSecret))
say "  B1 Cancel, forfeit by 1 of 2 committee signer nodes: $(rshow "$B1")"
# B2: valid 2-of-2 forfeit but tx signed by committee signer node 0's key, not the player
B2=$(redeem 1 --witness cancel --forfeit-sig $SIG1_12 --signer-secret $(signer_node_secret 0))
say "  B2 Cancel, valid 2-of-2 forfeit, tx signed by a committee signer node's key (not the player): $(rshow "$B2")"
# B3: player Refund before expiry on lock 4
B3=$(redeem 4 --witness refund --signer-secret $(k playerSecret))
say "  B3 Refund before expiry, the player's key: $(rshow "$B3")"
# B4: settle locks 2,3 with a wrong secret for lock 3
QPK=$(cd $HERE/.. && node --input-type=module -e "import { secp256k1 } from '@noble/curves/secp256k1.js'; process.stdout.write(Buffer.from(secp256k1.getPublicKey(Buffer.from(process.argv[1],'hex'),true)).toString('hex'))" $(rnd 32))
NB4=$(rnd 8); BADLOCKS="$(op 2):${PRE[2]}:$LOCK_MSAT,$(op 3):$(rnd 32):$LOCK_MSAT"
settleB4() { HOME=$FH timeout 180 $LOCK_BIN --mode settle --data-dir $P/client --claim-pk $CLAIM --locks "$BADLOCKS" --qualifier-pk $QPK --nonce $NB4 ${1:+--signature $1} 2>&1 | grep '"mode":"settle"' | tail -1; }
TB4=$(settleB4); B4=$(settleB4 $(node $HERE/stake-lock-forfeit.mjs $P/keys.json $(field "$TB4" message_hex) 1,2 | js 'o=>o.signature'))
say "  B4 Claim (settle) with a wrong secret for lock 3: $(echo "$B4" | js 'o=>`accepted ${o.accepted}; locks after ${JSON.stringify(o.locks_after)}; error ${JSON.stringify(o.error)}`')"

say ""
say "LEGITIMATE PATHS ON THE SAME FEDERATION:"
E2=$(ecash)
# forfeit lock 1, 2-of-2, player
LF=$(redeem 1 --witness cancel --forfeit-sig $SIG1_12 --signer-secret $(k playerSecret)); E3=$(settled_ecash "$E2")
say "  FORFEIT lock 1, 2-of-2, player: $(rshow "$LF"); ecash +$((E3 - E2))"
# B5: second spend of lock 1, now gone
B5=$(redeem 1 --witness cancel --forfeit-sig $SIG1_12 --signer-secret $(k playerSecret))
say "  B5 a second spend of the redeemed lock 1: $(rshow "$B5")"
# settlement locks 2,3, correct
NS=$(rnd 8); GOOD="$(op 2):${PRE[2]}:$LOCK_MSAT,$(op 3):${PRE[3]}:$LOCK_MSAT"
settleS() { HOME=$FH timeout 180 $LOCK_BIN --mode settle --data-dir $P/client --claim-pk $CLAIM --locks "$GOOD" --qualifier-pk $QPK --nonce $NS ${1:+--signature $1} 2>&1 | grep '"mode":"settle"' | tail -1; }
TS=$(settleS); LS=$(settleS $(node $HERE/stake-lock-forfeit.mjs $P/keys.json $(field "$TS" message_hex) 1,2 | js 'o=>o.signature'))
say "  SETTLE locks 2,3: $(echo "$LS" | js 'o=>`accepted ${o.accepted}; payout ${JSON.stringify(o.payout_stored)}; ${o.payout_msat} msat; error ${JSON.stringify(o.error)}`')"
# refund lock 4 after expiry
EXP4=$(field "${LJ[4]}" stored_expiration)
status4() { HOME=$FH timeout 120 $LOCK_BIN --mode status --data-dir $P/client --outpoint $(op 4) 2>&1 | grep '"mode":"status"' | tail -1; }
C0=$(field "$(status4)" block_count)
bcn -rpcwallet=probe generatetoaddress $(( EXP4 - C0 + 2 )) $(bcn -rpcwallet=probe getnewaddress) >/dev/null
tw=$(now); REACHED=no
while [ $(( $(now) - tw )) -lt 200000 ]; do
  C=$(field "$(status4)" block_count)
  [ "$C" != "?" ] && [ "$C" -ge "$EXP4" ] && { REACHED=yes; break; }
  sleep 3
done
[ "$REACHED" = yes ] || { say "  the guardians' count did not reach $EXP4 - refund not measured"; exit 1; }
E4=$(ecash); LR=$(redeem 4 --witness refund --signer-secret $(k playerSecret)); E5=$(settled_ecash "$E4")
say "  REFUND lock 4 after expiry, player (count reached $EXP4): $(rshow "$LR"); ecash +$((E5 - E4))"

say ""
ok() { echo "$1" | js "o=>String($2)"; }
VERDICT="B1 refused $(ok "$B1" '!o.accepted'), B2 refused $(ok "$B2" '!o.accepted'), B3 refused $(ok "$B3" '!o.accepted'), B4 refused $(ok "$B4" '!o.accepted'), B5 refused $(ok "$B5" '!o.accepted'); forfeit $(ok "$LF" 'o.accepted'), settle $(ok "$LS" 'o.accepted'), refund $(ok "$LR" 'o.accepted')"
say "STEP 7: $VERDICT"
echo "$VERDICT" | grep -q false && say "STEP 7 NOT MET" || say "STEP 7 MET: no single key and no macaroon moved a lock; the committee-threshold and player paths did"
say "total $(( ($(now) - T0) / 1000 )) s; probe dir: $P"
