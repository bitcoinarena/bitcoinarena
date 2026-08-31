# BLWP v4.6.1 — Pure Node.js Implementation Design

Written 2026-08-31. **Design document only — nothing here is implemented.**

This describes, in concrete engineering terms, how I would build the
providerless protocol specified in `multiplayer_p2p.md` (BLWP v4.6.1) as an
**all-JavaScript system**: the daemon, the protocol library, the browser
client, the threshold cryptography, and — the interesting part — the
deterministic simulation core itself. No Rust, no WASM toolchain, no native
addons.

Read `multiplayer_p2p.md` first; this document assumes its vocabulary
(census, committee, Entry Contract, checkpoint, objection window, hold
invoice, VSS shares) and only says *how*.

> **On the language choice.** An earlier draft of this plan put the
> deterministic core in Rust/WASM. The decision is to do it in JavaScript,
> and this document builds that properly rather than half-heartedly.
> JavaScript *can* be bit-deterministic — §3 is the design that makes it so,
> §3.7 is the enforcement that keeps it so, and §14 is honest about what the
> choice costs. Everything money-relevant is integer arithmetic, `BigInt`
> where width demands it, and the mechanism that catches a mistake is a
> cross-engine hash comparison in CI rather than a compiler.

---

## 1. Scope: everything is JavaScript

| Component | Runtime | Notes |
|---|---|---|
| `blwp-node` daemon (all roles) | Node 24 LTS | websockets, HTTP, Bitcoin RPC, Lightning gRPC, `node:sqlite` |
| Protocol library (encoding, hashing, contracts, census, sortition, payout, VSS, FROST) | Isomorphic JS | **The same file runs in the browser and in the node** |
| Deterministic simulation core | Isomorphic JS | Integer/fixed-point only (§3) |
| Browser client, Unity bridge, wallet | JS | Same protocol package |
| Threshold signing (FROST) | Pure JS on `@noble/curves` | RFC 9591, §9.3 |

**Dependency policy.** "Native Node.js" is taken to mean: no other language
in the build, no compiled addons, no WASM. Where the Node standard library
suffices it is used (`node:sqlite`, `node:crypto`, `node:worker_threads`,
`node:test`). Where a shared browser/node implementation is needed, only
audited pure-JS packages are used — `@noble/curves`, `@noble/hashes`,
`@noble/ciphers`. No `node-gyp`, ever.

**On `BigInt`.** Native `BigInt` is used, not a library. `bigint.js`,
`big-integer` and `bignumber.js` all predate native BigInt and exist to
support engines that lack it; every target here (Node 18+, Chrome, Firefox,
Safari, Edge) has had it since 2020. Native BigInt is exact, arbitrary
precision, and — importantly — has no library version that could change
behaviour under a protocol hash. Where BigInt is too slow (§3.2) the answer
is a different integer representation, not a different library.

---

## 2. Repository layout

npm workspaces, one repo, one language.

```
blwp/
  package.json                    # workspaces, "type": "module", node >= 24
  packages/
    core/                         # @blwp/core — THE DETERMINISTIC SIMULATION
      src/
        fixed.js                  # Q16.16 fixed-point primitives (§3.2)
        tables.js                 # GENERATED, COMMITTED sine/atan tables (§3.4)
        rng.js                    # xoshiro128** (§3.3)
        state.js                  # ArrayBuffer layout, views, hashing (§3.5)
        sim.js                    # tick(), the only public entry point
        rules/
          terrain.js  roads.js  vehicle.js  army.js
          damage.js   cargo.js   gate.js    score.js
      tools/
        gen-tables.js             # run ONCE by a human, output committed
        check-determinism.js      # AST guard, runs in CI (§3.7)
      test/
        vectors/                  # golden input logs -> expected state hashes
    protocol/                     # @blwp/protocol — isomorphic
      src/
        encode.js  hash.js  keys.js  contracts.js
        census.js  sortition.js  payout.js
        vss.js     frost.js   messages.js  constants.js
      test/vectors/
    node/                         # blwp-node — the daemon
      src/
        index.js                  # CLI, config, role wiring
        chain/  census/  rounds/  entries/  ingest/
        store/  replay/  results/ payout/   settlement/
        api/    metrics/
    client/                       # @blwp/client — browser
      src/session.js  wallet-nwc.js  unity-bridge.js
    replayer/                     # blwp-replay — standalone CLI verifier
  test-vectors/                   # cross-implementation fixtures
```

Two rules that keep this honest:

1. **`@blwp/core` and `@blwp/protocol` import nothing from `node:`.** The
   identical files run in the browser. Anything platform-specific is
   injected by the caller.
2. **Nothing outside those two packages computes a protocol hash or a
   simulation step.** If a hash is computed in two places, it will eventually
   be computed two ways.

---

## 3. The deterministic core in JavaScript

This is the heart of the system and the part that has to be right.

### 3.1 What is and is not deterministic in JavaScript

