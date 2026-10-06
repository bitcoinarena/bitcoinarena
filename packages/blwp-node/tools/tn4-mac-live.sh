#!/opt/homebrew/bin/bash
# A LIVE TESTNET4 FEDERATION ON THE MACBOOK, FOR THE STAKE LOCK'S ACCEPTANCE TIME (kanban #192, the owner 2026-10-06 10:13):
# seven guardians (each its seat's), founded on testnet4 against the test host's own testnet4 bitcoind (synced from public
# peers, 127.0.0.1:48342), every port on 127.0.0.1 - the measured path (the lock client to the guardians, the guardians to
# each other) never leaves the test host, no Tailscale in it. No gateway, no LND: the client is funded by an on-chain peg-in.
# The peg-in finality of THIS federation is named at its founding (FM_BLWP_FINALITY_DELAY, default 1; the fork's testnet4
# default 100 is untouched otherwise) - it governs peg-ins only, never a lock. No bond is posted. No mainnet.
#   tn4-mac-live.sh up <dir>      found, start the seven seats with their guardians, join a fedimint-cli client; left running
#   tn4-mac-live.sh address <dir> a peg-in address of the client
#   tn4-mac-live.sh notes <dir> <msat>   e-cash notes of the client for one run (file <dir>/notes-<time>)
#   tn4-mac-live.sh delay <dir> <ms>     each guardian's AlephBFT round delay (local.json), then a restart of the seats
#   tn4-mac-live.sh down <dir>
set -uo pipefail
CMD=${1:?up|address|notes|delay|down}; H=${2:?the run dir}
HERE=$(cd "$(dirname "$0")" && pwd)
O=$HOME/blwp-offload
NODE=${NODE_BIN:-$HOME/.nvm/versions/node/v24.15.0/bin/node}
export FORK_BIN=${FORK_BIN:-$O/fork-192/target/release} FORK_HOME=${FORK_HOME:-$O/fork-home}
export PATH=$FORK_BIN:$(dirname "$NODE"):$O/macshim:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export BLWP_TN4_NETWORK=testnet4 BLWP_TESTNET4_DIR=$H BLWP_DONATION_NETWORK=testnet4
# THE CHAIN READS (block count, fees, peg-ins; never a lock): the test host's own node, or BLWP_BITCOIND_URL/COOKIE named
export BLWP_BITCOIND_URL=${BLWP_BITCOIND_URL:-http://127.0.0.1:48342} BLWP_BITCOIND_COOKIE=${BLWP_BITCOIND_COOKIE:-$O/tn4-mac/testnet4/.cookie}
export CLIENT_DIR=$H/client NODE_PORTS=${NODE_PORTS:-24221,24231,24241,24251,24261,24271,24281}
LOG=$H/run.log
say() { echo "$(date -u +%T) $*" | tee -a "$LOG"; }
die() { say "STOPPED: $*"; exit 1; }
fc() { HOME=$FORK_HOME $FORK_BIN/fedimint-cli --data-dir $CLIENT_DIR "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; }
until_() { local what=$1 secs=$2; shift 2; local t=$(date +%s); until "$@"; do [ $(( $(date +%s) - t )) -gt $secs ] && die "$what: not within $secs s"; sleep 2; done; }
start_nodes() {
  i=0; for p in ${NODE_PORTS//,/ }; do i=$((i+1))
    ( cd "$HERE/.." && HOME=$FORK_HOME BLWP_STAKE_LOCK_BIN=$FORK_BIN/blwp-stake-lock BLWP_FEDERATION_CLIENT_DIR=$H/seat-client \
      nohup "$NODE" src/main.js $p $H/node-$i.db > $H/node-$i.log 2>&1 < /dev/null & )
  done
  for p in ${NODE_PORTS//,/ }; do until_ "node $p" 180 curl -s -o /dev/null --max-time 3 http://127.0.0.1:$p/identity; done
}
stop_nodes() { pkill -TERM -f "src/main.js [0-9]+ $H/node-" 2>/dev/null; sleep 6; pkill -KILL -f "src/main.js [0-9]+ $H/node-" 2>/dev/null
  for pid in $(pgrep -x fedimintd); do lsof -p $pid -Fn 2>/dev/null | grep -qE "^n(/private)?$H/" && kill -KILL $pid; done; sleep 2; }
consensus() { for i in 1 2 3 4 5 6 7; do grep -q 'Completed consensus session' $H/node-$i.db.guardian/fedimintd.log 2>/dev/null || return 1; done; }
case $CMD in
  up)
    mkdir -p $H; : > "$LOG"
    [ "$(curl -s --user "$(cat $BLWP_BITCOIND_COOKIE)" -d '{"method":"getblockchaininfo"}' $BLWP_BITCOIND_URL | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;console.log(r.chain+":"+(r.blocks===r.headers&&!r.initialblockdownload))})')" = "testnet4:true" ] \
      || die "the test host's testnet4 bitcoind is not synced"
    FOUND_ARGS=""; i=0; for p in ${NODE_PORTS//,/ }; do i=$((i+1)); FOUND_ARGS="$FOUND_ARGS $p:$H/node-$i.db"; done
    ( cd "$HERE/.." && HOME=$FORK_HOME FM_BLWP_FINALITY_DELAY=${FINALITY:-1} "$NODE" tools/testnet4-found.mjs $FOUND_ARGS ) >> "$LOG" 2>&1 || die "testnet4-found.mjs failed"
    INVITE=$(grep -o '"invite":"[^"]*"' "$LOG" | tail -1 | cut -d'"' -f4)
    [ -n "$INVITE" ] && [ "$INVITE" != "(none written)" ] || die "the founding wrote no invite"
    echo "$INVITE" > $H/invite-code
    for i in 1 2 3 4 5 6 7; do "$NODE" -e 'const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,"utf8"));c.broadcast_round_delay_ms=Number(process.argv[2]);fs.writeFileSync(f,JSON.stringify(c,null,2))' \
      $H/node-$i.db.guardian/local.json "${ROUND_DELAY_MS:-5}" || die "round delay on node-$i"; done
    FM_BLWP_FINALITY_DELAY=${FINALITY:-1} start_nodes
    until_ "every guardian completes a consensus session" 900 consensus
    joined() { fc join "$INVITE" >/dev/null 2>&1 || fc info >/dev/null 2>&1; }
    until_ "the client joins" 300 joined
    say "up: testnet4 federation $(fc info | grep -o '"federation_id": *"[0-9a-f]*"' | head -1), seven seats with their guardians, round delay ${ROUND_DELAY_MS:-5} ms, finality ${FINALITY:-1}; dir $H" ;;
  address) fc deposit-address ;;
  notes) fc module mintv2 send "${3:?msat}" > $H/notes.json; F=$H/notes-$(date +%s); grep -oE 'fedimint[0-9a-z]{20,}' $H/notes.json | head -1 > $F; echo $F ;;
  attempt)
    # ONE ATTEMPT: fresh notes for a fresh lock client (WASM dir $4), COUNT locks, the log $H/attempt-<label>.log
    LABEL=${3:?label}; WASM=${4:?wasm dir}
    # NOTES_FILE: notes already sent (a run cut short); else fresh notes from the client
    if [ -n "${NOTES_FILE:-}" ]; then N=$NOTES_FILE; else N=$("$0" notes "$H" "${NOTES_MSAT:-600000}") || die "no notes"; fi
    [ -s "$N" ] || die "the notes file is empty: $(head -c 300 $H/notes.json)"
    ( cd "$HERE/.." && INVITE_FILE=$H/invite-code WASM_PKG=$WASM ECASH_FILE=$N BLWP_TN4_NETWORK=testnet4 COUNT=${COUNT:-20} \
      "$NODE" ${LAT_NODE_FLAGS:-} tools/lock-latency-regtest.mjs ) > $H/attempt-$LABEL.log 2>&1; RC=$?
    # the leftover notes back into the federation's own client
    [ -s "$N.back" ] && fc module mintv2 receive "$(cat $N.back)" > $H/back-$LABEL.json 2>&1 && mv "$N.back" "$N.back.received"
    say "attempt $LABEL (wasm $WASM, rc $RC): $(grep '"step":"summary"' $H/attempt-$LABEL.log | tail -1)" ;;
  delay)
    stop_nodes
    for i in 1 2 3 4 5 6 7; do "$NODE" -e 'const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,"utf8"));c.broadcast_round_delay_ms=Number(process.argv[2]);fs.writeFileSync(f,JSON.stringify(c,null,2))' \
      $H/node-$i.db.guardian/local.json "${3:?ms}"; done
    start_nodes; until_ "consensus after restart" 600 consensus; say "round delay $3 ms on all seven; restarted" ;;
  down) stop_nodes; say "down" ;;
esac
