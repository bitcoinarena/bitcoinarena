# Release builds

`build-release.sh <version> <os> <arch> <out> <commit>` builds one node archive from one commit:
the commit's tracked files (`git archive`), pinned npm dependencies, and pinned downloads
(Node, cloudflared, Tor, and the custody binaries) checked against their SHA-256. The archive
is written as tar with a fixed owner, file order and mtime and `gzip -n` (zip on Windows).
`sign-part.mjs` signs `SHA256SUMS` with one release key, `combine-sigs.mjs` checks that 2 of the 3 keys signed (below).

## Sign a release: 2 of 3 keys (kanban #3920)

A node installs a release only when `SHA256SUMS` carries valid Ed25519 signatures from at least **2 distinct keys** of the
pinned key set (`PINNED_KEYSET` in `packages/arena-installer/src/release-verify.js`):

| Key | Public key | Held by |
|---|---|---|
| key 1 | `ce8d1ee7c371883e7c2e843f243ee6c648d3952a14f9e1eabf71e8cc5a90c892` | the owner, encrypted, on his MacBook (the key of every release before #3920) |
| key 2 | `7ef3d6e6471b36e771da1e6e29432907ef22e35e422e8bf2893d55cec5c4c78e` | the code session's signer |
| key 3 | `5fca22462162d1b75cea8cee12684243eac20ddaba11466c6dc392e5b6c7fe95` | the third key holder |

Files of a signed release, beside the assets:

- `SHA256SUMS.sigs` - one line per key: `<public key hex> <signature base64>`. What a 2-of-3 node reads.
- `SHA256SUMS.sig` - key 1's signature alone, base64. What a node from before #3920 reads (it trusts only key 1).
- `KEYSET-<seq>.json` - only after a key rotation (below); `download.json` names them in `keysets`.

Steps (no key ever on a live host, kanban #3553):

1. Each holder, on his own machine, with his own key:
   `node tools/release/sign-part.mjs <dir>/SHA256SUMS <key.pem>` - writes `<dir>/SHA256SUMS.sig-<first 16 hex of the key>`.
   An encrypted PKCS#8 pem asks for its passphrase on the terminal (no echo, never stored); an unencrypted pem must be mode 600.
   Plain Node crypto: it works on macOS, whose openssl (LibreSSL) has no Ed25519. `--encrypt <plain pem> <out pem>` encrypts a key.
2. Bring the `.sig-*` parts (public data) into one directory with `SHA256SUMS` and run
   `node tools/release/combine-sigs.mjs <dir>` - it keeps the parts that verify with a key of the set, writes `SHA256SUMS.sigs`
   and `SHA256SUMS.sig` (key 1's), checks the result as a node does and **exits 1 below 2 keys: then nothing is published**.
   It warns when key 1's part is missing: nodes from before #3920 would refuse that release.
   `--check` checks what is there without writing.
3. `latest.json` the same way: `sign-part.mjs <out>/latest.json <key>` per holder, then `combine-sigs.mjs <out> latest.json`
   (a node offers a release when `latest.json.sig` verifies with one key of the set - an offer only; the install needs 2).
4. `unlisted.mjs` copies `SHA256SUMS`, `SHA256SUMS.sig`, `SHA256SUMS.sigs` and any `KEYSET-*.json` beside the pieces and names them
   in `download.json`.

**The transition (the first 2-of-3 release).** Every node from before #3920 verifies only `SHA256SUMS.sig` with key 1. So the
release that brings the 2-of-3 verifier MUST be signed by key 1 (its `SHA256SUMS.sig` and `latest.json.sig`), or those nodes never
update again; and it must already carry a second key in `SHA256SUMS.sigs`, so the nodes it creates accept the next release. Keep
key 1 in every release until no node older than the transition release is left. A release signed only by key 2 and key 3 is
accepted by 2-of-3 nodes and refused by older ones (combine-sigs says so).

**Rotation (changing the key set).** Write `KEYSET-<seq>.json` = `{ "arenaReleaseKeyset": 1, "seq": <current + 1>, "threshold": 2,
"keys": [ ...64-hex public keys ] }`; at least 2 holders of the CURRENT set run `sign-part.mjs --keyset KEYSET-<seq>.json <key>`;
`combine-sigs.mjs <dir> --keyset KEYSET-<seq>.json` merges the parts into its `sigs` and exits 1 unless 2 keys of the current set
signed. Publish it with the next release (`download.json` `keysets`); a node checks the chain from the newest set it knows, keeps
the new set in `<home>/release-keyset.json` and never goes back to a lower seq. The signatures cover
`arena-release-keyset/1\n` + the JSON of `{ arenaReleaseKeyset, seq, threshold, keys }`, never the bytes of a `SHA256SUMS`.
A threshold below 2 is refused. The next release's code should pin the new set too (`PINNED_KEYSET`, its seq).

`sign.sh <dir> <key.pem> [file]` only runs `sign-part.mjs` (one key; it has no default key path any more).

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
were built on the older build machine. They were built again on the main build machine from the same commit,
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
fetched from the `custody-5fa01c5d` release. They were built once, on the main build machine
(`custody-build.sh`). The only other build machine is kept free of extra jobs, so no second build was made, and the SHA-256 of those binaries has
**not** been compared with an independent build. The same holds for the lock-client wasm
tracked in the repository. Until such a comparison exists, a release is reproducible only
from those pinned binaries, not from their Rust source.

Not reproducible by construction, and not claimed: the DMGs, the Windows installer and the
Debian packages (packaging steps after the archives), the web page, and the Unity WebGL client.

No public page may say more than this file does.
