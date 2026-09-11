#!/bin/bash
# DOES A LOSER'S STAKE REACH THE COMMITTEE'S POOL WITHOUT ONE NODE HOLDING IT -
# AND ON WHICH CLOCKS?
#
# the owner 2026-09-11: the submarine swap is how a loser's stake reaches the
# pool. Invoice, hold and cancel stay on the operator's replaceable lnd; the
# secret reaches the chain only by the committee's 2-of-2 claim, and that
# claim is what moves the value onto the pool key (tools/swap-into-pool.mjs).
#
# THE HOLE THE FIRST RUN NAMED: the operator's refund height must fall BEFORE
# alice's HTLC times out, with the committee's claim in between - otherwise a
# claim after alice is refunded takes the operator's coins. So every clock is
# printed, and one scenario is run per invocation:
#
#   normal               the claim right after the lock
#   late-before-timeout  the claim AFTER bob's refund height, bob not having
#                        refunded, alice's HTLC still standing
#   far-refund           bob's refund height PAST alice's timeout (the first
#                        run's +144); the claim after lnd cancels alice
#   bob-refunds          refund height inside the window; bob refunds at it;
#                        the claim after lnd cancels alice
#
# Own regtest, ports 30321-30332 + PORT_OFF (never 8080); alice's and bob's
# (the operator's) lnd; a harness 2-of-2 committee. The secret stands for the
# one the daemons rebuild from the players' shares. Regtest mines on demand,
# so seconds are printed at the 600 s block target, not measured.
#
#   bash tools/swap-into-pool-probe.sh [scenario] [stake-sats=980] [claim-fee=200] [refund-margin=20]
set -uo pipefail
P=${PROBE_DIR:-$(mktemp -d /tmp/swap-into-pool-probe-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
SCENARIO=${1:-normal}
SATS=${2:-980}
FEE=${3:-200}
MARGIN=${4:-20}
case $SCENARIO in normal|late-before-timeout|far-refund|bob-refunds) ;; *) echo "no scenario $SCENARIO"; exit 2;; esac
O=${PORT_OFF:-0}
RPC=$((30321 + O)); ZB=$((30323 + O)); ZT=$((30324 + O))
declare -A LRPC=([alice]=$((30325 + O)) [bob]=$((30328 + O))) LLIS=([alice]=$((30326 + O)) [bob]=$((30329 + O))) LREST=([alice]=$((30327 + O)) [bob]=$((30330 + O)))
mkdir -p $P/btc $P/alice $P/bob
: > $P/pids
H_=$(dirname "$0")/swap-into-pool.mjs
say() { echo "$@"; }
bcn() { $B/bitcoin-cli -regtest -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp "$@"; }
bc() { bcn -rpcwallet=probe "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1
  sleep 4
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
ln_() { local who=$1; shift; timeout 60 $L/lncli --lnddir=$P/$who --rpcserver=127.0.0.1:${LRPC[$who]} --network=regtest "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; say "GAVE UP waiting for $what"; exit 1; }
waitfor() { local n=$1; shift; for i in $(seq $n); do "$@" && return 0; sleep 1; done; return 1; }
pre() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; }
hashof() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(Buffer.from(process.argv[1],"hex")).digest("hex"))' "$1"; }
state() { ln_ bob lookupinvoice "$1" 2>/dev/null | js 'o=>o.state'; }
is_state() { [ "$(state $1)" = "$2" ]; }
# ALICE'S OWN LND SAYS WHAT HAPPENED TO HER PAYMENT - not the payinvoice
# process's output, which ends only when the payment does.
paid() { ln_ alice listpayments --include_incomplete 2>/dev/null | js "o=>(o.payments.find(p=>p.payment_hash==='$HASH')||{status:'none'}).status"; }
chanbal() { ln_ $1 channelbalance 2>/dev/null | js 'o=>o.local_balance.msat'; }
chainbal() { ln_ $1 walletbalance 2>/dev/null | js 'o=>o.total_balance'; }
send() { bcn sendrawtransaction "$1" 2>&1 | tr -d '\n' | sed 's/error code: -*[0-9]*//; s/error message://' | cut -c1-200; }
short() { tr -d '\n' | sed 's/  */ /g' | cut -c1-200; }
height() { bcn getblockcount; }
mine1() { bc generatetoaddress 1 $MINE >/dev/null; }
mine_to() { while [ "$(height)" -lt "$1" ]; do mine1; done; }
txsat() { bcn gettxout $1 $2 2>/dev/null | js 'o=>Math.round(o.value*1e8)'; }
# ONE BLOCK AT A TIME until lnd cancels alice's held HTLC, so the height it did
# it at is read, not assumed; lnd is given a moment to see each block.
mine_until_cancel() {
  for i in $(seq 200); do
    is_state $HASH CANCELED && { echo "$(height)"; return 0; }
    mine1; sleep 1
  done
  echo "never"
}
sec() { echo "$(( $1 * 600 )) s"; }

