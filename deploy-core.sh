#!/usr/bin/env bash
# Deploys the CORE-DRIVEN build to its own Cloudflare Pages project.
#
# btc-logistics-war is frozen: it holds the last single-player version, the one
# where Unity runs PhysX and there is no deterministic core. Everything from the
# bridge onwards is a different game underneath even when it looks identical, so
# it gets its own host and the old one stays where players can find it.
#
#   ./deploy-core.sh              -> btc-logistics-core
#   ./deploy-core.sh some-project -> that project instead
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# The page to deploy: the last Unity build, or - for the Daily's keeper after a reboot has emptied
# /tmp - the copy of the last deployed page kept on persistent disk (BLWP_BUILD_DIR).
BUILD="${BLWP_BUILD_DIR:-$ROOT/unity-proto/build/webgl}"
PROJECT="${1:-btc-logistics-core}"

if [ "$PROJECT" = "btc-logistics-war" ]; then
  echo "refusing: btc-logistics-war holds the last single-player version." >&2
  echo "Use ./deploy.sh if you really mean to replace it." >&2
  exit 2
fi

[ -f "$BUILD/index.html" ] || { echo "no build at $BUILD - run BuildWebGL.Run first"; exit 1; }
cp "$ROOT/deploy/_headers" "$BUILD/_headers"

# A PAGE THAT STILL CARRIES ITS TEMPLATE TOKENS DOES NOT START, AND LOOKS LIKE
# A SLOW DOWNLOAD WHILE IT DOES NOT. The WebGL template is where the page is
# edited, and an edit reaches a deploy by being copied over Unity's built
# index.html - which brings `{{{ LOADER_FILENAME }}}` back with it, and that is
# a 404 so Unity never starts. It shipped that way once (2026-09-09 16:08, found
# by hand-injecting the loader in a browser). The copy is how the page is
# edited and stays; what stops here is an unfilled copy reaching Cloudflare.
node "$ROOT/unity-proto/tools/fill-template.mjs" "$BUILD"
node "$ROOT/unity-proto/tools/fill-template.mjs" --check "$BUILD"

