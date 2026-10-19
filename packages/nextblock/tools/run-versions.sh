#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# Cross-VERSION acceptance, which is a different question from cross-engine.
#
# Three engines agreeing today says nothing about the same engine agreeing with
# itself next year. Measured here on 31 August 2026: V8 changed Math.pow
# between 12.4 and 13.6, so a simulation that called it would have desynced
# every player who updated Chrome - silently, and only for some inputs.
#
# The core survives that because it calls none of them. This script is what
# keeps it true: run the ten-minute corpus under every Node version installed
# under /tmp/nodevers plus the one on PATH, and require one hash.
#
# Fetch the versions once with:
#   for v in 18.20.8 20.19.0 22.14.0; do
#     curl -sL https://nodejs.org/dist/v$v/node-v$v-darwin-arm64.tar.gz | tar xz -C /tmp/nodevers
#   done
set -u
cd "$(dirname "$0")/../test" || exit 2

declare -a NAMES HASHES
add () { NAMES+=("$1"); HASHES+=("$2"); }

for dir in /tmp/nodevers/node-v*/bin/node; do
  [ -x "$dir" ] || continue
  v8=$("$dir" -p 'process.versions.v8' 2>/dev/null | cut -d- -f1)
  h=$("$dir" harness.js 2>&1 | tail -1 | awk '{print $2}')
  add "V8 $v8" "$h"
done
v8=$(node -p 'process.versions.v8' | cut -d- -f1)
add "V8 $v8" "$(node harness.js 2>&1 | tail -1 | awk '{print $2}')"

echo "cross-version harness (${#NAMES[@]} runtimes)"
fail=0
for i in "${!NAMES[@]}"; do
  printf '  %-16s %s\n' "${NAMES[$i]}" "${HASHES[$i]:0:32}"
  [ "${HASHES[$i]}" = "${HASHES[0]}" ] || fail=1
done

echo
if [ "${#NAMES[@]}" -lt 2 ]; then
  echo "cross-version acceptance: SKIPPED - only one runtime found"
  exit 0
fi
[ $fail -eq 0 ] && echo "cross-version acceptance: PASS" || echo "cross-version acceptance: FAIL"
exit $fail
