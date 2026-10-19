#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# ONE LNv2 GATEWAY OF THE TESTNET FEDERATION, ON ONE testnet4 LND (the ruled pick A: one gateway on each testnet4 LND).
# Stock gatewayd, base fee zero. Its Fedimint network label is the federation's: `testnet4`, which the guardians read off
# the chain's block-1 hash once Fedimint knows it (tools/fedimint-testnet4.patch; 2026-09-27 07:51) - the stock
# gatewayd asserts only that its LND and its label agree, and LND says testnet4. The LND's TLS certificate and admin macaroon are copied beside the
# gateway's data, because the fedimint bundle runs in a user chroot that does not see /mnt/bitcoin (a separate mount).
#
# ARENA_TN4_NETWORK (default testnet4) names the LND's chain and the gateway's label; ARENA_BITCOIND_URL / ARENA_BITCOIND_COOKIE
# the chain (default the testnet4 bitcoind). The regtest harness (tn4-tools-regtest.sh) names regtest and its own bitcoind.
#
#   PATH=<dir with gatewayd>:$PATH tools/testnet4-gateway.sh <lnddir> <lnd rpc host:port> <listen port> <data dir>
set -eu
NET=${ARENA_TN4_NETWORK:-testnet4}
BTC_URL=${ARENA_BITCOIND_URL:-http://127.0.0.1:48332}
BTC_COOKIE=${ARENA_BITCOIND_COOKIE:-/mnt/bitcoin/tn4/testnet4/.cookie}
LND=$1; RPC=$2; PORT=$3; DIR=$4
mkdir -p "$DIR"; chmod 700 "$DIR"
install -m 600 "$LND/tls.cert" "$DIR/lnd-tls.cert"
install -m 600 "$LND/data/chain/bitcoin/$NET/admin.macaroon" "$DIR/lnd-admin.macaroon"
[ -s "$DIR/password" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$DIR/password")
[ -s "$DIR/password-hash" ] || gateway-cli create-password-hash "$(cat "$DIR/password")" | tr -d '"\n' > "$DIR/password-hash"
export FM_DEFAULT_ROUTING_FEES="0 msat,0" FM_DEFAULT_TRANSACTION_FEES="0 msat,0" FM_GATEWAY_DATA_DIR=$DIR/data FM_GATEWAY_LISTEN_ADDR=127.0.0.1:$PORT FM_GATEWAY_API_ADDR=http://127.0.0.1:$PORT \
  FM_GATEWAY_BCRYPT_PASSWORD_HASH="$(cat "$DIR/password-hash")" FM_GATEWAY_NETWORK=$NET \
  FM_BITCOIND_URL=$BTC_URL FM_BITCOIND_USERNAME=__cookie__ \
  FM_BITCOIND_PASSWORD="$(cut -d: -f2- "$BTC_COOKIE")" FM_GATEWAY_SKIP_SETUP=true \
  FM_GATEWAY_IROH_LISTEN_ADDR=127.0.0.1:$((PORT + 1)) FM_GATEWAY_METRICS_LISTEN_ADDR=127.0.0.1:$((PORT + 2)) \
  FM_LND_RPC_ADDR=https://$RPC FM_LND_TLS_CERT=$DIR/lnd-tls.cert FM_LND_MACAROON=$DIR/lnd-admin.macaroon
mkdir -p "$DIR/data"
exec gatewayd lnd
