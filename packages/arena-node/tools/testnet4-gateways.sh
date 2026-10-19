#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE TWO GATEWAYS' PUBLIC ROOTS, REGISTERED AT ALL SEVEN GUARDIANS (2026-09-27: "Register both root URLs at all
# seven guardians. No 127.0.0.1 registration may remain.")
#
# A GATEWAY IS A ROOT, NEVER A PATH. The stock LNv2 client asks a gateway `base_url.join("/routing_info")`
# (fedimint-connectors http.rs, ROUTING_INFO_ENDPOINT = "/routing_info"), and a join with a leading slash drops the
# base's path: a gateway registered as https://host/gateway-a/ is asked https://host/routing_info. Measured 2026-09-27:
# both path registrations answered routing_info to curl and were `live: false` to the stock client. So gateway A is the
# root of Funnel port 10000 (`tailscale funnel --bg --https=10000 http://127.0.0.1:31270`) and gateway B the root of a
# Cloudflare quick tunnel (`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:31280`, as the Daily's nodes are
# published). A quick tunnel's name changes when it restarts: run this again with the new URL and the old one to drop.
#
#   PATH=<fedimint-cli> HOME=<bundle home> tools/testnet4-gateways.sh <client dir> <add url>... [-- <remove url>...]
#   (guardian admin passwords from $ARENA_TESTNET4_DIR/node-N.db.guardian/admin-password; each guardian's list printed)
set -u
CLIENT=$1; shift
DIR=${ARENA_TESTNET4_DIR:-$HOME/blwp-testnet4}
WRAP=${ARENA_TAILNET_EXEC:-$(dirname "$0")/tailnet-exec.sh}
ADD=(); DROP=(); into=add
for a in "$@"; do if [ "$a" = "--" ]; then into=drop; elif [ $into = add ]; then ADD+=("$a"); else DROP+=("$a"); fi; done
fc() { timeout 90 "$WRAP" fedimint-cli --data-dir "$CLIENT" "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v ' INFO \| WARN ' | tr -d '\n '; }
for i in 0 1 2 3 4 5 6; do
  pw=$(cat "$DIR/node-$((i + 1)).db.guardian/admin-password")
  for u in "${DROP[@]}"; do fc --our-id $i --password "$pw" module lnv2 gateways remove "$u" >/dev/null; done
  for u in "${ADD[@]}"; do fc --our-id $i --password "$pw" module lnv2 gateways add "$u" >/dev/null; done
  echo "guardian $i $(fc module lnv2 gateways list --peer $i | grep -o '\[.*\]' | tail -1)"
done
