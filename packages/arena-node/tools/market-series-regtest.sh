#!/bin/bash
# A PAID MARKET AS A PUBLISHED SERIES, ON A PRIVATE REGTEST, FOR THE PAGE (kanban #206, the owner 2026-10-07 23:23, decision A):
# the lobby offers a paid row only for a round of a series, so the regtest market is stood up as the live paid rounds are -
# seven seats with their guardians (the federation), their bonds, one series published with OP_RETURN "ARN SERIES" below its
# beacon - and held up for a browser. Regtest runs the mainnet series clock: a series starts on genesis_series_start +
# k x 24 h with its committee_time 72 h before, so the chain is MINED IN THE PAST (bitcoind setmocktime) through the bonds and
# the publication, then brought to the present; the lnds, the gateways and the peg-ins come after (an lnd on a tip days old
# never says synced - measured). Built from tn4-tools-regtest.sh: same ports, same safety check, same tools.
#
#   systemd-run --user ... bash tools/market-series-regtest.sh <log>       (from packages/arena-node; the test host's own launcher)
# The stack stays up until $H/release exists (or HOLD_MIN minutes); $H/ready names the lobby link and the series.
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
export CLIENT_DIR=$H/client LOCK_BIN=$FORK_BIN/blwp-stake-lock LNCLI=$L/lncli
export NODE_PORTS=${NODE_PORTS:-23221,23231,23241,23251,23261,23271,23281}   # another machine's stack on 23221..: name others
declare -A LRPC=([alice]=29011 [bob]=29012 [carol]=29013) LLIS=([alice]=29021 [bob]=29022 [carol]=29023) LREST=([alice]=29031 [bob]=29032 [carol]=29033)
ZB=${ZB:-29041}; ZT=${ZT:-29042}; GWA=${GWA:-29300}; GWB=${GWB:-29310}; LNADDR=${LNADDR:-29320}; RECIP=${RECIP:-29330}   # override beside another stack (kanban #236)
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
# a guardian of THIS run: its FM_DATA_DIR under $H (Linux: /proc's environment; macOS shows no other process's environment:
# a file it holds open under $H) - as the test host runs of kanban #178 found
ours() { if [ -r /proc/$1/environ ]; then tr '\0' '\n' < /proc/$1/environ | grep -q "^FM_DATA_DIR=$H/"; else lsof -p $1 -Fn 2>/dev/null | grep -qE "^n(/private)?$H/"; fi; }
kill_guardians() { for pid in $(pgrep -x fedimintd); do ours $pid && kill -KILL $pid; done; }
# THIS RUN'S GATEWAYS: their command line is only "gatewayd lnd", so they are found by a file they hold under $H
holds() { if [ -d /proc/$1/fd ]; then ls -l /proc/$1/fd 2>/dev/null | grep -q " $H/"; else lsof -p $1 -Fn 2>/dev/null | grep -qE "^n(/private)?$H/"; fi; }
kill_gateways() { for pid in $(pgrep -x gatewayd); do holds $pid && kill -KILL $pid; done; }
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
  pkill -f "src/main.js [0-9]+ $H/node-" 2>/dev/null; pkill -f "$H/" 2>/dev/null; sleep 3; kill_guardians; kill_gateways
  # AND EVERY NODE PROCESS STILL WRITING UNDER $H (kanban #293, measured twice on the test host: the paid runner outlived the
  # stack and held its port 29430, so the next run's safety check refused it). macOS's setsid shim forks when setsid()
  # fails, so $PIDS kept the shim's pid while the runner ran as the next one, in a session of its own.
  for pid in $(pgrep -x node); do holds $pid && kill -TERM $pid 2>/dev/null; done
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
# THE CHAIN IN THE PAST: today's series' committee_time (= its census cut, mainnet clock) is today 00:00Z - 72 h; the chain is
# mined from 8 h before it, and stays there until the series is published
TODAY_MS=$(( ($(date +%s) / 86400) * 86400 * 1000 ))
CUT=$(( TODAY_MS / 1000 - 72 * 3600 ))
bcn setmocktime $(( CUT - 8 * 3600 )) >/dev/null
# the wallet is made AFTER the clock is set: a wallet born now never scans blocks dated days before it (measured: balance 0)
bcn createwallet tn4rt >/dev/null
say "the chain is mined in the past: mocktime $(date -u -r $(( CUT - 8 * 3600 )) +%FT%TZ 2>/dev/null || date -u -d @$(( CUT - 8 * 3600 )) +%FT%TZ), the series' committee_time $(date -u -r $CUT +%FT%TZ 2>/dev/null || date -u -d @$CUT +%FT%TZ)"
MINE=$(bc getnewaddress)
bc generatetoaddress 250 $MINE >/dev/null