The reputation of JS as non-deterministic is only half earned. Precisely:

**Exactly specified by ECMAScript, identical in every conforming engine:**

- Integer arithmetic on Numbers, as long as every operand *and every result*
  is an exact integer with |value| < 2^53. IEEE-754 doubles represent such
  integers exactly, and `+`, `-`, `*` on them are exact.
- Bitwise operators (`|`, `&`, `^`, `<<`, `>>`, `>>>`) — defined as 32-bit
  integer operations with specified wrapping.
- `Math.imul` — 32-bit multiply, exactly specified.
- `Math.abs`, `Math.min`, `Math.max`, `Math.floor`, `Math.trunc`, `Math.sign`.
- Division and multiplication **by powers of two**: exact in IEEE-754, since
  they only adjust the exponent.
- All of `BigInt`.
- Typed array stores: writing to an `Int32Array` applies `ToInt32`, which is
  specified.

**Not safely deterministic across engines:**

- `Math.sin`, `cos`, `tan`, `atan`, `atan2`, `exp`, `log`, `pow`, `sqrt`,
  `cbrt`, `hypot`. The spec explicitly permits implementation-defined
  approximations. V8, SpiderMonkey and JavaScriptCore use different libm
  paths and *do* differ in the last bits.
- General floating-point arithmetic where results are not exact integers —
  correctly rounded per operation, but the moment you build a physics step on
  it, operand ordering, compiler reassociation and denormal handling make
  reasoning about equality impractical.
- `Math.random`, `Date.now`, `performance.now`, iteration order of `Set`
  built from floats, `Array.prototype.sort` comparator ties (stable since
  ES2019, so this one is actually fine).

**The design follows directly:** the core uses only the first list. Not a
single floating-point operation appears in settled state, and none of the
transcendental functions is ever called.

### 3.2 Fixed-point representation

**Q16.16 signed, stored in `Int32Array`.** One unit = 1/65536. Range
±32768, which comfortably covers a 260 × 170 m map, velocities, angles and
health.

```js
// packages/core/src/fixed.js — sketch, not implementation
export const SHIFT = 16;
export const ONE   = 1 << SHIFT;              // 65536
export const HALF  = ONE >> 1;

export const fromInt = (n) => (n << SHIFT) | 0;
export const toInt   = (x) => x >> SHIFT;      // arithmetic shift = floor
export const add     = (a, b) => (a + b) | 0;
export const sub     = (a, b) => (a - b) | 0;
export const neg     = (a)    => (-a) | 0;
```

Multiplication is the only genuinely interesting operation. `a * b` in
Q16.16 needs `(a * b) >> 16` with a 64-bit intermediate, and a 32-bit × 32-bit
product does not fit in a Number.

```js
// Fast path: |a|, |b| < 2^26  =>  |a*b| < 2^52 < 2^53, exact as a Number.
// Dividing by 65536 is a power of two, hence exact. `| 0` truncates toward
// zero, which is the documented rounding rule of this core.
export function mulFast(a, b) {
  return ((a * b) / ONE) | 0;
}

// General path: exact for the full Int32 range, via BigInt.
export function mulWide(a, b) {
  return Number((BigInt(a) * BigInt(b)) >> 16n) | 0;
}
```

The rule in the codebase: **`mulFast` is used only where a range invariant is
documented at the call site**, and a debug build (`BLWP_ASSERT=1`) checks
that invariant on every call. Where a magnitude cannot be bounded — accumulated
distances, score terms, anything derived from cargo value — `mulWide` is used
and the cost is accepted.

Division and square root are integer algorithms, never `Math.sqrt`:

```js
export function div(a, b) {                    // exact, truncating
  if (b === 0) throw new Error('BLWP: division by zero in core');
  return Number((BigInt(a) << 16n) / BigInt(b)) | 0;
}

export function sqrt(x) {                      // integer Newton–Raphson
  if (x <= 0) return 0;
  let r = x, prev;
  do { prev = r; r = ((r + div(x, r)) >> 1) | 0; } while (r < prev);
  return prev;
}
```

**Money never touches this.** Satoshis and millisatoshis are `BigInt`
throughout the protocol package and never enter the core at all — the core
computes a *score*, and the payout function (§6) converts scores to money in
integer msat. Keeping the two number systems apart is deliberate: fixed-point
is for physics, BigInt is for money, and nothing is both.

### 3.3 Randomness

`xoshiro128**`, four 32-bit words of state, implemented with `Math.imul` and
shifts — fast, well-studied, and exactly reproducible:

```js
// packages/core/src/rng.js — sketch
export function next(s) {                       // s: Int32Array(4)
  const r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9);
  const t = s[1] << 9;
  s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
  s[2] ^= t;    s[3] = rotl(s[3], 11);
  return r >>> 0;                               // uint32
}
```

