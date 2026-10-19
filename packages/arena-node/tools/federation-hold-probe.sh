#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# DOES A STAKE PAID INTO A FEDIMINT FEDERATION STAY HELD, OR SETTLE AT ONCE?
#
# The pool is a FEDERATION (2026-09-11 09:26): Fedimint-class, with a
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
# EXT_RPC_PORT, EXT_COOKIE, EXT_WALLET, EXT_BOB_LNDDIR and EXT_BOB_RPC put the
# federation on an existing regtest instead (the rehearsal's); SETUP_ONLY=1
# stops after the gateway is vetted, prints FEDERATION_READY, and leaves it up.
#
# The Fedimint builds are self-extracting bundles that unpack into
# $HOME/.cache; FEDIMINT_HOME (default $FEDIMINT_BIN/home) keeps that inside
# the directory the operator chose. Nothing is installed or put on PATH.
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-720}
if [ -z "${HOLD_PROBE_WRAPPED:-}" ]; then
  export HOLD_PROBE_WRAPPED=1
  exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"
fi
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the Fedimint v0.12.0 builds}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/federation-hold-probe-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
WINDOW_S=${1:-30}
AMOUNT_MSAT=${2:-1000000}
# THE GUARDIANS' HOLD (FM_LNV2_INCOMING_HOLD_SECS): only a fedimintd built with
# the hold patch reads it; 0, the default, is upstream's timing.
HOLD_SECS=${HOLD_SECS:-0}
mkdir -p $P/btc $P/alice $P/bob $P/gw $P/client $FH
: > $P/pids
ZB=30105; ZT=30106
declare -A LRPC=([alice]=30107 [bob]=30110 [carol]=30113) LLIS=([alice]=30108 [bob]=30111 [carol]=30114) LREST=([alice]=30109 [bob]=30112 [carol]=30115)
# SECOND_GATEWAY=1 (rehearsal step 5, own chain only): a second lnd, carol's,
# with a channel to alice funded both ways, and gateway B on it at 30180 -
# joined, pegged in and vetted like A. Off by default: steps 1-4 unchanged.
WHO="alice bob"; [ -n "${SECOND_GATEWAY:-}" ] && WHO="alice bob carol"
# AN EXTERNAL CHAIN (the rehearsal's): with EXT_RPC_PORT set, no bitcoind, lnd
# or channel of this tool's own - the federation stands up on that bitcoind
# (cookie auth: fedimintd and gatewayd take `__cookie__` and its secret as a
# user and password) with its gateway on that bob's lnd.
EXT=${EXT_RPC_PORT:-}
if [ -n "$EXT" ]; then
  RPC=$EXT_RPC_PORT
  BTC_USER=__cookie__; BTC_PASS=$(cut -d: -f2- "$EXT_COOKIE")
  BTC_AUTH=("-rpccookiefile=$EXT_COOKIE"); WALLET=${EXT_WALLET:-blwp}
  BOB_DIR=$EXT_BOB_LNDDIR; BOB_RPC=$EXT_BOB_RPC
else
  RPC=30101
  BTC_USER=blwp; BTC_PASS=blwp
  BTC_AUTH=("-datadir=$P/btc" -rpcuser=arena -rpcpassword=arena); WALLET=probe
  BOB_DIR=$P/bob; BOB_RPC=127.0.0.1:${LRPC[bob]}
fi
say() { echo "$@"; }
# EACH DAEMON'S WHOLE PROCESS GROUP. The Fedimint builds are wrappers that
# start the real daemon as a child; killing the recorded PID alone left four
# fedimintd and a gatewayd running on their ports (measured). Every daemon is
# started under `setsid`, so its group id is the recorded PID.
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  [ -n "$EXT" ] || bcn stop >/dev/null 2>&1
  sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
