#!/bin/bash
# kanban #2905: one canary pass on the MacBook (launchd io.bitcoinarena.canary2905, every 30 min): skip quietly while a seat roll runs on the
# Beelink, else one paid RPS round (canary-rps.mjs), then the alert check (canary-alert.mjs). One pass at a time (lock file); the round runs
# in its own process group and is killed whole after 8 min. Log: $CANARY_DIR/canary.jsonl, $CANARY_DIR/run.log. Nothing is deleted.
# Install: MacBook - this directory's files to ~/arena-canary, ln -s <a playwright-core node_modules> ~/arena-canary/node_modules, the plist to
# ~/Library/LaunchAgents + launchctl bootstrap gui/$(id -u) <plist>; Beelink - canary-beelink.py to ~/arena-canary (ssh from the MacBook, LAN).
DIR=${CANARY_DIR:-$HOME/arena-canary}; export CANARY_DIR=$DIR
export PATH=$HOME/.nvm/versions/node/v24.22.3/bin:/usr/bin:/bin:/usr/sbin:/sbin
BEE=${CANARY_BEELINK:-user@192.168.1.65}; export CANARY_BEELINK=$BEE
cd "$DIR" || exit 2
exec >> "$DIR/run.log" 2>&1
now() { date -u +%FT%TZ; }
q=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$BEE" python3 arena-canary/canary-beelink.py quiet 2>/dev/null)
if echo "$q" | grep -q '"quiet": true'; then
  echo "{\"at\":\"$(now)\",\"kind\":\"rps\",\"skip\":\"roll\",\"ok\":false,\"fail\":[],\"why\":$(echo "$q" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["why"]))')}" >> "$DIR/canary.jsonl"
  echo "#2905 $(now) skip: seat roll ($q)"; exit 0
fi
[ -z "$q" ] && echo "#2905 $(now) roll check unreachable - playing anyway"
echo "#2905 $(now) round"
perl "$DIR/canary-timeout.pl" 480 "$DIR/canary.lock" caffeinate -i node "$DIR/canary-rps.mjs" ${CANARY_URL:-}; rc=$?
echo "#2905 $(now) round exit $rc"
node "$DIR/canary-alert.mjs"