Seeding: the player sub-seed (32 bytes, from `H(round_randomness ‖ pubkey ‖
secret ‖ join_tick)`) is expanded into the four words with `splitmix32`. The
**draw order is part of the protocol** and must be documented rule by rule —
two implementations that draw the same numbers in a different order produce
different worlds. Every rule module therefore takes an explicit stream
handle rather than reaching for a global.

### 3.4 Trigonometry by table — and one trap worth naming

Angles are Q16.16 **turns** (0 … 65536 = full circle), which makes wrapping a
free `& 0xFFFF`. Sine comes from a 4096-entry quarter-wave table of Int32
values with linear interpolation between entries; cosine is a phase shift;
`atan2` is integer CORDIC.

The trap, and it is a real one:

> **The table must be a committed source literal, not computed at startup.**
> Generating it with `Math.sin()` on first run would reintroduce exactly the
> cross-engine dependence the whole design exists to avoid — the table would
> differ by one ULP between Chrome and Safari, and the divergence would
> appear only after several minutes of play.

`tools/gen-tables.js` is therefore run once, by a human, and its output is
committed as `src/tables.js`. The determinism guard (§3.7) fails the build if
`tables.js` is ever regenerated as part of a build step, and the file's hash
is part of `sim_wasm_hash` (§3.6) like any other source.

### 3.5 State layout and hashing

All simulation state lives in **one `ArrayBuffer`** with a documented, fixed
layout and typed-array views over it:

```
offset  size  content
0       4     tick
4       4     rng[0..3]
20      64    truck: x, y, heading, vx, vy, angVel, hp, cargoMask, ...
84      N*24  units[]: x, y, state, target, cooldown, hp, ...
...           terrain digest, cargo, gate flags, score accumulators
```

Two properties fall out of this that are worth the constraint:

- **Hashing is trivial and canonical.** `sha256(new Uint8Array(buffer))` —
  no serialization step, no field ordering question, nothing to get wrong
  between implementations.
- **A float cannot hide.** Storing `1.5` into an `Int32Array` slot silently
  becomes `1`; there is nowhere in the state for a fractional value to live.
  Combined with per-100-tick hashing in tests, a leaked float shows up as a
  hash mismatch immediately rather than as a rare desync.

Snapshots for crash recovery are `structuredClone` of the buffer, or just a
byte copy — the state has no object graph.

### 3.6 Versioning

The field named `sim_wasm_hash` in the Round Contract keeps its name for
protocol compatibility but now means: **sha256 over the canonical
concatenation of every source file in `@blwp/core`**, in sorted path order,
including `tables.js`. `tools/hash-core.js` prints it; CI publishes it; the
client checks a round's value against its known-good list (spec §5).

An alternative worth considering later is shipping the core as a single
bundled, minified file and hashing that — simpler to verify, but it makes the
hash depend on the bundler version, which is a bad property for something
that pins money. Sorted source hashing has no toolchain in the trust path.

### 3.7 Keeping floats out — enforcement, not discipline

Rules that depend on reviewer attention will eventually fail. Four layers,
in increasing order of strength:

1. **ESLint** over `packages/core/src/**`: ban `Math.*` except a whitelist
   (`imul`, `abs`, `min`, `max`, `floor`, `trunc`, `sign`); ban `Date`,
   `performance`, `Math.random`; require `use strict` semantics via modules.
2. **AST guard** (`tools/check-determinism.js`, ~120 lines on `acorn`), run
   in CI and as a pre-commit hook. It walks every core source file and fails
   on: a numeric literal containing `.` or `e`; a `/`, `*` or `%` operator
   outside a whitelisted helper file; any `Math` member not in the whitelist;
   any `import` from outside `@blwp/core`. This is stronger than lint because
   it cannot be silenced with an inline comment.
3. **Poison tests.** The test harness monkey-patches `Math.sin`, `cos`,
   `tan`, `pow`, `exp`, `log`, `sqrt`, `random` and `Date.now` to throw, then
   runs the full corpus. If any of them is reachable, the tests explode
   rather than quietly diverging.
4. **Cross-engine harness (§13).** The final backstop and the only one that
   catches a genuinely novel engine difference.

---

## 4. Canonical encoding

Every signature, Merkle leaf and `round_id` is a hash over bytes. Two
implementations that serialize differently compute different `round_id`s and
the protocol silently forks.

**Decision: hand-written fixed-layout binary encoding.** Not JSON — key
order, number formatting, `-0` and unicode escaping are unspecified enough
that `JSON.stringify` is not a specification. Not canonical CBOR — defensible
in principle, but every library has its own reading of "canonical", and a
library upgrade must never change a `round_id`. A hand-written encoder is
~300 lines with no dependencies and is trivially portable.

```js
// packages/protocol/src/encode.js — sketch
const w = new Writer();                    // growable Uint8Array
w.u8(TYPE_ROUND_CONTRACT);
w.u16(PROTOCOL_VERSION);
w.bytes32(simCoreHash);
w.u64(startTimeMs);                        // BigInt in, 8 bytes big-endian out
w.u32(censusHeight);
w.bytes32(censusRootGameVerify);
w.vec(nodes, (n) => w.bytes32(n.pubkey));  // u16 count, then items
```

