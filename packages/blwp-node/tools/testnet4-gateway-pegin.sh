#!/bin/bash
# A GATEWAY'S E-CASH IN THE FEDERATION, PEGGED IN FROM ITS OWN LND'S ON-CHAIN WALLET (item 5, measured 2026-09-28: both
# testnet gateways held 0 msat in the federation, and an LNv2 gateway funds a player's incoming deposit from its own
# e-cash - gateway B refused the first paid deposit "Error relaying incoming lightning payment err=Insufficient funds").
# A founded federation is not open for paid deposits until its gateways hold e-cash; the federation credits a peg-in
# only after its finality delay (testnet4: 100 blocks), so this runs at founding, not at the first player.
#
#   PATH=<gateway-cli>:$PATH tools/testnet4-gateway-pegin.sh <gateway api url> <password file> <federation id> <sats>
#   (the transaction id is printed; `gateway-cli get-balances` shows the e-cash once it is final)
set -eu
API=$1; PWFILE=$2; FED=$3; SATS=$4
WRAP=${BLWP_TAILNET_EXEC:-$(dirname "$0")/tailnet-exec.sh}
gc() { timeout 90 "$WRAP" gateway-cli --address "$API" --rpcpassword "$(cat "$PWFILE")" "$@" 2>/dev/null; }
ADDR=$(gc ecash pegin --federation-id "$FED" | grep -o 'tb1[0-9a-z]*\|bc1[0-9a-z]*\|bcrt1[0-9a-z]*' | head -1)
[ -n "$ADDR" ] || { echo "the gateway at $API named no peg-in address for $FED" >&2; exit 1; }
echo "peg-in address $ADDR"
gc onchain send --address "$ADDR" --amount "$SATS sats" --fee-rate-sats-per-vbyte "${FEE_RATE:-2}" | grep -o '"txid": *"[0-9a-f]*"'
