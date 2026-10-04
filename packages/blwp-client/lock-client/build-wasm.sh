#!/usr/bin/env bash
# Rebuild the BLWP wasm lock client with whole-msat e-cash (the owner 2026-10-01: "we want 1 sat = 1 sat").
set -euxo pipefail
B=/mnt/bitcoin/lockclient-build
# THE SOURCES ARE THIS SCRIPT'S OWN DIRECTORY (2026-10-04, #27): the crate and the patches next to it, not a fixed old
# checkout - before, every run re-linked the crate to /mnt/bitcoin/blwp-build-a535 and built that tree's lib.rs.
HERE=${BLWP_LOCK_CLIENT_DIR:-$(cd "$(dirname "$0")" && pwd)}
export RUSTUP_HOME=$B/rustup CARGO_HOME=$B/cargo PATH=$B/cargo/bin:$PATH
cd $B
# 1. TOOLS (as the user; no sudo): rustup + wasm32 target, wasi-sdk's clang, wasm-bindgen 0.2.106 (the lockfile's)
[ -x $B/cargo/bin/rustup ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
rustup target add wasm32-unknown-unknown
if [ ! -x $B/wasi-sdk/bin/clang ]; then
  curl -sSL -o wasi.tgz https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz
  mkdir -p wasi-sdk && tar xzf wasi.tgz -C wasi-sdk --strip-components=1
fi
if [ ! -x $B/wasm-bindgen/wasm-bindgen ]; then
  curl -sSL -o wb.tgz https://github.com/rustwasm/wasm-bindgen/releases/download/0.2.106/wasm-bindgen-0.2.106-x86_64-unknown-linux-musl.tar.gz
  mkdir -p wasm-bindgen && tar xzf wb.tgz -C wasm-bindgen --strip-components=1
fi
# 2. THE TREE: a worktree of the fork at its testnet4 commit, the one stock patch, the denominations change, the crate
if [ ! -d $B/tree ]; then git -C /mnt/bitcoin/fedimint-fork worktree add --detach $B/tree f1481d4bcfa; fi
cd $B/tree
git checkout -- . && git clean -fdq
patch -p1 < $HERE/fedimint-lnv2-send-expiry.patch
# 1 SAT = 1 SAT: the client issues and spends notes from 1 msat (the federation signs 0..41 already)
patch -p1 < $HERE/fedimint-mintv2-whole-msat.patch
patch -p1 < $HERE/fedimint-lnv2-testnet4-invoices.patch
# RECOVERY IN THE BROWSER (#27, the owner 2026-10-04: "patch Fedimint's recovery so it runs in the browser"): mintv2's
# recovery-slice fetch timed out on tokio's clock, whose std::time::Instant panics on wasm32
patch -p1 < $HERE/fedimint-mintv2-recovery-wasm-clock.patch
grep -q "fedimint_core::runtime::timeout(" modules/fedimint-mintv2-client/src/api.rs
grep -n "(0..42).map(Denomination)" modules/fedimint-mintv2-common/src/config.rs | wc -l | grep -qx 2
ln -sfn $HERE blwp-lock-client
grep -q '"blwp-lock-client"' Cargo.toml || sed -i 's/^members = \[/members = [\n  "blwp-lock-client",/' Cargo.toml
export CC_wasm32_unknown_unknown=$B/wasi-sdk/bin/clang AR_wasm32_unknown_unknown=$B/wasi-sdk/bin/llvm-ar
export CFLAGS_wasm32_unknown_unknown="--target=wasm32-unknown-unknown"
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='--cfg getrandom_backend="wasm_js"'
cargo build --release --target wasm32-unknown-unknown -p blwp-lock-client
mkdir -p $B/out && $B/wasm-bindgen/wasm-bindgen --target web --out-dir $B/out target/wasm32-unknown-unknown/release/blwp_lock_client.wasm
ls -la $B/out
echo BUILD-OK
