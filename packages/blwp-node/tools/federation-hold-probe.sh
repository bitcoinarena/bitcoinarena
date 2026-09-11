#!/bin/bash
# DOES A STAKE PAID INTO A FEDIMINT FEDERATION STAY HELD, OR SETTLE AT ONCE?
#
# The pool is a FEDERATION (the owner 2026-09-11 09:26): Fedimint-class, with a
# Lightning gateway, never single custody. Before any custom module, one
# number: through Fedimint's STANDARD Lightning path (LNv2, 0.12.0 defaults),
# is a player's stake still in flight when a round's objection window closes,
# or already a completed settlement in the gateway's lnd?
#
# What it stands up, all on its own isolated regtest and its own ports (never
# 8080; not the rehearsal's): bitcoind; alice's and bob's lnd with an
# alice->bob channel (the rehearsal's shape); FOUR fedimintd guardians -
# 0.12.0 refuses 2 ("Federation size must be 1 or at least 4"), and 1 would
# be single custody - through their own key ceremony; a gatewayd on bob's lnd,
# connected, pegged in and vetted by all four guardians; one receiving client.
# Then the client asks for an invoice, alice pays it, and the balances are
# read before the payment, right after it, and after the window.
#
#   FEDIMINT_BIN=<dir with fedimintd gatewayd fedimint-cli gateway-cli v0.12.0> \
#     bash tools/federation-hold-probe.sh [window-seconds] [stake-msat]
#
# The Fedimint builds are self-extracting bundles that unpack into
# $HOME/.cache; FEDIMINT_HOME (default $FEDIMINT_BIN/home) keeps that inside
# the directory the operator chose. Nothing is installed or put on PATH.
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the Fedimint v0.12.0 builds}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/federation-hold-probe-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
WINDOW_S=${1:-30}
AMOUNT_MSAT=${2:-1000000}
mkdir -p $P/btc $P/alice $P/bob $P/gw $P/client $FH
: > $P/pids
RPC=30101; ZB=30105; ZT=30106
declare -A LRPC=([alice]=30107 [bob]=30110) LLIS=([alice]=30108 [bob]=30111) LREST=([alice]=30109 [bob]=30112)
say() { echo "$@"; }
# EACH DAEMON'S WHOLE PROCESS GROUP. The Fedimint builds are wrappers that
# start the real daemon as a child; killing the recorded PID alone left four
# fedimintd and a gatewayd running on their ports (measured). Every daemon is
# started under `setsid`, so its group id is the recorded PID.
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  $B/bitcoin-cli -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp stop >/dev/null 2>&1
  sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
