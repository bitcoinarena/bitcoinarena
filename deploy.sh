#!/usr/bin/env bash
# Publish the Unity build to Cloudflare Pages.
#
# One-off: `wrangler login` (opens a browser). After that this script is all it
# takes, and it can be run again for every new build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/unity-proto/build/webgl"
PROJECT="${1:-btc-logistics-war}"

# FROZEN. This project holds the last single-player version - Unity running
# PhysX, no deterministic core. The core-driven build goes to its own host via
# deploy-core.sh, so that this one stays where players can find it.
if [ "$PROJECT" = "btc-logistics-war" ] && [ "${ALLOW_OVERWRITE_SINGLEPLAYER:-0}" != "1" ]; then
  echo "btc-logistics-war is frozen as the last single-player version." >&2
  echo "Use ./deploy-core.sh for the core build, or set" >&2
  echo "ALLOW_OVERWRITE_SINGLEPLAYER=1 if you really mean to replace it." >&2
  exit 2
fi

[ -f "$BUILD/index.html" ] || { echo "no build at $BUILD - run BuildWebGL.Run first"; exit 1; }

# The build directory is gitignored, so anything Cloudflare needs that is not
# produced by Unity has to be copied in from a version-controlled copy - or a
# fresh clone deploys without content types and cache rules and nobody notices.
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
# --branch is pinned: wrangler otherwise takes it from git, and a deployment
# on any branch but the production one is published under a preview URL while
# the main address answers "Deployment Not Found".
wrangler pages deploy "$BUILD" --project-name "$PROJECT" --branch main --commit-dirty=true
