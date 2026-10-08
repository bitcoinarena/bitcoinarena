#!/bin/bash
# THE ENGINE AS A PUBLIC SOURCE TREE (kanban #208, option A of comment 889): writes <out> from <commit> - Bitcoin Arena's
# packages, the page template the engine serves, and the spec - with no git history, no Unity project (its Asset Store
# packs may not be published, and nextblock's Unity client stays private), no committed node_modules symlinks, no Unity
# licence file, and the operator's private names replaced. It PUBLISHES NOTHING: it only writes a directory, so the tree
# can be measured (npm install, its tests) before anyone decides to publish it.
#
#   bash tools/public-export.sh <commit> <out dir>
set -euo pipefail
C=${1:?the commit to export}; OUT=${2:?the directory to write}
ROOT=$(git rev-parse --show-toplevel)
[ -e "$OUT" ] && { echo "$OUT exists: an export is written into a new directory" >&2; exit 2; }
mkdir -p "$OUT"
# WHAT GOES OUT: the engine and nextblock's packages, the page around the game (template: HTML, JS, icons - none of it
# Asset Store), and the spec. Committed node_modules (symlinks to a private path) stay behind.
git -C "$ROOT" archive --format=tar "$C" packages unity-proto/Assets/WebGLTemplates/NextBlock unity-proto/Assets/Plugins/WebGL \
  multiplayer_p2p.md FEDERATION.md IMPLEMENTATION.md | tar -x -C "$OUT"
find "$OUT/packages" -maxdepth 2 -name node_modules -exec rm -rf {} +
find "$OUT" -name '*.meta' -delete
# THE OPERATOR'S PRIVATE NAMES, replaced by placeholders (every text file; binaries untouched)
grep -rIl -E 'example|/home/arena|/Users/arena|100\.(74\.66\.98|85\.86\.106)|[a-z]+-[a-z]+-[a-z]+(-[a-z]+)*\.trycloudflare\.com|a tester' "$OUT" \
  | while read -r f; do
    sed -i -E -e 's#test-host\.example\.ts\.net#node.example.ts.net#g' -e 's#example#example#g' \
      -e 's#/home/arena#/home/operator#g' -e 's#/Users/arena#/Users/operator#g' \
      -e 's#100\.74\.66\.98#100.64.0.10#g' -e 's#100\.85\.86\.106#100.64.0.20#g' \
      -e 's#[a-z]+-[a-z]+-[a-z]+(-[a-z]+)*\.trycloudflare\.com#example-tunnel.trycloudflare.com#g' -e 's#a tester#bitcoin-arena#g' "$f"
  done
# ONE INSTALL FOR EVERY PACKAGE: Node resolves a package's imports up to this root
cat > "$OUT/package.json" <<'EOF'
{
  "name": "bitcoin-arena",
  "private": true,
  "type": "module",
  "description": "Bitcoin Arena: an engine for games and prediction markets played for bitcoin, and its first game, nextblock",
  "engines": { "node": ">=24" },
  "dependencies": { "@noble/curves": "2.4.0", "ws": "8.21.3", "acorn": "8.18.0", "qrcode-generator": "^1.4.4" }
}
EOF
cat > "$OUT/README.md" <<'EOF'
# Bitcoin Arena

An engine for games and prediction markets played for bitcoin: custody in a Fedimint federation of bonded nodes, every
run replayed by independent nodes, payouts computed alike by every node. **Test networks only (testnet4, regtest);
mainnet is not live.**

| package | what it is |
|---|---|
| `packages/arena-protocol` | the protocol: contracts, manifests, census, payouts, fees, donations |
| `packages/arena-node` | the node: lists rounds, takes entries, replays runs, signs results and payouts, runs a guardian |
| `packages/arena-client` | the player's client in the page: lobby, join, wallet, the game picker |
| `packages/arena-donor` | the developer's client: donation key, collect and withdraw, the game developer key, signing a manifest |
| `packages/nextblock` | the first game's deterministic core and its plugin |
| `unity-proto/Assets/WebGLTemplates/NextBlock` | the page around the game; `platform/index.html` is the guide for developers and node operators |

```sh
npm install
cd packages/arena-protocol && node --test test/
```

Start with `unity-proto/Assets/WebGLTemplates/NextBlock/platform/index.html` (open it in a browser): why build here, who
earns what, a guide to programming and signing a game, and how to run a node. The full specification is
`multiplayer_p2p.md`.
EOF
echo "exported $C to $OUT: $(find "$OUT" -type f | wc -l) files, $(du -sh "$OUT" | cut -f1)"