# ---- THE CHAIN, ALICE, AND BOB (the operator's lnd) ----
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp -port=$((30322 + O)) -listen=0 \
  -listenonion=0 -fallbackfee=0.0001 -txindex -zmqpubrawblock=tcp://127.0.0.1:$ZB \
  -zmqpubrawtx=tcp://127.0.0.1:$ZT -daemon >/dev/null
until_ bitcoind 60 bcn getblockcount >/dev/null 2>&1
bcn createwallet probe >/dev/null
MINE=$(bc getnewaddress)
bc generatetoaddress 250 $MINE >/dev/null
for who in alice bob; do
  setsid nohup $L/lnd --lnddir=$P/$who --bitcoin.regtest --bitcoin.node=bitcoind \
    --bitcoind.rpchost=127.0.0.1:$RPC --bitcoind.rpcuser=blwp --bitcoind.rpcpass=blwp \
    --bitcoind.zmqpubrawblock=tcp://127.0.0.1:$ZB --bitcoind.zmqpubrawtx=tcp://127.0.0.1:$ZT \
    --rpclisten=127.0.0.1:${LRPC[$who]} --listen=127.0.0.1:${LLIS[$who]} --restlisten=127.0.0.1:${LREST[$who]} \
    --noseedbackup --nobootstrap --alias=$who > $P/$who/lnd.out 2>&1 < /dev/null &
  echo "$! lnd-$who" >> $P/pids
done
synced() { [ "$(ln_ $1 getinfo 2>/dev/null | js 'o=>o.synced_to_chain')" = true ]; }
until_ "alice's lnd" 120 synced alice
until_ "bob's lnd" 120 synced bob
BOBKEY=$(ln_ bob getinfo | js 'o=>o.identity_pubkey')
bc sendtoaddress "$(ln_ alice newaddress p2tr | js 'o=>o.address')" 5 >/dev/null
bc sendtoaddress "$(ln_ bob newaddress p2tr | js 'o=>o.address')" 0.01 >/dev/null
bc generatetoaddress 6 $MINE >/dev/null
funded() { [ "$(ln_ $1 walletbalance | js 'o=>o.confirmed_balance')" != 0 ]; }
until_ "alice's coins" 120 funded alice
until_ "bob's coins" 120 funded bob
ln_ alice connect $BOBKEY@127.0.0.1:${LLIS[bob]} >/dev/null
opened() { ln_ alice openchannel --node_key=$BOBKEY --local_amt=2000000 >/dev/null 2>&1; }
until_ "the channel open" 120 opened
bc generatetoaddress 6 $MINE >/dev/null
active() { [ "$(ln_ alice listchannels | js 'o=>(o.channels||[]).filter(c=>c.active).length')" -gt 0 ]; }
until_ "the channel" 120 active
# AND ALICE ABLE TO SEND OVER IT. Measured: a payment made the moment the
# channel read active found "only have local balance: 0 mSAT" and lnd failed
# it for good (insufficient_balance) - 2 of 4 parallel runs.
cansend() { [ "$(ln_ alice channelbalance | js 'o=>Number(o.local_balance.sat)')" -gt 0 ]; }
until_ "alice's spendable balance" 60 cansend
say "SCENARIO $SCENARIO. chain at $(height); channel alice->bob active; bob on-chain $(chainbal bob) sat"
node $H_ deal $P/state.json >/dev/null
POOL=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).poolScript)' $P/state.json)

# ---- ALICE'S STAKE, HELD ON BOB'S LND - the daemons' own invoice shape:
# addholdinvoice with --expiry 3600 and no --cltv_expiry (src/lnd-port.js) ----
SECRET=$(pre); HASH=$(hashof $SECRET)
INV=$(ln_ bob addholdinvoice $HASH --amt $SATS --expiry 3600 | js 'o=>o.payment_request')
for try in 1 2 3 4 5; do
  ( timeout 900 $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:${LRPC[alice]} --network=regtest payinvoice --force "$INV" > $P/pay.out 2>&1 ) &
  waitfor 15 is_state $HASH ACCEPTED && break
done
until_ "alice's stake held on bob's lnd" 5 is_state $HASH ACCEPTED
say "  alice's payment taken on try $try; alice's channel $(chanbal alice) msat"
PAYH=$(height)
EXP=$(ln_ bob lookupinvoice $HASH | js 'o=>o.htlcs[0].expiry_height')
CLTV=$(ln_ bob decodepayreq $INV | js 'o=>o.cltv_expiry')
B0C=$(chanbal bob); B0W=$(chainbal bob)
say "CLOCK 1  alice's HTLC: paid at height $PAYH, invoice's final CLTV $CLTV, expiry_height $EXP = +$((EXP - PAYH)) blocks = $(sec $((EXP - PAYH))) at the 600 s target"

