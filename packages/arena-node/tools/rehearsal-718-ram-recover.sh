#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# REHEARSAL OF KANBAN #718: a throwaway devnet federation (7 guardians, 5 of 7, regtest, one machine - federation A's shape) with its
# guardians on a RAM disk of its own, killed with kill -9 in the middle of a session and its RAM wiped (what a reboot does), then started
# again: the session must close and the federation advance. Three phases:
#
#   A  one snapshot set (the new way): kill -9 all 7, RAM wiped, up again.
#      EXPECT in each logs/node-K.log:  [guardian-recover] guardian <id>: consistent - all 7 guardians restored from one snapshot set
#      EXPECT here:                     PASS A: sessions <s0> -> <s1> (s1 >= s0 + 2 on all 7)
#   B  the old staggered snapshots (ARENA_FEDIMINT_RAM_SET=0 - each guardian alone at its own second), then the same kill and wipe, up
#      again with the set back on.
#      EXPECT in the logs:  "repair - all 7 guardians restored from different moments, session N with the same M accepted items" on one
#                           node and "repair" on all 7, ram-snaps/pre-repair-* in each guardian dir; or, if a consensus item landed
#                           between two snapshots, "REFUSED: the accepted items of session N differ (...)" and no guardian started
#      EXPECT here:         PASS B: repaired, sessions <s0> -> <s1>        (or) PASS B: refused as designed: <why>
#   C  a lone guardian: only node 3 killed and its RAM dir wiped, then started again while the other 6 run on.
#      EXPECT in logs/node-3.log:  "lone - 1 of 7 guardians (2) restored here ... each waits until its peers have closed the session"
#                                  then "[guardian] fedimintd ... " only after the federation passed that session
#      EXPECT here:                PASS C: guardian 3 at session <s>, the others at <s'> (|s - s'| <= 1)
#
# RUN (a quiet machine with the regtest stack; nothing live is touched - its own DEVNET_DIR, base port, RAM dir):
#   BITCOIN_BIN=<dir with bitcoind, bitcoin-cli> FEDIMINT_BIN=<dir with fedimintd, fedimint-cli, fedimint-dbtool, blwp-stake-lock> \
#     bash packages/arena-node/tools/rehearsal-718-ram-recover.sh
# fedimint-dbtool: built from the same fork as fedimintd (tools/release/custody-build.sh BINS=fedimint-dbtool, or
#   cargo build --release -p fedimint-dbtool in the fork's tree). Phase B needs it; without it B reports UNCHECKED.
# Takes ~20-40 min. At the end: `node tools/devnet.mjs down` (DEVNET_DIR as below) and rm -rf "$R718_RAM".
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); PKG=$(cd "$HERE/.." && pwd)
export DEVNET_DIR=${DEVNET_DIR:-$PWD/rehearsal-718-data} DEVNET_BASE_PORT=${DEVNET_BASE_PORT:-26000} DEVNET_BLOCK_SECONDS=${DEVNET_BLOCK_SECONDS:-20}
export R718_RAM=${R718_RAM:-/dev/shm/arena-rehearsal-718}
export ARENA_FEDIMINT_RAM=1 ARENA_FEDIMINT_RAM_DIR=$R718_RAM ARENA_FEDIMINT_RECOVER_GATHER_MS=30000 ARENA_FEDIMINT_RECOVER_LONE_MS=900000
export ARENA_FEDIMINT_DBTOOL=${ARENA_FEDIMINT_DBTOOL:-${FEDIMINT_BIN:-}/fedimint-dbtool}
NODES=(); for k in 0 1 2 3 4 5 6; do NODES+=($((DEVNET_BASE_PORT + 100 + 10 * k))); done
say() { echo "$(date -u +%T) $*"; }
up() { (cd "$PKG" && node tools/devnet.mjs up) > "$DEVNET_DIR.up.log" 2>&1; }
# each guardian's session count, over its own API (node port + 1000)
sessions() { (cd "$PKG" && node --input-type=module -e '
  const { wsSessionCount } = await import("./src/halts.js");
  const out = [];
  for (const p of process.argv.slice(1)) out.push(await wsSessionCount(`ws://127.0.0.1:${Number(p) + 1000}`, { overrides: "", timeoutMs: 4000 }).catch(() => -1));
  console.log(out.join(" "));' "$@"); }
min() { tr ' ' '\n' | sort -n | head -1; }
# kill -9 a node's whole process group (the node and its fedimintd) - no clean stop, no last snapshot
kill9() { local k=$1 pg; pg=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pgid)' "$DEVNET_DIR/pids/node-$k.pid" 2>/dev/null) && kill -9 -- "-$pg" 2>/dev/null; }
# wait until every guardian's current snapshot carries the same name (a set), or until n sets of their own when staggered
wait_snaps() {
  local i names
  for i in $(seq 1 30); do
    sleep 10
    names=$(for k in 1 2 3 4 5 6 7; do readlink "$DEVNET_DIR/nodes/node-$k.db.guardian/ram-snaps/current"; done 2>/dev/null | sort -u | wc -l)
    [ "$1" = set ] && [ "$names" = 1 ] && return 0
    [ "$1" = any ] && [ "$i" -ge 9 ] && return 0
  done
  return 1
}
# the moment to kill: a session just started (its count rose since the last look) - so the kill lands inside it
mid_session() { local a b; a=$(sessions "${NODES[0]}"); for i in $(seq 1 120); do sleep 2; b=$(sessions "${NODES[0]}"); [ "$b" != "$a" ] && { sleep 3; return 0; }; done; }
advance() {   # $1 = the floor every guardian must pass by 2 sessions, within 10 min
  local i s; for i in $(seq 1 60); do sleep 10; s=$(sessions "${NODES[@]}"); [ "$(echo "$s" | min)" -ge $(( $1 + 2 )) ] && { echo "$s"; return 0; }; done; echo "$s"; return 1; }

say "devnet up ($DEVNET_DIR, base $DEVNET_BASE_PORT, RAM $R718_RAM)"
up || { say "FAIL: devnet up - see $DEVNET_DIR.up.log"; exit 1; }
say "sessions: $(sessions "${NODES[@]}")"

# ---- A: ONE SNAPSHOT SET ----
wait_snaps set || { say "FAIL A: the 7 guardians never shared one snapshot name"; exit 1; }
mid_session; s0=$(sessions "${NODES[@]}" | min)
say "A: kill -9 all 7 inside session $s0, RAM wiped"
for k in 1 2 3 4 5 6 7; do kill9 $k; done; sleep 2; rm -rf "$R718_RAM"
up || say "(up returned an error - the nodes may still be in recovery; looking at the sessions)"
grep -h "guardian-recover" "$DEVNET_DIR"/logs/node-*.log | tail -8
if s1=$(advance "$s0"); then say "PASS A: sessions $s0 -> $s1"; else say "FAIL A: sessions $s0 -> $s1 (stuck)"; exit 1; fi

# ---- B: STAGGERED SNAPSHOTS (the old way), then the same crash ----
for k in 1 2 3 4 5 6 7; do kill9 $k; done; sleep 2      # (RAM kept: a restart, no recovery)
ARENA_FEDIMINT_RAM_SET=0 up || true
wait_snaps any
mid_session; s0=$(sessions "${NODES[@]}" | min)
say "B: kill -9 all 7 inside session $s0 after staggered snapshots, RAM wiped"
for k in 1 2 3 4 5 6 7; do kill9 $k; done; sleep 2; rm -rf "$R718_RAM"
up || true
grep -h "guardian-recover" "$DEVNET_DIR"/logs/node-*.log | tail -10
if grep -qh "REFUSED: the accepted items" "$DEVNET_DIR"/logs/node-*.log; then say "PASS B: refused as designed: $(grep -h 'REFUSED: the accepted items' "$DEVNET_DIR"/logs/node-*.log | tail -1)"
elif grep -qh "UNCHECKED\|could not be read" "$DEVNET_DIR"/logs/node-*.log; then say "B UNCHECKED: no fedimint-dbtool at $ARENA_FEDIMINT_DBTOOL"
elif s1=$(advance "$s0"); then say "PASS B: $(cat "$DEVNET_DIR"/logs/node-*.log | grep -c ': repair - ') repair lines, sessions $s0 -> $s1"
else say "FAIL B: sessions $s0 -> $s1"; exit 1; fi

# ---- C: A LONE GUARDIAN ----
s0=$(sessions "${NODES[@]}" | min)
mid_session
say "C: kill -9 node 3 only, its RAM dir wiped, the other 6 run on"
kill9 3; sleep 2; rm -rf "$R718_RAM/${NODES[2]}-guardian"
up || true
for i in $(seq 1 90); do sleep 10; grep -q "fedimintd .* on chain" <(tail -n 50 "$DEVNET_DIR/logs/node-3.log") && break; done
grep -h "guardian-recover" "$DEVNET_DIR/logs/node-3.log" | tail -4
sleep 60; s=$(sessions "${NODES[@]}"); say "sessions now: $s"
g3=$(echo "$s" | cut -d' ' -f3); others=$(echo "$s" | tr ' ' '\n' | sed 3d | sort -n | tail -1)
if [ "$g3" -ge 0 ] && [ $(( others - g3 )) -le 1 ] && grep -q "lone" "$DEVNET_DIR/logs/node-3.log"; then say "PASS C: guardian 3 at session $g3, the others at $others"
else say "FAIL C: guardian 3 at $g3, the others at $others"; exit 1; fi
say "done - stop with: (cd $PKG && DEVNET_DIR=$DEVNET_DIR DEVNET_BASE_PORT=$DEVNET_BASE_PORT node tools/devnet.mjs down); rm -rf $R718_RAM"