Rules the encoder enforces itself:

- Fixed-width big-endian integers. **No `Number` above 2^53 anywhere** —
  amounts, timestamps and heights are `BigInt`, encoded as `u64`.
- UTF-8 strings with a `u16` length prefix; unpaired surrogates rejected.
- Arrays carry a `u16` count and must arrive **pre-sorted** where the
  protocol says so; the encoder asserts the ordering rather than sorting
  silently, so a caller that forgot cannot produce a valid-looking artifact.
- Every hash is **tagged**, BIP-340 style:
  `H_tag(x) = sha256(sha256(tag) ‖ sha256(tag) ‖ x)` with tags such as
  `"BLWP/v1/RoundContract"`. Cross-type collisions become impossible.

`test-vectors/` holds, per type, a description plus expected hex and hash.
Any second implementation is correct iff it reproduces them.

---

## 5. Crypto, all pure JS

| Purpose | Package | Note |
|---|---|---|
| ed25519 sign/verify | `@noble/curves/ed25519` | ~1.5k sig/s in Node; the protocol needs ~1 per player per second |
| x25519 ECDH (VSS share encryption) | `@noble/curves/ed25519` | |
| XChaCha20-Poly1305 | `@noble/ciphers/chacha` | 24-byte nonce, no reuse footgun |
| SHA-256 | `@noble/hashes/sha2` in shared code; `node:crypto` in daemon hot paths | Identical output |
| secp256k1 + Schnorr (bonds, FROST) | `@noble/curves/secp256k1` | |
| Bitcoin transactions | `bitcoinjs-lib` (pure JS) | Taproot script paths (§9.1) |

Session keys: each run generates an ephemeral ed25519 keypair in the browser,
certified by the player's entry key inside the Entry Contract, so the
long-term key is used once per entry and never per checkpoint.

---

## 6. Census, sortition, payout

### 6.1 Census by verification, not scanning

The spec (§5A.2–5A.4) derives the census from chain state. The literal
reading — scan the whole chain for outputs matching the bond template — needs
a custom index. The implementation inverts it for the identical result set:

> Nodes **announce** their bond outpoint; the daemon **verifies** each
> announcement against the chain. An unannounced bond is invisible anyway,
> because the advertisement body it commits to could not be retrieved.

```js
// packages/node/src/chain/verifyBond.js — sketch
const txout = await rpc.gettxout(txid, vout, false);          // unspent?
if (!txout) return reject('spent_or_missing');
if (tipHeight - txout.height + 1 < CENSUS_CONFIRMATIONS) return reject('immature');
if (txout.height > censusHeight) return reject('after_cutoff');
if (!matchesBondTemplate(txout.scriptPubKey, ad)) return reject('script');
const committed = await readCommitment(txid);                 // OP_RETURN / taproot leaf
if (!equalBytes(committed, taggedHash('BLWP/v1/Advert', encodeAdvert(ad))))
  return reject('commitment');
```

Chain access: `bitcoind` RPC for node operators (a node operator running a
Bitcoin node is a reasonable expectation, and it is the only self-sufficient
option). Esplora REST or Electrum for development and for the browser, with
two independent providers required to agree.

Canonicalization then follows the spec exactly: filter, **sort by
`(txid, vout)`**, Merkle-root the leaves. Sorting by `H(node_pubkey)` — as
pre-4.6.1 drafts said — is grindable, because a node can mine a pubkey that
lands wherever it likes; a txid cannot be chosen after funding. The code
should carry that comment, because the weaker version looks equivalent.

Census results are immutable per `census_height`: compute once, cache in
SQLite, never recompute.

### 6.2 Sortition

```js
// packages/protocol/src/sortition.js — sketch
export function selectCommittee({ entries, committeeSeed, role, slots, bondMin }) {
  const scored = entries.filter(e => e.roles.includes(role)).map(e => ({
    entry:  e,
    ticket: bytesToBigInt(taggedHash('BLWP/v1/Ticket',
              concat(committeeSeed, encodeOutpoint(e.outpoint), roleByte(role)))),
    weight: e.bondAmount / bondMin,          // BigInt division, floor, >= 1n — LINEAR
  }));

  // score = ticket / weight, compared WITHOUT dividing:
  scored.sort((a, b) => cmpBigInt(a.ticket * b.weight, b.ticket * a.weight));
  return scored.slice(0, slots).map(s => s.entry);
}
```

Three details that are load-bearing:

- **Never compute `ticket / weight` as a float.** Cross-multiplied BigInts.
  A float comparison here is a consensus bug that only appears when two
  nodes are close in score — the worst possible failure profile.