bcn() { $B/bitcoin-cli -regtest -rpcport=$RPC "${BTC_AUTH[@]}" "$@"; }
bc() { bcn -rpcwallet=$WALLET "$@"; }
ln_() {
  local who=$1; shift
  if [ "$who" = bob ]; then $L/lncli --lnddir=$BOB_DIR --rpcserver=$BOB_RPC --network=regtest "$@";
  else $L/lncli --lnddir=$P/$who --rpcserver=127.0.0.1:${LRPC[$who]} --network=regtest "$@"; fi
}
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
gw() { HOME=$FH timeout 120 $F/gateway-cli -a http://127.0.0.1:30170 --rpcpassword probe "$@"; }
fc() { HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/client "$@"; }
setup() { HOME=$FH timeout 120 $F/fedimint-cli --password probe admin setup "$@"; }
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; say "GAVE UP waiting for $what"; exit 1; }

# ---- THE CHAIN AND THE TWO LIGHTNING NODES, the rehearsal's shape ----
if [ -z "$EXT" ]; then
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=arena -rpcpassword=arena -port=30102 -listen=0 \
  -listenonion=0 -fallbackfee=0.0001 -txindex -zmqpubrawblock=tcp://127.0.0.1:$ZB \
  -zmqpubrawtx=tcp://127.0.0.1:$ZT -daemon >/dev/null
until_ bitcoind 60 bcn getblockcount >/dev/null 2>&1
bcn createwallet probe >/dev/null
MINE=$(bc getnewaddress)
bc generatetoaddress 250 $MINE >/dev/null
for who in $WHO; do
  mkdir -p $P/$who
  setsid nohup $L/lnd --lnddir=$P/$who --bitcoin.regtest --bitcoin.node=bitcoind \
    --bitcoind.rpchost=127.0.0.1:$RPC --bitcoind.rpcuser=arena --bitcoind.rpcpass=arena \
    --bitcoind.zmqpubrawblock=tcp://127.0.0.1:$ZB --bitcoind.zmqpubrawtx=tcp://127.0.0.1:$ZT \
    --rpclisten=127.0.0.1:${LRPC[$who]} --listen=127.0.0.1:${LLIS[$who]} --restlisten=127.0.0.1:${LREST[$who]} \
    --noseedbackup --nobootstrap --alias=$who > $P/$who/lnd.out 2>&1 < /dev/null &
  echo "$! lnd-$who" >> $P/pids
done
synced() { [ "$(ln_ $1 getinfo 2>/dev/null | js 'o=>o.synced_to_chain')" = true ]; }
until_ "alice's lnd" 120 synced alice
until_ "bob's lnd" 120 synced bob
[ -n "${SECOND_GATEWAY:-}" ] && until_ "carol's lnd" 120 synced carol
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
if [ -n "${SECOND_GATEWAY:-}" ]; then
  CAROLKEY=$(ln_ carol getinfo | js 'o=>o.identity_pubkey')
  ln_ alice connect $CAROLKEY@127.0.0.1:${LLIS[carol]} >/dev/null
  opened_c() { ln_ alice openchannel --node_key=$CAROLKEY --local_amt=2000000 --push_amt=1000000 >/dev/null 2>&1; }
  until_ "the channel to carol open" 120 opened_c
  bc generatetoaddress 6 $MINE >/dev/null
  active2() { [ "$(ln_ alice listchannels | js 'o=>(o.channels||[]).filter(c=>c.active).length')" -gt 1 ]; }
  until_ "the channel to carol" 120 active2
  say "channel alice->carol active, funded both ways"
fi
else
  MINE=$(bc getnewaddress)
  say "the external chain at $(bcn getblockcount); the gateway goes on the lnd at $BOB_RPC"
fi

