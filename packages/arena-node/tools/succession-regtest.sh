#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# CUSTODY SUCCESSION, MEASURED ON REGTEST (§23A.6; 2026-10-10: "Build guardian departure as the
# succession ... a new federation is formed with the remaining guardians ... the old federation ... every note paid out,
# then the bonds released"; "Fedimint cannot change a federation's guardians; do not add an in-place removal").
#   1. The old federation: federation-hold-probe's 4 guardians (3 of 4) and ONE gateway (A, on bob's lnd).
#   2. Two players hold notes in it (each paid in over LNv2 from alice).
#   3. Guardian 3 leaves. The successor is founded: the 3 remaining guardians seated first (same operators, new key shares,
#      new daemons) plus 1 drawn - Fedimint 0.12 refuses a federation of 3. Gateway A joins it and is vetted there.
#   4. Each player's whole balance moves: an LNv2 receive invoice in the successor, paid by an LNv2 send from the old
#      federation, both through gateway A - the one gateway serving both (bob's and alice's lnd are read for any hop).
#   5. The old federation is emptied: gateway A pegs its old e-cash out on chain; the guardians' audit is read.
#   6. The old guardians' bonds are spent at maturity (succession-bonds.mjs).
# Prints SUCCESSION <json> with every balance before and after. Nothing here reaches testnet4. Heavy (8 fedimintd, 2 lnd, a
# gatewayd, bitcoind): the test host load rule applies.
#   FEDIMINT_BIN=<fork bin dir> bash tools/succession-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-1800}
if [ -z "${SUCCESSION_WRAPPED:-}" ]; then export SUCCESSION_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/succession-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
PAY_MSAT=${PAY_MSAT:-300000000}       # 300,000 sat per player
# the run's own datadir: a bitcoin.conf of the machine (the test host's names testnet4) must not reach these calls
bcn() { $B/bitcoin-cli -datadir=$P/btc -regtest -rpcport=30101 -rpcuser=arena -rpcpassword=arena "$@"; }
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

# ---- 2. TWO PLAYERS HOLD NOTES IN IT ----
for p in p1 p2; do
  mkdir -p $P/$p; cl $p join "$INV1" >/dev/null
  R=$(cl $p module lnv2 receive $PAY_MSAT --gateway http://127.0.0.1:30170 2>&1)
  INVOICE=$(echo "$R" | grep -oE 'lnbcrt[0-9a-z]+' | head -1); OP=$(echo "$R" | grep -oE '[0-9a-f]{64}' | head -1)
  alice payinvoice --force "$INVOICE" > $P/$p-pay.out 2>&1
  cl $p module lnv2 await-receive "$OP" > /dev/null 2>&1
done
BOB_INV0=$(bob listpayments | js 'o=>o.payments.length'); ALICE_PAY0=$(alice listpayments | js 'o=>o.payments.length'); BOB_CH0=$(bob channelbalance | js 'o=>o.local_balance.sat')
BEFORE=$(printf '{"p1":%s,"p2":%s,"gatewayOld":%s,"auditOld":%s}' "$(ecash p1)" "$(ecash p2)" "$(gwecash $FED1)" "$(audit client)")
echo "BEFORE $BEFORE"

# ---- 3. GUARDIAN 3 LEAVES; THE SUCCESSOR: 3 SEATED FIRST + 1 DRAWN ----
G3=$(grep ' fedimintd-3$' $P/pids | cut -d' ' -f1); kill -TERM -- -$G3 2>/dev/null; sleep 3
echo "guardian 3 left the old federation (its daemon stopped); the old federation runs on 3 of 4"
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
MOVES=""
for p in p1 p2; do
  have=$(ecash $p); mkdir -p $P/${p}n; cl ${p}n join "$INV2" >/dev/null
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
  MOVES="$MOVES{\"player\":\"$p\",\"oldBefore\":$have,\"moved\":$amt,\"ms\":$(( $(nowms) - t )),\"send\":\"${SENT:0:80}\",\"receive\":\"${GOT:0:80}\",\"oldAfter\":$(ecash $p),\"successor\":$(ecash ${p}n)},"
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
AFTER=$(printf '{"p1Old":%s,"p2Old":%s,"p1Successor":%s,"p2Successor":%s,"gatewayOldBeforePegout":%s,"gatewayOld":%s,"gatewaySuccessor":%s,"auditOld":%s,"auditSuccessor":%s}' \
  "$(ecash p1)" "$(ecash p2)" "$(ecash p1n)" "$(ecash p2n)" "$GWOLD" "$(gwecash $FED1)" "$(gwecash $FED2)" "$(audit client)" "$(audit client2)")
echo "AFTER $AFTER"

# ---- 6. THE OLD GUARDIANS' BONDS SPENT AT MATURITY ----
BONDS=$(cd $HERE/.. && BITCOIN_BIN=$B BTC_DATADIR=$P/btc RPC=30101 GUARDIANS=4 node tools/succession-bonds.mjs > $P/bonds.out 2>&1; grep '^BONDS ' $P/bonds.out | cut -c7-)
[ -n "$BONDS" ] || { echo "BONDS FAILED:"; tail -15 $P/bonds.out; }
echo "BONDS ${BONDS:-none}"
echo "SUCCESSION $(printf '{"old":"%s","successor":"%s","before":%s,"moves":[%s],"onePath":{"gateway":"http://127.0.0.1:30170","bobPayments":[%s,%s],"alicePayments":[%s,%s],"bobChannelSat":[%s,%s],"bobSettledInvoices":%s},"pegoutLeftMsat":%s,"pegout":"%s","after":%s,"bonds":%s,"seconds":%s}' \
  "$FED1" "$FED2" "$BEFORE" "${MOVES%,}" "$BOB_INV0" "$BOB_INV1" "$ALICE_PAY0" "$ALICE_PAY1" "$BOB_CH0" "$BOB_CH1" "${BOB_SETTLED:-0}" "$LEFT" "${PEGOUT:0:120}" "$AFTER" "${BONDS:-null}" "$(( $(date +%s) - t0 ))")"