- **Weight is linear** (`bond / bond_min`). A comment must record *why*
  square root is wrong, because it looks like the obvious anti-whale choice
  and someone will try to reintroduce it: under `sqrt`, four nodes at 1×
  total weight 4 against one node at 4× with weight 2, so splitting a bond
  *doubles* selection chances.
- Settlement selection runs after removing the game/verify winners and their
  declared operator siblings (spec §5A.9), then re-sorts.

### 6.3 Payout

`computePayoutTable(contract, membership, results)` — pure, in the protocol
package, used identically by node, client and replayer.

- **Millisatoshi `BigInt` only.** No float anywhere near money.
- Deterministic remainders: floor each share, distribute leftover msat in
  ascending `H(round_id ‖ pubkey)` order.
- A hard assertion before returning:
  `sum(payouts) + sum(fees) === sum(activated stakes)`. On failure the node
  **refuses to sign** rather than signing something inconsistent. This single
  invariant catches an entire class of mistakes for free.
- Property tests (`fast-check`): sum invariance, tie handling,
  zero-qualifier refund, `VOID` entries neither contributing nor drawing.

---

## 7. Wire protocol and the daemon's network surface

**HTTP (`fastify`)** — cacheable and occasional:

```
GET  /v1/contract/:round_id            RoundContract bytes
POST /v1/contract                      submit -> timestamp receipt (§5A.5)
GET  /v1/census/:height                census list + root
GET  /v1/round/:id/committees          published committees + verification data
POST /v1/entry                         Entry Contract -> EntryReceipt
GET  /v1/round/:id/transcript/:pubkey  transcript for replay/objection
POST /v1/objection                     submit an objection (spec §13A)
GET  /v1/round/:id/results             signed results
GET  /v1/round/:id/payout              signed payout table
GET  /v1/health                        roles, census height, replay throughput
```

**WebSocket (`ws`)** — the per-run hot path, binary frames from
`@blwp/protocol/messages`, never JSON:

```
C -> S  HELLO       { round_id, player_pubkey, session_pubkey, entry_proof }
C -> S  INPUT_BATCH { first_tick, last_tick, inputs[], prev_hash }   10 Hz, ~30 B
C -> S  CHECKPOINT  { tick, state_hash, input_chain_hash, prev, sig } 1 Hz, ~150 B
S -> C  RECEIPT     { checkpoint_hash, received_at, node_sig }
S -> C  GHOSTS      { entries[] }                                     5 Hz
S -> C  NOTICE      { kind, payload }        // equivocation, void, finality
```

Practical concerns the implementation must handle:

- **Backpressure.** `ws` buffers without limit. Watch `bufferedAmount`; above
  a threshold drop **ghost** frames first — they are non-authoritative by
  definition — and never receipts.
- **Loss and ordering.** Batches are tick-numbered and idempotent; a repeat
  is a no-op, a gap is filled by the contract's neutral-input policy. The
  daemon never requests retransmission: publishing is the client's duty, and
  unpublished inputs cost the player the run.
- **Quotas.** A funded entry is required before the node stores one byte of
  transcript. Disk is spent only on stakes that exist — the main anti-DoS
  lever.
- **Clocks.** `Date.now()` for receipt timestamps (wall clock, NTP-synced),
  `performance.now()` for intervals. Mixing them is a quiet source of skew.

Ghost fan-out uses interest management: each connection subscribes to ~20
others (nearest plus leaderboard top), recomputed every few seconds — O(N·K),
never O(N²).

---

## 8. Storage

**`node:sqlite`** — built into Node 24, no addon, no `node-gyp`. Synchronous,
transactional, single file, one writer (the daemon owns its database).
`better-sqlite3` remains a drop-in fallback if a specific feature is missing,
at the cost of a native build.

```sql
CREATE TABLE rounds      (round_id BLOB PRIMARY KEY, contract BLOB, census_height INT, state TEXT);
CREATE TABLE census      (height INT, role TEXT, root BLOB, entries BLOB, PRIMARY KEY (height, role));
CREATE TABLE entries     (round_id BLOB, player BLOB, contract BLOB, payment_hash BLOB,
                          state TEXT, join_tick INT, PRIMARY KEY (round_id, player));
CREATE TABLE checkpoints (round_id BLOB, player BLOB, tick INT, state_hash BLOB,
                          input_chain_hash BLOB, sig BLOB, received_at INT,
                          PRIMARY KEY (round_id, player, tick));
CREATE TABLE results     (round_id BLOB, player BLOB, result TEXT, score INT,
                          transcript_hash BLOB, sigs BLOB, final_at INT,
                          PRIMARY KEY (round_id, player));
CREATE TABLE objections  (id INTEGER PRIMARY KEY, round_id BLOB, player BLOB,
                          artifact_path TEXT, verdict TEXT);
CREATE TABLE settlement  (round_id BLOB, player BLOB, state TEXT, preimage BLOB,
                          invoice TEXT, updated_at INT, PRIMARY KEY (round_id, player));
```

