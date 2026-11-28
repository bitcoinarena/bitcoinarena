#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# ONE RELEASE ASSET OF THE ARENA NODE: the seat, its protocol and the installer from a commit (the apps only as pins), their
# npm dependencies at pinned versions, a pinned Node runtime and cloudflared for the OS - each download checked against its published
# SHA-256 - and the launcher (`bitcoinarena-install`, `bitcoinarena-install.cmd` on Windows; `arena-install` beside it). Run by CI for every tag (release.yml), the same way
# each time.
#
#     tools/release/build-release.sh <version> <linux|darwin|windows> <x64|arm64> <out dir> [commit]
#
# Writes <out>/bitcoin-arena-node-<version>-<os>-<arch>.tar.gz (.zip on Windows) and appends its line to <out>/SHA256SUMS.
# THE NAME (kanban #635, 2026-10-25: "Es muss bitcoin-arena-node heissen"): ARENA_RELEASE_PREFIX=arena-node builds the
# files under the name releases before 2026.1.8 had, for the update channel a node before 2026.1.8 reads (auto-update.js).
set -euo pipefail
VER="$1"; OS="$2"; ARCH="$3"; OUT="$(mkdir -p "$4" && cd "$4" && pwd)"; REF="${5:-HEAD}"
NODE_VER=24.22.3   # kanban #1482: the 2026-11-10 security release (llhttp, undici, sqlite; the owner 2026-11-11); hashes from nodejs.org SHASUMS256.txt, its signature checked (release key 5BE8A3F6...B168D356, Antoine du Hamel). Before: 24.22.1 (#574)
CF_VER=2026.9.1
# the runtimes, by os-arch: Node's file and SHA-256 (nodejs.org SHASUMS256.txt), cloudflared's (its release notes)
declare -A NODE_FILE=([linux-x64]=node-v$NODE_VER-linux-x64.tar.xz [linux-arm64]=node-v$NODE_VER-linux-arm64.tar.xz
  [darwin-x64]=node-v$NODE_VER-darwin-x64.tar.gz [darwin-arm64]=node-v$NODE_VER-darwin-arm64.tar.gz [windows-x64]=node-v$NODE_VER-win-x64.zip)
declare -A NODE_SHA=([linux-x64]=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb [linux-arm64]=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c
  [darwin-x64]=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 [darwin-arm64]=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
  [windows-x64]=e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f)
declare -A CF_FILE=([linux-x64]=cloudflared-linux-amd64 [linux-arm64]=cloudflared-linux-arm64 [darwin-x64]=cloudflared-darwin-amd64.tgz
  [darwin-arm64]=cloudflared-darwin-arm64.tgz [windows-x64]=cloudflared-windows-amd64.exe)
declare -A CF_SHA=([linux-x64]=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc [linux-arm64]=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3
  [darwin-x64]=ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4 [darwin-arm64]=c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe
  [windows-x64]=2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712)
# a darwin .tgz: GitHub's digest of the archive above; the release notes name the binary inside it, checked once unpacked
declare -A CF_BIN_SHA=([darwin-x64]=1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75 [darwin-arm64]=9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e)
KEY="$OS-$ARCH"
[[ -n "${NODE_SHA[$KEY]:-}" ]] || { echo "no runtime for $KEY (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64)" >&2; exit 2; }
# releases are 2026.xx.yy, a fix 2026.xx.yy.zz (2026-10-19); the older x.y.z(-rc.N) still builds
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?(-[a-z0-9.]+)?$ ]] || { echo "version is like 2026.1.0 (a fix: 2026.1.0.1)" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel)"
NAME="${ARENA_RELEASE_PREFIX:-bitcoin-arena-node}-$VER-$OS-$ARCH"
STAGE="$OUT/$NAME"
[ -e "$STAGE" ] && { echo "$STAGE exists: a release is built once" >&2; exit 1; }
mkdir -p "$STAGE/runtime"
CACHE="${ARENA_RELEASE_CACHE:-$OUT/.downloads}"; mkdir -p "$CACHE"
fetch() { # url sha file [fallback url]
  [ -f "$CACHE/$3" ] && echo "$2  $CACHE/$3" | sha256sum -c --status && return 0
  # A PINNED FILE ITS FIRST HOST NO LONGER SERVES (kanban #1345, measured 2026-11-08: dist.torproject.org keeps only current Tor versions,
  # so 2026.1.9.26 could not be built again from its own commit): the archive URL, the same bytes by the same pinned checksum
  curl -fsSL --retry 3 -o "$CACHE/$3.part" "$1" || { [ -n "${4:-}" ] && curl -fsSL --retry 3 -o "$CACHE/$3.part" "$4"; } || { echo "$3: not served at $1${4:+ nor $4}" >&2; exit 1; }
  echo "$2  $CACHE/$3.part" | sha256sum -c --status || { echo "$3: checksum mismatch" >&2; rm -f "$CACHE/$3.part"; exit 1; }
  mv "$CACHE/$3.part" "$CACHE/$3"
}