# ---- BOB LOCKS THE SAME AMOUNT, CHOOSING HIS REFUND HEIGHT FROM ALICE'S EXPIRY ----
if [ "$SCENARIO" = far-refund ]; then REFUND_AT=$((PAYH + 144)); WHY="payment + 144, the first run's choice"
else REFUND_AT=$((EXP - MARGIN)); WHY="alice's expiry - $MARGIN"; fi
SW=$(node $H_ swap $P/state.json $HASH $REFUND_AT)
SWAP_SCRIPT=$(echo "$SW" | js 'o=>o.swapScript')
ADDR=$(bcn decodescript $SWAP_SCRIPT | js 'o=>o.address')
LTX=$(ln_ bob sendcoins --addr $ADDR --amt $SATS --sat_per_vbyte 2 2>&1 | js 'o=>o.txid')
mine1
LOCKH=$(height)
VOUT=$(bcn getrawtransaction $LTX true | js "o=>o.vout.findIndex(v=>v.scriptPubKey.hex==='$SWAP_SCRIPT')")
say "CLOCK 2  bob's refund: nLockTime $REFUND_AT ($WHY) = +$((REFUND_AT - PAYH)) blocks from payment, $((EXP - REFUND_AT)) block(s) BEFORE alice's expiry; lock confirmed at $LOCKH ($(txsat $LTX $VOUT) sat)"
TO=$(bcn validateaddress "$(ln_ bob newaddress p2tr | js 'o=>o.address')" | js 'o=>o.scriptPubKey')
RF=$(node $H_ refund $P/state.json $LTX $VOUT $SATS $FEE $TO)
say "  bob's refund at $(height), before $REFUND_AT: $(send $(echo "$RF" | js 'o=>o.raw'))"

claim() { node $H_ claim $P/state.json $LTX $VOUT $SATS $SECRET 1,2 $FEE | js 'o=>o.raw'; }
settle_from_chain() {
  local seen; seen=$(bcn getrawtransaction $1 true | js 'o=>o.vin[0].txinwitness[1]')
  [ "$(hashof $seen)" = "$HASH" ] || { echo "the claim's witness is not the stake's secret"; return; }
  echo "$(ln_ bob settleinvoice $seen 2>&1 | short)"
}
money() {
  say "WHERE THE MONEY IS: alice's payment $(paid) (her channel $(chanbal alice) msat), invoice $(state $HASH); bob's channel $B0C -> $(chanbal bob) msat; bob's on-chain $B0W -> $(chainbal bob) sat; the pool $1"
}

case $SCENARIO in
  normal)
    CTX=$(send $(claim)); mine1; C=$(height)
    say "CLOCK 3  the committee's claim (2 of 2 + secret) confirmed at $C: $((REFUND_AT - C)) block(s) before bob's refund, $((EXP - C)) before alice's expiry"
    say "  bob settles from the chain: '$(settle_from_chain $CTX)'"; waitfor 30 is_state $HASH SETTLED; sleep 3
    money "+$(txsat $CTX 0) sat at the pool key" ;;
  late-before-timeout)
    mine_to $REFUND_AT; mine1
    say "  chain at $(height), past bob's refund height $REFUND_AT; bob has NOT refunded; alice's invoice $(state $HASH)"
    CTX=$(send $(claim)); mine1; C=$(height)
    say "CLOCK 3  the LATE claim (after the refund height, before alice's timeout) confirmed at $C: $((C - REFUND_AT)) block(s) past bob's refund, $((EXP - C)) before alice's expiry"
    say "  bob settles from the chain: '$(settle_from_chain $CTX)'"; waitfor 30 is_state $HASH SETTLED; sleep 3
    money "+$(txsat $CTX 0) sat at the pool key" ;;
  far-refund)
    CX=$(mine_until_cancel); sleep 3
    say "  lnd CANCELED alice's HTLC at height $CX ($((EXP - CX)) block(s) before its expiry $EXP); alice's payment $(paid); bob's refund height $REFUND_AT is still $((REFUND_AT - CX)) block(s) away"
    CTX=$(send $(claim)); mine1; C=$(height)
    say "CLOCK 3  the LATE claim (after alice's timeout, before bob's refund) confirmed at $C: $CTX"
    say "  bob tries to settle from the chain: '$(settle_from_chain $CTX)'"
    money "+$(txsat $CTX 0) sat at the pool key"
    say "  => A LATE CLAIM $( [ "$(state $HASH)" = CANCELED ] && [ -n "$(txsat $CTX 0)" ] && echo "DRAINED BOB WHILE ALICE WAS REFUNDED" || echo "did not drain bob")" ;;
  bob-refunds)
    mine_to $REFUND_AT
    RF=$(node $H_ refund $P/state.json $LTX $VOUT $SATS $FEE $TO)
    RTX=$(send $(echo "$RF" | js 'o=>o.raw')); mine1; R=$(height)
    say "  bob refunds at his height: $RTX, confirmed at $R ($((EXP - R)) block(s) before alice's expiry); alice's invoice still $(state $HASH)"
    CX=$(mine_until_cancel); sleep 3
    say "  lnd CANCELED alice's HTLC at height $CX; alice's payment $(paid)"
    C=$(height)
    say "CLOCK 3  the LATE claim after alice's timeout, at $C: $(send $(claim))"
    money "nothing" ;;
esac
say "probe dir: $P"
