#!/bin/bash
# ONE RELEASE ASSET OF THE ARENA NODE (kanban #471 part A): the seat, its protocol, the installer and nextblock from a commit, their
# npm dependencies at pinned versions, a pinned Node runtime and cloudflared for the OS - each download checked against its published
# SHA-256 - and the launcher (`arena-install`, `arena-install.cmd` on Windows). Run by CI for every tag (release.yml), the same way
# each time.
#
#     tools/release/build-release.sh <version> <linux|darwin|windows> <x64|arm64> <out dir> [commit]
#
# Writes <out>/arena-node-<version>-<os>-<arch>.tar.gz (.zip on Windows) and appends its line to <out>/SHA256SUMS.
set -euo pipefail
VER="$1"; OS="$2"; ARCH="$3"; OUT="$(mkdir -p "$4" && cd "$4" && pwd)"; REF="${5:-HEAD}"
NODE_VER=24.15.0
CF_VER=2026.9.1
# the runtimes, by os-arch: Node's file and SHA-256 (nodejs.org SHASUMS256.txt), cloudflared's (its release notes)
declare -A NODE_FILE=([linux-x64]=node-v$NODE_VER-linux-x64.tar.xz [linux-arm64]=node-v$NODE_VER-linux-arm64.tar.xz
  [darwin-x64]=node-v$NODE_VER-darwin-x64.tar.gz [darwin-arm64]=node-v$NODE_VER-darwin-arm64.tar.gz [windows-x64]=node-v$NODE_VER-win-x64.zip)
declare -A NODE_SHA=([linux-x64]=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6 [linux-arm64]=f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0
  [darwin-x64]=ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b [darwin-arm64]=372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4
  [windows-x64]=cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62)
declare -A CF_FILE=([linux-x64]=cloudflared-linux-amd64 [linux-arm64]=cloudflared-linux-arm64 [darwin-x64]=cloudflared-darwin-amd64.tgz
  [darwin-arm64]=cloudflared-darwin-arm64.tgz [windows-x64]=cloudflared-windows-amd64.exe)
declare -A CF_SHA=([linux-x64]=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc [linux-arm64]=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3
  [darwin-x64]=ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4 [darwin-arm64]=c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe
  [windows-x64]=2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712)
# a darwin .tgz: GitHub's digest of the archive above; the release notes name the binary inside it, checked once unpacked
declare -A CF_BIN_SHA=([darwin-x64]=1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75 [darwin-arm64]=9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e)
KEY="$OS-$ARCH"
[[ -n "${NODE_SHA[$KEY]:-}" ]] || { echo "no runtime for $KEY (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64)" >&2; exit 2; }
# releases are 2026.xx.yy, a fix 2026.xx.yy.zz (the owner 2026-10-19); the older x.y.z(-rc.N) still builds
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?(-[a-z0-9.]+)?$ ]] || { echo "version is like 2026.1.0 (a fix: 2026.1.0.1)" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel)"
NAME="arena-node-$VER-$OS-$ARCH"
STAGE="$OUT/$NAME"
[ -e "$STAGE" ] && { echo "$STAGE exists: a release is built once" >&2; exit 1; }
mkdir -p "$STAGE/runtime"
CACHE="${ARENA_RELEASE_CACHE:-$OUT/.downloads}"; mkdir -p "$CACHE"
fetch() { # url sha file
  [ -f "$CACHE/$3" ] && echo "$2  $CACHE/$3" | sha256sum -c --status && return 0
  curl -fsSL --retry 3 -o "$CACHE/$3.part" "$1"
  echo "$2  $CACHE/$3.part" | sha256sum -c --status || { echo "$3: checksum mismatch" >&2; rm -f "$CACHE/$3.part"; exit 1; }
  mv "$CACHE/$3.part" "$CACHE/$3"
}

# 1. the code, from the commit (git archive: tracked files only, nothing of a working tree)
git -C "$ROOT" archive "$REF" packages/arena-node packages/arena-protocol packages/arena-client/src packages/arena-installer packages/nextblock \
  | tar -x -C "$STAGE"
for p in arena-node arena-protocol arena-installer nextblock; do
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
fetch "https://nodejs.org/dist/v$NODE_VER/$NF" "${NODE_SHA[$KEY]}" "$NF"
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

# 2b. TOR (kanban #471, the owner 2026-10-18: "find a way to connect to it via a tunnel" / "connect via tor to the other nodes as well"):
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
  fetch "https://dist.torproject.org/torbrowser/$TOR_VER/$TF" "${TOR_SHA[$KEY]}" "$TF"
  tar -xzf "$CACHE/$TF" -C "$STAGE/runtime" tor
  if [ "$OS" = windows ]; then ls "$STAGE/runtime/tor/tor.exe" > /dev/null; else ls "$STAGE/runtime/tor/tor" > /dev/null; fi
fi

# 3. the npm dependencies, pinned (pure JavaScript: the same files for every architecture)
( cd "$STAGE/packages/arena-node" && npm install --omit=dev --no-audit --no-fund --no-package-lock --ignore-scripts \
    @noble/curves@2.4.0 @noble/hashes@2.4.0 ws@8.21.3 bcryptjs@3.0.3 >/dev/null )   # bcryptjs: the gateway's admin password hash (gateway.js)

