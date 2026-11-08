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
NODE_VER=24.22.1   # kanban #574: the 2026-10-21 security release (Brotli RCE, TLS hostname bypasses); hashes from nodejs.org SHASUMS256.txt
CF_VER=2026.9.1
# the runtimes, by os-arch: Node's file and SHA-256 (nodejs.org SHASUMS256.txt), cloudflared's (its release notes)
declare -A NODE_FILE=([linux-x64]=node-v$NODE_VER-linux-x64.tar.xz [linux-arm64]=node-v$NODE_VER-linux-arm64.tar.xz
  [darwin-x64]=node-v$NODE_VER-darwin-x64.tar.gz [darwin-arm64]=node-v$NODE_VER-darwin-arm64.tar.gz [windows-x64]=node-v$NODE_VER-win-x64.zip)
declare -A NODE_SHA=([linux-x64]=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 [linux-arm64]=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e
  [darwin-x64]=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035 [darwin-arm64]=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7
  [windows-x64]=d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5)
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

# 3b. THE CUSTODY BINARIES: gatewayd, fedimintd, fedimint-cli and arena-stake-lock (kanban #824: every node reads the locks of a round it signs) of the patched fork (5fa01c5d7e6: v0.12.2 + BLWP), built on the test host by
# tools/release/custody-build.sh (stripped; Linux against glibc 2.31), pinned here by SHA-256 and fetched from this repo's release
# custody-76012ad9 (ARENA_CUSTODY_DIR: a local copy instead). A system without a pinned binary gets a release without custody - the
# wizard says so (gateway.js findGatewayd).
CUSTODY_TAG=custody-5fa01c5d   # kanban #584 (2026-10-22, urgent): fork 5fa01c5d7e6 = upstream v0.12.2 (the LNv2 gateway fund-loss fixes) + the BLWP commits of 7e8caa9fd3a
# the pinned binaries, "<bin>:<os>-<arch>" -> SHA-256 (out/SHA256SUMS.custody of tools/release/custody-build.sh)
declare -A CUSTODY_SHA=(
  [gatewayd:windows-x64]=ee4a435f13fdc62c65a39625b0ab7f563a0b3eeffcd790e0b25076631e57a6bb
  [fedimintd:windows-x64]=78297d65677112f060cad06f24d5519cc6ff24aabd76f243314dee663992ca01
  [fedimint-cli:windows-x64]=40672f9f4940ff05f87384bf973975c65a4e58badfa9ff32a2f2bd85966dadf0
  [gatewayd:darwin-arm64]=e7bf5c7abeba4e594258b9c172289981cde006d7dfbfabc4e216866378650915
  [gatewayd:darwin-x64]=d0c3db84eff8cc5225ad15978c2640f2ac2f268a8686f265d7ece052a5271a8e
  [gatewayd:linux-arm64]=edfdcc2ac125088d223f6f1b6f4b9c5c5ee54768a2a128e02476bb313f7c886d
  [gatewayd:linux-x64]=7448fb5e43f010eb207397ad42eb7d23f8d7e08f50d1786c39b232a7f89bf40d
  [fedimintd:darwin-arm64]=701f15908dd2bc9c0d6ea0de5b4a98aa94c689d1d0d7c4adac152ecef3670b4f
  [fedimintd:darwin-x64]=1a7299bef2de53057eaef93709f57545cfc71fc07029eb5a98c5a754d1e2234f
  [fedimintd:linux-arm64]=304ad329690b73484b1228fb33f574a5c272f9aacd48e293ec09995ebaa61f8c
  [fedimintd:linux-x64]=cbfb9ecad56b271ac4501c154aa1ee7a51eebdcbe23d4e66b118fb4c5b5c1283
  [fedimint-cli:darwin-arm64]=a5a6d1f8f2c7acde00b52be2e7af3f8997279d7d6877012aa3198b4b621ffae9
  [fedimint-cli:darwin-x64]=9d590a30e3e62a75c8289cef33b800ed6372fac65b23391b8017f2cc200a8bc1
  [fedimint-cli:linux-arm64]=bd6a3f3c1ec1ea2d730726c03f36ebfc75b3767d5f780ebcdf03ad1c62a7488e
  [fedimint-cli:linux-x64]=1eb63589f6753fc2da3c1e2c6c5ead2b6aeb88b5b319784ad81a0a80e1bf8a75
  [arena-stake-lock:windows-x64]=3e48d66650f22071a7f8a278292dd192822e392cb88b47aa22d8ccff2116b930
  [arena-stake-lock:darwin-arm64]=5c2098f857017a305aa91fed2ffa009b9e39011641b799527062ebcf56d9b434
  [arena-stake-lock:darwin-x64]=ed3d2aa607d8a4641b097f9efc1564d218812e90f40e645ed21341de983500bd
  [arena-stake-lock:linux-arm64]=1333150d73297a1551736d3be20b6e6254737305e44e793e06821bfc6a91fc69
  [arena-stake-lock:linux-x64]=580cff5c09b9077e43e87357da144913dbd4307957166f142ed18f91850fee16
)
EXE=""; if [ "$OS" = windows ]; then EXE=.exe; fi   # (an assignment from a failing $(...) ends a set -e script: CI run 39128370301)
for BIN in gatewayd fedimintd fedimint-cli arena-stake-lock; do
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
