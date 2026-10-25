#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE macOS PACKAGE: bitcoin-arena-node-<v>-darwin-<arch>.dmg - "Bitcoin Arena.app" (kanban #635: the name people see; the file keeps its name) (the native app pkg/macos/App.swift, its helper pkg/macos/arena-node-app and the release inside it)
# and a link to Applications, to drag it to. Made with hdiutil, so on a macOS (CI: the macos runner). Its line goes into
# <out>/SHA256SUMS.packages. Usage: package-mac.sh <version> <out dir with the darwin assets>
set -euo pipefail
V=$1; OUT=$(cd "$2" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# THE ICON (kanban #635, the owner's playtest 2026-10-25: "It has no logo"): the site's brand mark, pkg/icon/bitcoin-arena-1024.png, as an .icns
IS="$WORK/AppIcon.iconset"; mkdir -p "$IS"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HERE/pkg/icon/bitcoin-arena-1024.png" --out "$IS/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$HERE/pkg/icon/bitcoin-arena-1024.png" --out "$IS/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$IS" -o "$WORK/AppIcon.icns"
# THE APP ITSELF (the owner's playtest 2026-10-25: "It should look like a real app with the options" - "clicking Close seems to restart
# the app, it never closes/quits, Command+Q doesn't do anything"): pkg/macos/App.swift, a native AppKit window, one universal binary
swiftc -O -swift-version 5 -target arm64-apple-macos12 -framework AppKit -o "$WORK/app-arm64" "$HERE/pkg/macos/App.swift"
swiftc -O -swift-version 5 -target x86_64-apple-macos12 -framework AppKit -o "$WORK/app-x64" "$HERE/pkg/macos/App.swift"
lipo -create "$WORK/app-arm64" "$WORK/app-x64" -output "$WORK/Bitcoin Arena"
for arch in arm64 x64; do
  R=bitcoin-arena-node-$V-darwin-$arch
  [ -f "$OUT/$R.tar.gz" ] || { echo "no $R.tar.gz: skipped"; continue; }
  D=$WORK/$arch; APP="$D/Bitcoin Arena.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/release"
  install -m 0755 "$WORK/Bitcoin Arena" "$APP/Contents/MacOS/Bitcoin Arena"
  tar -xzf "$OUT/$R.tar.gz" -C "$APP/Contents/Resources/release"
  install -m 0755 "$HERE/pkg/macos/arena-node-app" "$APP/Contents/Resources/arena-node-app"
  cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Bitcoin Arena</string>
  <key>CFBundleDisplayName</key><string>Bitcoin Arena</string>
  <key>CFBundleExecutable</key><string>Bitcoin Arena</string>
  <key>CFBundleIdentifier</key><string>io.bitcoin-arena.node.setup</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$V</string>
  <key>CFBundleVersion</key><string>$V</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
  # an ad-hoc signature: the app's files sealed (no Developer ID yet - Gatekeeper asks once: right-click > Open)
  codesign --force --deep -s - "$APP" 2>/dev/null || echo "codesign: not signed ad hoc"
  ln -s /Applications "$D/Applications"
  DMG=bitcoin-arena-node-$V-darwin-$arch.dmg
  hdiutil create -quiet -volname "Bitcoin Arena $V" -srcfolder "$D" -ov -format UDZO "$OUT/$DMG"
  (cd "$OUT" && shasum -a 256 "$DMG") >> "$OUT/SHA256SUMS.packages"
  echo "built $DMG ($(du -h "$OUT/$DMG" | cut -f1))"
done
