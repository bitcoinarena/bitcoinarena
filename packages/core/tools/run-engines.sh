#!/usr/bin/env bash
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

echo "cross-engine harness"
run node node harness.js
[ -x ~/.jsvu/bin/v8 ] && run v8  ~/.jsvu/bin/v8 --module harness.js
[ -x ~/.jsvu/bin/sm ] && run sm  ~/.jsvu/bin/sm --module harness.js
[ -x "$JSC" ]         && run jsc "$JSC" -m harness.js

echo
for f in "$OUT"/*.txt; do
  [ "$f" = "$OUT/node.txt" ] && continue
  name=$(basename "$f" .txt)
  if diff -q "$OUT/node.txt" "$f" > /dev/null; then
    echo "  node vs $name: identical"
  else
    echo "  node vs $name: DIVERGENT"
    diff "$OUT/node.txt" "$f" | head -6 | sed 's/^/    /'
    fail=1
  fi
done

rm -rf "$OUT"
[ $fail -eq 0 ] && echo && echo "stage 0 acceptance: PASS" || echo "stage 0 acceptance: FAIL"
exit $fail