# 3b. THE CUSTODY BINARIES (kanban #471 slice 5): gatewayd, fedimintd and fedimint-cli of the patched fork 76012ad9119, built on the test host by
# tools/release/custody-build.sh (stripped; Linux against glibc 2.31), pinned here by SHA-256 and fetched from this repo's release
# custody-76012ad9 (ARENA_CUSTODY_DIR: a local copy instead). A system without a pinned binary gets a release without custody - the
# wizard says so (gateway.js findGatewayd).
CUSTODY_TAG=custody-76012ad9
# the pinned binaries, "<bin>:<os>-<arch>" -> SHA-256 (out/SHA256SUMS.custody of tools/release/custody-build.sh)
declare -A CUSTODY_SHA=(
  [gatewayd:windows-x64]=6864274731883823e520e3472ceccdfbdd7e46cb5578ec2da541fc0da0ddf75b
  [fedimintd:windows-x64]=7e82772ddb18c27948c9f2acf2f6723452c76c0f1aa014ec2c8b4cb715736faf
  [fedimint-cli:windows-x64]=55ff1133c2aa8d80873234c1b7310d22403b7d590be1376b0b8181d24c7dbbb0
  [gatewayd:darwin-arm64]=28d146a553f7fe0a23b30732aac5d2dab2a7f8eafb0c5d4af0437e3f064912ee
  [gatewayd:darwin-x64]=59c2807c4843e8421b1adf192ac69b114008d2f62c95841eac6db713fc47cfbe
  [gatewayd:linux-arm64]=47d6f6c6fabbc8a64509f67cfe7369a8764149cf82f1f571bbb03e8f944e1085
  [gatewayd:linux-x64]=bed6863fb0949feab628d7339052857717e48b964ec731c28e5e601fda2aba28
  [fedimintd:darwin-arm64]=99f3b9bd3dd329666c6358a030e50d1ae3ce72a27f625971142a2e09ec6b7a6e
  [fedimintd:darwin-x64]=94f23b2aac3ae8889f0af529656d2616aecb9cc2165616b7347be462654cf23b
  [fedimintd:linux-arm64]=f3a7ad326f32966d1fc9c530859a75b4bba694403cc816785a6557e5a63efa0e
  [fedimintd:linux-x64]=a6c1b82b10bbd41b8194a8f0b2c4b7b1eeb9f1483428932b252bf75bb7bad6e4
  [fedimint-cli:darwin-arm64]=e37785fc5bb33161acd26a2c10739e8e365ea3ad25211efb200c6c5fecf313e5
  [fedimint-cli:darwin-x64]=81784aa91d8b907613313cc5cac94717f4b89ba38f9a7cef2db42b538d1ff561
  [fedimint-cli:linux-arm64]=eafa49dc918b5b17d8d68fc5c23c99f0642e559575d3352f76cc33c00ca900dc
  [fedimint-cli:linux-x64]=cfb80f12946d87daf87247e582caa998bf34373d3624fe1ac4bdaad1b25a99fc
)
EXE=""; if [ "$OS" = windows ]; then EXE=.exe; fi   # (an assignment from a failing $(...) ends a set -e script: CI run 39128370301)
for BIN in gatewayd fedimintd fedimint-cli; do
  PIN="${CUSTODY_SHA[$BIN:$KEY]:-}"
  [ -n "$PIN" ] || continue
  F="$BIN-$KEY$EXE"
  if [ ! -f "$CACHE/$F" ] || ! echo "$PIN  $CACHE/$F" | sha256sum -c --status; then
    if [ -n "${ARENA_CUSTODY_DIR:-}" ]; then cp "$ARENA_CUSTODY_DIR/$F" "$CACHE/$F.part"
    else gh release download "$CUSTODY_TAG" --repo a tester/bitcoin-arena -p "$F" -O "$CACHE/$F.part" --clobber; fi
    echo "$PIN  $CACHE/$F.part" | sha256sum -c --status || { echo "$F: checksum mismatch" >&2; rm -f "$CACHE/$F.part"; exit 1; }
    mv "$CACHE/$F.part" "$CACHE/$F"
  fi
  mkdir -p "$STAGE/runtime/custody"
  install -m 0755 "$CACHE/$F" "$STAGE/runtime/custody/$BIN$EXE"
done

if [ "$OS" = windows ]; then rm "$STAGE/packages/arena-installer/node_modules"; cp -R "$STAGE/packages/arena-node/node_modules" "$STAGE/packages/arena-installer/node_modules"; fi

# 4. the launcher: the installer on the release's own runtime, cloudflared beside it
if [ "$OS" = windows ]; then
  printf '%s\r\n' '@echo off' 'rem The Arena node installer (kanban #471): double-click, then open the link it prints. --tunnel on a remote machine.' \
    'set "ARENA_CLOUDFLARED=%~dp0runtime\cloudflared.exe"' '"%~dp0runtime\node.exe" "%~dp0packages\arena-installer\bin\arena-install.mjs" %*' 'pause' > "$STAGE/arena-install.cmd"
else
  cat > "$STAGE/arena-install" <<'SH'
#!/bin/sh
# The Arena node installer (kanban #471): ./arena-install, then open the link it prints. --tunnel on a remote machine.
here="$(cd "$(dirname "$0")" && pwd)"
ARENA_CLOUDFLARED="$here/runtime/cloudflared" exec "$here/runtime/node" "$here/packages/arena-installer/bin/arena-install.mjs" "$@"
SH
  chmod 0755 "$STAGE/arena-install"
  # macOS: a double-clickable copy (Terminal opens it)
  [ "$OS" = darwin ] && cp "$STAGE/arena-install" "$STAGE/arena-install.command"
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