say "chain at $(bcn getblockcount); lnds alice, bob, carol synced; channels alice->bob, alice->carol; a block every 20 s"

# ---- 1. THE FEDERATION: testnet4-found.mjs, then the seven nodes with their guardians ----
# ARENA_EXTRA_PATH (the launcher's, not named here): kept before /usr/bin - the test host's GNU shims and /usr/sbin
export PATH=$FORK_BIN:$(dirname "$NODE"):${ARENA_EXTRA_PATH:+$ARENA_EXTRA_PATH:}/usr/bin:/bin HOME_REAL=$HOME
FOUND_ARGS=""; i=0; for p in ${NODE_PORTS//,/ }; do i=$((i+1)); FOUND_ARGS="$FOUND_ARGS $p:$H/node-$i.db"; done
( cd "$HERE/.." && HOME=$FORK_HOME timeout 900 "$NODE" tools/testnet4-found.mjs $FOUND_ARGS ) >> "$LOG" 2>&1 || die "testnet4-found.mjs failed"
INVITE=$(grep -o '"invite":"[^"]*"' "$LOG" | tail -1 | cut -d'"' -f4)
[ -n "$INVITE" ] && [ "$INVITE" != "(none written)" ] || die "the founding wrote no invite"
echo "$INVITE" > $H/invite-code
mkdir -p $H/paid/attach-proof $H/series
GAMES="$(cd "$HERE/.." && pwd)/../nextblock/plugin/nextblock.js,$(cd "$HERE/.." && pwd)/test/plugins/market/game.js,$(cd "$HERE/.." && pwd)/test/plugins/updown/game.js,$(cd "$HERE/.." && pwd)/../rock-paper-scissors/plugin/rock-paper-scissors.js"
SEAT_ENV=""
start_nodes() {
  i=0; for p in ${NODE_PORTS//,/ }; do i=$((i+1))
    # EACH SEAT READS LOCKS THROUGH ITS OWN COPY OF THE JOINED CLIENT (as the testnet4 seats do, client-lock-tn4-read-N; kanban
    # #237): through one shared directory the seven seats' status reads queued one at a time, a second player's stake lock
    # stayed unseen at four seats past the 12-block lock-height rule (4 min at a block every 20 s), and the order never traded
    READ=""; if [ -n "$SEAT_ENV" ]; then rm -rf $H/client-read-$i; cp -R $CLIENT_DIR $H/client-read-$i; READ="ARENA_FEDERATION_CLIENT_READ_DIR=$H/client-read-$i"; fi
    ( cd "$HERE/.." && HOME=$FORK_HOME ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_DIR ARENA_CLOSE_AT_END=1 \
      ARENA_DONATION_NETWORK=regtest ARENA_GAMES=$GAMES env $SEAT_ENV $READ setsid "$NODE" src/main.js $p $H/node-$i.db > $H/node-$i.log 2>&1 < /dev/null & echo "$! node-$i" >> $PIDS )
  done
  for p in ${NODE_PORTS//,/ }; do until_ "node $p" 120 curl -s -o /dev/null --max-time 3 http://127.0.0.1:$p/identity; done
}
start_nodes
joined() { fc join-federation "$INVITE" >/dev/null 2>&1 || fc info >/dev/null 2>&1; }
until_ "the client joins the federation" 300 joined
say "founded; seven nodes up, each with its guardian; client joined"
consensus() { for i in 1 2 3 4 5 6 7; do grep -q 'Completed consensus session' $H/node-$i.db.guardian/fedimintd.log 2>/dev/null || return 1; done; }
until_ "every guardian completes a consensus session" 900 consensus
"$NODE" "$HERE/tn4-tools-regtest.mjs" federation >> "$LOG" 2>&1 || die "reading 1 failed (above)"
reading "1 federation: $(grep '"reading":1' "$LOG" | tail -1)"

# ---- 1b. IN THE PAST: THE SEVEN BONDS (the market among their hosted games), THEN THE SERIES AND ITS PUBLICATION ----
MS_ENV="SEAT_PORTS=$NODE_PORTS SEAT_DIR=$H BITCOIN_CLI=$B/bitcoin-cli BITCOIN_CLI_ARGS=-datadir=$BTC_DIR,-rpcwallet=tn4rt CLIENT_DIR=$CLIENT_DIR LOCK_BIN=$LOCK_BIN WALLET=tn4rt"
( cd "$HERE/.." && env $MS_ENV HOME=$FORK_HOME "$NODE" tools/market-series.mjs bonds ) >> "$LOG" 2>&1 || die "the bonds were not posted (above)"
reading "bonds: $(grep '"step":"bonds"' "$LOG" | tail -1)"
( cd "$HERE/.." && env $MS_ENV OUT=$H/series/series.txt STAKE_MSAT=${STAKE_MSAT:-1000000} HOME=$FORK_HOME "$NODE" tools/market-series.mjs series ) >> "$LOG" 2>&1 \
  || die "the series was not published (above)"
reading "series: $(grep '"step":"series"' "$LOG" | tail -1)"

# ---- 1c. TO THE PRESENT: the mock clock off, blocks at today's time - the beacon of the series is one of these ----
bcn setmocktime 0 >/dev/null
bc generatetoaddress 12 $MINE >/dev/null
say "the chain is at the present: tip $(bcn getblockcount), median $(bcn getblockchaininfo | js 'o=>new Date(o.mediantime*1000).toISOString()')"

# ---- 1d. THE LNDS, THEIR CHANNELS AND THE MINER (on a current tip: an lnd on an old one never says synced) ----
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

# ---- 4. THE SEATS HOLD THE SERIES (as the live seats do: attach units with ARENA_SERIES_FILE), THE PAGE'S PROOF AND LINK ----
stop_nodes
SEAT_ENV="${SERIES_GAME:+$([ "$SERIES_GAME" = updown ] && echo ARENA_REGTEST_DONATION_SET=keys)} ARENA_SERIES_FILE=$H/series/series.txt ARENA_ATTACH_PROOF_DIR=$H/paid/attach-proof ARENA_FUNDED_ROUNDS_FILE=$H/paid/funded-rounds.txt \
  ARENA_BITCOIND_URL=$ARENA_BITCOIND_URL ARENA_BITCOIND_COOKIE=$ARENA_BITCOIND_COOKIE"
touch $H/paid/funded-rounds.txt
start_nodes
WSS=""; for p in ${NODE_PORTS//,/ }; do WSS="$WSS ARENA_WSS_$p=ws://127.0.0.1:$p"; done
( cd "$HERE/.." && env $WSS HOME=$FORK_HOME ARENA_TN4_PORTS=$NODE_PORTS ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_DIR \
  ARENA_FEDERATION_INVITE_FILE=$H/invite-code ARENA_RECIPIENT_PORT=$RECIP ARENA_TN4_DATADIR=$BTC_DIR ARENA_ATTACH=1 PAID_MARKET=1 PAID_RPS=${PAID_RPS:-0} ARENA_PUBLISH_AHEAD=${PAID_RPS:-0} \
  ARENA_PAID_STAKE_MSAT=${STAKE_MSAT:-1000000} setsid "$NODE" tools/run-testnet4-paid.mjs > $H/paid.out 2>&1 < /dev/null & echo "$! node-paid" >> $PIDS )
paidup() { grep -q '"paid":"up"' $H/paid.out; }
until_ "run-testnet4-paid.mjs (attach) writes the proof and the link" 1500 paidup
say "attach runner up: $(grep '"paid":"up"' $H/paid.out | tail -1 | cut -c1-300)"
seriesheld() { curl -s http://127.0.0.1:${NODE_PORTS%%,*}/series | grep -q '"series"'; }
until_ "the first seat answers /series" 60 seriesheld
reading "series held: $(curl -s http://127.0.0.1:${NODE_PORTS%%,*}/series | cut -c1-400)"

# ---- 5. HELD UP FOR THE BROWSER: the lobby link in $H/ready; touch $H/release to end ----
{ echo "LOBBY $(cat $H/paid/lobby-url.txt 2>/dev/null)"; echo "INVITE $(cat $H/invite-code)"; echo "DIR $H"; } > $H/ready
say "HOLD: up for the browser; $H/ready names the lobby; touch $H/release to end"
for i in $(seq 1 $(( ${HOLD_MIN:-180} * 6 ))); do [ -e $H/release ] && break; sleep 10; done
say "HOLD released"
