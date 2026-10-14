#!/bin/bash
# FEDERATION.md REHEARSAL 12, CAN STOCK 0.12 RESHARE? (§23A.6, kanban #326): "measure whether a running federation can seat a new
# guardian or move a gone guardian's share; the answer decides whether §23A.6's succession is the first path or the fallback".
# Fedimint 0.12 has no reshare in its source (no endpoint, no CLI); the only peer-set API is the setup API before the key
# ceremony (set-local-params, add-peer, start-dkg, restart_federation_setup). This asks a RUNNING federation's guardian every one
# of them, with its admin password, for a fifth guardian started fresh - and reads whether the federation, its peers and its id
# changed. One JSON line per question; it decides nothing. Nothing here reaches testnet4.
#   FEDIMINT_BIN=<fork bin dir> bash tools/rehearsal-12-regtest.sh
set -uo pipefail
TIMEOUT_S=${TIMEOUT_S:-900}
if [ -z "${R12_WRAPPED:-}" ]; then export R12_WRAPPED=1; exec timeout -k 30 "${TIMEOUT_S}s" bash "$0" "$@"; fi
: "${FEDIMINT_BIN:?}"
F=$FEDIMINT_BIN; FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/r12-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
HERE=$(cd "$(dirname "$0")" && pwd)
bcn() { $B/bitcoin-cli -datadir=$P/btc -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
jstr() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split("\n").filter(l=>!/ INFO | WARN /.test(l)).join(" ").slice(0,240))))'; }
cl() { local d=$1; shift; HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/$d "$@"; }
setup() { HOME=$FH timeout 60 $F/fedimint-cli --password probe admin setup "$@"; }
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; echo "GAVE UP waiting for $what"; exit 1; }
session() { cl client dev api status null --peer-id 0 --password probe 2>/dev/null | js 'o=>Number(((o.value||o).federation||{}).session_count)'; }
peers() { node -e 'const c=require(process.argv[1]);process.stdout.write(String(Object.keys((c.global||c).api_endpoints||{}).length))' $P/$1/client.json; }   # the guardian's own config
say() { echo "{\"step\":\"$1\",\"answer\":$2}"; }

UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH BITCOIN_BIN=$B LND_BIN=$L bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" > $P/setup.log
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
INV=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
FED=$(cl client info | js 'o=>o.federation_id')
S0=$(session)
echo "{\"step\":\"running federation\",\"federation\":\"$FED\",\"guardians\":$(peers g0),\"session\":$S0}"

# ---- a fifth guardian, started fresh in setup mode ----
mkdir -p $P/g4
( export HOME=$FH FM_DATA_DIR=$P/g4 FM_BITCOIN_NETWORK=regtest FM_BITCOIND_URL=http://127.0.0.1:30101 FM_BITCOIND_USERNAME=blwp FM_BITCOIND_PASSWORD=blwp \
    FM_BIND_P2P=127.0.0.1:30160 FM_BIND_API=127.0.0.1:30161 FM_BIND_UI=127.0.0.1:30162 FM_BIND_METRICS=127.0.0.1:30163 \
    FM_P2P_URL=fedimint://127.0.0.1:30160 FM_API_URL=ws://127.0.0.1:30161 FM_ENABLE_IROH=false FM_PASSWORD_API=probe FM_PASSWORD_UI=probe
  setsid nohup $F/fedimintd > $P/g4/fedimintd.out 2>&1 < /dev/null & echo "$! fedimintd-4" >> $P/pids )
up4() { grep -q "Setup UI running" $P/g4/fedimintd.out 2>/dev/null; }
until_ "the fifth guardian" 180 up4
CODE4=$(setup ws://127.0.0.1:30161 set-local-params g4 2>&1 | tr -d '"\n ')
say "the fifth guardian's setup code" "$(printf '%s' "${CODE4:0:40}..." | jstr)"

# ---- the running guardian g0 asked, as its admin, to take it ----
for q in "status" "add-peer $CODE4" "set-local-params g0-again" "start-dkg"; do
  say "running g0: admin setup $(echo $q | cut -c1-16)" "$(setup ws://127.0.0.1:30121 $q 2>&1 | jstr)"
done
say "running g0: restart_federation_setup" "$(cl client dev api restart_federation_setup null --peer-id 0 --password probe 2>&1 | jstr)"
say "running g0: status" "$(cl client dev api status null --peer-id 0 --password probe 2>&1 | js 'o=>JSON.stringify({server:(o.value||o).server,session:((o.value||o).federation||{}).session_count})')"
# ---- and the fifth guardian, the other way round: g0's own setup code ----
say "fifth guardian: add-peer g0" "$(setup ws://127.0.0.1:30161 add-peer "$(tr -d '"\n ' < $P/g0.setup)" 2>&1 | jstr)"
say "fifth guardian: start-dkg" "$(setup ws://127.0.0.1:30161 start-dkg 2>&1 | jstr)"
sleep 60   # sessions run on: is consensus still moving?
S1=$(session)
FED_AFTER=$(cl client info | js 'o=>o.federation_id')
echo "{\"step\":\"after\",\"federation\":\"$FED_AFTER\",\"sameId\":$([ "$FED" = "$FED_AFTER" ] && echo true || echo false),\"guardiansG0\":$(peers g0),\"sessionBefore\":$S0,\"sessionAfter\":$S1,\"g4Running\":$(grep -c 'Consensus is running\|consensus running' $P/g4/fedimintd.out)}"
