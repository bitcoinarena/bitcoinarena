#!/bin/bash
# CAN THE SETTLEMENT COMMITTEE BE THE SIGNER BEHIND A LIGHTNING NODE?
#
# the owner 2026-09-11 13:13: no central payment endpoint - invoice, hold,
# settle, cancel and spend need the same quorum as the mint (2 of 2 here). The
# accepted construction is a committee-signed Lightning node (23.6), and the
# first question is measured, not built: on the lnd we have (v0.21.3), with
# --remotesigner.enable and taproot channels, WHAT does bob's node ask its
# signer for at each act, and WHAT can bob still do when the signer is gone?
#
# What it stands up, on its own regtest and its own ports (30301-30312, never
# 8080): bitcoind; alice's lnd (ordinary); bob's lnd WATCH-ONLY - no private
# key in it - whose every key operation goes to a SIGNER lnd (no chain, no
# peers, its RPC log at debug so each request it serves is named); a private
# taproot channel alice -> bob. Then, with the signer up, each act once, with
# the signer's requests counted between marks; then the signer is stopped and
# each act is tried again with only bob's own node and credentials. Bob's
# health check on the signer is OFF - bob holds that switch, so the probe
# gives him every power his credentials allow.
#
#   bash tools/remote-signer-probe.sh
set -uo pipefail
P=${PROBE_DIR:-$(mktemp -d /tmp/remote-signer-probe-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
L=${LND_BIN:-/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta}
RPC=30301; ZB=30303; ZT=30304
declare -A LRPC=([alice]=30305 [bob]=30308 [signer]=30311) LLIS=([alice]=30306 [bob]=30309) LREST=([alice]=30307 [bob]=30310 [signer]=30312)
mkdir -p $P/btc $P/alice $P/bob $P/signer
: > $P/pids
say() { echo "$@"; }
bcn() { $B/bitcoin-cli -regtest -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp "$@"; }
bc() { bcn -rpcwallet=probe "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1
  sleep 4
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT
ln_() { local who=$1; shift; timeout 60 $L/lncli --lnddir=$P/$who --rpcserver=127.0.0.1:${LRPC[$who]} --network=regtest "$@"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(($1)(JSON.parse(s))))}catch(e){process.stdout.write('?')}})"; }
until_() { local what=$1 n=$2; shift 2; for i in $(seq $n); do "$@" && return 0; sleep 1; done; say "GAVE UP waiting for $what"; exit 1; }
waitfor() { local n=$1; shift; for i in $(seq $n); do "$@" && return 0; sleep 1; done; return 1; }
pre() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; }
hashof() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(Buffer.from(process.argv[1],"hex")).digest("hex"))' "$1"; }
state() { ln_ bob lookupinvoice "$1" 2>/dev/null | js 'o=>o.state'; }
is_state() { [ "$(state $1)" = "$2" ]; }
paid() { grep -o -E '"?status"?: *"?(SUCCEEDED|FAILED|IN_FLIGHT)' "$1" 2>/dev/null | tail -1 | grep -o -E 'SUCCEEDED|FAILED|IN_FLIGHT' || echo "no answer"; }
pay_bg() { ( ln_ alice payinvoice --force "$1" > "$2" 2>&1 ) & }
# THE SIGNER'S REQUESTS since a mark: every RPC the signer served, by name.
mark() { wc -l < $P/signer/lnd.out; }
calls() {
  local c; c=$(tail -n +$(( $1 + 1 )) $P/signer/lnd.out | grep -o '\[/[A-Za-z0-9_.]*/[A-Za-z0-9_]*\] requested' \
    | sed 's/\] requested//; s/^\[\///' | sort | uniq -c | awk '{printf "%s x%s, ", $2, $1}')
  echo "${c:-none}"
}
bobbal() { ln_ bob channelbalance 2>/dev/null | js 'o=>o.local_balance.msat'; }
short() { tr -d '\n' | sed 's/  */ /g' | cut -c1-160; }

# ---- THE CHAIN ----
$B/bitcoind -regtest -datadir=$P/btc -rpcport=$RPC -rpcuser=blwp -rpcpassword=blwp -port=30302 -listen=0 \
  -listenonion=0 -fallbackfee=0.0001 -txindex -zmqpubrawblock=tcp://127.0.0.1:$ZB \
  -zmqpubrawtx=tcp://127.0.0.1:$ZT -daemon >/dev/null
