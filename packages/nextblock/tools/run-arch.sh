#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
foreign=$(docker run --rm --platform linux/amd64 -v "$PWD/..:/w" -w /w/packages/nextblock \
          node:24 node test/harness.js 2>/dev/null | tail -1 | awk '{print $2}')

# And a BIG-endian machine, which is the case no amount of testing on x86 and
# ARM can reach - both are little-endian, so the digest inherited the host's
# byte order and every run agreed anyway. s390x is the only way to find out
# whether the fix is correct or merely correctly written.
#
# Node ships an s390x build; Docker emulates the architecture. It is slow, and
# it is run rarely and on purpose.
big=""
if [ "${SKIP_BIG_ENDIAN:-0}" != "1" ] && [ -f /tmp/node-s390x.tar.gz ]; then
  big=$(docker run --rm --platform linux/s390x -v "$PWD/..:/w" \
          -v /tmp/node-s390x.tar.gz:/node.tgz -w /w/packages/nextblock \
          s390x/debian:bookworm-slim bash -c '
            tar xzf /node.tgz -C /opt
            /opt/node-v22.14.0-linux-s390x/bin/node test/harness.js
          ' 2>/dev/null | tail -1 | awk '{print $2}')
fi

echo "cross-architecture harness"
printf '  %-16s %s\n' "$nativeArch (LE)" "$native"
printf '  %-16s %s\n' "x64 (LE)" "$foreign"
[ -n "$big" ] && printf '  %-16s %s\n' "s390x (BE)" "$big"
echo
if [ -z "$foreign" ]; then
  echo "cross-architecture acceptance: FAIL - the container produced nothing"
  exit 1
fi
fail=0
[ "$native" = "$foreign" ] || fail=1
[ -n "$big" ] && [ "$native" != "$big" ] && fail=1
[ $fail -eq 0 ] && { echo "cross-architecture acceptance: PASS"; exit 0; }
echo "cross-architecture acceptance: FAIL - the same inputs give two worlds"
exit 1