# 1. the code, from the commit (git archive: tracked files only, nothing of a working tree)
# (all of packages/arena-web/dist: every page script the node serves, packed by esbuild - its pages draw only with React, kanban #564;
# arena-web/test/dist-fresh checks each is the build of its source, arena-installer/test/release-bundles that each is tracked)
# THE APPS ARE NOT IN IT (kanban #575, 2026-10-21: "the installer downloads the 3 apps automatically, no longer built in"): only
# their pins - apps.lock.json (repository, commit) and apps.files.json (each file's SHA-256) - from which the installer, an update and the
# seat's start fetch and check them (arena-node/src/app-fetch.js) into packages/<app>. arena-sdk stays, which their registrations import
# as arena-sdk/<name> through the tracked link packages/node_modules/arena-sdk (arena-installer/test/release-bundles checks this line)
# (arena-attestor's src: the seat's drawn attestor imports it, kanban #630 - 2026.1.8 shipped without it and its node never started;
# release-bundles checks that every relative import of an archived module lands inside the archive)
git -C "$ROOT" archive "$REF" LICENSE apps.lock.json apps.files.json packages/arena-installer packages/arena-node packages/arena-protocol packages/arena-client/src packages/arena-web/dist \
  packages/arena-sdk packages/node_modules/arena-sdk packages/arena-donor/src/manifest-sign.js packages/arena-attestor/package.json packages/arena-attestor/src \
  | tar -x -C "$STAGE"
# THE TWO PIN FILES READ AS A NODE READS THEM (kanban #806: v2026.1.9.18 shipped Next Block at 2d75dadb in apps.lock.json and at 5c19be53 in
# apps.files.json, and every fresh install stopped at "the release's app pins do not read"): no release is built from pins that disagree
PIN_MOD="$STAGE/packages/arena-node/src/app-fetch.js" PIN_AT="$STAGE" node --input-type=module \
  -e "const { appPins } = await import(process.env.PIN_MOD); appPins(process.env.PIN_AT);" \
  || { echo "apps.lock.json and apps.files.json disagree: run node tools/fetch-apps.mjs && node tools/pin-apps.mjs" >&2; exit 1; }
for p in arena-node arena-protocol arena-installer arena-sdk; do
  rm -rf "$STAGE/packages/$p/test"
  [ -L "$STAGE/packages/$p/node_modules" ] && rm "$STAGE/packages/$p/node_modules"
done
ln -s ../arena-node/node_modules "$STAGE/packages/arena-installer/node_modules"
# (Windows: the link is replaced by a copy once the dependencies are in (step 3) - a .zip carries no symlink, Expand-Archive made an
# empty folder of it and the installer stopped at "Cannot find package '@noble/curves'": measured in the Windows VM, rc.10)
git -C "$ROOT" rev-parse "$REF" > "$STAGE/COMMIT"
echo "$VER" > "$STAGE/VERSION"

