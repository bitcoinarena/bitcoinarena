#!/opt/homebrew/bin/bash
# #471 slice 5: the custody binaries for every release system, built on the test host (the owner 2026-10-18: "use the mac to compile things
# as much") from the patched fork 76012ad9119 (the copy in src/: crunchy 0.2.4; gatewayd without jemalloc on Windows): stripped, no
# debug info. Linux against glibc 2.31 (zig), so older systems run it; macOS natively for both architectures; Windows through zig.
# Writes out/<bin>-<os>-<arch>[.exe] and out/SHA256SUMS.custody.
set -uo pipefail
B=/Users/arena/blwp-offload/fedwin; F=$B/src; OUT=$B/out; mkdir -p $OUT
export PATH=$HOME/.cargo/bin:$B/zig-aarch64-macos-0.16.0:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export AWS_LC_SYS_PREBUILT_NASM=1 CARGO_NET_RETRY=10 CARGO_PROFILE_RELEASE_DEBUG=false CARGO_PROFILE_RELEASE_STRIP=symbols
export CFLAGS_x86_64_pc_windows_gnu="-Wno-unused-command-line-argument" CXXFLAGS_x86_64_pc_windows_gnu="-Wno-unused-command-line-argument"
export LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib
export BINDGEN_EXTRA_CLANG_ARGS_x86_64_pc_windows_gnu="-I$B/zig-aarch64-macos-0.16.0/lib/include -I$B/zig-aarch64-macos-0.16.0/lib/libc/include/any-windows-any"
export FEDIMINT_BUILD_FORCE_GIT_HASH=76012ad9119d770398eb0d93faba1a90e0820c86 CARGO_TARGET_DIR=$B/target-custody
say() { echo "$(date -u +%T) $*"; }
rustup target add x86_64-pc-windows-gnu x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-apple-darwin >/dev/null 2>&1 || { say "rustup targets failed"; exit 1; }
cd $F
# target, how, os-arch, exe suffix
for row in "x86_64-pc-windows-gnu zig windows-x64 .exe" "x86_64-unknown-linux-gnu.2.31 zig linux-x64 -" "aarch64-unknown-linux-gnu.2.31 zig linux-arm64 -" \
           "aarch64-apple-darwin cargo darwin-arm64 -" "x86_64-apple-darwin cargo darwin-x64 -"; do
  set -- $row; tgt=$1; how=$2; key=$3; ext=${4/-/}; dir=${tgt%.2.31}
  t0=$(date +%s); say "gatewayd for $key ($tgt)"
  if [ $how = zig ]; then cargo zigbuild --release --target $tgt -p fedimint-gateway-server --bin gatewayd > $B/custody-$key.log 2>&1
  else cargo build --release --target $tgt -p fedimint-gateway-server --bin gatewayd > $B/custody-$key.log 2>&1; fi
  rc=$?; say "$key: exit $rc after $(( $(date +%s) - t0 )) s"
  if [ $rc = 0 ]; then cp $CARGO_TARGET_DIR/$dir/release/gatewayd$ext $OUT/gatewayd-$key$ext; ls -la $OUT/gatewayd-$key$ext; file $OUT/gatewayd-$key$ext | cut -c1-160
  else grep -E "^error" -A6 $B/custody-$key.log | head -14; fi
done
cd $OUT && shasum -a 256 gatewayd-* > SHA256SUMS.custody && cat SHA256SUMS.custody
say done
