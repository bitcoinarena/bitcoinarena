# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE ARENA SIDE OF THE SEVEN-SEAT REHEARSAL: SOURCED by phase0's tn4-tools-regtest.sh after its six
# readings (AFTER=<this file>), so it has that run's $H, $B, $NODE, $NODE_PORTS, $CLIENT_DIR, $LOCK_BIN, $BTC_DIR,
# $FORK_HOME, $ROUND, $PIDS and its say / reading / die / until_ / bc / bcn. The BLWP world is up: seven phase0 seats with
# their guardians (run-testnet4-paid.mjs), their BLWP bonds, a BLWP paid round $ROUND with a stake locked (testnet4-lock.mjs).
#
#   1. the bonds carried (rehearse209b.mjs carry): re-affirmed and updated by the Arena tree; each Arena seat's store made
#   2. an Arena series (market-series.mjs series, nextblock's, 4 days on) published below its beacon, its census the
#      re-affirmed bonds
#   3. seven Arena seats BESIDE the phase0 seats: their own ports and stores, the same node keys, no guardian of their own,
#      the one federation client directory - holding the Arena series
#   4. both read side by side (rehearse209b.mjs read), then the BLWP round read until its settlement is in at a phase0 seat
#      (its /api/round-result), the Arena seats up throughout
# ARENA_NODE names the Arena tree's packages/arena-node. Nothing here is testnet4.
ARENA_PORTS=${ARENA_PORTS:-24221,24231,24241,24251,24261,24271,24281}
A_ENV="BITCOIN_CLI=$B/bitcoin-cli BITCOIN_CLI_ARGS=-datadir=$BTC_DIR,-rpcwallet=tn4rt WALLET=tn4rt SEAT_DIR=$H ARENA_DIR=$H/arena"
rm -f $H/miner-pause
FROM=$(( $(bcn getblockcount) - 250 )); [ $FROM -lt 0 ] && FROM=0

# ---- A1. THE BONDS CARRIED ----
( cd "$ARENA_NODE" && env $A_ENV HOME=$FORK_HOME "$NODE" tools/rehearse209b.mjs carry ) >> "$LOG" 2>&1 || die "A1: the bonds were not carried (above)"
reading "A1 carry: $(grep '"step":"carry"' "$LOG" | tail -1)"
bc generatetoaddress 2 $(bc getnewaddress) >/dev/null

# ---- A2. THE ARENA SERIES ----
( cd "$ARENA_NODE" && env $A_ENV SEAT_PORTS=$ARENA_PORTS SEAT_DIR=$H/arena GUARDIAN_BASE=$H CLIENT_DIR=$CLIENT_DIR LOCK_BIN=$LOCK_BIN \
  OUT=$H/arena/series.txt SERIES_GAME=nextblock SERIES_K_AHEAD=4 STAKE_MSAT=1000000 HOME=$FORK_HOME "$NODE" tools/market-series.mjs series ) >> "$LOG" 2>&1 \
  || die "A2: the Arena series was not published (above)"
reading "A2 series: $(grep '"step":"series"' "$LOG" | tail -1)"
bc generatetoaddress 2 $(bc getnewaddress) >/dev/null

# ---- A3. SEVEN ARENA SEATS BESIDE THE PHASE0 SEATS ----
GAMES_A="$(cd "$ARENA_NODE/.." && pwd)/nextblock/plugin/nextblock.js,$ARENA_NODE/test/plugins/market/game.js"
i=0; for p in ${ARENA_PORTS//,/ }; do i=$((i+1))
  ( cd "$ARENA_NODE" && HOME=$FORK_HOME ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_DIR ARENA_CLOSE_AT_END=1 \
    ARENA_DONATION_NETWORK=regtest ARENA_GAMES=$GAMES_A ARENA_SERIES_FILE=$H/arena/series.txt \
    ARENA_BITCOIND_URL=${ARENA_BITCOIND_URL:-$BLWP_BITCOIND_URL} ARENA_BITCOIND_COOKIE=${ARENA_BITCOIND_COOKIE:-$BLWP_BITCOIND_COOKIE} \
    setsid "$NODE" src/main.js $p $H/arena/node-$i.db > $H/arena/node-$i.log 2>&1 < /dev/null & echo "$! arena-node-$i" >> $PIDS )
done
for p in ${ARENA_PORTS//,/ }; do until_ "Arena seat $p" 180 curl -s -o /dev/null --max-time 3 http://127.0.0.1:$p/identity; done
aseries() { curl -s --max-time 10 http://127.0.0.1:${ARENA_PORTS%%,*}/series | grep -q '"series"'; }
until_ "the first Arena seat holds the series" 300 aseries
say "seven Arena seats up beside the seven phase0 seats"
for i in 1 2 3 4 5 6 7; do grep -h "guardian\]" $H/arena/node-$i.log | head -1 | sed "s/^/arena seat $i: /" >> "$LOG"; done
reading "A3 guardians at the Arena seats: $(grep -c 'not a guardian\|holds no guardian' $H/arena/node-*.log | tr '\n' ' ') started: $(grep -l 'fedimintd started\|fedimintd [0-9]' $H/arena/node-*.log 2>/dev/null | wc -l)"

# ---- A4. SIDE BY SIDE, THEN THE BLWP ROUND TO ITS SETTLEMENT ----
( cd "$ARENA_NODE" && env $A_ENV PHASE0_PORTS=$NODE_PORTS ARENA_PORTS=$ARENA_PORTS FROM=$FROM HOME=$FORK_HOME "$NODE" tools/rehearse209b.mjs read ) >> "$LOG" 2>&1 \
  || die "A4: the side-by-side reading failed (above)"
reading "A4 side by side: $(grep '"step":"side by side"' "$LOG" | tail -1)"
P1=${NODE_PORTS%%,*}
settled() { curl -s --max-time 20 "http://127.0.0.1:$P1/api/round-result?round=$ROUND" > $H/round-result.json; grep -q '"result":"\(won\|lost\|stake back\)"' $H/round-result.json; }
until_ "the BLWP round $ROUND settles at a phase0 seat" ${SETTLE_WAIT_S:-2400} settled
reading "A5 BLWP round settled under phase0: $(cut -c1-900 $H/round-result.json)"
arenaup=0; for p in ${ARENA_PORTS//,/ }; do curl -s -o /dev/null --max-time 5 http://127.0.0.1:$p/identity && arenaup=$((arenaup+1)); done
reading "A6 Arena seats still up after the BLWP settlement: $arenaup of 7; their series: $(curl -s --max-time 10 http://127.0.0.1:${ARENA_PORTS%%,*}/series | cut -c1-300)"
( cd "$ARENA_NODE" && env $A_ENV PHASE0_PORTS=$NODE_PORTS ARENA_PORTS=$ARENA_PORTS FROM=$FROM HOME=$FORK_HOME "$NODE" tools/rehearse209b.mjs read ) >> "$LOG" 2>&1
reading "A7 side by side at the end: $(grep '"step":"side by side"' "$LOG" | tail -1)"
say "REHEARSAL 209b DONE"
