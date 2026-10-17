#!/bin/bash
# THE STAKE-LOCK TOOL'S TWO NEW MODES ON A REGTEST FEDERATION (kanban #397, the owner 2026-10-17 decision A: "Add the two receive-and-claim
# modes to the stake-lock tool ... the two tool additions tested on the test host against the regtest probe federation"):
#   receive-to-key   an invoice of the federation's gateway whose incoming contract only a given key can claim, its preimage a seed's hash
#   claim-incoming   that contract, once funded, claimed into one pre-expired output to the key - signed by the claim key alone
# On federation-hold-probe's regtest (4 guardians, a gateway on bob's lnd, alice paying). The claim key here is a plain test key: the
# tool takes any BIP-340 signature under it (on the seats it is the 5-of-7 FROST one). Checks, each printed:
#   1. the invoice: for exactly the amount, its payment hash sha256(sha256(seed)), the contract claimed by the key
#   2. before payment: funded false, and the commitment (claim key, payment hash) readable
#   3. a wrong seed: refused
#   4. alice pays the invoice
#   5. funded: the claim's 32 bytes and its payout
#   6. a signature by another key: refused
#   7. the key's signature: accepted, the payout stored under the key
#   8. the same claim again: not accepted
# Heavy (4 fedimintd, 2 lnd, a gatewayd, bitcoind): the test host only. Nothing here reaches testnet4.
#   FEDIMINT_BIN=<dir with fedimintd gatewayd fedimint-cli gateway-cli> LOCK_BIN=<blwp-stake-lock> BITCOIN_BIN=... LND_BIN=... \
#     bash tools/reserve-move-tool-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1500}
if [ -z "${RMT_WRAPPED:-}" ]; then export RMT_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}" "${LOCK_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/rmt-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
AMOUNT_MSAT=${AMOUNT_MSAT:-50000000}
BTC_ARGS="-datadir=$P/btc -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp"
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  $B/bitcoin-cli $BTC_ARGS stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
alice() { $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:30107 --network=regtest "$@"; }
tool() { HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client "$@"; }
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s.trim().split('\n').pop());process.stdout.write(String(($1)(o)))}catch(e){process.stdout.write('?')}})"; }
say() { echo "{\"step\":\"$1\",\"s\":$(( $(date +%s) - t0 ))${2:+,$2}}"; }
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); say "PASS $1" "\"got\":\"$2\""; else fail=$((fail+1)); say "FAIL $1" "\"got\":\"$2\",\"want\":\"$3\""; fi; }
t0=$(date +%s)

UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH BITCOIN_BIN=$B LND_BIN=$L bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" > $P/setup.log
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
GW=$(echo "$UP" | grep -oE 'gateway=[^ ]+' | tail -1 | cut -d= -f2-)
say "federation up" "\"gateway\":\"$GW\""