# 2. the runtime, checked
NF="${NODE_FILE[$KEY]}"; CF="${CF_FILE[$KEY]}"
fetch "https://nodejs.org/dist/v$NODE_VER/$NF" "${NODE_SHA[$KEY]}" "$NF" "https://nodejs.org/download/release/v$NODE_VER/$NF"
fetch "https://github.com/cloudflare/cloudflared/releases/download/$CF_VER/$CF" "${CF_SHA[$KEY]}" "$CF_VER-$CF"
case "$OS" in
  linux)
    tar -xJf "$CACHE/$NF" -C "$STAGE/runtime" --strip-components=2 "${NF%.tar.xz}/bin/node"
    install -m 0755 "$CACHE/$CF_VER-$CF" "$STAGE/runtime/cloudflared" ;;
  darwin)
    tar -xzf "$CACHE/$NF" -C "$STAGE/runtime" --strip-components=2 "${NF%.tar.gz}/bin/node"
    tar -xzf "$CACHE/$CF_VER-$CF" -C "$STAGE/runtime" cloudflared && chmod 0755 "$STAGE/runtime/cloudflared"
    echo "${CF_BIN_SHA[$KEY]}  $STAGE/runtime/cloudflared" | sha256sum -c --status || { echo "cloudflared inside $CF: checksum mismatch" >&2; exit 1; } ;;
  windows)
    unzip -q -j "$CACHE/$NF" "${NF%.zip}/node.exe" -d "$STAGE/runtime"
    install -m 0755 "$CACHE/$CF_VER-$CF" "$STAGE/runtime/cloudflared.exe" ;;
esac

# 2b. TOR (2026-10-18: "find a way to connect to it via a tunnel" / "connect via tor to the other nodes as well"):
# the Tor Project's expert bundle, pinned by the SHA-256 of its sha256sums-signed-build.txt, unpacked to runtime/tor/ (tor and its
# libraries). The node's LND runs hybrid through it: a permanent onion address with no open port. The Tor Project builds no linux-arm64
# bundle: there the installer uses the system's tor (apt install tor) when it is installed.
TOR_VER=15.0.25
declare -A TOR_FILE=([linux-x64]=tor-expert-bundle-linux-x86_64-$TOR_VER.tar.gz [darwin-arm64]=tor-expert-bundle-macos-aarch64-$TOR_VER.tar.gz
  [darwin-x64]=tor-expert-bundle-macos-x86_64-$TOR_VER.tar.gz [windows-x64]=tor-expert-bundle-windows-x86_64-$TOR_VER.tar.gz)
declare -A TOR_SHA=([linux-x64]=19cf18726eecb362e0f21d27afa9ea9efe5da928bfdfbb1ceb5fe54519e87f4a [darwin-arm64]=a3febb6179152b0b4f56a0f5cc57bf5cc8ecef7db35e7c3e9d5a044c8158c26c
  [darwin-x64]=e1ae4d4a734d28bb590839188511deb3cebc26fcbce9df66d01b2c452060fe95 [windows-x64]=c1988c701de2f24f7d098d1d6d7f507b58f27740d097f29c246e0524d639b252)
TF="${TOR_FILE[$KEY]:-}"
if [ -n "$TF" ]; then
  fetch "https://dist.torproject.org/torbrowser/$TOR_VER/$TF" "${TOR_SHA[$KEY]}" "$TF" "https://archive.torproject.org/tor-package-archive/torbrowser/$TOR_VER/$TF"
  tar -xzf "$CACHE/$TF" -C "$STAGE/runtime" tor
  if [ "$OS" = windows ]; then ls "$STAGE/runtime/tor/tor.exe" > /dev/null; else ls "$STAGE/runtime/tor/tor" > /dev/null; fi
fi

# 3. the npm dependencies, pinned (pure JavaScript: the same files for every architecture)
( cd "$STAGE/packages/arena-node" && npm install --omit=dev --no-audit --no-fund --no-package-lock --ignore-scripts \
    @noble/curves@2.4.0 @noble/hashes@2.4.0 ws@8.21.3 bcryptjs@3.0.3 >/dev/null )   # bcryptjs: the gateway's admin password hash (gateway.js)

