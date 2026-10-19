#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# FEDERATION.md, THE REHEARSAL, STEP 1: "deposit into a lock with claim_pk =
# the FROST key; the guardians accept it".
#
# Stock, unpatched fedimintd 0.12.0 (the released builds in FEDIMINT_BIN): four
# guardians, 3 of 4, on their own regtest, and a gateway on bob's lnd - stood
# up by tools/federation-hold-probe.sh's SETUP_ONLY mode with no hold setting.
# Then, as the player:
#
#   1. DEPOSIT   a stock LNv2 receive through the gateway; alice's lnd pays it;
#                the player's client ends with ecash
#   2. KEYS      the committee's 2-of-2 key from this repo's own ceremony, the
#                player's refund key, the stake's H(P) (tools/stake-lock-keys.mjs)
#   3. LOCK      tools/stake-lock (blwp-stake-lock): one stock OutgoingContract
#                funded from that ecash, claim_pk = the committee key,
#                refund_pk = the player, expiration = the guardians' block
#                count + EXPIRY_DELTA
#   4. READ      what the guardians stored at the lock's outpoint - contract id
#                and expiration - beside what the client computed
#
# Everything is stopped at the end: every process group and bitcoind.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> \
#     bash tools/stake-lock-step1.sh [deposit-msat=2000000] [lock-msat=980000] [expiry-delta=144]
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/stake-lock-step1-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
DEPOSIT_MSAT=${1:-2000000}
LOCK_MSAT=${2:-980000}
# stake_expiry_blocks = 144, ruled 2026-09-11 14:40 (FEDERATION.md "Rulings").
EXPIRY_DELTA=${3:-144}
HERE=$(cd "$(dirname "$0")" && pwd)
say() { echo "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=arena -rpcpassword=arena "$@"; }
fc() { HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/client "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1
  sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
ecash() { fc info 2>/dev/null | js 'o=>Number(o.total_amount_msat)'; }

# ---- THE FEDERATION: stock fedimintd, 4 guardians, 3 of 4; one gateway ----
t=$(date +%s)
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q FEDERATION_READY || { say "$UP" | tail -15; say "THE FEDERATION DID NOT COME UP"; exit 1; }
say "federation up in $(( $(date +%s) - t )) s: $(fc info 2>/dev/null | js 'o=>`${Object.keys(o.meta||{}).length>=0?"":""}federation ${o.federation_id.slice(0,16)}, ${o.network}`')"
# Fedimint's threshold is total - (total - 1) / 3 (fedimint-core peer_id.rs:82-102): 3 of 4.
say "  guardians: $(grep -c fedimintd $P/pids) fedimintd processes; peers in the config: $(fc config 2>/dev/null | js 'o=>{const n=Object.keys(o.global.api_endpoints).length;return n+", threshold "+(n-Math.floor((n-1)/3))}')"
say "  gateways vetted: $(fc module lnv2 gateways list 2>/dev/null | js 'o=>JSON.stringify(o)')"
say "  fedimintd: $(HOME=$FH $F/fedimintd --version 2>/dev/null | head -1)"

# ---- 1. DEPOSIT: stock LNv2 receive, paid by alice ----
E0=$(ecash)
RECV=$(fc module lnv2 receive $DEPOSIT_MSAT --gateway http://127.0.0.1:30170 2>&1)
INVOICE=$(echo "$RECV" | grep -oE 'lnbcrt[0-9a-z]+' | head -1)
OP=$(echo "$RECV" | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$INVOICE" ] || { say "NO INVOICE: $(echo "$RECV" | tr -d '\n' | cut -c1-200)"; exit 1; }
PAY=$(timeout 120 $L/lncli --lnddir=$P/alice --rpcserver=127.0.0.1:30107 --network=regtest payinvoice --force "$INVOICE" 2>&1 | grep -oE 'Payment status: [A-Z_]+' | tail -1)
RCV=$(fc module lnv2 await-receive "$OP" 2>&1 | tr -d '\n ')
E1=$(ecash)
say "DEPOSIT: $DEPOSIT_MSAT msat invoice through the gateway; alice's $PAY; receive $RCV; player's ecash $E0 -> $E1 msat"

# ---- 2. KEYS ----
KEYS=$(node $HERE/stake-lock-keys.mjs $P/keys.json)
CLAIM=$(echo "$KEYS" | js 'o=>o.claimPk'); REFUND=$(echo "$KEYS" | js 'o=>o.refundPk'); HASH=$(echo "$KEYS" | js 'o=>o.hash')
say "KEYS: committee (2-of-2, both signer nodes reached it) $CLAIM; player $REFUND; H(P) $HASH"

# ---- 3. LOCK, 4. READ ----
H0=$(bcn getblockcount)
LOCK=$(HOME=$FH timeout 180 $LOCK_BIN --data-dir $P/client --amount-msat $LOCK_MSAT --hash $HASH \
  --claim-pk $CLAIM --refund-pk $REFUND --expiry-delta $EXPIRY_DELTA 2>&1)
E2=$(ecash)
echo "$LOCK" | grep -q '"stored_contract_id"' || { say "THE LOCK FAILED: $(echo "$LOCK" | tail -5 | tr -d '\n' | cut -c1-400)"; exit 1; }
LJ=$(echo "$LOCK" | grep '"stored_contract_id"' | tail -1)
say "LOCK: $LJ"
say "  bitcoin height $H0 (regtest); player's ecash $E1 -> $E2 msat (lock $LOCK_MSAT + fees = $((E1 - E2)) msat)"
# The guardians answer in BLOCKS LEFT (lnv2-server lib.rs:851-865); the lock
# tool adds their own block count back. The id is the hash of the whole
# contract, so a matching id is every field, claim_pk included.
say "STEP 1: $(echo "$LJ" | js 'o=>o.ids_match && o.stored_expiration===o.computed_expiration ? "ACCEPTED - the guardians stored contract "+o.stored_contract_id+" at "+o.txid+":"+o.out_idx+", expiring at block "+o.stored_expiration+" ("+o.stored_blocks_left+" left at their count "+o.block_count_at_read+"), claim_pk = the committee key" : "MISMATCH: "+JSON.stringify(o)')"
echo "$LJ" > $P/lock.json
# STAY_UP=1 (step 2's way in): the federation, the gateway, the chain and the
# player's client are left running for whoever called this; it stops them
# with the process groups in $P/pids and `bitcoin-cli stop`.
if [ -n "${STAY_UP:-}" ]; then
  trap - EXIT
  say "STEP1_STATE probe=$P lock=$P/lock.json keys=$P/keys.json"
fi
say "probe dir: $P"
