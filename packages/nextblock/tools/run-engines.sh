#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# The acceptance criterion for stage 0: identical state hashes from every
# engine. Exits non-zero on any divergence and prints the first differing tick.
#
# Engines: Node and the v8 shell are both V8 but different builds, which is
# worth keeping - it catches a difference between the embedder and the shell.
# SpiderMonkey and JavaScriptCore are the ones that actually matter.
#
# Install the shells once with:  npx jsvu --os=mac64arm --engines=spidermonkey,v8
set -u
cd "$(dirname "$0")/../test" || exit 2

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
OUT=$(mktemp -d)
fail=0

run () { # name, command...
  local name=$1; shift
  if ! "$@" > "$OUT/$name.txt" 2>&1; then
    echo "  $name: RUN FAILED"; sed 's/^/    /' "$OUT/$name.txt" | head -5; fail=1; return
  fi
  echo "  $name: $(tail -1 "$OUT/$name.txt")"
}

echo "cross-engine harness: modules"
run node node harness.js
[ -x ~/.jsvu/bin/v8 ] && run v8  ~/.jsvu/bin/v8 --module harness.js
[ -x ~/.jsvu/bin/sm ] && run sm  ~/.jsvu/bin/sm --module harness.js
[ -x "$JSC" ]         && run jsc "$JSC" -m harness.js

# And the BUNDLE, which is the artifact the browser actually loads. It had
# only ever run under Node, so the file players use had never been through
# SpiderMonkey or JavaScriptCore - and concatenation changes scoping,
# hoisting and declaration order, which is precisely the ground engines have
# historically disagreed on.
#
# Each shell wants its files differently: v8 and jsc take a list, SpiderMonkey
# needs -f in front of each.
if [ -f ../dist/blwp-core.js ]; then
  echo
  echo "cross-engine harness: bundle"
  run bundle-node node harness-bundle.cjs
  [ -x ~/.jsvu/bin/v8 ] && run bundle-v8 ~/.jsvu/bin/v8 ../dist/blwp-core.js harness-bundle.cjs
  [ -x ~/.jsvu/bin/sm ] && run bundle-sm ~/.jsvu/bin/sm -f ../dist/blwp-core.js -f harness-bundle.cjs
  [ -x "$JSC" ]         && run bundle-jsc "$JSC" ../dist/blwp-core.js harness-bundle.cjs
fi

echo
# Comment lines are stripped before comparing. The module and bundle harnesses
# print different banners, and comparing those made all eight runs look
# divergent while every hash on every line was identical - a script bug wearing
# a determinism failure's clothes, which is the worst kind to leave lying about.
strip () { grep -v '^#' "$1"; }

for f in "$OUT"/*.txt; do
  [ "$f" = "$OUT/node.txt" ] && continue
  name=$(basename "$f" .txt)
  if diff -q <(strip "$OUT/node.txt") <(strip "$f") > /dev/null; then
    echo "  node vs $name: identical"
  else
    echo "  node vs $name: DIVERGENT"
    diff <(strip "$OUT/node.txt") <(strip "$f") | head -6 | sed 's/^/    /'
    fail=1
  fi
done

rm -rf "$OUT"
[ $fail -eq 0 ] && echo && echo "stage 0 acceptance: PASS" || echo "stage 0 acceptance: FAIL"
exit $fail