until_ bitcoind 60 bcn getblockcount >/dev/null 2>&1
bcn createwallet probe >/dev/null
MINE=$(bc getnewaddress)
bc generatetoaddress 250 $MINE >/dev/null
CHAIN=(--bitcoin.regtest --bitcoin.node=bitcoind --bitcoind.rpchost=127.0.0.1:$RPC --bitcoind.rpcuser=blwp
  --bitcoind.rpcpass=blwp --bitcoind.zmqpubrawblock=tcp://127.0.0.1:$ZB --bitcoind.zmqpubrawtx=tcp://127.0.0.1:$ZT)

# ---- THE SIGNER: every key bob's node uses, and nothing else ----
setsid nohup $L/lnd --lnddir=$P/signer --bitcoin.regtest --bitcoin.node=nochainbackend \
  --rpclisten=127.0.0.1:${LRPC[signer]} --restlisten=127.0.0.1:${LREST[signer]} --nolisten \
  --noseedbackup --nobootstrap --debuglevel=debug --alias=signer > $P/signer/lnd.out 2>&1 < /dev/null &
echo "$! lnd-signer" >> $P/pids
SIGNER_PID=$!
accounts() { ln_ signer wallet accounts list > $P/accounts.json 2>/dev/null && [ -s $P/accounts.json ]; }
until_ "the signer's accounts" 90 accounts
say "signer up: $(js 'o=>o.accounts.length' < $P/accounts.json) accounts exported (xpubs only)"
say "WHAT THE SIGNER HOLDS: one seed ($(ls $P/signer/data/chain/bitcoin/regtest/ | tr '\n' ' '))- every private key below comes from it:"
node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).accounts;
  const by = {};
  for (const x of a) { const k = x.derivation_path.split("/").slice(0, 2).join("/") + " " + x.address_type; (by[k] = by[k] || []).push(x.derivation_path.split("/")[3]); }
  for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v.length} account(s)${v.length > 3 ? `, families ${v[0]}..${v[v.length - 1]}` : ""}`);
  console.log("  (m/1017 families are lnd channel keys: 0 multisig/funding, 1 revocation base, 2 htlc base, 3 payment base, 4 delay base, 5 revocation root, 6 NODE KEY, 7-9 encryption/tower)");' $P/accounts.json

# ---- BOB, WATCH-ONLY, SIGNING THROUGH IT; ALICE, ORDINARY ----
SIGMAC=$P/signer/data/chain/bitcoin/regtest/admin.macaroon
setsid nohup $L/lnd --lnddir=$P/bob "${CHAIN[@]}" \
  --rpclisten=127.0.0.1:${LRPC[bob]} --listen=127.0.0.1:${LLIS[bob]} --restlisten=127.0.0.1:${LREST[bob]} \
  --nobootstrap --alias=bob --protocol.simple-taproot-chans \
  --remotesigner.enable --remotesigner.rpchost=127.0.0.1:${LRPC[signer]} \
  --remotesigner.macaroonpath=$SIGMAC --remotesigner.tlscertpath=$P/signer/tls.cert \
  --remotesigner.timeout=10s --healthcheck.remotesigner.attempts=0 \
  > $P/bob/lnd.out 2>&1 < /dev/null &
echo "$! lnd-bob" >> $P/pids
setsid nohup $L/lnd --lnddir=$P/alice "${CHAIN[@]}" \
  --rpclisten=127.0.0.1:${LRPC[alice]} --listen=127.0.0.1:${LLIS[alice]} --restlisten=127.0.0.1:${LREST[alice]} \
  --noseedbackup --nobootstrap --alias=alice --protocol.simple-taproot-chans > $P/alice/lnd.out 2>&1 < /dev/null &
echo "$! lnd-alice" >> $P/pids

# `lncli createwatchonly` asks for a password on a terminal; the same call over
# REST (InitWallet with watch_only) takes it in the body.
rest_up() { [ -s $P/bob/tls.cert ] && curl -s --cacert $P/bob/tls.cert https://127.0.0.1:${LREST[bob]}/v1/state >/dev/null 2>&1; }
until_ "bob's REST" 90 rest_up
BODY=$(node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).accounts;
  const accounts = a.map((x) => { const [purpose, coin_type, account] = x.derivation_path.replace(/^m\//, "").split("/").map((s) => parseInt(s, 10));
    return { purpose, coin_type, account, xpub: x.extended_public_key }; });
  process.stdout.write(JSON.stringify({ wallet_password: Buffer.from("probe-password").toString("base64"),
    watch_only: { master_key_birthday_timestamp: "0", accounts } }));' $P/accounts.json)
INIT=$(curl -s --cacert $P/bob/tls.cert -X POST https://127.0.0.1:${LREST[bob]}/v1/initwallet -d "$BODY")
say "bob's watch-only wallet: $(echo "$INIT" | short)"
synced() { [ "$(ln_ $1 getinfo 2>/dev/null | js 'o=>o.synced_to_chain')" = true ]; }
until_ "alice's lnd" 120 synced alice
until_ "bob's lnd" 180 synced bob
BOBKEY=$(ln_ bob getinfo | js 'o=>o.identity_pubkey')
say "bob's node key $BOBKEY - its private key is only in the signer"
grep -q -i "remote signer\|remotesigner\|RemoteSigner" $P/bob/lnd.out && say "bob's log names the remote signer: $(grep -i -m1 'remote signer' $P/bob/lnd.out | short)"

bc sendtoaddress "$(ln_ alice newaddress p2tr | js 'o=>o.address')" 5 >/dev/null
bc generatetoaddress 6 $MINE >/dev/null
funded() { [ "$(ln_ alice walletbalance | js 'o=>o.confirmed_balance')" != 0 ]; }
until_ "alice's coins" 120 funded
ln_ alice connect $BOBKEY@127.0.0.1:${LLIS[bob]} >/dev/null
m=$(mark)
OPEN=$(ln_ alice openchannel --node_key=$BOBKEY --local_amt=2000000 --push_amt=1000000 --channel_type=taproot --private 2>&1)
say "open a private TAPROOT channel alice->bob: $(echo "$OPEN" | short)"
bc generatetoaddress 6 $MINE >/dev/null
active() { [ "$(ln_ alice listchannels | js 'o=>(o.channels||[]).filter(c=>c.active).length')" -gt 0 ]; }
until_ "the channel" 120 active
say "  channel type $(ln_ bob listchannels | js 'o=>o.channels[0].commitment_type'); signer requests for the open: $(calls $m)"
m=$(mark); sleep 10
say "IDLE 10 s (noise floor): $(calls $m)"

say ""
say "WITH THE SIGNER UP - what each act asks it for:"
BAL0=$(bobbal)
P1=$(pre); H1=$(hashof $P1)
BOBARGS=($L/lncli $P/bob 127.0.0.1:${LRPC[bob]})
ACTS="node $(dirname "$0")/remote-signer-acts.mjs"
say "  bob's credential on every act below: ONE macaroon, $P/bob/data/chain/bitcoin/regtest/admin.macaroon"
m=$(mark); CR=$($ACTS create "${BOBARGS[@]}" $H1 1000000)
INV1=$(echo "$CR" | js 'o=>o.request')
say "  invoice  lndPort.createHeld (the daemons' port; addholdinvoice $H1 --amt_msat 1000000): $(echo "$CR" | js 'o=>o.ok?"made":"REFUSED: "+o.why'); signer: $(calls $m)"
say "           the invoice's signature: $($ACTS signer "$INV1" $BOBKEY)"
m=$(mark); pay_bg "$INV1" $P/pay1.out
waitfor 60 is_state $H1 ACCEPTED
say "  hold     alice pays: bob's invoice $(state $H1); signer: $(calls $m)"
m=$(mark); ST=$($ACTS settle "${BOBARGS[@]}" $P1)
waitfor 30 is_state $H1 SETTLED; sleep 3
say "  settle   lndPort.settle (settleinvoice --preimage): '$ST', invoice $(state $H1), alice's payment $(paid $P/pay1.out); signer: $(calls $m)"
P2=$(pre); H2=$(hashof $P2)
INV2=$(ln_ bob addholdinvoice $H2 --amt 1000 | js 'o=>o.payment_request'); pay_bg "$INV2" $P/pay2.out
waitfor 60 is_state $H2 ACCEPTED
m=$(mark); CN=$(ln_ bob cancelinvoice $H2 2>&1 | short); sleep 5
say "  cancel   cancelinvoice: '${CN:-ok}', invoice $(state $H2), alice's payment $(paid $P/pay2.out); signer: $(calls $m)"
REQ=$(ln_ alice addinvoice --amt 500 | js 'o=>o.payment_request')
m=$(mark); SP=$(ln_ bob payinvoice --force $REQ 2>&1); sleep 2
say "  spend    bob pays alice 500 sat: $(echo "$SP" | grep -o -E 'SUCCEEDED|FAILED' | tail -1); signer: $(calls $m)"
say "  bob's channel balance ${BAL0} -> $(bobbal) msat"

# ---- READY FOR THE SIGNER TO BE GONE: invoices made and held while it is up ----
P3=$(pre); H3=$(hashof $P3); INV3=$(ln_ bob addholdinvoice $H3 --amt 1000 | js 'o=>o.payment_request')
P4=$(pre); H4=$(hashof $P4); INV4=$(ln_ bob addholdinvoice $H4 --amt 1000 | js 'o=>o.payment_request')
P5=$(pre); H5=$(hashof $P5); INV5=$(ln_ bob addholdinvoice $H5 --amt 1000 | js 'o=>o.payment_request')
pay_bg "$INV4" $P/pay4.out; pay_bg "$INV5" $P/pay5.out
waitfor 60 is_state $H4 ACCEPTED; waitfor 60 is_state $H5 ACCEPTED
REQ2=$(ln_ alice addinvoice --amt 500 | js 'o=>o.payment_request')
BAL1=$(bobbal)
say ""
say "prepared with the signer up: invoice 3 made (unpaid), invoices 4 and 5 $(state $H4)/$(state $H5); bob's balance $BAL1 msat"

kill -TERM -- -$SIGNER_PID 2>/dev/null
gone() { ! ln_ signer getinfo >/dev/null 2>&1; }
until_ "the signer to stop" 30 gone
say "THE SIGNER IS STOPPED. Bob's own node and credentials only:"
P6=$(pre); H6=$(hashof $P6)
IV=$(ln_ bob addholdinvoice $H6 --amt 1000 2>&1)
say "  invoice  addholdinvoice: $(echo "$IV" | js 'o=>o.payment_request ? "MADE" : "?"' | grep -q MADE && echo MADE || echo "REFUSED: $(echo "$IV" | short)")"
sleep 2
say "  bob's lnd after that refusal: $(ln_ bob getinfo >/dev/null 2>&1 && echo still running || echo GONE) - $(grep -m1 '\[CRT\]' $P/bob/lnd.out | short) / $(grep -m1 'Shutdown complete' $P/bob/lnd.out | short)"
pay_bg "$INV3" $P/pay3.out
waitfor 40 is_state $H3 ACCEPTED
say "  hold     alice pays invoice 3: bob's invoice $(state $H3) after up to 40 s; alice's payment $(paid $P/pay3.out)"
ST=$(ln_ bob settleinvoice $P4 2>&1 | short); sleep 20
say "  settle   settleinvoice on invoice 4: '${ST:-ok}'; invoice $(state $H4); alice's payment $(paid $P/pay4.out)"
CN=$(ln_ bob cancelinvoice $H5 2>&1 | short); sleep 20
say "  cancel   cancelinvoice on invoice 5: '${CN:-ok}'; invoice $(state $H5); alice's payment $(paid $P/pay5.out)"
SP=$(ln_ bob payinvoice --force $REQ2 2>&1)
say "  spend    bob pays alice 500 sat: $(echo "$SP" | grep -o -E 'SUCCEEDED|FAILED' | tail -1 || true) $(echo "$SP" | grep -i -m1 'error\|fail' | short)"
say "  bob's channel balance $BAL1 -> $(bobbal) msat; channel active: $(ln_ bob listchannels | js 'o=>o.channels.map(c=>c.active).join(",")')"
say "  bob's log, signer errors: $(grep -c -i 'remote signer\|signer.*\(unavailable\|refused\|error\)' $P/bob/lnd.out) line(s); last: $(grep -i 'signer' $P/bob/lnd.out | tail -1 | short)"
say "probe dir: $P"
