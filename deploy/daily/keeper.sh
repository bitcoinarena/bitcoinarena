#!/usr/bin/env bash
# THE DAILY'S KEEPER (the owner 2026-09-15, 12:54: always one free round and one paying 2-of-2 open).
#
# The seats are reached through two Cloudflare quick tunnels, and a quick tunnel gets a new public
# name every time it restarts; the seats bond under those names, and daily.json - deployed beside
# the page - names them. So a tunnel restart, a reboot or a launcher restart leaves the deployed
# lobby pointing at silence until the launcher runs under the new names and the page is deployed
# again. This does that, every 30 s:
#   1. read each tunnel's current name from its own unit's journal (this invocation only);
#   2. if they differ from what the seats run under, write them to seats.env and restart the seats;
#   3. once daily.json names exactly those two and both answer /rounds through them, deploy the kept
#      page with it through deploy-core.sh - which checks every seat again and refuses silence -
#      when daily.json differs from the one last deployed from here.
# Durable public names (an account tunnel) stay parked; this covers the gap.
#
# ITS DEPLOYS NEED CLOUDFLARE AUTH THAT NEEDS NO BROWSER (the owner 2026-09-15: a Pages-only API token,
# for the keeper alone). Measured before: wrangler's OAuth login lapsed - "Not logged in ... the
# environment is non-interactive" - and a tunnel restart then left the Daily naming dead seats with
# nothing able to deploy. The unit reads $BLWP_2OF2_DIR/cloudflare.env, owned by this user, mode 600:
#   CLOUDFLARE_API_TOKEN=<token>
#   CLOUDFLARE_ACCOUNT_ID=<the account that owns the btc-logistics-core Pages project>
# The token, created at dash.cloudflare.com -> My Profile -> API Tokens -> Create Custom Token:
#   Permissions:        Account | Cloudflare Pages | Edit          (nothing else)
#   Account Resources:  Include | <that one account>
#   Client IP filter / TTL: optional
# With CLOUDFLARE_ACCOUNT_ID set, wrangler pages deploy needs no user or membership scope. Without
# the file, wrangler falls back to its OAuth login. Nothing here prints the token.
set -uo pipefail
D="${BLWP_2OF2_DIR:-/mnt/bitcoin/blwp-2of2}"
CODE="${BLWP_DAILY_CODE:-$D/code}"
ENVF="$D/seats.env"
LAST="$D/keeper.deployed.json"
say() { echo "{\"at\":\"$(date -u +%FT%TZ)\",$1}"; }

tunnel() {
  local id; id=$(systemctl --user show "blwp-daily-tunnel-$1" -p InvocationID --value 2>/dev/null)
  [ -n "$id" ] || return 0
  journalctl --user "_SYSTEMD_INVOCATION_ID=$id" -o cat --no-pager 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
}
answers() { curl -s -m 15 -o /dev/null -w '%{http_code}' "$1/rounds" | grep -q '^200$'; }

while true; do
  A=$(tunnel a); B=$(tunnel b)
  if [ -n "$A" ] && [ -n "$B" ]; then
    WANT="BLWP_WSS_18080=wss://${A#https://}
BLWP_WSS_18081=wss://${B#https://}"
    if [ "$(cat "$ENVF" 2>/dev/null)" != "$WANT" ]; then
      printf '%s\n' "$WANT" > "$ENVF"
      say "\"tunnels\":[\"$A\",\"$B\"],\"seats\":\"restarting under the new names\""
      systemctl --user restart blwp-daily-seats
      sleep 20
    fi
    if python3 - "$D/daily.json" "$A" "$B" <<'PY' && answers "$A" && answers "$B"; then
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if d.get('node') == [sys.argv[2], sys.argv[3]] else 1)
PY
      if ! cmp -s "$D/daily.json" "$LAST"; then
        AUTH=$([ -n "${CLOUDFLARE_API_TOKEN:-}" ] && echo "api token (Pages edit)" || echo "wrangler login")
        say "\"daily.json\":\"changed since the last deploy\",\"deploying\":\"$D/page\",\"auth\":\"$AUTH\""
        if BLWP_2OF2_DIR="$D" BLWP_BUILD_DIR="$D/page" "$CODE/deploy-core.sh" > "$D/keeper-deploy.log" 2>&1; then
          cp "$D/daily.json" "$LAST"
          say "\"deployed\":\"$(grep -oE 'https://[0-9a-f]{8}\.btc-logistics-core\.pages\.dev' "$D/keeper-deploy.log" | tail -1)\""
        else
          say "\"deployFailed\":\"$(tail -1 "$D/keeper-deploy.log" | tr -d '"\\' | cut -c1-200)\""
        fi
      fi
    fi
  fi
  sleep 30
done