bcn() { $B/bitcoin-cli -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp "$@"; }
bc() { bcn -rpcwallet=probe "$@"; }
ln_() { local who=$1; shift; $L/lncli --lnddir=$P/$who --rpcserver=127.0.0.1:${LRPC[$who]} --network=regtest "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
gw() { HOME=$FH timeout 120 $F/gateway-cli -a http://127.0.0.1:30170 --rpcpassword probe "$@"; }
fc() { HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/client "$@"; }
setup() { HOME=$FH timeout 120 $F/fedimint-cli --password probe admin setup "$@"; }
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; say "GAVE UP waiting for $what"; exit 1; }

# ---- THE CHAIN AND THE TWO LIGHTNING NODES, the rehearsal's shape ----
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp -port=30102 -listen=0 \
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
bc generatetoaddress 6 $MINE >/dev/null
funded() { [ "$(ln_ alice walletbalance | js 'o=>o.confirmed_balance')" != 0 ]; }
until_ "alice's coins" 120 funded
ln_ alice connect $BOBKEY@127.0.0.1:${LLIS[bob]} >/dev/null
opened() { ln_ alice openchannel --node_key=$BOBKEY --local_amt=2000000 --push_amt=1000000 >/dev/null 2>&1; }
until_ "the channel open" 120 opened
bc generatetoaddress 6 $MINE >/dev/null
active() { [ "$(ln_ alice listchannels | js 'o=>(o.channels||[]).filter(c=>c.active).length')" -gt 0 ]; }
until_ "the channel" 120 active
say "chain at $(bcn getblockcount); channel alice->bob active"

# ---- FOUR GUARDIANS, started one after another: the bundles share one
# unpack directory, and two first runs at once found it half-written ----
for g in 0 1 2 3; do
  base=$((30120 + g * 10)); mkdir -p $P/g$g
  ( export HOME=$FH FM_DATA_DIR=$P/g$g FM_BITCOIN_NETWORK=regtest \
      FM_BITCOIND_URL=http://127.0.0.1:$RPC FM_BITCOIND_USERNAME=blwp FM_BITCOIND_PASSWORD=blwp \
      FM_BIND_P2P=127.0.0.1:$base FM_BIND_API=127.0.0.1:$((base+1)) FM_BIND_UI=127.0.0.1:$((base+2)) \
      FM_BIND_METRICS=127.0.0.1:$((base+3)) FM_P2P_URL=fedimint://127.0.0.1:$base FM_API_URL=ws://127.0.0.1:$((base+1)) \
      FM_ENABLE_IROH=false FM_PASSWORD_API=probe FM_PASSWORD_UI=probe
    setsid nohup $F/fedimintd > $P/g$g/fedimintd.out 2>&1 < /dev/null & echo "$! fedimintd-$g" >> $P/pids )
  up() { grep -q "Setup UI running" $P/g$g/fedimintd.out 2>/dev/null; }
  until_ "guardian $g" 180 up
done
setup ws://127.0.0.1:30121 set-local-params g0 --federation-name blwp-probe --federation-size 4 > $P/g0.setup
for g in 1 2 3; do setup ws://127.0.0.1:$((30121 + g * 10)) set-local-params g$g > $P/g$g.setup; done
for g in 0 1 2 3; do for o in 0 1 2 3; do
  [ $g = $o ] || setup ws://127.0.0.1:$((30121 + g * 10)) add-peer "$(tr -d '"\n ' < $P/g$o.setup)" >/dev/null
done; done
for g in 0 1 2 3; do ( setup ws://127.0.0.1:$((30121 + g * 10)) start-dkg > $P/g$g.dkg 2>&1 & ); done
invited() { [ -s $P/g0/invite-code ]; }
until_ "the key ceremony" 180 invited
INV=$(tr -d '"\n ' < $P/g0/invite-code)
say "federation of 4 guardians, threshold 3: ${INV:0:24}..."

# ---- THE GATEWAY ON BOB'S LND: connected, pegged in, vetted ----
HASH=$(HOME=$FH timeout 120 $F/gateway-cli create-password-hash probe | tr -d '"\n')
( export HOME=$FH FM_GATEWAY_DATA_DIR=$P/gw FM_GATEWAY_LISTEN_ADDR=127.0.0.1:30170 FM_GATEWAY_API_ADDR=http://127.0.0.1:30170 \
    FM_GATEWAY_BCRYPT_PASSWORD_HASH="$HASH" FM_GATEWAY_NETWORK=regtest FM_BITCOIND_URL=http://127.0.0.1:$RPC \
    FM_BITCOIND_USERNAME=blwp FM_BITCOIND_PASSWORD=blwp FM_GATEWAY_SKIP_SETUP=true \
    FM_GATEWAY_IROH_LISTEN_ADDR=127.0.0.1:30171 FM_GATEWAY_METRICS_LISTEN_ADDR=127.0.0.1:30172 \
    FM_LND_RPC_ADDR=https://127.0.0.1:${LRPC[bob]} FM_LND_TLS_CERT=$P/bob/tls.cert \
    FM_LND_MACAROON=$P/bob/data/chain/bitcoin/regtest/admin.macaroon
  setsid nohup $F/gatewayd lnd > $P/gw/gatewayd.out 2>&1 < /dev/null & echo "$! gatewayd" >> $P/pids )
running() { grep -q "Gateway is running" $P/gw/gatewayd.out 2>/dev/null; }
until_ "the gateway" 180 running
FED=$(gw connect-fed "$INV" | js 'o=>o.federation_id')
PEGIN=$(gw ecash pegin --federation-id $FED | js 'o=>o.address||o')
bc sendtoaddress "$PEGIN" 0.01 >/dev/null
bc generatetoaddress 20 $MINE >/dev/null
pegged() { local e=$(gw get-balances | js 'o=>(o.ecash_balances||[]).reduce((t,b)=>t+Number(b.ecash_balance_msats||0),0)'); [ "$e" != 0 ] && [ "$e" != '?' ] || { bc generatetoaddress 1 $MINE >/dev/null; false; }; }
until_ "the gateway's peg-in" 180 pegged
fc join "$INV" >/dev/null
for g in 0 1 2 3; do fc --our-id $g --password probe module lnv2 gateways add http://127.0.0.1:30170 >/dev/null; done
say "gateway on bob's lnd: joined, pegged in, vetted by $(fc module lnv2 gateways list | js 'o=>o.length') list(s) of 4 guardians"

# ---- THE MEASUREMENT ----
T0=$(date +%s%3N)
snap() {
  local gwb=$(gw get-balances 2>/dev/null)
  say "  $1 (+$(( $(date +%s%3N) - T0 )) ms, height $(bcn getblockcount)):" \
    "bob channel $(ln_ bob channelbalance | js 'o=>o.local_balance.sat')" \
    "| alice channel $(ln_ alice channelbalance | js 'o=>o.local_balance.sat')" \
    "| gateway ecash $(echo "$gwb" | js 'o=>Math.floor((o.ecash_balances||[]).reduce((t,b)=>t+Number(b.ecash_balance_msats||0),0)/1000)')" \
    "| gateway lightning $(echo "$gwb" | js 'o=>Math.floor(Number(o.lightning_balance_msats)/1000)')" \
    "| receiver ecash $(fc info 2>/dev/null | js 'o=>Math.floor(Number(o.total_amount_msat)/1000)')" \
    "| federation audit net assets (sat) $(fc --our-id 0 --password probe admin audit 2>/dev/null | js 'o=>JSON.stringify(Object.fromEntries(Object.entries(o.module_summaries).map(([k,v])=>[v.kind||k,Math.round(Number(v.net_assets)/1000)])))')"
}
say "STAKE $((AMOUNT_MSAT / 1000)) sats, window ${WINDOW_S} s"
snap "BEFORE PAY"
RECV=$(fc module lnv2 receive $AMOUNT_MSAT 2>&1)
INVOICE=$(echo "$RECV" | grep -oE 'lnbcrt[0-9a-z]+' | head -1)
OP=$(echo "$RECV" | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$INVOICE" ] || { say "NO INVOICE - nothing was measured: $(echo "$RECV" | tr -d '\n' | cut -c1-200)"; exit 1; }
t=$(date +%s%3N)
PAY=$(timeout $((WINDOW_S + 60)) $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:${LRPC[alice]} --network=regtest payinvoice --force "$INVOICE" 2>&1)
say "  alice's payinvoice returned after $(( $(date +%s%3N) - t )) ms: $(echo "$PAY" | grep -oE 'Payment status: [A-Z_]+' | tail -1)"
snap "AFTER PAY"
say "  the receiver's operation: $(fc module lnv2 await-receive "$OP" 2>&1 | tr -d '\n ')"
say "  bob's lnd: $(ln_ bob listinvoices | js 'o=>o.invoices.map(i=>`invoice ${i.state}, HTLC accepted at height ${(i.htlcs[0]||{}).accept_height}, held ${Number((i.htlcs[0]||{}).resolve_time)-Number((i.htlcs[0]||{}).accept_time)} s`).join("; ")')"
sleep $WINDOW_S
snap "AFTER WINDOW"