The primary key on `checkpoints` is doing real work: inserting a second,
different checkpoint for the same `(round, player, tick)` violates it, and the
conflict handler turns the pair into an **equivocation proof** (spec §13B)
instead of silently overwriting.

**Input logs are files, not rows.** `transcripts/<round>/<player>.log`,
length-prefixed records appended, with SQLite holding only offsets. A
1,000-player round is ~180 MB of transcript; SQLite is the wrong container.
A nightly job deletes them once the objection *and* claim windows have closed.

---

## 9. Settlement role

### 9.1 The bond output

`bitcoinjs-lib`, taproot, three spend paths per spec §5A.3B:

```js
const internalKey = musigAggregate(nodeKey, arbitrationAggregate);   // key path
const recovery = script.compile([                                     // path A
  bip65Encode(bondMaturity), OP_CHECKLOCKTIMEVERIFY, OP_DROP,
  toXOnly(nodeKey), OP_CHECKSIG,
]);
const slash = script.compile([                                        // path B
  ...arbitrationKeys.flatMap((k, i) => [toXOnly(k), i === 0 ? OP_CHECKSIG : OP_CHECKSIGADD]),
  arbitrationK, OP_NUMEQUAL,
]);
```

A slashing transaction must additionally carry
`OP_RETURN <H(fraud_proof)> <uri>`. The daemon refuses to co-sign one whose
committed proof it cannot itself retrieve and verify — that refusal is what
makes "slash without cause" detectable rather than theoretical.

### 9.2 VSS custody of the stake preimage

Feldman VSS over the ristretto255 scalar field, pure JS on noble:

```
P is 32 bytes -> split into two 16-byte halves, each a scalar.
For each half: f(x) = a0 + a1*x + ... + a_{t-1}*x^{t-1}, a0 = half.
Commitments C_j = g^{a_j}.
Share for custodian i: (i, f(i)), encrypted to their x25519 key
                       with XChaCha20-Poly1305.
Custodian verifies: g^{f(i)} == prod_j C_j^(i^j)
Reconstruction: Lagrange interpolation at x = 0 over any 5 shares.
```

Custodians verify on receipt and **reject the entry if verification fails** —
a player must not be able to commit a stake whose preimage cannot later be
reconstructed. Field arithmetic comes from noble rather than hand-rolled
BigInt modular code, for constant-time behaviour.

### 9.3 FROST in pure JavaScript

Threshold Schnorr is now specified: **RFC 9591**, *Two-Round Threshold
Schnorr Signatures with FROST*, with the secp256k1 ciphersuite and official
test vectors. That changes the calculus — implementing it is following a
specification with a conformance suite, not inventing protocol.

```
packages/protocol/src/frost.js
  keygen        trusted-dealer for V1; DKG (RFC 9591 Appendix) for V2
  commit()      round 1: hiding/binding nonces + commitments
  sign()        round 2: binding factor, group commitment, share
  aggregate()   verify each share, sum into a valid BIP-340 signature
```

Built on `@noble/curves/secp256k1` for scalar and point arithmetic. Roughly
500–700 lines. Ships with the RFC's vectors as tests, and — stated plainly —
**must have external cryptographic review before it holds real money.**
Threshold signature implementations fail subtly, especially around nonce
handling, and a green test suite is not a review.

Operationally, the settlement wallet has two possible shapes:

1. **Threshold-signed Lightning node.** LND with a remote signer whose
   signing is the FROST quorum above. Cleanest architecture; the least mature
   technology; the interface the rest of the daemon codes against.
2. **Federation with a Lightning gateway.** Guardians hold funds under
   threshold consensus; the daemon is an RPC client. Mature today, and a
   valid production shortcut with the same trust statement.

The daemon exposes a `SettlementBackend` interface with implementations
`threshold-lnd`, `federation`, and `lnd-single`. The last is for development
only and must be labelled, in code and in logs, as **custodial** — a single
operator holding the keys while a quorum votes is theatre, and the code
should say so where someone will read it.

Hold invoices come from LND's `invoicesrpc` — `AddHoldInvoice`,
`SubscribeSingleInvoice`, `SettleInvoice`, `CancelInvoice` — over
`@grpc/grpc-js` (pure JS) or `ln-service`.

### 9.4 Settlement state machine

Per entry, persisted, crash-safe, idempotent at every step:

```
AWAITING_INVOICE -> HELD -> (result FINAL)
   qualifying: CANCEL_REQUESTED -> CANCELLED -> PAYOUT_QUEUED -> PAID
   losing:     SHARES_REQUESTED -> PREIMAGE_READY -> SETTLE_REQUESTED -> SETTLED
   void:       EXPIRED            (the refund happened by itself)
```

Every transition is written to SQLite **before** the external call, and
reconciled against LND/the federation on startup. Lightning operations must
be assumed to be interrupted mid-flight; the saving invariant is that a
repeated `settleInvoice` with the same preimage is harmless.

---

## 10. Replay: worker threads

