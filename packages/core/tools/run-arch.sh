#!/usr/bin/env bash
# Cross-ARCHITECTURE acceptance, the third of the three questions.
#
#   cross-engine   run-engines.sh    do V8, SpiderMonkey and JSC agree?
#   cross-version  run-versions.sh   does one engine agree with itself over time?
#   cross-arch     this              does one engine agree with itself across CPUs?
#
# The third is not redundant. Measured 1 September 2026 on V8 13.6 - the SAME
# version - x86-64 and arm64 return different results from sin, cos, tan,
# atan2, exp, log and pow. Two players on the same Chrome build, one on Intel
# and one on Apple silicon, would compute different worlds.
#
# The core agrees, because it calls none of them. This proves it rather than
# asserting it.
#
# Needs Docker. On Apple silicon the x86-64 side runs under Rosetta: it
# exercises V8's x86-64 backend - different instruction selection, different
# register allocation - with the instructions themselves translated. The CI
# workflow runs it natively; this is the answer you can have in a minute.
set -u
cd "$(dirname "$0")/../.." || exit 2

docker info > /dev/null 2>&1 || { echo "cross-arch: SKIPPED - no docker daemon"; exit 0; }

native=$(cd core && node test/harness.js | tail -1 | awk '{print $2}')
nativeArch=$(node -p process.arch)
foreign=$(docker run --rm --platform linux/amd64 -v "$PWD/..:/w" -w /w/packages/core \
          node:24 node test/harness.js 2>/dev/null | tail -1 | awk '{print $2}')

echo "cross-architecture harness"
printf '  %-8s %s\n' "$nativeArch" "$native"
printf '  %-8s %s\n' "x64" "$foreign"
echo
if [ -z "$foreign" ]; then
  echo "cross-architecture acceptance: FAIL - the container produced nothing"
  exit 1
fi
[ "$native" = "$foreign" ] && { echo "cross-architecture acceptance: PASS"; exit 0; }
echo "cross-architecture acceptance: FAIL - the same inputs give two worlds"
exit 1
