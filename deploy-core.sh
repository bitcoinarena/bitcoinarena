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
BUILD="$ROOT/unity-proto/build/webgl"
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


echo "deploying $(du -sh "$BUILD" | cut -f1) to Cloudflare Pages project '$PROJECT'"
wrangler pages deploy "$BUILD" --project-name "$PROJECT" --branch main --commit-dirty=true
