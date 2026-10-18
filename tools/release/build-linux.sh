#!/bin/bash
# ONE LINUX RELEASE ASSET OF THE ARENA NODE (kanban #471 part A): the seat, its protocol, the installer and nextblock from a commit,
# their two npm dependencies at pinned versions, a pinned Node runtime and cloudflared - each download checked against its published
# SHA-256 - and the launcher `arena-install`. Run by CI for every tag (release.yml), the same way each time.
#
#     tools/release/build-linux.sh <version> <x64|arm64> <out dir> [commit]
#
# Writes <out>/arena-node-<version>-linux-<arch>.tar.gz and appends its line to <out>/SHA256SUMS.
set -euo pipefail
VER="$1"; ARCH="$2"; OUT="$(mkdir -p "$3" && cd "$3" && pwd)"; REF="${4:-HEAD}"
NODE_VER=24.15.0
declare -A NODE_SHA=([x64]=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6 [arm64]=f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0)
CF_VER=2026.9.1
declare -A CF_ARCH=([x64]=amd64 [arm64]=arm64)
declare -A CF_SHA=([x64]=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc [arm64]=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3)
[[ -n "${NODE_SHA[$ARCH]:-}" ]] || { echo "arch is x64 or arm64" >&2; exit 2; }
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$ ]] || { echo "version is like 0.1.0" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel)"
NAME="arena-node-$VER-linux-$ARCH"
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
git -C "$ROOT" rev-parse "$REF" > "$STAGE/COMMIT"
echo "$VER" > "$STAGE/VERSION"

# 2. the runtime, checked
fetch "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-$ARCH.tar.xz" "${NODE_SHA[$ARCH]}" "node-v$NODE_VER-linux-$ARCH.tar.xz"
tar -xJf "$CACHE/node-v$NODE_VER-linux-$ARCH.tar.xz" -C "$STAGE/runtime" --strip-components=2 "node-v$NODE_VER-linux-$ARCH/bin/node"
fetch "https://github.com/cloudflare/cloudflared/releases/download/$CF_VER/cloudflared-linux-${CF_ARCH[$ARCH]}" "${CF_SHA[$ARCH]}" "cloudflared-linux-${CF_ARCH[$ARCH]}-$CF_VER"
install -m 0755 "$CACHE/cloudflared-linux-${CF_ARCH[$ARCH]}-$CF_VER" "$STAGE/runtime/cloudflared"

# 3. the npm dependencies, pinned (pure JavaScript: the same files for every architecture)
( cd "$STAGE/packages/arena-node" && npm install --omit=dev --no-audit --no-fund --no-package-lock --ignore-scripts \
    @noble/curves@2.4.0 @noble/hashes@2.4.0 ws@8.21.3 >/dev/null )

# 4. the launcher: the installer on the release's own runtime, cloudflared beside it
cat > "$STAGE/arena-install" <<'SH'
#!/bin/sh
# The Arena node installer (kanban #471): ./arena-install, then open the link it prints. --tunnel on a remote machine.
here="$(cd "$(dirname "$0")" && pwd)"
ARENA_CLOUDFLARED="$here/runtime/cloudflared" exec "$here/runtime/node" "$here/packages/arena-installer/bin/arena-install.mjs" "$@"
SH
chmod 0755 "$STAGE/arena-install"

# 5. the asset and its checksum (tar with fixed owner and order, so the same commit gives the same bytes)
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$(git -C "$ROOT" log -1 --format=%ct "$REF")" -C "$OUT" -cf - "$NAME" | gzip -n -9 > "$OUT/$NAME.tar.gz"
( cd "$OUT" && sha256sum "$NAME.tar.gz" >> SHA256SUMS )
echo "$OUT/$NAME.tar.gz $(du -h "$OUT/$NAME.tar.gz" | cut -f1)"
