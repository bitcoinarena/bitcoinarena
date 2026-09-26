#!/bin/bash
# THE TESTNET FEDERATION, FOUNDED AMONG FOUR NODES THAT ARE EACH ONE GUARDIAN (spec §23A.2; the owner 2026-09-26 22:54 /
# 23:08: testnet is 3 of 4, one node one guardian, and a node start is the guardian start).
#
# Each node started its guardian itself (src/guardian.js) and knows its own endpoint; this reads them off the nodes and
# runs the stock Fedimint ceremony (set-local-params, add-peer, start-dkg), unpatched, base fees off. It does NOT draw
# the four: §23A.2's sortition over the guardian-capable census is not built yet (the advert carries no
# guardian_capable), so the four named here are the four this launcher's operator runs. Founded once: a federation
# that already exists is left alone and its invite printed.
#
#   PATH=<dir with fedimint-cli>:$PATH tools/testnet4-federation.sh [port:store ...]
#   default: 31221:/mnt/bitcoin/fed-testnet4/node-1.db ... 31251:/mnt/bitcoin/fed-testnet4/node-4.db
set -eu
NODES=("$@")
[ ${#NODES[@]} -gt 0 ] || NODES=(31221:/mnt/bitcoin/fed-testnet4/node-1.db 31231:/mnt/bitcoin/fed-testnet4/node-2.db
  31241:/mnt/bitcoin/fed-testnet4/node-3.db 31251:/mnt/bitcoin/fed-testnet4/node-4.db)
[ ${#NODES[@]} -eq 4 ] || { echo "a testnet federation is four guardians (3 of 4); got ${#NODES[@]}" >&2; exit 2; }
command -v fedimint-cli >/dev/null || { echo "no fedimint-cli on PATH" >&2; exit 2; }
say() { echo "[federation] $*"; }

port() { echo "${1%%:*}"; }
store() { echo "${1#*:}"; }
api() { echo "ws://127.0.0.1:$(( $(port $1) + 1000 ))"; }   # the node's guardian API, local (guardian.js guardianPorts)
pw() { cat "$(store $1).guardian/admin-password"; }
setup() { local n=$1; shift; timeout 120 fedimint-cli --password "$(pw $n)" admin setup "$(api $n)" "$@"; }

for n in "${NODES[@]}"; do
  g=$(curl -s -m 10 "http://127.0.0.1:$(port $n)/guardian")
  echo "$g" | grep -q '"guardian":true' || { echo "node on $(port $n) is not a guardian: $g" >&2; exit 3; }
  say "node $(port $n): $g"
done

first=${NODES[0]}
INVITE_FILE="$(store $first).guardian/invite-code"
if [ -s "$INVITE_FILE" ]; then say "already founded"; say "invite $(tr -d '"\n ' < "$INVITE_FILE")"; exit 0; fi

declare -A CODE
i=0
for n in "${NODES[@]}"; do
  i=$((i + 1))
  if [ $i -eq 1 ]; then CODE[$n]=$(setup $n set-local-params "node-$i" --federation-name blwp-testnet4 --federation-size 4)
  else CODE[$n]=$(setup $n set-local-params "node-$i"); fi
  CODE[$n]=$(echo "${CODE[$n]}" | tr -d '"\n ')
  say "node $(port $n) set its local params"
done
for n in "${NODES[@]}"; do for o in "${NODES[@]}"; do
  [ "$n" = "$o" ] || setup $n add-peer "${CODE[$o]}" >/dev/null
done; done
say "every node holds the other three peers; starting the ceremony"
for n in "${NODES[@]}"; do ( setup $n start-dkg > "$(store $n).guardian/start-dkg.out" 2>&1 & ); done
for _ in $(seq 1 150); do [ -s "$INVITE_FILE" ] && break; sleep 2; done
[ -s "$INVITE_FILE" ] || { echo "the ceremony did not write an invite in 300 s" >&2; exit 4; }
say "founded"
say "invite $(tr -d '"\n ' < "$INVITE_FILE")"
