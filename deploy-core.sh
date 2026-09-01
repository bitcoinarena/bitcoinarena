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

echo "deploying $(du -sh "$BUILD" | cut -f1) to Cloudflare Pages project '$PROJECT'"
wrangler pages deploy "$BUILD" --project-name "$PROJECT" --branch main --commit-dirty=true
