#!/opt/homebrew/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# slice 5: the custody binaries for every release system, built on the test host (2026-10-18: "use the mac to compile things
# as much") from the patched fork 5fa01c5d7e6 (upstream v0.12.2, kanban #584: the LNv2 gateway fixes; the BLWP commits of 7e8caa9fd3a; crunchy 0.2.4; gatewayd without jemalloc on Windows and Linux): stripped, no
# debug info. Linux against glibc 2.31 (zig), so older systems run it; macOS natively for both architectures; Windows through zig.
# ONLY: os-arch keys to build (default all).
# Writes out/<bin>-<os>-<arch>[.exe] and out/SHA256SUMS.custody. BINS: which (default: gatewayd fedimintd fedimint-cli arena-stake-lock fedimint-dbtool; jemalloc off for all).
# fedimint-dbtool (kanban #718): stock, read by a RAM-disk guardian restored after an unclean stop (guardian-recover.js) - its accepted items
# compared and, when they agree, its AlephBFT units deleted before fedimintd starts.
# arena-stake-lock: packages/arena-node/tools/stake-lock copied into $F as a workspace member (kanban #824).
set -uo pipefail
B=${FEDWIN:-$HOME/blwp-offload/fedwin}; F=$B/src; OUT=$B/out; mkdir -p $OUT   # FEDWIN: the build folder (kanban #808: the second machine's is ~/m808/blwp-offload/fedwin)
export PATH=$HOME/.cargo/bin:$B/zig-aarch64-macos-0.16.0:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export AWS_LC_SYS_PREBUILT_NASM=1 CARGO_NET_RETRY=10 CARGO_PROFILE_RELEASE_DEBUG=false CARGO_PROFILE_RELEASE_STRIP=symbols
export CFLAGS_x86_64_pc_windows_gnu="-Wno-unused-command-line-argument" CXXFLAGS_x86_64_pc_windows_gnu="-Wno-unused-command-line-argument"
export LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib
export BINDGEN_EXTRA_CLANG_ARGS_x86_64_pc_windows_gnu="-I$B/zig-aarch64-macos-0.16.0/lib/include -I$B/zig-aarch64-macos-0.16.0/lib/libc/include/any-windows-any"
export FEDIMINT_BUILD_FORCE_GIT_HASH=5fa01c5d7e66c73074bd0cd96db83f0d86f15429 CARGO_TARGET_DIR=$B/target-custody
say() { echo "$(date -u +%T) $*"; }
rustup target add x86_64-pc-windows-gnu x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-apple-darwin >/dev/null 2>&1 || { say "rustup targets failed"; exit 1; }
cd $F
# target, how, os-arch, exe suffix
for row in "x86_64-pc-windows-gnu zig windows-x64 .exe" "x86_64-unknown-linux-gnu.2.31 zig linux-x64 -" "aarch64-unknown-linux-gnu.2.31 zig linux-arm64 -" \
           "aarch64-apple-darwin cargo darwin-arm64 -" "x86_64-apple-darwin cargo darwin-x64 -"; do
  set -- $row; tgt=$1; how=$2; key=$3; ext=${4/-/}; dir=${tgt%.2.31}
  [ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $key "* ]] && continue
  for bin in ${BINS:-gatewayd fedimintd fedimint-cli fedimint-dbtool arena-stake-lock}; do
    case $bin in arena-stake-lock) spec="-p arena-stake-lock";; gatewayd) spec="-p fedimint-gateway-server --bin gatewayd";; fedimintd) spec="-p fedimintd --no-default-features";; fedimint-cli) spec="-p fedimint-cli --no-default-features";; fedimint-dbtool) spec="-p fedimint-dbtool";; esac
    t0=$(date +%s); say "$bin for $key ($tgt)"
    if [ $how = zig ]; then cargo zigbuild --release --target $tgt $spec > $B/custody-$bin-$key.log 2>&1
    else cargo build --release --target $tgt $spec > $B/custody-$bin-$key.log 2>&1; fi
    rc=$?; say "$bin $key: exit $rc after $(( $(date +%s) - t0 )) s"
    if [ $rc = 0 ]; then cp $CARGO_TARGET_DIR/$dir/release/$bin$ext $OUT/$bin-$key$ext; ls -la $OUT/$bin-$key$ext; file $OUT/$bin-$key$ext | cut -c1-160
    else grep -E "^error" -A6 $B/custody-$bin-$key.log | head -14; fi
  done
done
cd $OUT && shasum -a 256 gatewayd-* fedimintd-* fedimint-cli-* fedimint-dbtool-* arena-stake-lock-* > SHA256SUMS.custody && cat SHA256SUMS.custody
say done