# ---- FOUR GUARDIANS, started one after another: the bundles share one
# unpack directory, and two first runs at once found it half-written ----
for g in 0 1 2 3; do
  base=$((30120 + g * 10)); mkdir -p $P/g$g
  ( export HOME=$FH FM_DATA_DIR=$P/g$g FM_BITCOIN_NETWORK=regtest \
      FM_BITCOIND_URL=http://127.0.0.1:$RPC FM_BITCOIND_USERNAME=$BTC_USER FM_BITCOIND_PASSWORD=$BTC_PASS \
      FM_BIND_P2P=127.0.0.1:$base FM_BIND_API=127.0.0.1:$((base+1)) FM_BIND_UI=127.0.0.1:$((base+2)) \
      FM_BIND_METRICS=127.0.0.1:$((base+3)) FM_P2P_URL=fedimint://127.0.0.1:$base FM_API_URL=ws://127.0.0.1:$((base+1)) \
      FM_ENABLE_IROH=false FM_PASSWORD_API=probe FM_PASSWORD_UI=probe \
      FM_LNV2_INCOMING_HOLD_SECS=$HOLD_SECS \
      FM_DISABLE_BASE_FEES=${DISABLE_BASE_FEES:-1}
    # THE FEDERATION'S BASE FEE IS 0 (2026-09-15 07:44: "run the federation with
    # disable_base_fees"). fedimint 0.12 takes it at DKG from each guardian's env - set-local-params
    # has no flag - and then LNv2's fee_consensus is FeeConsensus::zero(); without it, 1000 msat on
    # every input and every output (measured). DISABLE_BASE_FEES=0 runs the stock default, to compare.
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
( export HOME=$FH FM_DEFAULT_ROUTING_FEES="0 msat,0" FM_DEFAULT_TRANSACTION_FEES="0 msat,0" FM_GATEWAY_DATA_DIR=$P/gw FM_GATEWAY_LISTEN_ADDR=127.0.0.1:30170 FM_GATEWAY_API_ADDR=http://127.0.0.1:30170 \
    FM_GATEWAY_BCRYPT_PASSWORD_HASH="$HASH" FM_GATEWAY_NETWORK=regtest FM_BITCOIND_URL=http://127.0.0.1:$RPC \
    FM_BITCOIND_USERNAME=$BTC_USER FM_BITCOIND_PASSWORD=$BTC_PASS FM_GATEWAY_SKIP_SETUP=true \
    FM_GATEWAY_IROH_LISTEN_ADDR=127.0.0.1:30171 FM_GATEWAY_METRICS_LISTEN_ADDR=127.0.0.1:30172 \
    FM_LND_RPC_ADDR=https://$BOB_RPC FM_LND_TLS_CERT=$BOB_DIR/tls.cert \
    FM_LND_MACAROON=$BOB_DIR/data/chain/bitcoin/regtest/admin.macaroon
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
GWB=""
if [ -n "${SECOND_GATEWAY:-}" ]; then
  # ---- GATEWAY B ON CAROL'S LND, the same way ----
  mkdir -p $P/gwb
  ( export HOME=$FH FM_DEFAULT_ROUTING_FEES="0 msat,0" FM_DEFAULT_TRANSACTION_FEES="0 msat,0" FM_GATEWAY_DATA_DIR=$P/gwb FM_GATEWAY_LISTEN_ADDR=127.0.0.1:30180 FM_GATEWAY_API_ADDR=http://127.0.0.1:30180 \
      FM_GATEWAY_BCRYPT_PASSWORD_HASH="$HASH" FM_GATEWAY_NETWORK=regtest FM_BITCOIND_URL=http://127.0.0.1:$RPC \
      FM_BITCOIND_USERNAME=$BTC_USER FM_BITCOIND_PASSWORD=$BTC_PASS FM_GATEWAY_SKIP_SETUP=true \
      FM_GATEWAY_IROH_LISTEN_ADDR=127.0.0.1:30181 FM_GATEWAY_METRICS_LISTEN_ADDR=127.0.0.1:30182 \
      FM_LND_RPC_ADDR=https://127.0.0.1:${LRPC[carol]} FM_LND_TLS_CERT=$P/carol/tls.cert \
      FM_LND_MACAROON=$P/carol/data/chain/bitcoin/regtest/admin.macaroon
    setsid nohup $F/gatewayd lnd > $P/gwb/gatewayd.out 2>&1 < /dev/null & echo "$! gatewayd-b" >> $P/pids )
  running_b() { grep -q "Gateway is running" $P/gwb/gatewayd.out 2>/dev/null; }
  until_ "gateway B" 180 running_b
  gwb() { HOME=$FH timeout 120 $F/gateway-cli -a http://127.0.0.1:30180 --rpcpassword probe "$@"; }
  gwb connect-fed "$INV" >/dev/null
  PEGINB=$(gwb ecash pegin --federation-id $FED | js 'o=>o.address||o')
  bc sendtoaddress "$PEGINB" 0.01 >/dev/null
  bc generatetoaddress 20 $MINE >/dev/null
  pegged_b() { local e=$(gwb get-balances | js 'o=>(o.ecash_balances||[]).reduce((t,b)=>t+Number(b.ecash_balance_msats||0),0)'); [ "$e" != 0 ] && [ "$e" != '?' ] || { bc generatetoaddress 1 $MINE >/dev/null; false; }; }
  until_ "gateway B's peg-in" 180 pegged_b
  for g in 0 1 2 3; do fc --our-id $g --password probe module lnv2 gateways add http://127.0.0.1:30180 >/dev/null; done
  say "gateway B on carol's lnd: joined, pegged in, vetted; the guardians' list: $(fc module lnv2 gateways list | js 'o=>JSON.stringify(o)')"
  GWB=" gateway_b=http://127.0.0.1:30180"
fi
# SETUP ONLY (the rehearsal's way in): the federation is left running, and
# whoever called this stops it with the process groups in the pids file.
if [ -n "${SETUP_ONLY:-}" ]; then
  say "FEDERATION_READY invite=$INV client=$P/client gateway=http://127.0.0.1:30170 pids=$P/pids$GWB"
  trap - EXIT
  exit 0
fi

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
say "STAKE $((AMOUNT_MSAT / 1000)) sats, window ${WINDOW_S} s, guardians' hold ${HOLD_SECS} s"
snap "BEFORE PAY"
RECV=$(fc module lnv2 receive $AMOUNT_MSAT 2>&1)
INVOICE=$(echo "$RECV" | grep -oE 'lnbcrt[0-9a-z]+' | head -1)
OP=$(echo "$RECV" | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$INVOICE" ] || { say "NO INVOICE - nothing was measured: $(echo "$RECV" | tr -d '\n' | cut -c1-200)"; exit 1; }
# ALICE PAYS IN THE BACKGROUND, so the table can be read WHILE her payment is
# in flight: a held stake must not be in bob's balance inside the window.
t=$(date +%s%3N)
( timeout $((WINDOW_S + HOLD_SECS + 120)) $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:${LRPC[alice]} --network=regtest payinvoice --force "$INVOICE" > $P/pay.out 2>&1; echo "$(( $(date +%s%3N) - t ))" > $P/pay.ms ) &
PAYER=$!
sleep 10
snap "INSIDE WINDOW (pay +10 s)"
say "  bob's lnd at pay +10 s: $(ln_ bob listinvoices | js 'o=>o.invoices.map(i=>`invoice ${i.state}, ${(i.htlcs||[]).map(h=>h.state).join(",") || "no HTLC"}`).join("; ")')"
# AND THE RECEIVER'S SIDE, DRIVEN: `info` exits before a claim can run, so it
# cannot tell "not claimable" from "not yet run". The receiver's own
# await-receive is given 8 s inside the window; one client process at a time.
s2=$(date +%s%3N)
CL=$(HOME=$FH timeout 8 $F/fedimint-cli --data-dir $P/client module lnv2 await-receive "$OP" 2>&1 | tr -d '\n ')
say "  the receiver's claim inside the window (await-receive, 8 s max): ${CL:-no answer - still pending} after $(( $(date +%s%3N) - s2 )) ms, at pay +$(( $(date +%s%3N) - t )) ms; receiver ecash then $(fc info 2>/dev/null | js 'o=>Math.floor(Number(o.total_amount_msat)/1000)')"
wait $PAYER
say "  alice's payinvoice returned after $(cat $P/pay.ms) ms: $(grep -oE 'Payment status: [A-Z_]+' $P/pay.out | tail -1)"
snap "AFTER PAY"
say "  the receiver's operation: $(fc module lnv2 await-receive "$OP" 2>&1 | tr -d '\n ')"
say "  bob's lnd: $(ln_ bob listinvoices | js 'o=>o.invoices.map(i=>`invoice ${i.state}, HTLC accepted at height ${(i.htlcs[0]||{}).accept_height}, held ${Number((i.htlcs[0]||{}).resolve_time)-Number((i.htlcs[0]||{}).accept_time)} s`).join("; ")')"
sleep $WINDOW_S
snap "AFTER WINDOW"
