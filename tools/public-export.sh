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
  test-vectors multiplayer_p2p.md FEDERATION.md IMPLEMENTATION.md | tar -x -C "$OUT"
find "$OUT/packages" -maxdepth 2 -name node_modules -exec rm -rf {} +
find "$OUT" -name '*.meta' -delete
# THE OPERATOR'S PRIVATE NAMES, replaced by placeholders (every text file; binaries untouched). The Funnel host
# (test-host.<tailnet>.ts.net) is NOT one: it is public - the live page names it (wallet/) - and it is encoded inside test
# invites, where no text replace can follow it. The GitHub owner (a tester) is public too: the repository lives there.
grep -rIl -E '/home/arena|/Users/arena|100\.(74\.66\.98|85\.86\.106)|[a-z]+-[a-z]+-[a-z]+(-[a-z]+)*\.trycloudflare\.com' "$OUT" \
  | while read -r f; do
    sed -i -E -e 's#/home/arena#/home/operator#g' -e 's#/Users/arena#/Users/operator#g' \
      -e 's#100\.74\.66\.98#100.64.0.10#g' -e 's#100\.85\.86\.106#100.64.0.20#g' \
      -e 's#[a-z]+-[a-z]+-[a-z]+(-[a-z]+)*\.trycloudflare\.com#example-tunnel.trycloudflare.com#g' "$f"
  done
# NEXTBLOCK'S UNITY CLIENT STAYS PRIVATE, so the tests that read it (its C# scripts, models, fixtures, a built player)
# cannot run here: they are left out, and named in TESTS-LEFT-OUT.txt
grep -lE 'unity-proto/(Assets/(Scripts|Models|Tests)|build/)' "$OUT"/packages/*/test/*.js 2>/dev/null | sort > "$OUT/.left" || true
{ echo "Tests of nextblock's Unity client, which is not in this tree:"; sed "s#^$OUT/##" "$OUT/.left"; } > "$OUT/TESTS-LEFT-OUT.txt"
xargs -r rm -f < "$OUT/.left"; rm -f "$OUT/.left"
# ONE INSTALL FOR EVERY PACKAGE: npm installs at this root, and each package reaches it through a RELATIVE node_modules
# link - the layout the source tree has (some files import a dependency by its path under node_modules)
for p in "$OUT"/packages/*/; do ln -s ../../node_modules "$p/node_modules"; done
cat > "$OUT/package.json" <<'EOF'
{
  "name": "bitcoin-arena",
  "private": true,
  "license": "MIT",
  "repository": "github:a tester/bitcoin-arena",
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

MIT licence: see `LICENSE`.
EOF
# THE LICENCE (the owner 2026-10-08, kanban #208: a tester/bitcoin-arena, MIT)
cat > "$OUT/LICENSE" <<'LICENSE_END'
MIT License

Copyright (c) 2026 the Bitcoin Arena authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
LICENSE_END
echo "exported $C to $OUT: $(find "$OUT" -type f | wc -l) files, $(du -sh "$OUT" | cut -f1)"