# 3b. THE CUSTODY BINARIES: gatewayd, fedimintd, fedimint-cli, fedimint-dbtool and arena-stake-lock (kanban #824: every node reads the locks of a round it signs) of the
# patched fork, built on the test host by tools/release/custody-build.sh (stripped; Linux against glibc 2.31), pinned here by SHA-256 and fetched from this repo's
# release $CUSTODY_TAG (ARENA_CUSTODY_DIR: a local copy instead). A system without a pinned binary gets a release without custody - the wizard says so
# (gateway.js findGatewayd).
# THE 2.0 LINE'S CUSTODY (kanban #3897, the 2026.2.0 blocker found by the #3896 devnet run): the fork d7d91d1e0b9 = 5fa01c5d7e6 (v0.12.2 + BLWP, kanban #584)
# + the Arena lock 1ca203a9f96 (kanban #1044 B1, LNv2 module consensus version 1.100) + its fallback claim (#1281) - the commit the 2.0 page's wasm lock client
# is built from (build-wasm.sh, bd2b5e7b1). A round of protocol 27+ at or above its network's NAMED_CLAIM_HEIGHT (regtest, devnet and mainnet from 0) locks to
# an Arena lock, and a seat opens none in a federation whose guardians do not run it (named-claim-gate.js); 1.9's fedimintd (5fa01c5d) did not. And
# arena-stake-lock is the 2.0 tool (packages/arena-node/tools/stake-lock, --features arena-lock): 1.9's lacked session-audit, session-export,
# session-proof-verify, theft-verify and arena-claim-read, which 2.0's reserve audit, port and theft proofs call.
# AND THE LIQUIDATION PATCH (kanban #3910): d7d91d1e lacked packages/arena-node/tools/fedimint-spent-nonces.patch, so no guardian could publish a spent set
# (blwp_spent_nonces) and no arbiter validate a claim (`module mintv2 validate`, check-pending). Now the fork 6aae042d92a (branch blwp/arena-lock-3910) =
# d7d91d1e0b9 + that patch; tools/release/custody-check.sh holds every release to it.
# Built 2026-11-28: FORK_HASH=6aae042d92aae94c32f9154dc0dc1329b0360227 STAKE_LOCK_FEATURES=arena-lock tools/release/custody-build.sh on the MacBook (zig 0.16.0).
CUSTODY_TAG=custody-6aae042d
# the pinned binaries, "<bin>:<os>-<arch>" -> SHA-256 (out/SHA256SUMS.custody of tools/release/custody-build.sh)
declare -A CUSTODY_SHA=(
  [gatewayd:darwin-arm64]=b99642100d379388b13fffd83064b3c2404904bb0a49c4e81ca013760dd22a27
  [gatewayd:darwin-x64]=9eb3b0366d95e2fbf6b21d9b94f890d7ff402b7c8dfae15d9a0127fcddff1dc7
  [gatewayd:linux-arm64]=c7681c8591299e8fa7d81306a0e3204b0fec9e05cd4e56526196272c4ffe93d2
  [gatewayd:linux-x64]=ddc21123be782c246087da6220bb17500597f55d50e35d78163d3a8c79bd565a
  [gatewayd:windows-x64]=0c43b1c6fc9a35ca43dcfb98ec7e384d2fcc378829c4bcd478d41e23816b91f3
  [fedimintd:darwin-arm64]=f3bbb4b2a54820ce417d41628d8a079a882efad75f29aaac161ee5bffd7f9351
  [fedimintd:darwin-x64]=801133ee945a02f80284b6bef72cb47367c2c1d7faeaf0d07fe3ab5a62721088
  [fedimintd:linux-arm64]=2cc66d2bcd4db398b557a63e1c851cde66ae2c008eb7c3c20ad160b2e60b5028
  [fedimintd:linux-x64]=da7dd580baa1f8531e88b8644eb1a97b49237290afdcbae761fefd7121144d69
  [fedimintd:windows-x64]=8ba79d6f90c53053813e36ff6736120fa07c1cbc4142ea3bd53cd8d6a9a77d8f
  [fedimint-cli:darwin-arm64]=aa8a229957d74e7adc486cbb334e993b17e1ea2c954730c36e4e90b43d635e37
  [fedimint-cli:darwin-x64]=1410c62abf5d0a0a52f20469b38bfd19144d7e7b6a26a473669c0cd869c16fe8
  [fedimint-cli:linux-arm64]=27feb1caf3a53cc0d0eb0d35baf41d68b7757933805a114c3d39445016b44db2
  [fedimint-cli:linux-x64]=820e0d83dd666ad630d42625b92a4da1d733364b2dc6026e1031ffb7b5373b80
  [fedimint-cli:windows-x64]=d9e6646b16f0a267f214cdffdd08a3bdfa094be381e9ad75a98be21e2c4bfaad
  [fedimint-dbtool:darwin-arm64]=447b9ef5feebaa6bad2358063036399f6ef75283d84efad681ac3746ba5e5af1
  [fedimint-dbtool:darwin-x64]=e969fa8a50fdf7559bec319f9e5ffcd04db7e04242c9b3d4e57be2b3d8f8b4d4
  [fedimint-dbtool:linux-arm64]=98309e638aea32ec0a29e05f842eee15ea7fcff0688a788bea6b66788aef7990
  [fedimint-dbtool:linux-x64]=8d35442c6bfe1825105ee9a601785fba9dcd604de9ea8dfd1b2ec4018927b643
  [fedimint-dbtool:windows-x64]=cf55948edda6817acc7f997acf3e68f0e090afcb6ff176b8aa6319d49a83b1f9
  [arena-stake-lock:darwin-arm64]=2bd47cf34ad8a15b73ea34d08060d86e260b47bded4a033c1d81cdfc004fd584
  [arena-stake-lock:darwin-x64]=45e60d105aec69b6aa6817273683035c9472f6edd6e5512d061bebec48482dc1
  [arena-stake-lock:linux-arm64]=a2ee72594ffb5a620163a734aa97b80838ef1dd6512b5ab2d0d4528b6081cf87
  [arena-stake-lock:linux-x64]=0fc6db1034f7523bb21d3bfa524f3ecc3e56beebc5641c7c12d1ff4746303076
  [arena-stake-lock:windows-x64]=6458d6362d7c932aaf8801cf0777481139038f9286e499f978130b2d9c52dfef
)
EXE=""; if [ "$OS" = windows ]; then EXE=.exe; fi   # (an assignment from a failing $(...) ends a set -e script: CI run 39128370301)
# fedimint-dbtool (kanban #718): taken once pinned here (custody-build.sh builds it); a release without it starts a restored RAM guardian unchecked
for BIN in gatewayd fedimintd fedimint-cli fedimint-dbtool arena-stake-lock; do
  PIN="${CUSTODY_SHA[$BIN:$KEY]:-}"
  [ -n "$PIN" ] || continue
  F="$BIN-$KEY$EXE"
  if [ ! -f "$CACHE/$F" ] || ! echo "$PIN  $CACHE/$F" | sha256sum -c --status; then
    if [ -n "${ARENA_CUSTODY_DIR:-}" ]; then cp "$ARENA_CUSTODY_DIR/$F" "$CACHE/$F.part"
    else gh release download "$CUSTODY_TAG" --repo bitcoinarena/bitcoinarena -p "$F" -O "$CACHE/$F.part" --clobber; fi
    echo "$PIN  $CACHE/$F.part" | sha256sum -c --status || { echo "$F: checksum mismatch" >&2; rm -f "$CACHE/$F.part"; exit 1; }
    mv "$CACHE/$F.part" "$CACHE/$F"
  fi
  mkdir -p "$STAGE/runtime/custody"
  install -m 0755 "$CACHE/$F" "$STAGE/runtime/custody/$BIN$EXE"
