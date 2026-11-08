# Release builds

`build-release.sh <version> <os> <arch> <out> <commit>` builds one node archive from one commit:
the commit's tracked files (`git archive`), pinned npm dependencies, and pinned downloads
(Node, cloudflared, Tor, and the custody binaries) checked against their SHA-256. The archive
is written as tar with a fixed owner, file order and mtime and `gzip -n` (zip on Windows).
`sign.sh` signs `SHA256SUMS`.

## Verify a release

1. Check out the release's commit (the tag `v<version>` points at it).
2. For each of `linux x64`, `linux arm64`, `darwin arm64`, `darwin x64`, `windows x64`, run
   `ARENA_RELEASE_PREFIX=bitcoin-arena-node tools/release/build-release.sh <version> <os> <arch> <fresh out dir> <commit>`
   with an empty `ARENA_RELEASE_CACHE`.
3. Compare each line of the new `<out>/SHA256SUMS` with the release's `SHA256SUMS`.

A pinned download whose first host no longer serves it is fetched from its archive URL
(`archive.torproject.org` for Tor, `nodejs.org/download/release` for Node), and is checked
against the same pinned checksum (kanban #1345).

## What has been measured

**2026.1.9.26** (commit `650581bd6e99`, kanban #1345, 2026-11-08). The published archives
were built on the old MacBook. They were built again on the main MacBook from the same commit,
with the same script and an empty download cache. All five archives are byte-identical:

| Archive | SHA-256 (both builds) |
|---|---|
| bitcoin-arena-node-2026.1.9.26-linux-x64.tar.gz | `c2155a318962a099…` |
| bitcoin-arena-node-2026.1.9.26-linux-arm64.tar.gz | `ac94b67cfc0b2f5b…` |
| bitcoin-arena-node-2026.1.9.26-darwin-arm64.tar.gz | `aea53747b0134ff3…` |
| bitcoin-arena-node-2026.1.9.26-darwin-x64.tar.gz | `278e70d766fa6706…` |
| bitcoin-arena-node-2026.1.9.26-windows-x64.zip | `fce02af9a437fcfd…` |

This proves that **assembling** an archive from its commit and its pinned inputs is
reproducible on two machines.

## What has not been proven

**The Rust binaries were not rebuilt on a second machine.** fedimintd, gatewayd,
fedimint-cli and arena-stake-lock enter the archives as prebuilt binaries, pinned by SHA-256 and
fetched from the `custody-5fa01c5d` release. They were built once, on the main MacBook
(`custody-build.sh`). The only other Mac, 192.168.1.18, is barred from extra jobs by the 11-05
no-extra-jobs rule, so no second build was made, and the SHA-256 of those binaries has
**not** been compared with an independent build. The same holds for the lock-client wasm
tracked in the repository. Until such a comparison exists, a release is reproducible only
from those pinned binaries, not from their Rust source.

Not reproducible by construction, and not claimed: the DMGs, the Windows installer and the
Debian packages (packaging steps after the archives), the web page, and the Unity WebGL client.

No public page may say more than this file does.