# A TEST CLAIM KEY (any BIP-340 key: on the seats the 5-of-7 reserve key), another key, a seed
KEYS=$(cd $HERE/.. && node --input-type=module -e "
const { schnorr, secp256k1 } = await import('@noble/curves/secp256k1.js');
const h = (b) => Buffer.from(b).toString('hex');
const even = () => { for (;;) { const k = secp256k1.utils.randomSecretKey(); if (secp256k1.getPublicKey(k, true)[0] === 2) return k; } };
const a = even(), b = even(), seed = crypto.getRandomValues(new Uint8Array(32));
console.log([h(a), h(secp256k1.getPublicKey(a, true)), h(b), h(seed)].join(' '));")
read SK PK SK2 SEED <<< "$KEYS"
sign() { (cd $HERE/.. && node --input-type=module -e "const { schnorr } = await import('@noble/curves/secp256k1.js'); process.stdout.write(Buffer.from(schnorr.sign(Buffer.from('$2','hex'), Buffer.from('$1','hex'))).toString('hex'))"); }
WANT_HASH=$(node -e "const c=require('crypto');const s=Buffer.from('$SEED','hex');console.log(c.createHash('sha256').update(c.createHash('sha256').update(s).digest()).digest('hex'))")

# 1. THE INVOICE
R=$(tool --mode receive-to-key --claim-pk $PK --amount-msat $AMOUNT_MSAT --seed $SEED --gateway $GW --expiry-secs 3600 2>$P/receive.err)
echo "$R" > $P/receive.json
check "invoice amount" "$(echo "$R" | field 'o=>o.amount_msat')" "$AMOUNT_MSAT"
check "payment hash = sha256(sha256(seed))" "$(echo "$R" | field 'o=>o.payment_hash')" "$WANT_HASH"
check "contract claimed by the key" "$(echo "$R" | field 'o=>o.claim_pk')" "$PK"
INVOICE=$(echo "$R" | field 'o=>o.invoice'); CONTRACT=$(echo "$R" | field 'o=>o.contract_hex')
say "receive-to-key" "\"contract_amount_msat\":$(echo "$R" | field 'o=>o.contract_amount_msat'),\"receive_fee_msat\":$(echo "$R" | field 'o=>o.receive_fee_msat')"

# 2. BEFORE PAYMENT
N=0102030405060708
U=$(tool --mode claim-incoming --contract $CONTRACT --seed $SEED --payout-pk $PK --nonce $N --wait-s 3 2>$P/unfunded.err)
check "unfunded" "$(echo "$U" | field 'o=>o.funded')" "false"
check "commitment readable before payment" "$(echo "$U" | field 'o=>o.commitment.claim_pk+":"+o.commitment.payment_hash')" "$PK:$WANT_HASH"

# 3. A WRONG SEED
W=$(tool --mode claim-incoming --contract $CONTRACT --seed $(echo $SEED | tr '0123456789abcdef' '123456789abcdef0') --payout-pk $PK --nonce $N --wait-s 3 2>&1)
check "a wrong seed is refused" "$(echo "$W" | grep -c 'not the one this contract was made with')" "1"

# 4. ALICE PAYS
alice payinvoice --force "$INVOICE" > $P/pay.out 2>&1
check "alice paid" "$(grep -oE 'Payment status: [A-Z_]+' $P/pay.out | tail -1)" "Payment status: SUCCEEDED"

# 5. FUNDED: WHAT TO SIGN
C=$(tool --mode claim-incoming --contract $CONTRACT --seed $SEED --payout-pk $PK --nonce $N --wait-s 120 2>$P/claim0.err)
check "funded" "$(echo "$C" | field 'o=>o.funded')" "true"
MSG=$(echo "$C" | field 'o=>o.message_hex'); OUT=$(echo "$C" | field 'o=>o.payout.msat')
say "claim built" "\"payout_msat\":$OUT,\"contract_amount_msat\":$(echo "$C" | field 'o=>o.contract_amount_msat')"

# 6. ANOTHER KEY'S SIGNATURE
X=$(tool --mode claim-incoming --contract $CONTRACT --seed $SEED --payout-pk $PK --nonce $N --wait-s 60 --signature $(sign $SK2 $MSG) 2>&1)
check "another key's signature is refused" "$(echo "$X" | grep -c "not the contract's claim key")" "1"

# 7. THE KEY'S SIGNATURE
A=$(tool --mode claim-incoming --contract $CONTRACT --seed $SEED --payout-pk $PK --nonce $N --wait-s 60 --signature $(sign $SK $MSG) 2>$P/claim1.err)
echo "$A" > $P/claim.json
check "claim accepted" "$(echo "$A" | field 'o=>o.accepted')" "true"
check "payout stored" "$(echo "$A" | field 'o=>o.payout_stored ? "held" : "none"')" "held"

# 8a. THE SAME TRANSACTION SENT AGAIN: the same txid, answered as the one already accepted - nothing moves twice
A2=$(tool --mode claim-incoming --contract $CONTRACT --seed $SEED --payout-pk $PK --nonce $N --wait-s 60 --signature $(sign $SK $MSG) 2>&1)
check "the identical claim sent again is the same transaction" "$(echo "$A2" | field 'o=>o.txid')" "$(echo "$A" | field 'o=>o.txid')"
# 8b. A SECOND CLAIM - another nonce, so another transaction spending the same funded contract - is not accepted
N2=0807060504030201
C2=$(tool --mode claim-incoming --contract $CONTRACT --seed $SEED --payout-pk $PK --nonce $N2 --wait-s 60 2>$P/claim2.err)
MSG2=$(echo "$C2" | field 'o=>o.message_hex')
A3=$(tool --mode claim-incoming --contract $CONTRACT --seed $SEED --payout-pk $PK --nonce $N2 --wait-s 60 --signature $(sign $SK $MSG2) 2>&1)
echo "$A3" > $P/claim-second.json
check "a second claim (another transaction) is not accepted" "$(echo "$A3" | field 'o=>o.accepted')" "false"
say "second claim refused" ""error":$(echo "$A3" | field 'o=>JSON.stringify(String(o.error).slice(0,160))')"

say "DONE" "\"pass\":$pass,\"fail\":$fail"
[ $fail = 0 ]