done
# and the custody carries the liquidation patch (kanban #3910: custody-d7d91d1e did not - no spent set, no claim validated): a release without it stops here
if [ -f "$STAGE/runtime/custody/fedimintd$EXE" ]; then
  bash "$ROOT/tools/release/custody-check.sh" "$STAGE/runtime/custody/fedimintd$EXE" "$STAGE/runtime/custody/fedimint-cli$EXE" || exit 1
fi

if [ "$OS" = windows ]; then rm "$STAGE/packages/arena-installer/node_modules"; cp -R "$STAGE/packages/arena-node/node_modules" "$STAGE/packages/arena-installer/node_modules"; fi
# (and the apps' arena-sdk, a link the .zip would lose too: a copy of the folder - kanban #569)
# one folder deeper than the link it replaces, so its ../../arena-node and ../../arena-protocol go one more up (kanban #808, measured 2026-10-31 in the Windows VM: "Cannot find module packages/node_modules/arena-node/src/core-hash.js", the seat never started)
if [ "$OS" = windows ]; then rm "$STAGE/packages/node_modules/arena-sdk"; cp -R "$STAGE/packages/arena-sdk" "$STAGE/packages/node_modules/arena-sdk"
  find "$STAGE/packages/node_modules/arena-sdk" -name '*.js' -print0 | xargs -0 perl -pi -e "s#(['\"])\.\./\.\./arena-([a-z]+)/#\$1../../../arena-\$2/#g"; fi

