#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE TESTNET4 STACK TOOLS, EACH RUN AS IT IS RUN LIVE, ON A PRIVATE REGTEST (plan comment 235,
# Go 2026-10-05). The binaries are the patched fork (/home/arena/blwp-testnet4/patched/bin); stock Fedimint is not used.
# ARENA_TN4_NETWORK=regtest is the one thing the tools are told differently from live, with the paths and ports of this
# run in place of the live ones.
#
# EVERY PORT BELOW 32768, outside Linux's ephemeral range (an lnd once lost its listen port to an outbound socket).
# THE STACK, ALL OF IT IN ONE FRESH DIR UNDER /tmp: a regtest bitcoind (rpc 30211, p2p 30212, cookie auth), three lnds
# (alice pays; bob and carol each carry one gateway - one lnd carries one gateway's HTLC interceptor and cannot pay its
# own invoice), seven signer nodes on 23221..23281 each with its guardian, a block every 20 s from a miner beside it.
#
# THE SEQUENCE AND ITS READINGS (one log, one READING line each):
#   1 testnet4-found.mjs founds the federation; the seven nodes start and run their guardians
#     -> 7 guardians, threshold 5, consensus running (the 7-peer invite, which run-testnet4-paid.mjs writes, after 4)
#   2 testnet4-gateway.sh x2 on bob and carol; testnet4-gateways.sh registers both roots, dropping a 127.0.0.1 one
#     -> both roots at all 7 guardians, no 127.0.0.1 entry left
#   3 testnet4-gateway-pegin.sh for each gateway                -> each gateway's e-cash from 0 to more than 0 msat
#   4 run-testnet4-paid.mjs stands the paid round up (bonds posted, six deep)
#     -> one bond per node six deep, the round open at all 7 seats, POST /round 201 at all 7
#   5 testnet4-lock.mjs locks a stake through the page's wasm lock client -> at least 5 seats verify the lock
#   6 testnet4-lnaddr.mjs on bob's lnd                          -> the lnurlp answer, an invoice whose description hash matches
#
# NOTHING LIVE: before any binary starts, tn4-tools-regtest.mjs `safe` refuses the run if a port, dir or macaroon of it is
# the live testnet4 chain, the live lnds, the seats, the guardians or the donors, or if a port already answers. No bond is
# spent; nothing posts or signs on testnet4; no mainnet. Start it with systemd-run (a driver restart kills nohup children):
#   systemd-run --user --unit=blwp-tn4-tools-regtest bash tools/tn4-tools-regtest.sh <log>
set -uo pipefail
LOG=${1:?the log file}
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE_BIN:-$(command -v node)}
export FORK_BIN=${FORK_BIN:-/home/arena/blwp-testnet4/patched/bin} FORK_HOME=${FORK_HOME:-/home/arena/blwp-testnet4/patched/home}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
WASM=${WASM_PKG:-$(cd "$HERE/../../arena-client/dist" && pwd)}
export H=$(mktemp -d /tmp/tn4-tools-regtest-XXXXXX)
: > "$LOG"
say() { echo "$(date -u +%T) $*" | tee -a "$LOG"; }
reading() { say "READING $*"; }
die() { say "STOPPED: $*"; exit 1; }

