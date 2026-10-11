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
kill -TERM $(awk '/node-paid/{print $1}' $PIDS) 2>/dev/null; sleep 10
( cd "$HERE/.." && env $WSS HOME=$FORK_HOME ARENA_TN4_PORTS=$NODE_PORTS ARENA_STAKE_LOCK_BIN=$LOCK_BIN ARENA_FEDERATION_CLIENT_DIR=$CLIENT_DIR \
  ARENA_FEDERATION_INVITE_FILE=$H/invite-code ARENA_RECIPIENT_PORT=$RECIP ARENA_TN4_DATADIR=$BTC_DIR ARENA_DRAINING=$FED:$FED_B ARENA_FEDERATION_RECORD_MS=15000 \
  setsid "$NODE" tools/run-testnet4-paid.mjs > $H/paid2.out 2>&1 < /dev/null & echo "$! node-paid2" >> $PIDS )
paidup2() { grep -q '"paid":"up"' $H/paid2.out; }
until_ "the paid runner stands up again" 1500 paidup2
ROUND2=$(grep -o '"firstRound":"[0-9a-f]*"' $H/paid2.out | tail -1 | cut -d'"' -f4)
drained() { curl -s --max-time 10 http://127.0.0.1:${NODE_PORTS%%,*}/federations | grep -q '"status":"DRAINING"'; }
until_ "A's record DRAINING" 600 drained
reading "S3 A draining: $(curl -s --max-time 10 http://127.0.0.1:${NODE_PORTS%%,*}/federations | cut -c1-400)"
# the player's notes move: a deposit into A, then the page's migratePlayerWallet into B
( cd "$HERE/.." && ROUND=$ROUND2 NODES=$NODE_PORTS INVITE_A=$H/invite-code INVITE_B=$HB/invite-code WASM_PKG=$WASM LNCLI=$LNCLI \
  PAYER_DIR=$H/alice PAYER_RPC=127.0.0.1:${LRPC[alice]} NETWORK=regtest HOME=$FORK_HOME timeout 900 "$NODE" tools/succession-move.mjs ) > $H/move.out 2>&1; MOVE_RC=$?
cat $H/move.out >> "$LOG"
reading "S4 notes moved: {\"exit\":$MOVE_RC,\"record\":$(grep '"step":"A record"' $H/move.out | tail -1 || echo null),\"moved\":$(grep '"step":"moved"' $H/move.out | tail -1 || echo null)}"
