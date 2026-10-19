#!/usr/bin/env bash
# THE DAILY'S KEEPER (2026-09-15, 12:54: always one free round and one paying 2-of-2 open).
#
# The signer nodes are reached through two Cloudflare quick tunnels, and a quick tunnel gets a new public
# name every time it restarts; the signer nodes bond under those names, and daily.json - deployed beside
# the page - names them. So a tunnel restart, a reboot or a launcher restart leaves the deployed
# lobby pointing at silence until the launcher runs under the new names and the page is deployed
# again. This does that, every 30 s:
#   1. read each tunnel's current name from its own unit's journal (this invocation only);
#   2. if they differ from what the signer nodes run under, write them to signer-nodes.env and restart the signer nodes;
#   3. once daily.json names exactly those two and both answer /rounds through them, deploy the kept
#      page with it through deploy-core.sh - which checks every signer node again and refuses silence -
#      when daily.json differs from the one last deployed from here.
# Durable public names (an account tunnel) stay parked; this covers the gap.
#
# ITS DEPLOYS NEED CLOUDFLARE AUTH THAT NEEDS NO BROWSER (2026-09-15: a Pages-only API token,
# for the keeper alone). Measured before: wrangler's OAuth login lapsed - "Not logged in ... the
# environment is non-interactive" - and a tunnel restart then left the Daily naming dead signer nodes with
# nothing able to deploy. The unit reads $ARENA_2OF2_DIR/cloudflare.env, owned by this user, mode 600:
#   CLOUDFLARE_API_TOKEN=<token>
#   CLOUDFLARE_ACCOUNT_ID=<the account that owns the btc-logistics-core Pages project>
# The token, created at dash.cloudflare.com -> My Profile -> API Tokens -> Create Custom Token:
#   Permissions:        Account | Cloudflare Pages | Edit          (nothing else)
#   Account Resources:  Include | <that one account>
#   Client IP filter / TTL: optional
# With CLOUDFLARE_ACCOUNT_ID set, wrangler pages deploy needs no user or membership scope.
# THE FILE IS READ ON EVERY PASS, so a token dropped in is used within 30 s with no restart - and
# only from a file this user owns with mode 600. WITHOUT IT THE KEEPER DOES NOT DEPLOY (the owner
# 2026-09-15): wrangler's browser login lapses and cannot be renewed unattended - measured, it
# failed every 30 s - so the keeper says once why it holds and keeps the signer nodes on the tunnels'
# names. Nothing here prints the token.
set -uo pipefail
D="${ARENA_2OF2_DIR:-/mnt/bitcoin/blwp-2of2}"
CODE="${ARENA_DAILY_CODE:-$D/code}"
ENVF="$D/signer-nodes.env"
LAST="$D/keeper.deployed.json"
say() { echo "{\"at\":\"$(date -u +%FT%TZ)\",$1}"; }

# A QUICK TUNNEL'S PUBLIC NAME, and nothing else that looks like one. cloudflared logs the address it
# asks for a tunnel at - https://api.trycloudflare.com - before it has one, and when that request
# fails it never logs a name at all. Measured (13:51:52Z): the keeper took api.trycloudflare.com as
# signer node A's address and restarted the signer nodes under it. A quick tunnel's name is words joined by
# hyphens; anything else, api included, is no name, and with no name the signer nodes are left alone.
name_in() { grep -oE 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -1; }
tunnel() {
  local id; id=$(systemctl --user show "blwp-daily-tunnel-$1" -p InvocationID --value 2>/dev/null)
  [ -n "$id" ] || return 0
  [ "$(systemctl --user show "blwp-daily-tunnel-$1" -p ActiveState --value 2>/dev/null)" = active ] || return 0
  journalctl --user "_SYSTEMD_INVOCATION_ID=$id" -o cat --no-pager 2>/dev/null | name_in
}
answers() { curl -s -m 15 -o /dev/null -w '%{http_code}' "$1/rounds" | grep -q '^200$'; }
CF="$D/cloudflare.env"
HOLD=""; WHY=""
# The keeper's own token, loaded fresh into this shell for the deploy that follows - or WHY not.
auth() {
  unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  if [ ! -f "$CF" ]; then WHY="no $CF"; return 1; fi
  if [ "$(stat -c '%U %a' "$CF")" != "$(id -un) 600" ]; then WHY="$CF is not this user's with mode 600"; return 1; fi
  set -a; . "$CF"; set +a
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    WHY="$CF names no CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"; unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; return 1
  fi
  WHY=""
}

while true; do
  A=$(tunnel a); B=$(tunnel b)
  if [ -n "$A" ] && [ -n "$B" ]; then
    WANT="BLWP_WSS_18080=wss://${A#https://}
ARENA_WSS_18081=wss://${B#https://}"
    if [ "$(cat "$ENVF" 2>/dev/null)" != "$WANT" ]; then
      printf '%s\n' "$WANT" > "$ENVF"
      say "\"tunnels\":[\"$A\",\"$B\"],\"signerNodes\":\"restarting under the new names\""
      systemctl --user restart blwp-daily-signer-nodes
      sleep 20
    fi
    if python3 - "$D/daily.json" "$A" "$B" <<'PY' && answers "$A" && answers "$B"; then
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if d.get('node') == [sys.argv[2], sys.argv[3]] else 1)
PY
      if ! cmp -s "$D/daily.json" "$LAST"; then
        if auth; then
          HOLD=""
          say "\"daily.json\":\"changed since the last deploy\",\"deploying\":\"$D/page\",\"auth\":\"api token (Pages edit)\""
          if ARENA_2OF2_DIR="$D" ARENA_BUILD_DIR="$D/page" "$CODE/deploy-core.sh" > "$D/keeper-deploy.log" 2>&1; then
            cp "$D/daily.json" "$LAST"
            say "\"deployed\":\"$(grep -oE 'https://[0-9a-f]{8}\.btc-logistics-core\.pages\.dev' "$D/keeper-deploy.log" | tail -1)\""
          else
            say "\"deployFailed\":\"$(grep -E 'ERROR|refusing' "$D/keeper-deploy.log" | tail -1 | tr -d '"\\' | cut -c1-200)\""
          fi
        elif [ "$WHY" != "$HOLD" ]; then
          HOLD="$WHY"
          say "\"holding\":\"daily.json changed since the last deploy, and the keeper deploys only with its own token: $WHY\""
        fi
      fi
    fi
  fi
  sleep 30
done
