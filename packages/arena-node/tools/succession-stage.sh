# ---- 8. SUCCESSION (kanban #325, §23A.6): sourced by tn4-tools-regtest.sh when SUCCESSION=1, after its readings ----
# Federation B is founded on seven MORE nodes (one node is one guardian; the old federation's guardians keep serving its
# drain), both gateways join B and peg into it, A's seats are told the successor (ARENA_DRAINING) and sign A's record
# DRAINING with successor_id B, and a player's notes in A move to B by the page's own migratePlayerWallet.
HB=$H/b; mkdir -p $HB
B_PORTS=${B_PORTS:-20221,20231,20241,20251,20261,20271,20281}
FOUND_B=""; i=0; for p in ${B_PORTS//,/ }; do i=$((i+1)); FOUND_B="$FOUND_B $p:$HB/node-$i.db"; done
( cd "$HERE/.." && HOME=$FORK_HOME timeout 900 "$NODE" tools/testnet4-found.mjs $FOUND_B ) >> "$LOG" 2>&1 || die "founding B failed"
INVITE_B=$(grep -o '"invite":"[^"]*"' "$LOG" | tail -1 | cut -d'"' -f4)
[ -n "$INVITE_B" ] && [ "$INVITE_B" != "$INVITE" ] || die "founding B wrote no new invite"
echo "$INVITE_B" > $HB/invite-code
CLIENT_B=$HB/client; mkdir -p $CLIENT_B
fcb() { HOME=$FORK_HOME timeout 120 $FORK_BIN/fedimint-cli --data-dir $CLIENT_B "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; }
i=0; for p in ${B_PORTS//,/ }; do i=$((i+1))
  ( cd "$HERE/.." && HOME=$FORK_HOME ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_B ARENA_CLOSE_AT_END=1 \
    ARENA_DONATION_NETWORK=regtest setsid "$NODE" src/main.js $p $HB/node-$i.db > $HB/node-$i.log 2>&1 < /dev/null & echo "$! b-node-$i" >> $PIDS )
done
for p in ${B_PORTS//,/ }; do until_ "B node $p" 120 curl -s -o /dev/null --max-time 3 http://127.0.0.1:$p/identity; done
joinedB() { fcb join-federation "$INVITE_B" >/dev/null 2>&1 || fcb info >/dev/null 2>&1; }
until_ "a client joins B" 300 joinedB
consensusB() { for i in 1 2 3 4 5 6 7; do sed 's/\x1b\[[0-9;]*m//g' $HB/node-$i.db.guardian/fedimintd.log 2>/dev/null | grep -q 'Completed consensus session' || return 1; done; }
until_ "every B guardian completes a consensus session" 900 consensusB
FED_B=$(fcb info | js 'o=>o.federation_id')
reading "S1 successor founded: {\"federationA\":\"$FED\",\"federationB\":\"$FED_B\",\"guardiansB\":7}"
# the two gateways serve B as well: joined, registered at B's seven guardians, pegged in
for g in a b; do port=$([ $g = a ] && echo $GWA || echo $GWB); gc $port $H/gw-$g/password connect-fed "$INVITE_B" >/dev/null || die "gateway $g did not join B"; done
( cd "$HERE/.." && HOME=$FORK_HOME ARENA_TESTNET4_DIR=$HB bash tools/testnet4-gateways.sh $CLIENT_B http://localhost:$GWA http://localhost:$GWB ) >> "$LOG" 2>&1 || die "registering the gateways at B failed"
ecashB() { gc $1 $2 get-balances | js "o=>((o.ecash_balances||[]).find(b=>b.federation_id==='$FED_B')||{}).ecash_balance_msats||0"; }
for g in a b; do port=$([ $g = a ] && echo $GWA || echo $GWB)
  ( cd "$HERE/.." && FEE_RATE=2 HOME=$FORK_HOME bash tools/testnet4-gateway-pegin.sh http://127.0.0.1:$port $H/gw-$g/password $FED_B 500000 ) >> "$LOG" 2>&1 || die "peg-in of gateway $g into B failed"
done
bc generatetoaddress 30 $MINE >/dev/null
creditedB() { [ "$(ecashB $GWA $H/gw-a/password)" -gt 0 ] && [ "$(ecashB $GWB $H/gw-b/password)" -gt 0 ]; }
until_ "both gateways hold e-cash in B" 600 creditedB
reading "S2 gateways serve both: {\"gatewayA_B_msat\":$(ecashB $GWA $H/gw-a/password),\"gatewayB_B_msat\":$(ecashB $GWB $H/gw-b/password)}"
# A's seats told the successor: the paid runner restarted with ARENA_DRAINING (its seven seats are in its process)
# by its command line: on a macOS `setsid` is a shim, and the pid the harness kept is the shim's (measured 19:23Z: the old runner
# kept port 12221 and the new one died on EADDRINUSE)
for p in $(pgrep -f "tools/run-testnet4-paid.mjs"); do ps -E -ww -o command= -p $p 2>/dev/null | grep -q "$H" && kill -TERM $p; done
# every seat port closed - the runner closes its seats one after another (measured 20:00Z: 12221 closed, 12251 still held);
# after 60 s it is killed
portsHeld() { for p in ${NODE_PORTS//,/ }; do curl -s -o /dev/null --max-time 2 http://127.0.0.1:$p/identity && return 0; done; return 1; }
for i in $(seq 1 30); do portsHeld || break; sleep 2; done
if portsHeld; then for p in $(pgrep -f "tools/run-testnet4-paid.mjs"); do ps -E -ww -o command= -p $p 2>/dev/null | grep -q "$H" && kill -KILL $p; done; sleep 3; fi
# A TEST OWNER for A's seats (kanban #321): the CRITICAL stage below signs two owner leaves with its secret
OWNER_SECRET=${OWNER_SECRET:-1111111111111111111111111111111111111111111111111111111111111111}
OWNER_PUB=$("$NODE" --input-type=module -e "import { schnorr } from '@noble/curves/secp256k1.js'; console.log(Buffer.from(schnorr.getPublicKey(Buffer.from('$OWNER_SECRET', 'hex'))).toString('hex'))")
( cd "$HERE/.." && env $WSS HOME=$FORK_HOME ARENA_TEST_OWNER_PUBKEY=$OWNER_PUB ARENA_TN4_PORTS=$NODE_PORTS ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_DIR \
  ARENA_FEDERATION_INVITE_FILE=$H/invite-code ARENA_RECIPIENT_PORT=$RECIP ARENA_TN4_DATADIR=$BTC_DIR ARENA_DRAINING=$FED:$FED_B ARENA_FEDERATION_RECORD_MS=15000 PAID_FIRST=0 \
  setsid "$NODE" tools/run-testnet4-paid.mjs > $H/paid2.out 2>&1 < /dev/null & echo "$! node-paid2" >> $PIDS )
paidup2() { grep -q '"paid":"up"' $H/paid2.out; }
until_ "the paid runner stands up again" 1500 paidup2
# NO NEW ROUND NAMES A DRAINING FEDERATION (its seats refuse one - measured 19:35Z): the runner opens none (PAID_FIRST=0), and the
# move reads the round the A seats hold from reading 4
ROUND2=$ROUND
drained() { curl -s --max-time 10 http://127.0.0.1:${NODE_PORTS%%,*}/federations | grep -q '"status":"DRAINING"'; }
until_ "A's record DRAINING" 600 drained
reading "S3 A draining: $(curl -s --max-time 10 http://127.0.0.1:${NODE_PORTS%%,*}/federations | cut -c1-400)"
# A ROUTE BETWEEN THE TWO GATEWAYS (§23A.6 step 3: "a gateway that serves only one routes over Lightning to one that serves the
# other"): the lock client never pays through the gateway on the invoice's own node, so a move from A pays B's invoice
# through the other gateway - and this stack's only channels were alice->bob and alice->carol (run 5: every send Refunded)
# (the pair in named variables: under set -u a function's $1 is its own, empty, argument list - run 6 stopped there)
for pair in "bob carol" "carol bob"; do FROM=${pair% *} TO=${pair#* }
  KEY2=$(ln_ $TO getinfo | js 'o=>o.identity_pubkey')
  # (the second pair is already peers through the first's channel: lncli then says "already connected" - run 7 stopped there)
  peered() { local out; out=$(ln_ $FROM connect "$KEY2@127.0.0.1:${LLIS[$TO]}" 2>&1) || echo "$out" | grep -q 'already connected'; }
  until_ "$FROM connects $TO" 60 peered
  openx() { ln_ $FROM openchannel --node_key=$KEY2 --local_amt=4000000 --push_amt=2000000 > $H/open-$FROM-$TO.out 2>&1; }
  until_ "$FROM opens a channel to $TO" 120 openx
  bc generatetoaddress 1 $MINE >/dev/null
done
bc generatetoaddress 6 $MINE >/dev/null
activeBC() { [ "$(ln_ bob listchannels | grep -c '"active": *true')" -ge 2 ] && [ "$(ln_ carol listchannels | grep -c '"active": *true')" -ge 2 ]; }
until_ "the bob-carol channels are active" 300 activeBC
say "channels bob<->carol open and active"
# the player's notes move: a deposit into A, then the page's migratePlayerWallet into B
( cd "$HERE/.." && ROUND=$ROUND2 NODES=$NODE_PORTS INVITE_A=$H/invite-code INVITE_B=$HB/invite-code WASM_PKG=$WASM LNCLI=$LNCLI \
  PAYER_DIR=$H/alice PAYER_RPC=127.0.0.1:${LRPC[alice]} NETWORK=regtest SEAT_RECORD=1 HOME=$FORK_HOME timeout 900 "$NODE" tools/succession-move.mjs ) > $H/move.out 2>&1; MOVE_RC=$?
cat $H/move.out >> "$LOG"
reading "S4 notes moved: {\"exit\":$MOVE_RC,\"record\":$(grep '"step":"A record"' $H/move.out | tail -1 || echo null),\"moved\":$(grep '"step":"moved"' $H/move.out | tail -1 || echo null)}"
# ---- 9. CRITICAL (kanban #321, §23A.1 / 23A.4): two of A's seven seats leave by their owner's signed leave; A's record then
# says CRITICAL (reserve 0 - a worse band than DRAINING, which it keeps), and the client offers only Withdraw and Move
( cd "$HERE/.." && NODES=$NODE_PORTS LEAVE=6,7 OWNER_SECRET=$OWNER_SECRET WAIT_S=600 timeout 700 "$NODE" tools/critical-leave.mjs ) > $H/critical.out 2>&1; CRIT_RC=$?
cat $H/critical.out >> "$LOG"
reading "C1 two leave, A critical: {\"exit\":$CRIT_RC,\"leaves\":[$(grep '"step":"leave"' $H/critical.out | paste -sd, -)],\"record\":$(grep '"step":"record"' $H/critical.out | tail -1 || echo null)}"
# the stack held for a look (the page's CRITICAL view): HOLD_S seconds before the stop
[ -n "${HOLD_S:-}" ] && { say "holding the stack $HOLD_S s"; sleep "$HOLD_S"; }
