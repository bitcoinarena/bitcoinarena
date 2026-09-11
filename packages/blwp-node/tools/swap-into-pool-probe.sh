#!/bin/bash
# DOES A LOSER'S STAKE REACH THE COMMITTEE'S POOL WITHOUT ONE NODE HOLDING IT?
#
# the owner 2026-09-11: invoice, hold and cancel may sit on one replaceable node;
# the settle and the spend of settled money must not. The committee-signed
# lnd measured NO (tools/remote-signer-probe.sh). This measures the other
# recognised shape, a submarine swap (tools/swap-into-pool.mjs): the
# operator's lnd holds alice's HTLC; to settle it the operator must first lock
# the same amount on-chain in an output the committee claims into the pool
# with 2 of 2 and the stake's secret - and the claim is what publishes the
# secret the operator needs.
#
# Own regtest, ports 30321-30332 (never 8080); alice's and bob's (the
# operator's) lnd; a harness 2-of-2 committee. The secret stands for the one
# the daemons rebuild from the players' shares (preimage.js).
#
#   bash tools/swap-into-pool-probe.sh [stake-sats] [claim-fee-sats]
set -uo pipefail
P=${PROBE_DIR:-$(mktemp -d /tmp/swap-into-pool-probe-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
SATS=${1:-980}
FEE=${2:-200}
RPC=30321; ZB=30323; ZT=30324
declare -A LRPC=([alice]=30325 [bob]=30328) LLIS=([alice]=30326 [bob]=30329) LREST=([alice]=30327 [bob]=30330)
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
paid() { grep -o -E 'SUCCEEDED|FAILED|IN_FLIGHT' "$1" 2>/dev/null | tail -1 || echo "no answer"; }
chanbal() { ln_ $1 channelbalance 2>/dev/null | js 'o=>o.local_balance.msat'; }
chainbal() { ln_ $1 walletbalance 2>/dev/null | js 'o=>o.total_balance'; }
send() { bcn sendrawtransaction "$1" 2>&1 | tr -d '\n' | sed 's/error code: -*[0-9]*//; s/error message://' | cut -c1-200; }
short() { tr -d '\n' | sed 's/  */ /g' | cut -c1-200; }

# ---- THE CHAIN, ALICE, AND BOB (the operator's lnd) ----
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp -port=30322 -listen=0 \
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
say "chain at $(bcn getblockcount); channel alice->bob active; bob on-chain $(chainbal bob) sat"

# ---- THE COMMITTEE (harness 2 of 2) AND ITS POOL ----
say "committee: $(node $H_ deal $P/state.json)"

# ---- ALICE'S STAKE, HELD ON BOB'S LND ----
SECRET=$(pre); HASH=$(hashof $SECRET)
INV=$(ln_ bob addholdinvoice $HASH --amt $SATS | js 'o=>o.payment_request')
( ln_ alice payinvoice --force "$INV" > $P/pay.out 2>&1 ) &
waitfor 60 is_state $HASH ACCEPTED
B0C=$(chanbal bob); B0W=$(chainbal bob)
say "alice's $SATS-sat stake: bob's invoice $(state $HASH); bob's channel $B0C msat, on-chain $B0W sat"
say "  bob, with only his own node, cannot settle it: he has no secret (the committee rebuilds it from the players' shares)"

# ---- BOB LOCKS THE SAME AMOUNT ON-CHAIN, CLAIMABLE ONLY BY THE COMMITTEE WITH THE SECRET ----
REFUND_AT=$(( $(bcn getblockcount) + 144 ))
SW=$(node $H_ swap $P/state.json $HASH $REFUND_AT)
SWAP_SCRIPT=$(echo "$SW" | js 'o=>o.swapScript')
ADDR=$(bcn decodescript $SWAP_SCRIPT | js 'o=>o.address')
say "the swap output: $ADDR (no key path; claim = secret + committee key; refund = bob's key after height $REFUND_AT)"
say "  claim leaf  $(echo "$SW" | js 'o=>o.claimScript')"
LOCK=$(ln_ bob sendcoins --addr $ADDR --amt $SATS --sat_per_vbyte 2 2>&1)
LTX=$(echo "$LOCK" | js 'o=>o.txid')
bc generatetoaddress 1 $MINE >/dev/null
VOUT=$(bcn getrawtransaction $LTX true | js "o=>o.vout.findIndex(v=>v.scriptPubKey.hex==='$SWAP_SCRIPT')")
say "bob locked it: tx $LTX vout $VOUT, $(bcn gettxout $LTX $VOUT | js 'o=>Math.round(o.value*1e8)') sat, 1 confirmation"

# ---- WHAT FAILS ----
TO=$(bcn getaddressinfo $(bc getnewaddress '' bech32m) | js 'o=>o.scriptPubKey')
RF=$(node $H_ refund $P/state.json $LTX $VOUT $SATS $FEE $TO)
say "bob takes it back BEFORE height $REFUND_AT (chain $(bcn getblockcount)): $(send $(echo "$RF" | js 'o=>o.raw'))"
C1=$(node $H_ claim $P/state.json $LTX $VOUT $SATS $SECRET 1 $FEE)
say "the committee claims, 1 of 2 signing (verifies locally: $(echo "$C1" | js 'o=>o.verifiesLocally')): $(send $(echo "$C1" | js 'o=>o.raw'))"
C2=$(node $H_ claim $P/state.json $LTX $VOUT $SATS $(pre) 1,2 $FEE)
say "the committee claims, 2 of 2, with a WRONG secret: $(send $(echo "$C2" | js 'o=>o.raw'))"
say "  alice's invoice still $(state $HASH); bob's channel $(chanbal bob) msat"

# ---- THE CLAIM: 2 OF 2 AND THE SECRET, INTO THE POOL ----
C3=$(node $H_ claim $P/state.json $LTX $VOUT $SATS $SECRET 1,2 $FEE)
CTX=$(send $(echo "$C3" | js 'o=>o.raw'))
say "the committee claims, 2 of 2 with the secret (verifies locally: $(echo "$C3" | js 'o=>o.verifiesLocally')): $CTX"
bc generatetoaddress 1 $MINE >/dev/null
POOL=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).poolScript)' $P/state.json)
say "  the pool's output: $(bcn gettxout $CTX 0 | js "o=>Math.round(o.value*1e8)+' sat, '+(o.scriptPubKey.hex==='$POOL'?'the POOL key':'NOT the pool')+', '+o.confirmations+' conf'")"

# ---- BOB READS THE SECRET OFF THE CHAIN, AND ONLY NOW SETTLES ----
SEEN=$(bcn getrawtransaction $CTX true | js 'o=>o.vin[0].txinwitness[1]')
say "bob reads the secret from the claim's witness: $([ "$(hashof $SEEN)" = "$HASH" ] && echo "sha256 = the stake's hash" || echo "does NOT match")"
ST=$(ln_ bob settleinvoice $SEEN 2>&1 | short)
waitfor 30 is_state $HASH SETTLED; sleep 3
say "bob settles with it: '$ST', invoice $(state $HASH), alice's payment $(paid $P/pay.out)"
say ""
say "WHERE THE MONEY IS:"
say "  bob's channel     $B0C -> $(chanbal bob) msat"
say "  bob's on-chain    $B0W -> $(chainbal bob) sat"
say "  the pool          +$(bcn gettxout $CTX 0 | js 'o=>Math.round(o.value*1e8)') sat, at the committee's 2-of-2 key"
say "probe dir: $P"