export ARENA_TN4_NETWORK=regtest ARENA_TESTNET4_DIR=$H ARENA_TN4_WALLET=tn4rt
export BTC_DIR=$H/btc BITCOIN_CLI=$B/bitcoin-cli ARENA_BITCOIND_URL=http://127.0.0.1:30211 ARENA_BITCOIND_COOKIE=$H/btc/regtest/.cookie
export CLIENT_DIR=$H/client LOCK_BIN=$FORK_BIN/arena-stake-lock LNCLI=$L/lncli
export NODE_PORTS=${NODE_PORTS:-23221,23231,23241,23251,23261,23271,23281}
declare -A LRPC=([alice]=29011 [bob]=29012 [carol]=29013) LLIS=([alice]=29021 [bob]=29022 [carol]=29023) LREST=([alice]=29031 [bob]=29032 [carol]=29033)
ZB=29041; ZT=29042; GWA=29300; GWB=29310; LNADDR=${LNADDR_PORT:-29320}; RECIP=29330
GPORTS=""; for p in ${NODE_PORTS//,/ }; do GPORTS="$GPORTS,$p,$((p+1000)),$((p+2000)),$((p+3000)),$((p+4000))"; done
export RUN_PORTS="30211,30212,$ZB,$ZT,${LRPC[alice]},${LRPC[bob]},${LRPC[carol]},${LLIS[alice]},${LLIS[bob]},${LLIS[carol]},${LREST[alice]},${LREST[bob]},${LREST[carol]},$GWA,$((GWA+1)),$((GWA+2)),$GWB,$((GWB+1)),$((GWB+2)),$LNADDR,$RECIP$GPORTS"
export RUN_DIRS="$H/btc,$H/alice,$H/bob,$H/carol,$H/gw-a,$H/gw-b,$CLIENT_DIR,$H/paid,$(for i in 1 2 3 4 5 6 7; do printf '%s,' "$H/node-$i.db"; done)"
export RUN_MACAROONS="$H/bob/data/chain/bitcoin/regtest/admin.macaroon,$H/carol/data/chain/bitcoin/regtest/admin.macaroon,$H/alice/data/chain/bitcoin/regtest/admin.macaroon"

PIDS=$H/pids; : > $PIDS
bcn() { $B/bitcoin-cli -datadir=$BTC_DIR "$@"; }
bc() { bcn -rpcwallet=tn4rt "$@"; }
ln_() { local who=$1; shift; $L/lncli --lnddir=$H/$who --rpcserver=127.0.0.1:${LRPC[$who]} --network=regtest "$@"; }
fc() { HOME=$FORK_HOME timeout 120 $FORK_BIN/fedimint-cli --data-dir $CLIENT_DIR "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; }
gc() { HOME=$FORK_HOME timeout 120 $FORK_BIN/gateway-cli --address http://127.0.0.1:$1 --rpcpassword "$(cat $2)" "${@:3}" 2>/dev/null; }
js() { "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s.slice(s.indexOf('{')===-1?s.indexOf('['):Math.min(...[s.indexOf('{'),s.indexOf('[')].filter(i=>i>=0))));console.log(($1)(o))})"; }
until_() { local what=$1 secs=$2; shift 2; local t=$(date +%s); until "$@"; do [ $(( $(date +%s) - t )) -gt $secs ] && die "$what: not within $secs s"; sleep 2; done; }
# THIS RUN'S GUARDIANS: fedimintd children whose environment names this run's dir (a node killed hard leaves its own)
# (macOS has no /proc: there `ps -E` prints a process's environment after its command line)
envOf() { if [ -r /proc/$1/environ ]; then tr '\0' '\n' < /proc/$1/environ; else ps -Eww -o command= -p $1 2>/dev/null | tr ' ' '\n'; fi; }
kill_guardians() { for pid in $(pgrep -x fedimintd); do envOf $pid | grep -q "^FM_DATA_DIR=$H/" && kill -KILL $pid; done; }
# THE NODES BY WHAT THEY RUN (a recorded pid once missed one, which then held its port): every src/main.js on this run's
# stores, then until no node port answers - their guardians are their children and go with them
stop_nodes() { pkill -TERM -f "src/main.js [0-9]+ $H/node-" 2>/dev/null; sleep 8; pkill -KILL -f "src/main.js [0-9]+ $H/node-" 2>/dev/null
  kill_guardians; sed -i '/ node-[0-9]/d' $PIDS
  down() { for p in ${NODE_PORTS//,/ }; do curl -s -o /dev/null --max-time 2 http://127.0.0.1:$p/identity && return 1; done; return 0; }
  until_ "the seven nodes stop" 60 down; }
cleanup() {
  say "stopping the private stack"
  for pid in $(cut -d' ' -f1 $PIDS); do kill -TERM -- -$pid 2>/dev/null; kill -TERM $pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 8
  for pid in $(cut -d' ' -f1 $PIDS); do kill -KILL -- -$pid 2>/dev/null; done
  pkill -f "src/main.js [0-9]+ $H/node-" 2>/dev/null; pkill -f "$H/" 2>/dev/null; sleep 3; kill_guardians
  # AND WHAT A STAGE STARTED WITHOUT A PID LINE (run 6 on the test host: the restarted runner A held 12221 after the stop):
  # every process of this user whose environment names this run's dir, but this script
  for pid in $(pgrep -u "$(id -u)"); do [ "$pid" = $$ ] && continue; envOf $pid 2>/dev/null | grep -q "^H=$H$" && kill -KILL $pid 2>/dev/null; done
  say "stack dir kept for reading: $H"
}
trap cleanup EXIT

# ---- 0. NOTHING OF THIS RUN IS THE LIVE STACK ----
"$NODE" "$HERE/tn4-tools-regtest.mjs" safe >> "$LOG" 2>&1 || die "the safety check refused this run (above)"
say "safe: every port, dir and macaroon of this run is private (dir $H)"

# ---- THE CHAIN, THE LNDS, THE MINER ----
mkdir -p $BTC_DIR
cat > $BTC_DIR/bitcoin.conf <<EOF
regtest=1
[regtest]
rpcport=30211
port=30212
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
listen=1
bind=127.0.0.1
listenonion=0
fallbackfee=0.0001
txindex=1
zmqpubrawblock=tcp://127.0.0.1:$ZB
zmqpubrawtx=tcp://127.0.0.1:$ZT
EOF
setsid $B/bitcoind -datadir=$BTC_DIR > $H/bitcoind.out 2>&1 < /dev/null & echo "$! bitcoind" >> $PIDS
until_ bitcoind 90 bcn getblockcount >/dev/null 2>&1
bcn createwallet tn4rt >/dev/null
MINE=$(bc getnewaddress)
bc generatetoaddress 250 $MINE >/dev/null
for who in alice bob carol; do
  mkdir -p $H/$who
  setsid $L/lnd --lnddir=$H/$who --bitcoin.regtest --bitcoin.node=bitcoind --bitcoind.rpchost=127.0.0.1:30211 \
    --bitcoind.rpccookie=$ARENA_BITCOIND_COOKIE --bitcoind.zmqpubrawblock=tcp://127.0.0.1:$ZB --bitcoind.zmqpubrawtx=tcp://127.0.0.1:$ZT \
    --rpclisten=127.0.0.1:${LRPC[$who]} --listen=127.0.0.1:${LLIS[$who]} --restlisten=127.0.0.1:${LREST[$who]} \
    --noseedbackup --nobootstrap --alias=$who > $H/$who/lnd.out 2>&1 < /dev/null & echo "$! lnd-$who" >> $PIDS
done
synced() { ln_ $1 getinfo > $H/$1.getinfo 2>&1; grep -q '"synced_to_chain": *true' $H/$1.getinfo; }
for who in alice bob carol; do until_ "$who's lnd" 180 synced $who; done
for who in alice alice bob carol; do bc sendtoaddress "$(ln_ $who newaddress p2tr | js 'o=>o.address')" 5 >/dev/null; done
bc generatetoaddress 6 $MINE >/dev/null
for who in bob carol; do
  KEY=$(ln_ $who getinfo | js 'o=>o.identity_pubkey')
  until_ "alice connects $who" 60 ln_ alice connect "$KEY@127.0.0.1:${LLIS[$who]}" >/dev/null 2>&1
  opens() { ln_ alice openchannel --node_key=$KEY --local_amt=4000000 --push_amt=1000000 > $H/open-$who.out 2>&1; }
  until_ "alice opens a channel to $who" 120 opens
  bc generatetoaddress 1 $MINE >/dev/null
done
bc generatetoaddress 6 $MINE >/dev/null
( while true; do sleep 20; [ -e $H/miner-pause ] && continue; $B/bitcoin-cli -datadir=$BTC_DIR -rpcwallet=tn4rt generatetoaddress 1 $MINE >/dev/null 2>&1 || exit 0; done ) &
echo "$! miner" >> $PIDS
say "chain at $(bcn getblockcount); lnds alice, bob, carol synced; channels alice->bob, alice->carol; a block every 20 s"

# ---- 1. THE FEDERATION: testnet4-found.mjs, then the seven nodes with their guardians ----
export PATH=$FORK_BIN:$(dirname "$NODE"):${SHIM_DIR:+$SHIM_DIR:}/usr/bin:/bin HOME_REAL=$HOME   # SHIM_DIR: timeout/setsid on a macOS
FOUND_ARGS=""; i=0; for p in ${NODE_PORTS//,/ }; do i=$((i+1)); FOUND_ARGS="$FOUND_ARGS $p:$H/node-$i.db"; done
( cd "$HERE/.." && HOME=$FORK_HOME timeout 900 "$NODE" tools/testnet4-found.mjs $FOUND_ARGS ) >> "$LOG" 2>&1 || die "testnet4-found.mjs failed"
INVITE=$(grep -o '"invite":"[^"]*"' "$LOG" | tail -1 | cut -d'"' -f4)
[ -n "$INVITE" ] && [ "$INVITE" != "(none written)" ] || die "the founding wrote no invite"
echo "$INVITE" > $H/invite-code
mkdir -p $H/paid/attach-proof
start_nodes() {
  i=0; for p in ${NODE_PORTS//,/ }; do i=$((i+1))
    ( cd "$HERE/.." && HOME=$FORK_HOME ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_DIR ARENA_CLOSE_AT_END=1 \
      ARENA_DONATION_NETWORK=regtest setsid "$NODE" src/main.js $p $H/node-$i.db > $H/node-$i.log 2>&1 < /dev/null & echo "$! node-$i" >> $PIDS )
  done
  for p in ${NODE_PORTS//,/ }; do until_ "node $p" 120 curl -s -o /dev/null --max-time 3 http://127.0.0.1:$p/identity; done
}
start_nodes
joined() { fc join-federation "$INVITE" >/dev/null 2>&1 || fc info >/dev/null 2>&1; }
until_ "the client joins the federation" 300 joined
say "founded; seven nodes up, each with its guardian; client joined"
consensus() { for i in 1 2 3 4 5 6 7; do sed 's/\x1b\[[0-9;]*m//g' $H/node-$i.db.guardian/fedimintd.log 2>/dev/null | grep -q 'Completed consensus session' || return 1; done; }
until_ "every guardian completes a consensus session" 900 consensus
"$NODE" "$HERE/tn4-tools-regtest.mjs" federation >> "$LOG" 2>&1 || die "reading 1 failed (above)"
reading "1 federation: $(grep '"reading":1' "$LOG" | tail -1)"

# ---- 2. THE GATEWAYS: testnet4-gateway.sh on bob and carol, testnet4-gateways.sh registers their roots ----
for g in a b; do
  who=$([ $g = a ] && echo bob || echo carol); port=$([ $g = a ] && echo $GWA || echo $GWB)
  ( cd "$HERE/.." && HOME=$FORK_HOME setsid bash tools/testnet4-gateway.sh $H/$who 127.0.0.1:${LRPC[$who]} $port $H/gw-$g > $H/gw-$g.out 2>&1 < /dev/null & echo "$! gatewayd-$g" >> $PIDS )
done
gwup() { gc $1 $2 info >/dev/null 2>&1; }
until_ "gateway a" 180 gwup $GWA $H/gw-a/password
until_ "gateway b" 180 gwup $GWB $H/gw-b/password
for g in a b; do port=$([ $g = a ] && echo $GWA || echo $GWB); gc $port $H/gw-$g/password connect-fed "$INVITE" >/dev/null || die "gateway $g did not join"; done
FED=$(fc info | js 'o=>o.federation_id')
cat > $H/passthrough <<'EOF'
#!/bin/sh
exec "$@"
EOF
chmod +x $H/passthrough
export ARENA_TAILNET_EXEC=$H/passthrough GATEWAY_ROOTS="http://localhost:$GWA,http://localhost:$GWB"
# a 127.0.0.1 registration first, as the live federation once had, so the tool's drop is measured too
( cd "$HERE/.." && HOME=$FORK_HOME bash tools/testnet4-gateways.sh $CLIENT_DIR http://127.0.0.1:$GWA ) >> "$LOG" 2>&1
( cd "$HERE/.." && HOME=$FORK_HOME bash tools/testnet4-gateways.sh $CLIENT_DIR http://localhost:$GWA http://localhost:$GWB -- http://127.0.0.1:$GWA ) >> "$LOG" 2>&1 \
  || die "testnet4-gateways.sh failed"
"$NODE" "$HERE/tn4-tools-regtest.mjs" gateways >> "$LOG" 2>&1 || die "reading 2 failed (above)"
reading "2 gateways: $(grep '"reading":2' "$LOG" | tail -1)"

# ---- 3. THE PEG-INS: testnet4-gateway-pegin.sh for each gateway, from its own lnd's on-chain wallet ----
ecash() { gc $1 $2 get-balances | js "o=>((o.ecash_balances||[]).find(b=>b.federation_id==='$FED')||{}).ecash_balance_msats||0"; }
BEFORE_A=$(ecash $GWA $H/gw-a/password); BEFORE_B=$(ecash $GWB $H/gw-b/password)
for g in a b; do port=$([ $g = a ] && echo $GWA || echo $GWB)
  ( cd "$HERE/.." && FEE_RATE=2 HOME=$FORK_HOME bash tools/testnet4-gateway-pegin.sh http://127.0.0.1:$port $H/gw-$g/password $FED 500000 ) >> "$LOG" 2>&1 \
    || die "testnet4-gateway-pegin.sh $g failed"
done
bc generatetoaddress 30 $MINE >/dev/null
credited() { [ "$(ecash $GWA $H/gw-a/password)" -gt 0 ] && [ "$(ecash $GWB $H/gw-b/password)" -gt 0 ]; }
until_ "both gateways hold e-cash" 600 credited
reading "3 peg-in: {\"ok\":true,\"gatewayA\":{\"beforeMsat\":$BEFORE_A,\"afterMsat\":$(ecash $GWA $H/gw-a/password)},\"gatewayB\":{\"beforeMsat\":$BEFORE_B,\"afterMsat\":$(ecash $GWB $H/gw-b/password)}}"
[ "$BEFORE_A" = 0 ] && [ "$BEFORE_B" = 0 ] || die "a gateway held e-cash before its peg-in"

# ---- 7. THE ARBITER'S PEG-IN (spec §5A.3: "the arbitration set pegs it into the round's federation"): its own
# client joined to the federation, a peg-in address (stake-lock --mode pegin-address), a payment to it, the claim once the
# federation has seen it confirmed (--mode pegin-claim) - the e-cash the shares are then locked from. PEGIN_BIN names the build.
# PEGIN_ONLY=1 takes it right after reading 7 (lock latency), on the federation as it stands, and stops there.
pegin() {
if [ -n "${PEGIN_BIN:-}" ]; then
  ARB=$H/arbiter; mkdir -p $ARB
  HOME=$FORK_HOME timeout 120 $FORK_BIN/fedimint-cli --data-dir $ARB join-federation "$(cat $H/invite-code)" >> "$LOG" 2>&1
  rm -f $H/miner-pause
  PA=$(HOME=$FORK_HOME timeout 300 $PEGIN_BIN --mode pegin-address --data-dir $ARB 2>>"$LOG" | grep '"mode":"pegin-address"')
  reading "7a pegin address: ${PA:-null}"
  ADDR=$(echo "$PA" | js 'o=>o.address')
  [ -n "$ADDR" ] || die "reading 7 failed: no peg-in address"
  T0=$(date +%s)
  TXID=$(bc sendtoaddress "$ADDR" 0.001)
  say "sent 0.001 BTC to the peg-in address: $TXID"
  bc generatetoaddress 12 $(bc getnewaddress) >/dev/null
  PC=$(HOME=$FORK_HOME timeout 900 $PEGIN_BIN --mode pegin-claim --data-dir $ARB --address "$ADDR" --timeout-s 840 2>>"$LOG" | grep '"mode":"pegin-claim"')
  reading "7b pegin claim: {\"claim\":${PC:-null},\"seconds\":$(( $(date +%s) - T0 )),\"txid\":\"$TXID\"}"
  [ -n "$PC" ] || die "reading 7 failed: no claim"
  # 7c. THE PLAYERS' ESCROW INTO THE FEDERATION (§5A.3B): an escrow output of the arbitration set, as a slash's
  # path B pays it, spent by 5 of its 7 members to a fresh peg-in address of the arbiter's client; then that peg-in claimed
  PA2=$(HOME=$FORK_HOME timeout 300 $PEGIN_BIN --mode pegin-address --data-dir $ARB 2>>"$LOG" | grep '"mode":"pegin-address"')
  ADDR2=$(echo "$PA2" | js 'o=>o.address')
  [ -n "$ADDR2" ] || die "reading 7c failed: no second peg-in address"
  T1=$(date +%s)
  ( cd "$HERE/.." && BITCOIN_CLI="$B/bitcoin-cli -datadir=$BTC_DIR -rpcwallet=tn4rt" PEGIN_ADDRESS=$ADDR2 timeout 300 "$NODE" tools/escrow-pegin.mjs ) > $H/escrow.out 2>&1; ESC_RC=$?
  cat $H/escrow.out >> "$LOG"
  bc generatetoaddress 11 $(bc getnewaddress) >/dev/null
  PC2=$(HOME=$FORK_HOME timeout 900 $PEGIN_BIN --mode pegin-claim --data-dir $ARB --address "$ADDR2" --timeout-s 840 2>>"$LOG" | grep '"mode":"pegin-claim"')
  reading "7c escrow into the federation: {\"exit\":$ESC_RC,\"spend\":$(grep '"step":"escrow into the federation"' $H/escrow.out | tail -1 || echo null),\"claim\":${PC2:-null},\"seconds\":$(( $(date +%s) - T1 ))}"
  [ -n "$PC2" ] || die "reading 7c failed: the escrow's peg-in was not claimed"
  # 7d. THE SLASH'S PAYOUTS (§5A.3B "locks each share to its player"): two wronged players' shares from the
  # arbiter's e-cash, in one transaction, each a pre-expired lock only that player's key moves (stake-lock --mode pay)
  pkOf() { "$NODE" --input-type=module -e "import { secp256k1 } from '@noble/curves/secp256k1.js'; console.log(Buffer.from(secp256k1.getPublicKey(Buffer.from('$1', 'hex'), true)).toString('hex'))"; }
  PS1=$(openssl rand -hex 32); PS2=$(openssl rand -hex 32); PK1=$(pkOf $PS1); PK2=$(pkOf $PS2)
  PAY=$(HOME=$FORK_HOME timeout 300 $PEGIN_BIN --mode pay --data-dir $ARB --payouts "$PK1:60000000,$PK2:40000000" 2>>"$LOG" | grep '"mode":"pay"')
  reading "7d slash payouts: ${PAY:-null}"
  [ -n "$PAY" ] || die "reading 7d failed: no payout transaction"
  # 7e. EACH PLAYER TAKES ITS OWN: a fresh client of the federation, the payout redeemed by the refund path with the
  # player's key (the page's way for a settlement's payout); the other player's key cannot
  PTX=$(echo "$PAY" | js 'o=>o.txid')
  RED=""
  for i in 1 2; do
    eval "SK=\$PS$i; PK=\$PK$i"; DIRP=$H/player-$i; mkdir -p $DIRP
    HOME=$FORK_HOME timeout 120 $FORK_BIN/fedimint-cli --data-dir $DIRP join-federation "$(cat $H/invite-code)" >> "$LOG" 2>&1
    IDX=$(echo "$PAY" | js "o=>o.payouts.find(p=>p.refund_pk==='$PK').out_idx"); MSAT=$(echo "$PAY" | js "o=>o.payouts.find(p=>p.refund_pk==='$PK').amount_msat")
    redeemAs() { HOME=$FORK_HOME timeout 300 $PEGIN_BIN --mode redeem --data-dir $DIRP --outpoint $PTX:$IDX --amount-msat $MSAT --hash 0000000000000000000000000000000000000000000000000000000000000000 \
      --claim-pk $PK --refund-pk $PK --expiration 0 --witness refund --signer-secret $1 2>>"$LOG" | grep '"mode":"redeem"' | js 'o=>JSON.stringify({accepted:o.accepted,signerIsRefundPk:o.signer_is_refund_pk,error:o.error})'; }
    OTHER=$([ $i = 1 ] && echo $PS2 || echo $PS1)
    WRONG=$(redeemAs $OTHER); RIGHT=$(redeemAs $SK)
    # the redeem exits once the guardians accept it; the notes it pays are issued after - waited for here (measured: info
    # read 0 msat straight after both accepted redeems)
    HOME=$FORK_HOME timeout 180 $FORK_BIN/fedimint-cli --data-dir $DIRP dev wait-complete >/dev/null 2>&1
    BAL=$(HOME=$FORK_HOME timeout 120 $FORK_BIN/fedimint-cli --data-dir $DIRP info 2>/dev/null | js 'o=>o.total_amount_msat')
    RED="$RED{\"player\":$i,\"msat\":$MSAT,\"otherKey\":$WRONG,\"ownKey\":$RIGHT,\"balanceMsat\":${BAL:-null}},"
  done
  reading "7e payouts redeemed: [${RED%,}]"
  # 7f. THE SERVICE'S OWN PAYOUT STEP (arbiter.js payOutSlash), end to end on a recorded slash: escrow -> federation -> claimed
  # -> each share locked -> each player redeems its own
  ( cd "$HERE/.." && BITCOIN_CLI="$B/bitcoin-cli -datadir=$BTC_DIR -rpcwallet=tn4rt" STAKE_LOCK_BIN=$PEGIN_BIN CLIENT_DIR=$ARB FEDIMINT_CLI=$FORK_BIN/fedimint-cli \
    INVITE_FILE=$H/invite-code WORK_DIR=$H FORK_HOME=$FORK_HOME timeout 1500 "$NODE" tools/arbiter-payout-regtest.mjs ) > $H/payout.out 2>&1; PO_RC=$?
  cat $H/payout.out >> "$LOG"
  # 7g. THE COOPERATIVE RELEASE (§5A.3B key path): a bond output spent by MuSig2 of its node (owner doors) and the
  # arbitration set (arbiter doors), one key-path signature, accepted by bitcoind and mined
  ( cd "$HERE/.." && BITCOIN_CLI="$B/bitcoin-cli -datadir=$BTC_DIR -rpcwallet=tn4rt" timeout 300 "$NODE" tools/musig-release-regtest.mjs ) > $H/release.out 2>&1; RL_RC=$?
  cat $H/release.out >> "$LOG"
  reading "7g cooperative release: {\"exit\":$RL_RC,\"signed\":$(grep '"step":"signed"' $H/release.out | tail -1 || echo null),\"released\":$(grep '"step":"released"' $H/release.out | tail -1 || echo null)}"
  reading "7f the service's payout step: {\"exit\":$PO_RC,\"paid\":$(grep '"step":"payOutSlash"' $H/payout.out | tail -1 || echo null),\"redeemed\":$(grep '"step":"redeemed"' $H/payout.out | tail -1 || echo null)}"
fi
}

# ---- 7. THE STAKE LOCK'S ACCEPTANCE TIME: lock-latency-regtest.mjs, 20 locks through the page's wasm lock
# client on this federation (alice pays the deposit through a gateway); submit -> accepted on one clock, the 200 ms line.
# Recorded, not a stop: the run goes on to the paid round whatever it measures. LOCK_LATENCY_ONLY=1 stops after it.
( cd "$HERE/.." && INVITE_FILE=$H/invite-code WASM_PKG=$WASM LNCLI=$LNCLI PAYER_DIR=$H/alice PAYER_RPC=127.0.0.1:${LRPC[alice]} \
  timeout 600 "$NODE" tools/lock-latency-regtest.mjs ) > $H/latency.out 2>&1; LAT_RC=$?
cat $H/latency.out >> "$LOG"
reading "7 lock latency: {\"exit\":$LAT_RC,\"summary\":$(grep '"step":"summary"' $H/latency.out | tail -1 || echo null)}"
[ "${LOCK_LATENCY_ONLY:-}" = 1 ] && { say "LOCK_LATENCY_ONLY: stopping after reading 7"; exit 0; }
[ "${PEGIN_ONLY:-}" = 1 ] && { pegin; say "PEGIN_ONLY: stopping after readings 7a and 7b"; exit 0; }

# ---- 4. THE PAID ROUND: run-testnet4-paid.mjs, which starts the seven nodes itself and posts their bonds ----
stop_nodes
WSS=""; for p in ${NODE_PORTS//,/ }; do WSS="$WSS ARENA_WSS_$p=ws://127.0.0.1:$p"; done
( cd "$HERE/.." && env $WSS HOME=$FORK_HOME ARENA_TN4_PORTS=$NODE_PORTS ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_DIR \
  ARENA_FEDERATION_INVITE_FILE=$H/invite-code ARENA_RECIPIENT_PORT=$RECIP ARENA_TN4_DATADIR=$BTC_DIR \
  ARENA_ENTRY_WINDOW_MS=${ENTRY_WINDOW_MS:-21600000} ${ENTRY_WINDOW_MS:+PAID_KEEP=0} \
  setsid "$NODE" tools/run-testnet4-paid.mjs > $H/paid.out 2>&1 < /dev/null & echo "$! node-paid" >> $PIDS )
paidup() { grep -q '"paid":"up"' $H/paid.out; }
until_ "run-testnet4-paid.mjs stands the round up" 1500 paidup
ROUND=$(grep -o '"firstRound":"[0-9a-f]*"' $H/paid.out | tail -1 | cut -d'"' -f4)
say "paid round $ROUND up: $(grep '"paid":"up"' $H/paid.out | tail -1 | cut -c1-300)"
"$NODE" "$HERE/tn4-tools-regtest.mjs" round $ROUND >> "$LOG" 2>&1 || die "reading 4 failed (above)"
reading "4 paid round: $(grep '"reading":4' "$LOG" | tail -1)"
"$NODE" "$HERE/tn4-tools-regtest.mjs" invite >> "$LOG" 2>&1 || die "reading 1 (the invite) failed (above)"
reading "1 invite: $(grep '"reading":"1-invite"' "$LOG" | tail -1)"

# ---- 5. THE LOCK: testnet4-lock.mjs, the page's own wasm lock client, alice paying the deposit ----
# THE FEDERATION'S BLOCK COUNT CAUGHT UP FIRST. The lock client sets a lock's expiration from the federation's consensus
# block count, and a seat refuses a lock whose height is more than 12 blocks below the chain tip it verifies at. This
# harness mines in bursts (30 blocks for the peg-ins, 6 per bond burial) that testnet4's 10-minute blocks never make, so
# the miner pauses and the federation is waited for (measured: count 440 at tip 501 straight after the round stood up).
touch $H/miner-pause
fedcount() { fc module walletv2 info block-count | tr -dc '0-9'; }
caught() { local t=$(bcn getblockcount) f=$(fedcount); echo "$t $f" > $H/fedcount; [ -n "$f" ] && [ "$f" -ge $((t - 15)) ]; }
until_ "the federation's block count reaches the tip less 15" 900 caught
say "federation block count $(cut -d' ' -f2 $H/fedcount) at tip $(cut -d' ' -f1 $H/fedcount); the miner is paused for the lock"
# The seats make the round's claim key together after it opens; the tool stops on "claim key:" - before any deposit - while
# fewer than five attest it, so only that stop is tried again.
for try in 1 2 3 4 5 6 7 8 9 10; do
  ( cd "$HERE/.." && ROUND=$ROUND PORTS=$NODE_PORTS INVITE_FILE=$H/invite-code WASM_PKG=$WASM LNCLI=$LNCLI PAYER_DIR=$H/alice \
    MARK_BOT=off PAYER_RPC=127.0.0.1:${LRPC[alice]} timeout 900 "$NODE" tools/testnet4-lock.mjs ) > $H/lock.out 2>&1; LOCK_RC=$?
  cat $H/lock.out >> "$LOG"
  grep -q '"why":"Error: claim key:' $H/lock.out || break
  say "lock try $try: the claim key is not attested by five yet; again in 15 s"; sleep 15
done
LOCKED=$(grep '"step":"handed over"' $H/lock.out | tail -1)
reading "5 lock: {\"ok\":$([ $LOCK_RC = 0 ] && echo true || echo false),\"exit\":$LOCK_RC,\"handedOver\":${LOCKED:-null}}"
[ $LOCK_RC = 0 ] || die "reading 5 failed: testnet4-lock.mjs exit $LOCK_RC"

# ---- 6. THE LIGHTNING ADDRESS: testnet4-lnaddr.mjs on bob's lnd ----
( cd "$HERE/.." && LNCLI=$LNCLI LND_DIR=$H/bob LND_RPC=127.0.0.1:${LRPC[bob]} PORT=$LNADDR PUBLIC=http://localhost:$LNADDR \
  setsid "$NODE" tools/testnet4-lnaddr.mjs > $H/lnaddr.out 2>&1 < /dev/null & echo "$! lnaddr" >> $PIDS )
until_ "lnaddr" 30 curl -s -o /dev/null --max-time 3 http://127.0.0.1:$LNADDR/.well-known/lnurlp/x
LNADDR_PUBLIC=http://localhost:$LNADDR LNADDR_LND_DIR=$H/bob LNADDR_LND_RPC=127.0.0.1:${LRPC[bob]} "$NODE" "$HERE/tn4-tools-regtest.mjs" lnaddr >> "$LOG" 2>&1 \
  || die "reading 6 failed (above)"
reading "6 lightning address: $(grep '"reading":6' "$LOG" | tail -1)"

[ -n "${PEGIN_ONLY:-}" ] || pegin
[ "${SUCCESSION:-}" = 1 ] && . "$HERE/succession-stage.sh"   #: the successor, the drain, the notes moved

say "ALL SIX READINGS TAKEN"
