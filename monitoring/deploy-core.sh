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
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The page to deploy: the last Unity build, or - for the Daily's keeper after a reboot has emptied
# /tmp - the copy of the last deployed page kept on persistent disk (ARENA_BUILD_DIR).
BUILD="${ARENA_BUILD_DIR:-$ROOT/unity-proto/build/webgl}"
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

# THE LOBBY'S SIGNER NODES GO BESIDE THE PAGE ON EVERY DEPLOY (2026-09-15 12:54: the Daily lobby
# must list rounds). The page's bare root shows the lobby only from daily.json (index.html reads
# it when the address has no query), and no deploy put it here - measured: every deploy from
# 0.0.1265 to 0.0.1304 answered /daily.json with the page itself, so the bare root was the
# offline daily. (A full Unity build does not remove it: the build of 0.0.1311, 13:23-13:25, left
# a daily.json already in this folder in place. It was never copied in.) The file is the signer nodes'
# own launcher's, current on every deploy (tools/run-2of2.mjs writes it
# with the tunnels it bonded under), and it is checked before it ships: two signer nodes, a bond door,
# a signed advertisement, and every signer node answering /rounds. A missing file or a silent signer node
# refuses the deploy by name - a lobby that points at silence is not shipped.
DAILY_DIR="${ARENA_2OF2_DIR:-/mnt/bitcoin/blwp-2of2}"
DAILY="$DAILY_DIR/daily.json"
[ -f "$DAILY" ] || { echo "refusing: no $DAILY - the Daily's signerNodes (packages/arena-node/tools/run-2of2.mjs) write it; without it the bare root shows no lobby" >&2; exit 3; }
node - "$DAILY" <<'CHECK' || { echo "refusing: $DAILY does not name live signerNodes" >&2; exit 3; }
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const nodes = Array.isArray(d.node) ? d.node : [];
const bad = (why) => { console.error(`daily.json: ${why}`); process.exit(1); };
if (nodes.length < 2 || !nodes.every((n) => /^https:\/\/[^/]+$/.test(n))) bad(`names ${nodes.length} https signerNodes, not two or more`);
if (typeof d.bond !== 'string' || !/^https:\/\//.test(d.bond)) bad('names no bond door');
if (!/^[0-9a-f]{128}$/.test(String(d.advert))) bad('carries no signed advertisement');
(async () => {
  for (const n of nodes) {
    let r; try { r = await fetch(`${n}/rounds`, { signal: AbortSignal.timeout(15000) }); } catch (e) { bad(`${n}/rounds did not answer: ${e.message}`); }
    if (r.status !== 200) bad(`${n}/rounds answered ${r.status}`);
    let body; try { body = await r.json(); } catch { bad(`${n}/rounds is not JSON`); }
    if (!Array.isArray(body.rounds)) bad(`${n}/rounds lists no rounds array`);
    console.log(`daily.json signerNode ${n}: /rounds 200, ${body.rounds.length} round(s), ${body.rounds.filter((x) => x.phase === 'open').length} open`);
  }
})();
CHECK
cp "$DAILY" "$BUILD/daily.json"


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
