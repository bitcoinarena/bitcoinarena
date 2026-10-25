#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE macOS PACKAGE: bitcoin-arena-node-<v>-darwin-<arch>.dmg - "Bitcoin Arena.app" (kanban #635: the name people see; the file keeps its name) (the applet pkg/macos/app.applescript, its helper pkg/macos/arena-node-app and the release inside it)
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
for arch in arm64 x64; do
  R=bitcoin-arena-node-$V-darwin-$arch
  [ -f "$OUT/$R.tar.gz" ] || { echo "no $R.tar.gz: skipped"; continue; }
  D=$WORK/$arch; APP="$D/Bitcoin Arena.app"
  # A STAY-OPEN APPLET (kanban #635, the owner's playtest 2026-10-25: "doesn't stay open, doesn't have an icon that indicates that it is
  # running"): pkg/macos/app.applescript, in the Dock while the installer runs; its steps are the helper arena-node-app in Resources
  mkdir -p "$D"
  osacompile -s -o "$APP" "$HERE/pkg/macos/app.applescript"
  mkdir -p "$APP/Contents/Resources/release"
  tar -xzf "$OUT/$R.tar.gz" -C "$APP/Contents/Resources/release"
  install -m 0755 "$HERE/pkg/macos/arena-node-app" "$APP/Contents/Resources/arena-node-app"
  cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/applet.icns"
  rm -f "$APP/Contents/Resources/Assets.car"
  P="$APP/Contents/Info.plist"
  for kv in "CFBundleName Bitcoin Arena" "CFBundleDisplayName Bitcoin Arena" "CFBundleIdentifier io.bitcoin-arena.node.setup" \
    "CFBundleShortVersionString $V" "CFBundleVersion $V" "LSMinimumSystemVersion 12.0" "CFBundleIconFile applet"; do
    k=${kv%% *}; v=${kv#* }
    /usr/libexec/PlistBuddy -c "Set :$k \"$v\"" "$P" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$k string \"$v\"" "$P"
  done
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$P" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Delete :LSUIElement" "$P" 2>/dev/null || true
  # an ad-hoc signature: the app's files sealed (no Developer ID yet - Gatekeeper asks once: right-click > Open)
  codesign --force --deep -s - "$APP" 2>/dev/null || echo "codesign: not signed ad hoc"
  ln -s /Applications "$D/Applications"
  DMG=bitcoin-arena-node-$V-darwin-$arch.dmg
  hdiutil create -quiet -volname "Bitcoin Arena $V" -srcfolder "$D" -ov -format UDZO "$OUT/$DMG"
  (cd "$OUT" && shasum -a 256 "$DMG") >> "$OUT/SHA256SUMS.packages"
  echo "built $DMG ($(du -h "$OUT/$DMG" | cut -f1))"
done