# THE LOBBY'S SIGNER NODES GO BESIDE THE PAGE ON EVERY DEPLOY (the owner 2026-09-15 12:54: the Daily lobby
# must list rounds). The page's bare root shows the lobby only from daily.json (index.html reads
# it when the address has no query), and no deploy put it here - measured: every deploy from
# 0.0.1265 to 0.0.1304 answered /daily.json with the page itself, so the bare root was the
# offline daily. (A full Unity build does not remove it: the build of 0.0.1311, 13:23-13:25, left
# a daily.json already in this folder in place. It was never copied in.) The file is the signer nodes'
# own launcher's, current on every deploy (tools/run-2of2.mjs writes it
# with the tunnels it bonded under), and it is checked before it ships: two signer nodes, a bond door,
# a signed advertisement, and every signer node answering /rounds. A missing file or a silent signer node
# refuses the deploy by name - a lobby that points at silence is not shipped.
DAILY_DIR="${BLWP_2OF2_DIR:-/mnt/bitcoin/blwp-2of2}"
DAILY="$DAILY_DIR/daily.json"
[ -f "$DAILY" ] || { echo "refusing: no $DAILY - the Daily's signerNodes (packages/blwp-node/tools/run-2of2.mjs) write it; without it the bare root shows no lobby" >&2; exit 3; }
# THE FREE PAIR MAY BE DOWN; THE PAID LOBBY MAY NOT (the owner 2026-10-07, kanban #29 path 2): a daily.json that names no live
# FREE signerNode is not shipped either - its rows are left out (exit 2 below, FREE_DEAD) and the page names the testnet lobby
# alone. A malformed file still refuses, and the testnet merge still refuses when no paid node answers.
FREE_DEAD=0
set +e
node - "$DAILY" <<'CHECK'
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const nodes = Array.isArray(d.node) ? d.node : [];
const bad = (why) => { console.error(`daily.json: ${why}`); process.exit(1); };
if (nodes.length < 2 || !nodes.every((n) => /^https:\/\/[^/]+$/.test(n))) bad(`names ${nodes.length} https signerNodes, not two or more`);
if (typeof d.bond !== 'string' || !/^https:\/\//.test(d.bond)) bad('names no bond door');
if (!/^[0-9a-f]{128}$/.test(String(d.advert))) bad('carries no signed advertisement');
(async () => {
  for (const n of nodes) {
    // ?next=1, NOT THE WHOLE LIST (PAID-NIGHT-2155, measured: a bare /rounds is every round the node holds - 2.2 MB, 7 s,
    // up to 17 s on testnet4 seat 1's event loop, every PLAY behind it waiting); one listed round proves it answers
    const silent = (why) => { console.error(`daily.json: ${why} - the free rows are left out`); process.exit(2); };
    let r; try { r = await fetch(`${n}/rounds?next=1`, { signal: AbortSignal.timeout(15000) }); } catch (e) { silent(`${n}/rounds did not answer: ${e.message}`); }
    if (r.status !== 200) silent(`${n}/rounds answered ${r.status}`);
    let body; try { body = await r.json(); } catch { bad(`${n}/rounds is not JSON`); }
    if (!Array.isArray(body.rounds)) bad(`${n}/rounds lists no rounds array`);
    console.log(`daily.json signerNode ${n}: /rounds 200, ${body.rounds.length} round(s), ${body.rounds.filter((x) => x.phase === 'open').length} open`);
  }
})();
CHECK
rc=$?
set -e
if [ $rc -eq 2 ]; then FREE_DEAD=1; elif [ $rc -ne 0 ]; then echo "refusing: $DAILY does not name live signerNodes" >&2; exit 3; fi
cp "$DAILY" "$BUILD/daily.json"
# THE TESTNET LOBBY BESIDE IT (the owner 2026-09-30 16:07, DEPLOY-1900: "The page he opens always shows both: a free round and a
# live paid testnet round of series 3cfbe516"): testnet-lobby.json in the pair's directory - the testnet4 nodes, bond,
# advert, federation and funded gateway - is merged into daily.json as `testnet`, once one of its nodes answers /rounds.
TESTNET="$DAILY_DIR/testnet-lobby.json"
[ $FREE_DEAD -eq 0 ] || [ -f "$TESTNET" ] || { echo "refusing: the free signerNodes are silent and there is no $TESTNET to show instead" >&2; exit 3; }
if [ -f "$TESTNET" ]; then
  FREE_DEAD=$FREE_DEAD node - "$BUILD/daily.json" "$TESTNET" <<'MERGE' || { echo "refusing: $TESTNET names no live testnet node" >&2; exit 4; }
const fs = require('fs');
const [daily, testnet] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
(async () => {
  // THIS HOST CANNOT REACH ITS OWN FUNNEL NAME (the relay drops TLS started here): the name is resolved to the tailnet
  // address for the check, as the harness's Chrome maps it (--host-resolver-rules).
  const { execFileSync } = require('child_process');
  let ok = 0;
  for (const n of testnet.node || []) {
    const u = new URL(`${n}/rounds?next=1`);   // not the whole list: a bare /rounds held seat 1's loop 7-17 s
    try {
      const code = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '60',
        '--resolve', `${u.hostname}:443:${process.env.BLWP_TAILNET_IP || '198.51.100.7'}`, u.toString()]).toString();
      if (code === '200') { ok++; break; }
    } catch {}
  }
  if (!ok) process.exit(1);
  // FREE PAIR SILENT: the testnet lobby is the page's first and only lobby - its own fields at the top, nothing of the pair's
  const out = process.env.FREE_DEAD === '1' ? { ...testnet, testnet } : { ...daily, testnet };
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log(process.env.FREE_DEAD === '1'
    ? `daily.json: the free signerNodes are silent - their rows left out; the testnet lobby alone, ${(testnet.node || []).length} node(s)`
    : `daily.json: testnet lobby merged, ${(testnet.node || []).length} node(s)`);
})();
MERGE
fi


echo "deploying $(du -sh "$BUILD" | cut -f1) to Cloudflare Pages project '$PROJECT'"
wrangler pages deploy "$BUILD" --project-name "$PROJECT" --branch main --commit-dirty=true

# AND WHAT WAS DEPLOYED IS KEPT WHERE A REBOOT LEAVES IT (the Daily's keeper, deploy/daily): /tmp is
# emptied at boot (tmpfiles "D /tmp"), and the keeper redeploys this copy with a new daily.json when
# the signer nodes' tunnels or bonds change. Only for the Daily's own project.
if [ "$PROJECT" = "btc-logistics-core" ]; then
  PAGE="$DAILY_DIR/page"
  mkdir -p "$PAGE"
  if [ "$(cd "$BUILD" && pwd -P)" != "$(cd "$PAGE" && pwd -P)" ]; then
    rm -rf "$PAGE.new" && cp -a "$BUILD" "$PAGE.new" && rm -rf "$PAGE" && mv "$PAGE.new" "$PAGE"
    echo "kept the deployed page at $PAGE"
  fi
fi
