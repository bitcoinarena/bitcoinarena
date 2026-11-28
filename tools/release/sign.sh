#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# ONE KEY'S SIGNATURE (kanban #3920: releases are 2-of-3 now). Kept for old habits: it only runs sign-part.mjs, which writes
# <dir>/<file>.sig-<key16>; combine-sigs.mjs then writes SHA256SUMS.sigs and SHA256SUMS.sig and checks that 2 keys signed.
# There is no default key path any more: the release keys never sit on a live host (kanban #3553).
#
#     tools/release/sign.sh <dir holding SHA256SUMS> <private key pem> [file to sign, SHA256SUMS by default]
set -euo pipefail
DIR="$1"; KEY="${2:?private key pem}"; F="${3:-SHA256SUMS}"
exec node "$(dirname "$0")/sign-part.mjs" "$DIR/$F" "$KEY"
