#!/usr/bin/env bash
# Publish the Unity build to Cloudflare Pages.
#
# One-off: `wrangler login` (opens a browser). After that this script is all it
# takes, and it can be run again for every new build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/unity-proto/build/webgl"
PROJECT="${1:-btc-logistics-war}"

[ -f "$BUILD/index.html" ] || { echo "no build at $BUILD - run BuildWebGL.Run first"; exit 1; }

# The build directory is gitignored, so anything Cloudflare needs that is not
# produced by Unity has to be copied in from a version-controlled copy - or a
# fresh clone deploys without content types and cache rules and nobody notices.
cp "$ROOT/deploy/_headers" "$BUILD/_headers"

echo "deploying $(du -sh "$BUILD" | cut -f1) to Cloudflare Pages project '$PROJECT'"
# --branch is pinned: wrangler otherwise takes it from git, and a deployment
# on any branch but the production one is published under a preview URL while
# the main address answers "Deployment Not Found".
wrangler pages deploy "$BUILD" --project-name "$PROJECT" --branch main --commit-dirty=true