Replay is the only CPU-bound work in the daemon, and it must never block the
event loop that issues checkpoint receipts — a stalled receipt looks to the
protocol like a cadence failure, which is a correctness bug wearing a
performance costume.

```js
const pool = new WorkerPool({
  size: Math.max(1, os.availableParallelism() - 1),
  script: './replayWorker.js',        // imports @blwp/core directly
});
const result = await pool.run({ coreHash, contract, subSeed, inputLogPath });
```

- Each worker imports `@blwp/core` once; the JIT warms up over the first few
  replays, so workers are long-lived and reused rather than spawned per job.
- Priority queue: objected runs first, then top-ranked runs, then the rest.
  When the result window is tight, this ordering keeps the economically
  important runs verified first.
- **Capacity is measured, not assumed** (spec §34). The daemon records
  replay-seconds per simulated-second and publishes it at `/v1/health`; the
  client refuses rounds whose player count exceeds what the committee's
  published throughput supports.
- A replay exceeding a hard time or memory budget is aborted and the
  transcript treated as invalid — this is also the defence against a
  maliciously expensive input log.

**Expected performance, to be measured rather than promised.** Q16.16
integer code in a warm JIT typically lands within 2–4× of native for this
kind of workload; the `mulWide`/`div` BigInt paths are the slow spots, so
keeping them off the per-unit hot path matters. If a Rust core would give
~60× realtime, this design should be expected in the 15–30× range — which
sets the per-round player cap through the spec's formula and is the single
number most worth benchmarking first (§12, stage 0).

---

## 11. The browser side

### 11.1 Unity ⇄ JS

Unity WebGL calls JavaScript through a `.jslib` plugin
(`Assets/Plugins/blwp.jslib`, `mergeInto(LibraryManager.library, {...})`);
JS calls back via `SendMessage`.

- Unity → JS: `BLWP_SubmitInput(tickStart, ptr, len)` — inputs are written
  into a `Uint8Array` view of the Unity heap, no per-frame string
  marshalling.
- JS → Unity: a pre-allocated shared buffer that Unity polls each frame,
  rather than `SendMessage` with base64 at 30 Hz.
- The core runs in JS-land; Unity renders **from** the state it exposes and
  never writes to it except through the input API. Cosmetic suspension,
  particles and camera work stay in Unity exactly as they are today.

### 11.2 Client session flow

`@blwp/client`, using the same protocol and core packages as the daemon:

1. Fetch and validate the RoundContract; check the core hash against the
   client's known-good list; refuse real money on an unknown hash.
2. Wait for `committee_time`; fetch the beacon; **recompute both committees
   locally** with `selectCommittee` and compare — never trust the published
   list.
3. Verify the census root against two independent chain providers.
4. Build the Entry Contract, generate `P`, VSS-share it to the *verified*
   settlement committee.
5. Request the hold invoice; display the full cost breakdown (spec §22A);
   hand it to the wallet.
6. On receipts from ≥5 nodes: start the run.
7. During the run: maintain the input chain, sign checkpoints at 1 Hz, keep a
   local copy of everything.
8. On delivery: emit the terminal checkpoint, then **upload the full
   transcript to ≥2 nodes and a mirror before showing the victory screen** —
   this is what arms the objection veto.

### 11.3 Wallet

NWC via `nostr-tools`: parse the `nostr+walletconnect://` URI, connect to the
relay, send NIP-47 `pay_invoice` / `make_invoice` encrypted to the wallet
service pubkey. Fallback: BOLT11 QR (`qrcode`) plus polling.

The client must display, and no code path may bypass: stake, node fee,
donation (capped, second confirmation above 5%), total, committee identities,
overlap count, and whether any selected operator is declared as playing.

---

## 12. Testing

The project's history is a catalogue of "code correct, thing broken" bugs
caught only by measuring. With a JavaScript core, the harness below is not a
quality nicety — it is the mechanism that replaces the Rust type system.

**1. Cross-engine determinism harness — build this first.** A CI job that
runs a corpus of recorded input logs through `@blwp/core` in Node, and via
Playwright in headless Chromium, Firefox and WebKit, on x86 and ARM. Assert
byte-equal state hashes every 100 ticks. Any divergence fails the build.
Nothing else may be built on top of the core until this is green and stays
green.

**2. Poison tests.** `Math.sin/cos/tan/pow/exp/log/sqrt/random` and
`Date.now` monkey-patched to throw, then the full corpus. Reachability of any
of them is a hard failure.

**3. AST guard** (§3.7) in CI and pre-commit.

**4. Golden vectors** in `test-vectors/`: canonical encodings, tagged hashes,
census roots, committee selections for fixed inputs, payout tables, FROST
(RFC 9591), VSS round-trips. A second implementation is validated against
them.

**5. Property tests** (`fast-check`): payout sum invariance; sortition
frequencies converging to bond weights over 10⁵ rounds; fixed-point identities
(`mulFast` ≡ `mulWide` inside the documented range; `div(mul(a,b),b) ≈ a`
within one ULP of the format); encoder round-trips.