# 4. the launcher: the installer on the release's own runtime, cloudflared beside it - named bitcoinarena-install (kanban #721, 2026-10-27:
# "the install script is still named arena-install, should be bitcoinarena-install"); arena-install stays beside it, the same launcher under
# the name the docs and scripts of earlier releases give
if [ "$OS" = windows ]; then
  printf '%s\r\n' '@echo off' 'rem The Bitcoin Arena node installer: double-click, then open the link it prints. --tunnel on a remote machine.' \
    'set "ARENA_CLOUDFLARED=%~dp0runtime\cloudflared.exe"' '"%~dp0runtime\node.exe" "%~dp0packages\arena-installer\bin\arena-install.mjs" %*' 'pause' > "$STAGE/bitcoinarena-install.cmd"
  cp "$STAGE/bitcoinarena-install.cmd" "$STAGE/arena-install.cmd"
else
  cat > "$STAGE/bitcoinarena-install" <<'SH'
#!/bin/sh
# The Bitcoin Arena node installer: ./bitcoinarena-install, then open the link it prints. --tunnel on a remote machine.
here="$(cd "$(dirname "$0")" && pwd)"
ARENA_CLOUDFLARED="$here/runtime/cloudflared" exec "$here/runtime/node" "$here/packages/arena-installer/bin/arena-install.mjs" "$@"
SH
  chmod 0755 "$STAGE/bitcoinarena-install"
  cp "$STAGE/bitcoinarena-install" "$STAGE/arena-install"
  # macOS: a double-clickable copy (Terminal opens it)
  [ "$OS" = darwin ] && cp "$STAGE/bitcoinarena-install" "$STAGE/bitcoinarena-install.command" && cp "$STAGE/bitcoinarena-install" "$STAGE/arena-install.command"
fi

# 5. the asset and its checksum (tar with fixed owner and order, so the same commit gives the same bytes)
MTIME="$(git -C "$ROOT" log -1 --format=%ct "$REF")"
if [ "$OS" = windows ]; then
  # zip with fixed times and order (-X: no extra attributes), so a commit gives the same bytes
  find "$STAGE" -exec touch -h -d "@$MTIME" {} +
  ( cd "$OUT" && find "$NAME" -print | LC_ALL=C sort | zip -q -X -@ "$NAME.zip" )
  ASSET="$NAME.zip"
else
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$MTIME" -C "$OUT" -cf - "$NAME" | gzip -n -9 > "$OUT/$NAME.tar.gz"
  ASSET="$NAME.tar.gz"
fi
( cd "$OUT" && sha256sum "$ASSET" >> SHA256SUMS )
echo "$OUT/$ASSET $(du -h "$OUT/$ASSET" | cut -f1)"
