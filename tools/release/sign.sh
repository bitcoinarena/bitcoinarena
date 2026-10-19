#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# SIGN A RELEASE'S CHECKSUMS (kanban #471 ruling 6: the release key is Claude's, its public key published on the Arena site and in
# deploy/release/arena-release-key.pub.pem). Ed25519 over the SHA256SUMS file's bytes; the signature, base64, beside it. The
# installer and the updater refuse an asset whose line is missing or whose SHA256SUMS does not verify (release-verify.js).
#
#     tools/release/sign.sh <dir holding SHA256SUMS> [private key pem] [file to sign, SHA256SUMS by default]
#
# The same key signs release/latest.json (tools/release/latest.mjs), the newest release the owner page offers.
set -euo pipefail
DIR="$1"; KEY="${2:-$HOME/.config/blwp/arena-release-key.pem}"; F="${3:-SHA256SUMS}"
[ "$(stat -c %a "$KEY")" = 600 ] || { echo "$KEY must be mode 600" >&2; exit 1; }
openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$DIR/$F" | base64 -w0 > "$DIR/$F.sig"
echo >> "$DIR/$F.sig"
PUB="$(git rev-parse --show-toplevel)/deploy/release/arena-release-key.pub.pem"
openssl pkeyutl -verify -pubin -inkey "$PUB" -rawin -in "$DIR/$F" -sigfile <(base64 -d "$DIR/$F.sig") >/dev/null && echo "signed and verified: $DIR/$F.sig"
