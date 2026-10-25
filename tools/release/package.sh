#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE INSTALLER PACKAGES (2026-10-19: "For the installer, for windows we want an exe, for macOS OS we want a deb. That also
# includes a small gui version of the installer that launches the browser etc"). Each wraps a release asset build-release.sh made:
#   windows  bitcoin-arena-node-setup-<v>-windows-x64.exe   NSIS (makensis): no administrator, %LOCALAPPDATA%\ArenaNode, Start menu "Bitcoin Arena"
#   linux    bitcoin-arena-node_<v>_<amd64|arm64>.deb     /opt/bitcoin-arena-node/<release>, /usr/bin/bitcoin-arena-node-setup, the menu's "Bitcoin Arena"
#   darwin   bitcoin-arena-node-<v>-darwin-<arch>.dmg      tools/release/package-mac.sh, on a macOS (hdiutil)
# Each package's line goes into <out>/SHA256SUMS.packages (the release job adds it to SHA256SUMS, which the release key signs).
# Usage: package.sh <version> <out dir with the assets> [windows] [linux]   (NSISDIR may name an unpacked NSIS)
set -euo pipefail
V=$1; OUT=$(cd "$2" && pwd); shift 2
WHAT=${*:-windows linux}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
sums() { (cd "$OUT" && sha256sum "$1") >> "$OUT/SHA256SUMS.packages"; echo "built $1 ($(du -h "$OUT/$1" | cut -f1))"; }

for what in $WHAT; do
  case $what in
    windows)
      R=bitcoin-arena-node-$V-windows-x64
      mkdir -p "$WORK/win" && unzip -q "$OUT/$R.zip" -d "$WORK/win"
      cp "$HERE/pkg/windows/ArenaNode.ps1" "$HERE/pkg/windows/arena-node.nsi" "$WORK/win/"
      EXE=bitcoin-arena-node-setup-$V-windows-x64.exe
      MAKENSIS=${MAKENSIS:-makensis}
      (cd "$WORK/win" && "$MAKENSIS" -V2 -DVERSION="$V" -DRELEASE="$R" -DSTAGE="$WORK/win/$R" -DOUT="$OUT/$EXE" arena-node.nsi)
      sums "$EXE"
      ;;
    linux)
      for arch in x64 arm64; do
        R=bitcoin-arena-node-$V-linux-$arch
        deb=$([ $arch = x64 ] && echo amd64 || echo arm64)
        P=$WORK/deb-$arch
        mkdir -p "$P/opt/bitcoin-arena-node" "$P/usr/bin" "$P/usr/share/applications" "$P/DEBIAN"
        tar -xzf "$OUT/$R.tar.gz" -C "$P/opt/bitcoin-arena-node"
        install -m 0755 "$HERE/pkg/linux/arena-node-setup" "$P/usr/bin/bitcoin-arena-node-setup"
        cat > "$P/usr/share/applications/bitcoin-arena-node.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Bitcoin Arena
Comment=Set up and manage your Bitcoin Arena node (testnet4)
Exec=bitcoin-arena-node-setup
Icon=network-server
Terminal=false
Categories=Network;
EOF
        # Debian orders 0.1.0~rc.25 before 0.1.0 ("-" would start the Debian revision)
        cat > "$P/DEBIAN/control" <<EOF
Package: bitcoin-arena-node
Version: ${V/-/\~}
Architecture: $deb
Maintainer: Bitcoin Arena <noreply@bitcoin-arena.io>
Section: net
Priority: optional
Suggests: zenity, xdg-utils
Description: Bitcoin Arena node (testnet4): the node, its installer and its runtime
 Run bitcoin-arena-node-setup (or "Bitcoin Arena" in the menu): the installer's setup page
 opens in the browser. Afterwards arenanode status / doctor / restart manage it.
EOF
        NAME=bitcoin-arena-node_${V/-/\~}_$deb.deb
        dpkg-deb --root-owner-group -Zxz --build "$P" "$OUT/$NAME" >/dev/null
        sums "$NAME"
      done
      ;;
  esac
done