**6. Adversarial integration tests**, each asserting the *specified* outcome:

| Scenario | Must produce |
|---|---|
| Two conflicting checkpoints, same tick | Equivocation proof, `FORFEIT` |
| Fabricated result signed by 5 of 7 | Objection accepted, result overturned, slashing artifact |
| Transcript with withheld inputs | Unverifiable, `FORFEIT` |
| Entry attempted before `committee_time` | Rejected, no receipts |
| Contract with mismatched census root | Rejected by every node |
| Contract published after the beacon | No timestamp receipts, unusable |
| Committee cannot reach 5-of-7 | `VOID`, HTLC expires, refund |
| Node killed mid-round | Recovers from SQLite + transcript files, no double receipts |
| LND restarted mid-settlement | Idempotent reconciliation, no double payment |

**7. Load tests.** Synthetic clients driving 100 and 1,000 concurrent runs
against a seven-node local committee: receipt latency, replay lag, WebSocket
buffer growth, SQLite write throughput.

---

## 13. Operations

- **Runtime:** Node 24 LTS, systemd unit per role,
  `--max-old-space-size` tuned to transcript buffering.
- **Config:** one TOML file plus environment overrides; roles as an explicit
  array (`roles = ["game_verify"]`).
- **Keys:** node identity key at `0600`; the settlement FROST share never on
  the same host as the public web API.
- **Metrics:** `prom-client` — census height, replay throughput and lag,
  receipts/s, objections, settlement state histogram, bond confirmation
  depth, channel liquidity.
- **Logging:** `pino`, structured, `round_id` and `player_pubkey` as
  first-class fields. Preimages and shares are never logged.
- **Backups:** SQLite online backup API; transcripts by file sync. Both must
  survive the objection window, or the node cannot defend its own signatures.

---

## 14. Build order

| Stage | Content | Done when |
|---|---|---|
| 0 | `@blwp/core`: fixed-point, RNG, tables, state, one rule module — plus the cross-engine harness, poison tests and AST guard | Zero divergence across 4 engines × 2 architectures on a 10-minute corpus; **replay throughput measured and published** |
| 1 | Port the remaining game rules from C# into the core | Recorded Unity sessions replay to the same score |
| 2 | `@blwp/protocol`: encoding, hashes, contracts, census, sortition, payout + full vectors | A second implementation could be written from `test-vectors/` alone |
| 3 | `blwp-node` skeleton: HTTP + ws, `node:sqlite`, entry receipts, checkpoint ingest, transcripts | Seven local nodes run a play-money round end to end |
| 4 | Replay pool, result signing, 5-of-7 finality, objection window, equivocation, no-quorum | The adversarial table passes |
| 5 | Chain integration: bond verification, census build, committee publication, timestamp receipts | A contract with a wrong census root is rejected by every node |
| 6 | Unity bridge, `@blwp/client`, NWC wallet | A browser plays a play-money round against real nodes |
| 7 | Settlement: VSS, FROST (+ external review), hold invoices, `SettlementBackend` | Testnet round settles; a killed node recovers without double-paying |
| 8 | Bonds and arbitration on-chain, load tests at 100/1,000, external security review | Real sats at the lowest bracket |

---

## 15. What this choice costs

Stated plainly, so nobody discovers it in month four:

1. **Determinism is enforced by tooling, not by a compiler.** Rust would make
   a float in settled state a type error; here it is an AST-guard rule and a
   CI harness. Those work — but they must exist *before* the core grows, not
   after. That is why they are stage 0 and not stage 5.
2. **The trig tables must never be regenerated at runtime.** §3.4. This is
   the single most likely way for a subtle divergence to enter, because
   generating them looks tidier than committing 4096 numbers.
3. **Replay is slower**, expected 15–30× realtime against ~60× for a native
   core. It costs directly: the round's player cap is derived from it
   (spec §34). Measure it in stage 0 before promising anyone a 1,000-player
   round.
4. **`mulWide` and `div` allocate.** BigInt operations are the hot-path
   hazard; keeping them off per-unit inner loops is a real optimisation task,
   not a micro-optimisation.
5. **BigInt discipline is manual for money.** Nothing stops
   `Number(satoshis)`. Enforced by a lint rule banning `Number()` in
   `packages/protocol` and `settlement`, plus the payout sum assertion.
6. **FROST is a self-implementation.** RFC 9591 plus its vectors makes this
   respectable rather than reckless, but it still needs external review
   before real money (§9.3).

What the choice buys, and it is not small: **one language, one protocol
implementation, one core, shared between the browser and every node.** No
Rust toolchain, no WASM build step, no napi-rs, no `node-gyp`. Canonical
encoding, contract validation, sortition, the payout function and the
simulation exist exactly once — and the places where two implementations
would silently disagree simply have no second implementation to disagree
with.
