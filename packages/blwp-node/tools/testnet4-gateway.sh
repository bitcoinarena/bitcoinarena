#!/bin/bash
# ONE LNv2 GATEWAY OF THE TESTNET FEDERATION, ON ONE testnet4 LND (the ruled pick A: one gateway on each testnet4 LND).
# Stock gatewayd, base fee zero. Its Fedimint network label is the federation's: `regtest`, Fedimint 0.12's own label
# for the testnet4 chain (src/guardian.js). The LND's TLS certificate and admin macaroon are copied beside the
# gateway's data, because the fedimint bundle runs in a user chroot that does not see /mnt/bitcoin (a separate mount).
#
#   PATH=<dir with gatewayd>:$PATH tools/testnet4-gateway.sh <lnddir> <lnd rpc host:port> <listen port> <data dir>
set -eu
LND=$1; RPC=$2; PORT=$3; DIR=$4
mkdir -p "$DIR"; chmod 700 "$DIR"
install -m 600 "$LND/tls.cert" "$DIR/lnd-tls.cert"
install -m 600 "$LND/data/chain/bitcoin/testnet4/admin.macaroon" "$DIR/lnd-admin.macaroon"
[ -s "$DIR/password" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$DIR/password")
[ -s "$DIR/password-hash" ] || gateway-cli create-password-hash "$(cat "$DIR/password")" | tr -d '"\n' > "$DIR/password-hash"
export FM_GATEWAY_DATA_DIR=$DIR/data FM_GATEWAY_LISTEN_ADDR=127.0.0.1:$PORT FM_GATEWAY_API_ADDR=http://127.0.0.1:$PORT \
  FM_GATEWAY_BCRYPT_PASSWORD_HASH="$(cat "$DIR/password-hash")" FM_GATEWAY_NETWORK=regtest \
  FM_BITCOIND_URL=http://127.0.0.1:48332 FM_BITCOIND_USERNAME=__cookie__ \
  FM_BITCOIND_PASSWORD="$(cut -d: -f2- /mnt/bitcoin/tn4/testnet4/.cookie)" FM_GATEWAY_SKIP_SETUP=true \
  FM_GATEWAY_IROH_LISTEN_ADDR=127.0.0.1:$((PORT + 1)) FM_GATEWAY_METRICS_LISTEN_ADDR=127.0.0.1:$((PORT + 2)) \
  FM_LND_RPC_ADDR=https://$RPC FM_LND_TLS_CERT=$DIR/lnd-tls.cert FM_LND_MACAROON=$DIR/lnd-admin.macaroon
mkdir -p "$DIR/data"
exec gatewayd lnd
