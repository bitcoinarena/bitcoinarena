#!/usr/bin/env bash
# LIVE CHROME PLAYTESTS RUN ON THE OWNER'S MACBOOK, NOT ON THIS BOX (the owner 2026-09-18 19:05, HARD).
#
# test host carries bitcoind, the signer daemons and every build; two headless WebGL players on top of that drew under
# one frame a second, and measurements taken there kept catching the starved tab rather than the game - a chain read
# that answers in 0.52 s to curl took 8.7 s inside such a tab, past the client's ten second budget. the test host has a
# Metal GPU and no SwiftShader, so a page there runs at a player's speed.
#
# RETIRED BY RULING (the owner 2026-09-20 15:12): "Live Chrome playtests run on the test host only. Do not use
# the test host." This script IS the test host path, so its 9341/9342 are left alone - they are what it talks
# to - but nothing should be driven through it any more. The the test host's two playtest Chromes are 9351 and
# 9352, and every probe and suite defaults to those now.
#
#   start    the two headless-shell browsers on the test host (CDP 9341 and 9342), through its own launcher
#   stop     both of them
#   status   what the test host says it is running
#   tunnel   forward 9341/9342 from the test host to this box, so a probe here drives the browsers there
set -euo pipefail

MAC="${BLWP_MAC:-arena@192.0.2.226}"
LAUNCH="/Users/arena/.blwp-playtest/start.sh"
PORT_A="${PORT_A:-9341}"
PORT_B="${PORT_B:-9342}"
PAGE="${PAGE:-https://btc-logistics-core.pages.dev/}"
SSH=(ssh -o ConnectTimeout=10 -o BatchMode=yes "$MAC")

case "${1:-status}" in
  start)   "${SSH[@]}" "PAGE='$PAGE' PORT_A=$PORT_A PORT_B=$PORT_B $LAUNCH" ;;
  stop)    "${SSH[@]}" "$LAUNCH stop" ;;
  status)  "${SSH[@]}" "$LAUNCH status" ;;
  tunnel)
    # The forward runs until it is killed; a probe on this box then talks to 127.0.0.1:9341 and :9342.
    pkill -f "ssh -N -L $PORT_A:127.0.0.1:$PORT_A" 2>/dev/null || true
    ssh -o ConnectTimeout=10 -o BatchMode=yes -N \
      -L "$PORT_A:127.0.0.1:$PORT_A" -L "$PORT_B:127.0.0.1:$PORT_B" "$MAC" &
    echo "$!" > /tmp/blwp-mac-tunnel.pid
    sleep 2
    curl -fsS "http://127.0.0.1:$PORT_A/json/version" >/dev/null && echo "tunnel up on $PORT_A" || echo "tunnel: $PORT_A does not answer"
    curl -fsS "http://127.0.0.1:$PORT_B/json/version" >/dev/null && echo "tunnel up on $PORT_B" || echo "tunnel: $PORT_B does not answer"
    ;;
  *) echo "usage: $0 start|stop|status|tunnel" >&2; exit 2 ;;
esac
