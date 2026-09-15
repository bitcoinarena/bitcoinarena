#!/bin/bash
# THE FEDERATION'S GUARDIANS, READ OFF ITS OWN CONFIG (M3; the owner 2026-09-15 07:33: every guardian
# has its own bond, federationIsBonded stays on). On stock fedimintd 0.12.0 - 4 guardians, 3 of 4,
# base fee 0, rehearsal step 1's setup - `blwp-stake-lock --mode guardians` is set beside what the
# stock client itself reads from the same config (`fedimint-cli config` and `info`): the same four
# broadcast keys per peer, the threshold n - floor((n-1)/3) = 3, the same federation id.
#
#   FEDIMINT_BIN=<released v0.12.0 builds> LOCK_BIN=<blwp-stake-lock> bash tools/guardians-regtest.sh
set -uo pipefail
: "${FEDIMINT_BIN:?FEDIMINT_BIN must name the directory holding the released Fedimint v0.12.0 builds}"
: "${LOCK_BIN:?LOCK_BIN must name the built blwp-stake-lock}"
F=$FEDIMINT_BIN
FH=${FEDIMINT_HOME:-$F/home}
P=${PROBE_DIR:-$(mktemp -d /tmp/guardians-XXXXXX)}
B=${BITCOIN_BIN:-/mnt/bitcoin/bitcoin-31.1/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
bcn() { $B/bitcoin-cli -regtest -rpcport=30101 -rpcuser=blwp -rpcpassword=blwp "$@"; }
fc() { HOME=$FH timeout 120 $F/fedimint-cli --data-dir $P/client "$@"; }
stop() {
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -TERM -- -$pid 2>/dev/null; done
  bcn stop >/dev/null 2>&1; sleep 5
  for pid in $(cut -d' ' -f1 $P/pids 2>/dev/null); do kill -KILL -- -$pid 2>/dev/null; done
}
trap stop EXIT

t=$(date +%s)
UP=$(PROBE_DIR=$P SETUP_ONLY=1 FEDIMINT_BIN=$F FEDIMINT_HOME=$FH bash $HERE/federation-hold-probe.sh 2>&1)
echo "$UP" | grep -q FEDERATION_READY || { echo "$UP" | tail -15; echo "THE FEDERATION DID NOT COME UP"; exit 1; }
echo "federation up in $(( $(date +%s) - t )) s, $(grep -c fedimintd $P/pids) fedimintd processes"

OURS=$(HOME=$FH timeout 120 $LOCK_BIN --mode guardians --data-dir $P/client 2>&1)
G=$(echo "$OURS" | grep '"mode":"guardians"' | tail -1)
[ -n "$G" ] || { echo "NO GUARDIANS: $(echo "$OURS" | tail -3 | tr -d '\n' | cut -c1-300)"; exit 1; }
echo "GUARDIANS $G"
fc config > $P/config.json 2>/dev/null || { echo "fedimint-cli config failed"; exit 1; }
fc info > $P/info.json 2>/dev/null || { echo "fedimint-cli info failed"; exit 1; }
FEES=$(HOME=$FH timeout 120 $LOCK_BIN --mode fees --data-dir $P/client 2>&1 | grep '"mode":"fees"' | tail -1)
echo "FEES $FEES"

# THE COMPARISON, in node: every key the stock config lists for every peer, the count, the
# threshold fedimint's own NumPeers gives, the federation id `info` names.
G="$G" node -e '
const fs = require("fs");
const g = JSON.parse(process.env.G);
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const info = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const glob = cfg.global || {};
const stock = glob.broadcast_public_keys || {};
const peers = Object.keys(glob.api_endpoints || {}).length;
const threshold = peers - Math.floor((peers - 1) / 3);
const ours = Object.fromEntries(g.keys.map((k) => [String(k.peer), k.key]));
const sameKeys = Object.keys(stock).length === g.keys.length && Object.entries(stock).every(([p, k]) => ours[String(p)] === k);
const out = { peers, stockKeys: Object.keys(stock).length, oursKeys: g.keys.length, sameKeys,
  threshold: { ours: g.threshold, fedimint: threshold }, guardians: g.guardians,
  federationId: { ours: g.federation_id, info: info.federation_id }, keyBytes: g.keys.map((k) => k.key.length / 2) };
console.log("CHECK " + JSON.stringify(out));
const ok = sameKeys && g.threshold === threshold && g.guardians === peers && g.federation_id === info.federation_id
  && g.keys.every((k) => /^0[23][0-9a-f]{64}$/.test(k.key));
console.log(ok ? "GUARDIANS MATCH THE STOCK CONFIG" : "GUARDIANS DO NOT MATCH THE STOCK CONFIG");
process.exit(ok ? 0 : 1);
' $P/config.json $P/info.json
RC=$?

# THE PAGE'S OWN READ (WASM_PKG, optional: a wasm-bindgen --target web output of the lock client).
# The page joins the federation by the invite with the stock client compiled to wasm and reads the
# guardians off the config it downloaded - it must name what the seat's tool names, key for key.
if [ -n "${WASM_PKG:-}" ] && [ $RC -eq 0 ]; then
  INVITE=$(echo "$UP" | grep -oE 'invite=[^ ]+' | tail -1 | cut -d= -f2-)
  G="$G" INVITE="$INVITE" WASM_PKG="$WASM_PKG" timeout 150 node --input-type=module -e '
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const env = process.env;
const g = JSON.parse(env.G);
const dir = mkdtempSync(join(tmpdir(), "guardians-glue-"));
copyFileSync(join(env.WASM_PKG, "blwp_lock_client.js"), join(dir, "blwp_lock_client.mjs"));
const glue = await import(join(dir, "blwp_lock_client.mjs"));
await glue.default({ module_or_path: readFileSync(join(env.WASM_PKG, "blwp_lock_client_bg.wasm")) });
const held = new Map();
const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
const t = Date.now();
const lc = await glue.LockClient.join(env.INVITE, glue.LockClient.federationIdOf(env.INVITE), randomBytes(32).toString("hex"), store);
const w = JSON.parse(await lc.guardians());
const byPeer = (keys) => JSON.stringify(keys.map((k) => [String(k.peer), k.key]).sort());
const same = byPeer(w.keys) === byPeer(g.keys) && w.threshold === g.threshold && w.guardians === g.guardians
  && w.federation_id === g.federation_id;
console.log("WASM " + JSON.stringify({ ms: Date.now() - t, ...w }));
console.log(same ? "THE PAGE READS THE SAME GUARDIANS" : "THE PAGE READS OTHER GUARDIANS");
process.exit(same ? 0 : 1);
' 2>&1 | grep -E '^WASM |THE PAGE|Error|panicked'
  RC=${PIPESTATUS[0]}
fi
echo "probe dir: $P (exit $RC)"
exit $RC
