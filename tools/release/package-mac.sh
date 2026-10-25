#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE macOS PACKAGE: bitcoin-arena-node-<v>-darwin-<arch>.dmg - "Bitcoin Arena.app" (kanban #635: the name people see; the file keeps its name) (pkg/macos/arena-node-app with the release inside it)
# and a link to Applications, to drag it to. Made with hdiutil, so on a macOS (CI: the macos runner). Its line goes into
# <out>/SHA256SUMS.packages. Usage: package-mac.sh <version> <out dir with the darwin assets>
set -euo pipefail
V=$1; OUT=$(cd "$2" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
for arch in arm64 x64; do
  R=bitcoin-arena-node-$V-darwin-$arch
  [ -f "$OUT/$R.tar.gz" ] || { echo "no $R.tar.gz: skipped"; continue; }
  D=$WORK/$arch; APP="$D/Bitcoin Arena.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/release"
  tar -xzf "$OUT/$R.tar.gz" -C "$APP/Contents/Resources/release"
  install -m 0755 "$HERE/pkg/macos/arena-node-app" "$APP/Contents/MacOS/arena-node-app"
  cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Bitcoin Arena</string><key>CFBundleDisplayName</key><string>Bitcoin Arena</string>
  <key>CFBundleIdentifier</key><string>io.bitcoin-arena.node.setup</string><key>CFBundleExecutable</key><string>arena-node-app</string>
  <key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>$V</string><key>CFBundleVersion</key><string>$V</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string><key>LSUIElement</key><true/>
</dict></plist>
EOF
  # an ad-hoc signature: the app's files sealed (no Developer ID yet - Gatekeeper asks once: right-click > Open)
  codesign --force --deep -s - "$APP" 2>/dev/null || echo "codesign: not signed ad hoc"
  ln -s /Applications "$D/Applications"
  DMG=bitcoin-arena-node-$V-darwin-$arch.dmg
  hdiutil create -quiet -volname "Bitcoin Arena $V" -srcfolder "$D" -ov -format UDZO "$OUT/$DMG"
  (cd "$OUT" && shasum -a 256 "$DMG") >> "$OUT/SHA256SUMS.packages"
  echo "built $DMG ($(du -h "$OUT/$DMG" | cut -f1))"
done
