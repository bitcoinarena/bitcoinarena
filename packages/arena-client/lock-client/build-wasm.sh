#!/usr/bin/env bash
# Rebuild the Arena wasm lock client with whole-msat e-cash (2026-10-01: "we want 1 sat = 1 sat").
set -euxo pipefail
# WHERE: the the test host's /mnt/bitcoin by default; ARENA_LOCK_BUILD and ARENA_FORK_DIR move it (the test host,: a whole
# wasm build of the fork is a job that takes the test host past load 12)
B=${ARENA_LOCK_BUILD:-/mnt/bitcoin/lockclient-build}
FORK=${ARENA_FORK_DIR:-/mnt/bitcoin/fedimint-fork}
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) WASI_PLAT=arm64-macos; WB_PLAT=aarch64-apple-darwin; SEDI=(sed -i '') ;;
  *) WASI_PLAT=x86_64-linux; WB_PLAT=x86_64-unknown-linux-musl; SEDI=(sed -i) ;;
esac
mkdir -p $B
# THE SOURCES ARE THIS SCRIPT'S OWN DIRECTORY (2026-10-04): the crate and the patches next to it, not a fixed old
# checkout - before, every run re-linked the crate to /mnt/bitcoin/blwp-build-a535 and built that tree's lib.rs.
HERE=${ARENA_LOCK_CLIENT_DIR:-$(cd "$(dirname "$0")" && pwd)}
export RUSTUP_HOME=$B/rustup CARGO_HOME=$B/cargo PATH=$B/cargo/bin:$PATH
cd $B
# 1. TOOLS (as the user; no sudo): rustup + wasm32 target, wasi-sdk's clang, wasm-bindgen 0.2.106 (the lockfile's)
[ -x $B/cargo/bin/rustup ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
rustup target add wasm32-unknown-unknown
if [ ! -x $B/wasi-sdk/bin/clang ]; then
  curl -sSL -o wasi.tgz https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-${WASI_PLAT}.tar.gz
  mkdir -p wasi-sdk && tar xzf wasi.tgz -C wasi-sdk --strip-components=1
fi
if [ ! -x $B/wasm-bindgen/wasm-bindgen ]; then
  curl -sSL -o wb.tgz https://github.com/rustwasm/wasm-bindgen/releases/download/0.2.106/wasm-bindgen-0.2.106-${WB_PLAT}.tar.gz
  mkdir -p wasm-bindgen && tar xzf wb.tgz -C wasm-bindgen --strip-components=1
fi
# 2. THE TREE: a worktree of the fork at its testnet4 commit, the one stock patch, the denominations change, the crate
if [ ! -d $B/tree ]; then git -C $FORK worktree add --detach $B/tree f1481d4bcfa; fi
cd $B/tree
git checkout -- . && git clean -fdq
patch -p1 < $HERE/fedimint-lnv2-send-expiry.patch
# 1 SAT = 1 SAT: the client issues and spends notes from 1 msat (the federation signs 0..41 already)
patch -p1 < $HERE/fedimint-mintv2-whole-msat.patch
patch -p1 < $HERE/fedimint-lnv2-testnet4-invoices.patch
# LOST DEPOSITS (kanban #883): the receive scan the client already runs for LNURL, for this client's own key
awk -v f=$HERE/lnv2-scan-receive.rs '/Receive an incoming contract locked to a public key derived from our/ && !d { while ((getline l < f) > 0) print l; d = 1 } { print }' modules/fedimint-lnv2-client/src/lib.rs > /tmp/lnv2-lib.rs && cp /tmp/lnv2-lib.rs modules/fedimint-lnv2-client/src/lib.rs
grep -q "fn scan_receives" modules/fedimint-lnv2-client/src/lib.rs
# RECOVERY IN THE BROWSER (2026-10-04: "patch Fedimint's recovery so it runs in the browser"): mintv2's
# recovery-slice fetch timed out on tokio's clock, whose std::time::Instant panics on wasm32
patch -p1 < $HERE/fedimint-mintv2-recovery-wasm-clock.patch
grep -q "fedimint_core::runtime::timeout(" modules/fedimint-mintv2-client/src/api.rs
# THE STAKE LOCK'S LATENCY (2026-10-05; applies on top of the recovery clock): change notes checked once per
# note (a threshold of shares combined, share by share only when that fails); the tweak grinder yields every 4096 tries
# and keeps 200 ready; the change-note work starts a turn after the acceptance; notes counted and chosen by their key's
# denomination byte, only the chosen decoded
patch -p1 < $HERE/fedimint-mintv2-lock-latency.patch
grep -q "CombinedShareThreshold::new" modules/fedimint-mintv2-client/src/api.rs
# ACCEPTED ONCE f + 1 GUARDIANS SAY SO (normal since, 2026-10-06 14:33): the client's await_transaction
# stops at f + 1 = 3 of 7 identical answers instead of n - f - an honest guardian answers only after consensus (still 5 of 7)
# accepted the transaction, so the f a federation tolerates cannot make it up alone
patch -p1 < $HERE/fedimint-client-accept-f1.patch; grep -q "fn one_honest" fedimint-api-client/src/query.rs
# A READ THAT RUNS OUT OF PEERS IS AN ERROR, NOT A PANIC (measured live 2026-10-06 12:39Z): the stake lock's
# stored-contract read waits for all n answers; a guardian whose request failed (fewer than f + 1 failed) left fedimint's
# request_with_strategy with no futures and it panicked, killing the lock client. Now it returns the peers' errors.
patch -p1 < $HERE/fedimint-api-client-no-exhaust-panic.patch; grep -q "kanban #196" fedimint-api-client/src/api/mod.rs
# THE ACCEPTANCE AWAITED BESIDE THE SUBMISSION (opt-in ARENA_AWAIT_PARALLEL=1): not after a threshold of submit
# answers, which the guardians give only once the transaction is accepted
# THE TWEAK GRINDER YIELDS FOR REAL (opt-in ARENA_GRINDER_YIELD=1): sleep(0) is ready at its first poll on wasm
# (n0_future), so the grinder held the client's one thread for a whole tweak (~65536 tries, ~250 ms) - the acceptance waited
# behind it (measured: 5 of 7 guardian answers arriving at once after a 220-280 ms gap). A 1 ms sleep every 1024 tries.
if [ -n "${ARENA_GRINDER_YIELD:-}" ]; then
  F=modules/fedimint-mintv2-client/src/lib.rs
  grep -q "if tries % 4096 == 0 {" $F
  perl -0pi -e 's/if tries % 4096 == 0 \{\n(\s*)fedimint_core::task::sleep\(Duration::ZERO\)\.await;/if tries % 1024 == 0 {\n$1fedimint_core::task::sleep(Duration::from_millis(1)).await;/' $F
  grep -q "if tries % 1024 == 0 {" $F && grep -q "sleep(Duration::from_millis(1))" $F
fi
# THE CHANGE NOTES CHECKED IN ONE BATCH ("BATCH 2", normal since): a threshold of answers gathered first, all
# combined blinded signatures checked in one random-linear-combination batch with 128-bit factors, each note's combined
# signature made once (kept from the checked batch for the output state machine); a batch that fails falls back to the
# share-by-share check, as before. The earlier variants (ARENA_NOTE_YIELDS, ARENA_NOTE_BATCH) patch the same lines.
if [ -n "${ARENA_NOTE_YIELDS:-}${ARENA_NOTE_BATCH:-}" ]; then echo "ARENA_NOTE_YIELDS/ARENA_NOTE_BATCH: replaced by the batch every build applies (#196)" >&2; exit 2; fi
patch -p1 < $HERE/fedimint-mintv2-note-batch2.patch; grep -q "static COMBINED" modules/fedimint-mintv2-client/src/api.rs
# A NEW WALLET'S FIRST RECEIVE IS AS QUICK AS A TOP-UP (kanban #1381, Daniel 2026-11-09 "it is very slow on new accounts"; measured: the welcome's 500 sat
# credited 15-20 s after the faucet paid, a 300 sat top-up into the same wallet 1.6-1.9 s). Every transaction's rebalance stocks the wallet up to
# TARGET_PER_DENOMINATION (3) notes of every denomination from 1 msat up; an empty wallet's first receive asked ~50 notes (its claim 8432 bytes, the
# top-up's 1670), each needing a ground tweak (~65536 SHA-256 tries) the grinder had not made yet - 9.5 s before the claim, then 5.5 s of share checks.
# The stock is only for later spends: it now takes at most half the tweaks already ground; the notes the amount needs are made as before.
F=modules/fedimint-mintv2-client/src/lib.rs
grep -q "let n_missing = TARGET_PER_DENOMINATION.saturating_sub(n_denomination as usize);" $F
perl -pi -e 's/^(\s*)let n_denominations = self\.get_count_by_denomination_dbtx\(dbtx\)\.await;$/$1let n_denominations = self.get_count_by_denomination_dbtx(dbtx).await;\n$1let mut blwp_stock_budget = self.tweak_receiver.len() \/ 2;   \/\/ kanban #1381/' $F
perl -pi -e 's/let n_missing = TARGET_PER_DENOMINATION\.saturating_sub\(n_denomination as usize\);/let n_missing = TARGET_PER_DENOMINATION.saturating_sub(n_denomination as usize).min(blwp_stock_budget);\n            blwp_stock_budget -= n_missing;/' $F
grep -q "let mut blwp_stock_budget = self.tweak_receiver.len() / 2;" $F && grep -q "blwp_stock_budget -= n_missing;" $F
if [ -n "${ARENA_AWAIT_PARALLEL:-}" ]; then patch -p1 < $HERE/fedimint-client-await-parallel.patch; grep -q "drop(tx_submitted)" fedimint-client-module/src/transaction/sm.rs; fi
grep -n "(0..42).map(Denomination)" modules/fedimint-mintv2-common/src/config.rs | wc -l | tr -d ' ' | grep -qx 2
# PENDING OUTPUTS (spec 23A.5 "Notes still in issuance at the halt"): the wallet names what was issued to its seed
# and never signed, for a liquidation's pending-output claim - mintv2's own recovery scan, as a method
grep -q "fn blwp_pending_outputs" modules/fedimint-mintv2-client/src/lib.rs || cat $HERE/mintv2-pending-outputs.rs >> modules/fedimint-mintv2-client/src/lib.rs
# NOTES IN ISSUANCE: what the wallet's pending output state machines are being issued - a recovery's re-issue, a
# deposit's notes, a payment's change - which the balance does not count until each finishes
grep -q "fn blwp_issuing_msat" modules/fedimint-mintv2-client/src/lib.rs || cat $HERE/mintv2-issuing.rs >> modules/fedimint-mintv2-client/src/lib.rs
grep -q "fn blwp_issuing_detail" modules/fedimint-mintv2-client/src/lib.rs || cat $HERE/mintv2-issuing-detail.rs >> modules/fedimint-mintv2-client/src/lib.rs
# STUCK OUTPUTS (kanban #910): a machine whose transaction state was lost can be asked at the federation and ended, and what the seed was issued comes back
grep -q "fn blwp_recover_stuck" modules/fedimint-mintv2-client/src/lib.rs || cat $HERE/mintv2-recover-stuck.rs >> modules/fedimint-mintv2-client/src/lib.rs
grep -q "BLWP_GIVEN_UP" modules/fedimint-mintv2-client/src/output.rs || perl -0pi -e 'BEGIN { open F, "<", shift @ARGV; local $/; $r = <F>; } s/global_context\s*\.await_tx_accepted\(range\.txid\)\s*\.await\?;/$r/' $HERE/mintv2-stuck-output.txt modules/fedimint-mintv2-client/src/output.rs
grep -q "BLWP_GIVEN_UP" modules/fedimint-mintv2-client/src/output.rs
ln -sfn $HERE blwp-lock-client
grep -q '"blwp-lock-client"' Cargo.toml || perl -0pi -e 's/^members = \[/members = [\n  "blwp-lock-client",/m' Cargo.toml
export CC_wasm32_unknown_unknown=$B/wasi-sdk/bin/clang AR_wasm32_unknown_unknown=$B/wasi-sdk/bin/llvm-ar
export CFLAGS_wasm32_unknown_unknown="--target=wasm32-unknown-unknown"
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='--cfg getrandom_backend="wasm_js"'
cargo build --release --target wasm32-unknown-unknown -p blwp-lock-client
mkdir -p $B/out && $B/wasm-bindgen/wasm-bindgen --target web --out-dir $B/out target/wasm32-unknown-unknown/release/blwp_lock_client.wasm
ls -la $B/out
echo BUILD-OK
