#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md REHEARSAL 13, SUCCESSION ON REGTEST (§23A.6): "a 4-guardian federation with notes in three wallets
# and one open lock; one guardian abandons (attested); a successor of 4 is founded with the three seated first; every wallet's
# notes move on their own through a gateway that serves both, with no press; the lock settles in the old federation and its
# payout moves; the old record goes CLOSED; nothing lost anywhere, and the amounts written down".
# tools/succession-regtest.sh (measured) with: a third wallet; p3's stake lock (blwp-stake-lock, the committee's claim key)
# open across the departure, settled in the old federation by the committee's one signature to p1, the winner, who collects the
# payout (Refund of the pre-expired contract) and moves it with the rest; the records signed and verified (tools/rehearsal-13.mjs).
# Heavy (8 fedimintd, 2 lnd, a gatewayd, bitcoind): the test host load rule applies. Nothing here reaches testnet4.
#   FEDIMINT_BIN=<fork bin dir> LOCK_BIN=<blwp-stake-lock> bash tools/rehearsal-13-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1800}
if [ -z "${R13_WRAPPED:-}" ]; then export R13_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"; : "${LOCK_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/r13-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
PAY_MSAT=${PAY_MSAT:-250000000}       # 250,000 sat per wallet: 3 of them within the gateway's 1,000,000 sat in each federation
# the run's own datadir: a bitcoin.conf of the machine (the test host's names testnet4) must not reach these calls
bcn() { $B/bitcoin-cli -datadir=$P/btc -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
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
bob() { ln_ bob 30110 "$@"; }
gw() { HOME=$FH timeout 120 $F/gateway-cli -a http://127.0.0.1:30170 --rpcpassword probe "$@"; }
cl() { local d=$1; shift; HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/$d "$@"; }
lk() { local d=$1; shift; HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/$d "$@" 2>$P/lock-$d.err | tail -1; }
r13() { (cd $HERE/.. && node tools/rehearsal-13.mjs "$@"); }
LOCK_MSAT=${LOCK_MSAT:-100000000}
setup() { HOME=$FH timeout 120 $F/fedimint-cli --password probe admin setup "$@"; }
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; echo "GAVE UP waiting for $what"; exit 1; }
ecash() { cl $1 info 2>/dev/null | js 'o=>Number(o.total_amount_msat)'; }
gwecash() { gw get-balances | js "o=>((o.ecash_balances||[]).find(b=>b.federation_id==='$1')||{}).ecash_balance_msats||0"; }
audit() { cl $1 --our-id 0 --password probe admin audit 2>/dev/null | js 'o=>JSON.stringify(Object.fromEntries(Object.entries(o.module_summaries).map(([k,v])=>[v.kind||k,Number(v.net_assets)])))'; }
MINE=""
nowms() { node -e 'process.stdout.write(String(Date.now()))'; }   # GNU date's %3N is not on macOS
t0=$(date +%s)

# ---- 1. THE OLD FEDERATION, ONE GATEWAY ----
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH BITCOIN_BIN=$B LND_BIN=$L bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" > $P/setup.log
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE OLD FEDERATION DID NOT COME UP"; exit 1; }
INV1=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
MINE=$(bc getnewaddress)
FED1=$(cl client info | js 'o=>o.federation_id')
echo "old federation $FED1 (4 guardians, 3 of 4) up in $(( $(date +%s) - t0 )) s"

# ---- 2. THREE PLAYERS HOLD NOTES IN IT ----
for p in p1 p2 p3; do
  mkdir -p $P/$p; cl $p join "$INV1" >/dev/null
  R=$(cl $p module lnv2 receive $PAY_MSAT --gateway http://127.0.0.1:30170 2>&1)
  INVOICE=$(echo "$R" | grep -oE 'lnbcrt[0-9a-z]+' | head -1); OP=$(echo "$R" | grep -oE '[0-9a-f]{64}' | head -1)
  alice payinvoice --force "$INVOICE" > $P/$p-pay.out 2>&1
  cl $p module lnv2 await-receive "$OP" > /dev/null 2>&1
done
BOB_INV0=$(bob listpayments | js 'o=>o.payments.length'); ALICE_PAY0=$(alice listpayments | js 'o=>o.payments.length'); BOB_CH0=$(bob channelbalance | js 'o=>o.local_balance.sat')
BEFORE=$(printf '{"p1":%s,"p2":%s,"p3":%s,"gatewayOld":%s,"auditOld":%s}' "$(ecash p1)" "$(ecash p2)" "$(ecash p3)" "$(gwecash $FED1)" "$(audit client)")
echo "BEFORE $BEFORE"

# ---- 2b. ONE OPEN LOCK: p3 stakes LOCK_MSAT under the committee's claim key, refundable to p3 at +144 ----
KEYS=$(r13 keys)
kv() { echo "$KEYS" | js "o=>o.$1"; }
LOCK=$(lk p3 --amount-msat $LOCK_MSAT --hash $(kv hash) --claim-pk $(kv committeePk) --refund-pk $(kv p3Pk) --expiry-delta 144)
LOCK_OP="$(echo "$LOCK" | js 'o=>o.txid'):$(echo "$LOCK" | js 'o=>o.out_idx')"
echo "LOCKED $(echo "$LOCK" | js 'o=>JSON.stringify({txid:o.txid.slice(0,16),out_idx:o.out_idx,ids_match:o.ids_match,amount_msat:o.amount_msat,expiration:o.stored_expiration})') p3 now $(ecash p3)"

# ---- 3. GUARDIAN 3 LEAVES; THE SUCCESSOR: 3 SEATED FIRST + 1 DRAWN ----
G3=$(grep ' fedimintd-3$' $P/pids | cut -d' ' -f1); kill -TERM -- -$G3 2>/dev/null; sleep 3
echo "guardian 3 left the old federation (its daemon stopped); the old federation runs on 3 of 4"

# ---- 3b. THE LOCK SETTLES IN THE OLD FEDERATION (3 of 4): the committee's one signature, p1 the winner; p1 collects ----
NONCE=$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')
SET=$(lk client --mode settle --claim-pk $(kv committeePk) --locks "$LOCK_OP:$(kv preimage):$LOCK_MSAT" --nonce $NONCE --qualifier-pk $(kv p1Pk))
SIG=$(r13 sign $(echo "$SET" | js 'o=>o.message_hex') | js 'o=>o.signature')
SETTLED=$(lk client --mode settle --claim-pk $(kv committeePk) --locks "$LOCK_OP:$(kv preimage):$LOCK_MSAT" --nonce $NONCE --qualifier-pk $(kv p1Pk) --signature $SIG)
PAY_OP="$(echo "$SET" | js 'o=>o.txid'):0"; PAYOUT=$(echo "$SET" | js 'o=>o.payout_msat')
P1_BEFORE=$(ecash p1)
COLLECT=$(lk p1 --mode redeem --outpoint $PAY_OP --amount-msat $PAYOUT --hash $(printf '0%.0s' {1..64}) --claim-pk $(kv p1Pk) --refund-pk $(kv p1Pk) --expiration 0 --witness refund --signer-secret $(kv p1Secret))
sleep 3
echo "SETTLED $(printf '{"settle":%s,"collect":%s,"p1Before":%s,"p1After":%s}' "$(echo "$SETTLED" | js 'o=>JSON.stringify({accepted:o.accepted,txid:(o.txid||"").slice(0,16),payout_msat:o.payout_msat,input_fees_msat:o.input_fees_msat,output_fee_msat:o.output_fee_msat,error:o.error||null})')" "$(echo "$COLLECT" | js 'o=>JSON.stringify({accepted:o.accepted,error:o.error||null})')" "$P1_BEFORE" "$(ecash p1)")"
names=(g0-succ g1-succ g2-succ drawn)
for s in 0 1 2 3; do
  base=$((30220 + s * 10)); mkdir -p $P/s$s
  ( export HOME=$FH FM_DATA_DIR=$P/s$s FM_BITCOIN_NETWORK=regtest FM_BITCOIND_URL=http://127.0.0.1:30101 FM_BITCOIND_USERNAME=blwp FM_BITCOIND_PASSWORD=blwp \
      FM_BIND_P2P=127.0.0.1:$base FM_BIND_API=127.0.0.1:$((base+1)) FM_BIND_UI=127.0.0.1:$((base+2)) FM_BIND_METRICS=127.0.0.1:$((base+3)) \
      FM_P2P_URL=fedimint://127.0.0.1:$base FM_API_URL=ws://127.0.0.1:$((base+1)) FM_ENABLE_IROH=false FM_PASSWORD_API=probe FM_PASSWORD_UI=probe \
      FM_LNV2_INCOMING_HOLD_SECS=0 FM_DISABLE_BASE_FEES=1
    setsid nohup $F/fedimintd > $P/s$s/fedimintd.out 2>&1 < /dev/null & echo "$! successor-$s" >> $P/pids )
  up() { grep -q "Setup UI running" $P/s$s/fedimintd.out 2>/dev/null; }
  until_ "successor guardian $s" 180 up
done
setup ws://127.0.0.1:30221 set-local-params ${names[0]} --federation-name blwp-successor --federation-size 4 > $P/s0.setup
for s in 1 2 3; do setup ws://127.0.0.1:$((30221 + s * 10)) set-local-params ${names[$s]} > $P/s$s.setup; done
for s in 0 1 2 3; do for o in 0 1 2 3; do [ $s = $o ] || setup ws://127.0.0.1:$((30221 + s * 10)) add-peer "$(tr -d '"\n ' < $P/s$o.setup)" >/dev/null; done; done
for s in 0 1 2 3; do ( setup ws://127.0.0.1:$((30221 + s * 10)) start-dkg > $P/s$s.dkg 2>&1 & ); done
invited() { [ -s $P/s0/invite-code ]; }
until_ "the successor's key ceremony" 180 invited
INV2=$(tr -d '"\n ' < $P/s0/invite-code)
mkdir -p $P/client2; cl client2 join "$INV2" >/dev/null
FED2=$(cl client2 info | js 'o=>o.federation_id')
gw connect-fed "$INV2" >/dev/null
PEGIN=$(gw ecash pegin --federation-id $FED2 | js 'o=>o.address||o')
bc sendtoaddress "$PEGIN" 0.01 >/dev/null; bc generatetoaddress 20 $MINE >/dev/null
pegged() { local e=$(gwecash $FED2); [ "$e" != 0 ] && [ "$e" != '?' ] || { bc generatetoaddress 1 $MINE >/dev/null; false; }; }
until_ "the gateway's peg-in to the successor" 180 pegged
for s in 0 1 2 3; do cl client2 --our-id $s --password probe module lnv2 gateways add http://127.0.0.1:30170 >/dev/null; done
GW2=$(gwecash $FED2)
echo "successor $FED2 (4 guardians: 3 seated first + 1 drawn) up; gateway A in both, its successor e-cash $GW2 msat"

# ---- 4. THE PLAYERS' MONEY MOVES, OLD -> SUCCESSOR, THROUGH GATEWAY A ----
# EVERY PASS OF THE CLIENT MOVES WHAT IS THERE (§23A.6: on its own, on every start): a note still in issuance at one pass -
# the change of a lock, a collected payout - is in the wallet by the next (measured: 15,783,424 msat of p3's lock change was
# left behind by a single pass). Up to 3 passes, each moving every wallet that still holds old e-cash.
MOVES=""
for pass in 1 2 3; do
for p in p1 p2 p3; do
  sleep 2; have=$(ecash $p); [ "$have" = 0 ] || [ "$have" = '?' ] && continue
  [ -d $P/${p}n ] || { mkdir -p $P/${p}n; cl ${p}n join "$INV2" >/dev/null; }
  t=$(nowms); amt=$have; ok=""
  for try in 1 2 3; do
    R=$(cl ${p}n module lnv2 receive $amt --gateway http://127.0.0.1:30170 2>&1)
    INVOICE=$(echo "$R" | grep -oE 'lnbcrt[0-9a-z]+' | head -1); ROP=$(echo "$R" | grep -oE '[0-9a-f]{64}' | head -1)
    SOP=$(cl $p module lnv2 send "$INVOICE" --gateway http://127.0.0.1:30170 2>&1 | grep -oE '[0-9a-f]{64}' | head -1)
    SENT=$(cl $p module lnv2 await-send "$SOP" 2>&1 | tr -d '\n ')
    GOT=$(cl ${p}n module lnv2 await-receive "$ROP" 2>&1 | tr -d '\n ')
    echo "$SENT $GOT" | grep -qi 'success\|claimed\|funded' && { ok=1; break; }
    amt=$(( amt * 99 / 100 ))     # a fee the send must cover: 1 % less, again
  done
  MOVES="$MOVES{\"pass\":$pass,\"player\":\"$p\",\"oldBefore\":$have,\"moved\":$amt,\"ms\":$(( $(nowms) - t )),\"send\":\"${SENT:0:80}\",\"receive\":\"${GOT:0:80}\",\"oldAfter\":$(ecash $p),\"successor\":$(ecash ${p}n)},"
done
done
BOB_INV1=$(bob listpayments | js 'o=>o.payments.length'); ALICE_PAY1=$(alice listpayments | js 'o=>o.payments.length'); BOB_CH1=$(bob channelbalance | js 'o=>o.local_balance.sat')
BOB_SETTLED=$(bob listinvoices | js 'o=>o.invoices.filter(i=>i.state==="SETTLED").length')
echo "MOVES [${MOVES%,}]"

# ---- 5. THE OLD FEDERATION EMPTIED: the gateway's old e-cash pegged out ----
GWOLD=$(gwecash $FED1)
ADDR=$(bc getnewaddress)
# "all" leaves the federation's wallet a change below dust when the gateway holds nearly all of it (measured: "Invalid request");
# then 1,000 sat less at a time, and what is left behind is the dust the old federation cannot pay out (§23A.6 step 4)
PEGOUT=""; LEFT=0
for keep in 1000000 5000000 20000000 50000000 0; do   # "all" last: tried first it was aborted and held the e-cash (measured)
  if [ $keep = 0 ]; then A=all; else A=$(( (GWOLD - keep) / 1000 * 1000 )); fi   # whole sats: the CLI refuses a part of one
  PEGOUT=$(gw ecash pegout --federation-id $FED1 --amount $A --address $ADDR 2>&1 | tr -d '\n ')
  echo "$PEGOUT" | grep -q txid && { LEFT=$keep; break; }
  bc generatetoaddress 1 $MINE >/dev/null; sleep 3
done
bc generatetoaddress 12 $MINE >/dev/null; sleep 5; bc generatetoaddress 6 $MINE >/dev/null; sleep 3
AFTER=$(printf '{"p1Old":%s,"p2Old":%s,"p3Old":%s,"p1Successor":%s,"p2Successor":%s,"p3Successor":%s,"gatewayOldBeforePegout":%s,"gatewayOld":%s,"gatewaySuccessor":%s,"auditOld":%s,"auditSuccessor":%s}' \
  "$(ecash p1)" "$(ecash p2)" "$(ecash p3)" "$(ecash p1n)" "$(ecash p2n)" "$(ecash p3n)" "$GWOLD" "$(gwecash $FED1)" "$(gwecash $FED2)" "$(audit client)" "$(audit client2)")
echo "AFTER $AFTER"

# ---- 5b. THE RECORDS: the old federation names its successor, then CLOSED; the successor OPEN ----
echo "RECORDS $(r13 records $FED1 $FED2 "$INV1" "$INV2")"

# ---- 6. THE OLD GUARDIANS' BONDS SPENT AT MATURITY ----
BONDS=$(cd $HERE/.. && BITCOIN_BIN=$B BTC_DATADIR=$P/btc RPC=30101 GUARDIANS=4 node tools/succession-bonds.mjs > $P/bonds.out 2>&1; grep '^BONDS ' $P/bonds.out | cut -c7-)
[ -n "$BONDS" ] || { echo "BONDS FAILED:"; tail -15 $P/bonds.out; }
echo "BONDS ${BONDS:-none}"
echo "REHEARSAL13 $(printf '{"old":"%s","successor":"%s","before":%s,"moves":[%s],"onePath":{"gateway":"http://127.0.0.1:30170","bobPayments":[%s,%s],"alicePayments":[%s,%s],"bobChannelSat":[%s,%s],"bobSettledInvoices":%s},"pegoutLeftMsat":%s,"pegout":"%s","after":%s,"bonds":%s,"seconds":%s}' \
  "$FED1" "$FED2" "$BEFORE" "${MOVES%,}" "$BOB_INV0" "$BOB_INV1" "$ALICE_PAY0" "$ALICE_PAY1" "$BOB_CH0" "$BOB_CH1" "${BOB_SETTLED:-0}" "$LEFT" "${PEGOUT:0:120}" "$AFTER" "${BONDS:-null}" "$(( $(date +%s) - t0 ))")"
