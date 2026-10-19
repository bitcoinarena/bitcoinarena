# Bitcoin Arena — Pure Node.js Implementation Design

Written 2026-08-31. **Design document only — nothing here is implemented.**

This describes, in concrete engineering terms, how I would build the
providerless protocol specified in `multiplayer_p2p.md` as an
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

## 1. Scope: JavaScript first, WebAssembly where it earns it

| Component | Runtime | Notes |
|---|---|---|
| `arena-node` daemon (all roles) | Node 24 LTS | websockets, HTTP, Bitcoin RPC, Lightning gRPC, `node:sqlite` |
| Protocol library (encoding, hashing, contracts, census, sortition, payout, VSS, FROST) | Isomorphic JS | **The same file runs in the browser and in the node** |
| Deterministic simulation core | Isomorphic JS | Integer/fixed-point only (§3) |
| Browser client, Unity bridge, wallet | JS | Same protocol package |
| Threshold signing (FROST) | Pure JS on `@noble/curves` | RFC 9591, §9.3 |

**Dependency policy.** No other language in the *build*, no compiled addons,
no `node-gyp`, ever. Where the Node standard library suffices it is used
(`node:sqlite`, `node:crypto`, `node:worker_threads`, `node:test`). Where a
shared browser/node implementation is needed, only audited pure-JS packages
are used — `@noble/curves`, `@noble/hashes`, `@noble/ciphers`.

**On WebAssembly.** An earlier draft banned it outright. That was one
assumption too many, and §1.1 replaces it: WASM is permitted inside the
deterministic core under conditions, because WASM arithmetic is
*specified* where JavaScript's is not. It remains banned everywhere it would
merely be convenient.

### 1.1 When WebAssembly is allowed, and when it is not

The reason the core is fixed-point is narrow and worth restating: in
JavaScript, `Math.sin` and its family are *permitted by the specification* to
be implementation-defined approximations, and V8, SpiderMonkey and
JavaScriptCore genuinely differ in the last bits. Integer arithmetic is
exact; transcendentals are not.

**WebAssembly does not have that problem.** Its floating-point arithmetic is
IEEE-754 with specified rounding, no reassociation, no fused multiply-add in
the core instruction set, and no x87 excess precision. `sin` is not a WASM
instruction at all — it comes from the libm compiled *into* the module, so
every browser executes the same code. A physics engine compiled to WASM can
therefore be bit-identical across engines in a way that the same engine
written in plain JavaScript cannot.

That is a real alternative to hand-building fixed point, and refusing to look
at it would be dogma. It is admitted under five conditions, all of which
exist because WASM's determinism has exactly four holes:

1. **The binary is committed, not built.** The `.wasm` artifact is a checked-in
   file whose hash is part of `sim_wasm_hash`. Nothing in the trust path may
   depend on a toolchain version, a build flag or a package manager
   resolving a range. This is the same rule as the trig tables (§3.4) and for
   the same reason.
2. **No threads, no shared memory, no atomics.** Thread scheduling is
   nondeterministic by construction. A single instance, single-threaded.
3. **No relaxed SIMD.** Ordinary SIMD follows the same IEEE rules and is
   fine; `relaxed-simd` is *explicitly specified as nondeterministic* and is
   the one extension that would silently break everything.
4. **NaN must be impossible, and proven so.** The specification allows
   implementation-defined NaN payloads — the single genuine nondeterminism in
   WASM float. A physics step should never produce NaN, so the core asserts
   on every state hash that no lane is NaN, and the corpus includes inputs
   designed to provoke one.
5. **Host imports are pure.** No `Date.now`, no `Math.random`, no `performance`
   crossing the boundary. The module gets ticks and inputs and nothing else.

Under those five, WASM is allowed in the simulation core. It is **not**
allowed in `@blwp/protocol` — encoding, hashing, contracts, census, sortition
and payout stay pure JS, because those are what a second implementation would
have to reproduce from the test vectors, and a WASM blob is not a
specification anybody can read.

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
    node/                         # arena-node — the daemon
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
  approximations.

  **Measured, 31 August 2026** — 120,000 inputs per function, hashed over the
  exact bit patterns, on arm64:

  | | Node 24 | V8 15.4 | SpiderMonkey | JavaScriptCore |
  |---|---|---|---|---|
  | `sqrt` | agree | agree | agree | agree |
  | `sin` `cos` `tan` | ✗ | ✗ | ✗ | ✗ |
  | `atan2` `exp` `log` `pow` `cbrt` `hypot` | ✗ | ✗ | ✗ | ✗ |

  `sqrt` is the single exception, and for a good reason: IEEE-754 requires it
  to be correctly rounded, so every engine gets it from the hardware.
  Everything else differs.

  The result worth pausing on is the first two columns. **Node 24 and the V8
  15.4 shell disagree** — two builds of the *same engine*.

  Followed up across four Node releases spanning four years of V8:

  | | V8 10.2 | V8 11.3 | V8 12.4 | V8 13.6 |
  |---|---|---|---|---|
  | core, 36,000 ticks | `5d65d265…` | `5d65d265…` | `5d65d265…` | `5d65d265…` |
  | `Math.pow` digest | `0150334f` | `0150334f` | `0150334f` | **`a01870cd`** |

  **V8 changed `Math.pow` between 12.4 and 13.6.** Not a browser difference —
  a version difference, in the wild, in the engine most players run. A
  simulation that called it would have desynced everyone who updated Chrome,
  silently, and only for some inputs.

  The core is unaffected across all four, because it calls none of them. That
  is the whole argument, and `tools/run-versions.sh` is what keeps it true:
  the ten-minute corpus under every installed Node version, requiring one
  hash.

  And the same question again across CPUs, on one V8 version — 13.6:

  | | x86-64 | arm64 |
  |---|---|---|
  | core, 36,000 ticks | `5d65d265…` | `5d65d265…` |
  | `sin` `cos` `tan` `atan2` | ✗ | ✗ |
  | `exp` `log` `pow` | ✗ | ✗ |
  | `sqrt` `cbrt` `hypot` | agree | agree |

  **The same browser build gives different answers on Intel and on Apple
  silicon.** Not a version difference this time — one binary version, two
  instruction sets, seven functions that disagree.

  So there are three questions, not one, and the core has now been measured
  against all three:

  | | script | asks |
  |---|---|---|
  | cross-engine | `tools/run-engines.sh` | do V8, SpiderMonkey and JSC agree? |
  | cross-version | `tools/run-versions.sh` | does one engine agree with itself over time? |
  | cross-arch | `tools/run-arch.sh` | does one engine agree with itself across CPUs? |

  Cross-*browser* divergence was the expected hazard. The other two are worse,
  because no amount of "test on the three engines" catches either — and both
  have now actually been observed.
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
secret is a field of the Entry Contract (2026-09-08), so a node can replay. The
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
// packages/arena-protocol/src/encode.js — sketch
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
earlier drafts said — is grindable, because a node can mine a pubkey that
lands wherever it likes; a txid cannot be chosen after funding. The code
should carry that comment, because the weaker version looks equivalent.

Census results are immutable per `census_height`: compute once, cache in
SQLite, never recompute.

### 6.2 Sortition

```js
// packages/arena-protocol/src/sortition.js — sketch
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
packages/arena-protocol/src/frost.js
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

Operationally, the settlement wallet has **one** shape (2026-09-21,
spec §23.6): a **Fedimint-class federation**. Guardians hold funds under
threshold consensus; the daemon is a Fedimint client that reads locks,
submits the settlement transaction and watches confirmations (spec §23A.4).
The threshold-signed Lightning node (`threshold-lnd`) was measured, found
not buildable on lnd, and withdrawn; the single-operator lnd (`lnd-single`)
was the interim it hid behind and goes with it - the regtest federation
(`FEDERATION.md`, four guardians on one laptop) is the development backend.

The daemon exposes a `SettlementBackend` interface with one implementation,
`federation`. No hold invoices: a deposit is a stock LNv2 receive through a
gateway into the player's wallet (spec §24A.1), a withdrawal a stock LNv2
send, and the stake is a contract the client builds (spec §23.1).

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

### 12.1 A scripted winner and the round's own beacon (RULED 2026-09-25, B)

2026-09-25 10:52, spec only. A paying round is now seeded from the
round's own beacon (multiplayer_p2p.md §5A.5: the block hash of the bonded
chain), and that hash differs in every round of every run. So a winner's
**recorded** inputs, captured against one run's world, do not deliver in
another's: measured, the scripted winner fails against a different beacon.

**Ruling: B, re-scope.** The slice that moved the seed to the round's own
beacon is the **seed slice** and nothing more:

- it lands the node and the fixtures reading the beacon from the bonded
  chain, and the players and the node seeding the world from that same
  hash;
- it measures what does not depend on who delivers: that every holder
  names the same beacon, that the seed and the committee derive from it,
  and that a round on a fixed beacon replays bit-identically;
- a test whose assertion needs a **specific scripted entry to deliver** on
  a beacon-seeded round is **listed by name as red with this cause** -
  "recorded inputs, another run's beacon" - for the span of this one
  slice. It is not tuned, not skipped silently, not pointed at a fixed
  beacon to make it pass, and its expectation does not change.

**The recompute is the next slice, directly after, and no other slice goes
between.** Its content: the scripted winner's inputs are **derived per run
from that run's replayed world**, never recorded once and reused - a
closed-loop driver that reads the core's own published state each tick
(the gate, the truck, the surface) and steers to the gate, starting from the
gate-steering driver the window fixture already has. It is measured to
deliver on at least ten consecutive runs with ten different beacons, and it
turns every test listed red above green without changing one expectation.
Searching a seed space for a delivering drive is **not** chosen: it is
slower, it tests the search instead of the round, and a seed with no
delivering drive would read as a product failure.

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
| 3 | `arena-node` skeleton: HTTP + ws, `node:sqlite`, entry receipts, checkpoint ingest, transcripts | Seven local nodes run a play-money round end to end |
| 4 | Replay pool, result signing, 5-of-7 finality, objection window, equivocation, no-quorum | The adversarial table passes |
| 5 | Chain integration: bond verification, census build, committee publication, timestamp receipts | A contract with a wrong census root is rejected by every node |
| 6 | Unity bridge, `@blwp/client`, NWC wallet | A browser plays a play-money round against real nodes |
| 7 | Settlement: VSS, FROST (+ external review), hold invoices, `SettlementBackend` | Testnet round settles; a killed node recovers without double-paying |
| 8 | Bonds and arbitration on-chain, load tests at 100/1,000, external security review | Real sats at the lowest bracket |

---

## 15. Effort and milestones

*Estimated 31 August 2026, against the game rules as they stood that day.
Written down here because the first version of this estimate lived only in a
chat and was lost to compaction.*

Two honesties first. **"Session" is a poor unit** — ours have run from a few
minutes to several hours. What is counted here is a session of that longer
kind: a few hours, 30–80 tool calls, one coherent piece of work. And
**software estimates are systematically optimistic, mine included.** The
ranges are wide because they have to be.

The calibration is the session this was written in: same codebase, same
working style, including the rounds spent because something had been built
and was invisible.

### 15.1 Effort by stage

| Stage | Content | Sessions |
|---|---|---|
| 0 | Core foundation: fixed point, RNG, tables, state layout, AST guard, cross-engine harness | 3–5 |
| 1 | Port the game rules from C# into the core (armies, terrain, driving, damage, gate, score) | 7–12 |
| 2 | `@blwp/protocol`: encoding, contracts, census, sortition, payout + vectors | 3–4 |
| 3 | `arena-node`: HTTP/WS, `node:sqlite`, entries, checkpoints, transcripts | 4–6 |
| 4 | Replay pool, 5-of-7 finality, objection, equivocation, no-quorum | 3–5 |
| 5 | Chain: bond verification, census build, committee publication (regtest) | 3–4 |
| 6 | Unity bridge, `@blwp/client`, NWC wallet | 4–6 |
| 7 | Settlement: VSS, FROST, hold invoices, backends | 5–8 |
| 8 | Bonds and arbitration on-chain, load tests | 3–5 |
| | **Total** | **35–55** |

Stage 1 is the one number that has moved since the first estimate, from 6–10
to 7–12. The rules grew that same day: the score gained a multiplicative
exposure term integrated over ground made good rather than time, threat
became a count of units actually in range rather than distance to a line, the
block clock started ending runs, and two buildings arrived with collision
that the simulation has to agree on.

Their *displays* do not move the number. The terminal, the histogram, the
goggles wall and the fee tiers are presentation fed from live chain state —
they are outside the deterministic core by construction, because nothing that
depends on when an HTTP response arrived can be part of a replayable
simulation.

### 15.2 When it is playable

The better news: playability comes long before real money.

| Milestone | What you can do | Cumulative |
|---|---|---|
| **M1 — core-driven single player** | Today's game, but position, damage, enemies and delivery come from the deterministic JS core instead of PhysX. No network, no money. Plays in a browser as it does now. | 11–18 |
| **M2 — play-money multiplayer** | Lobby, shared round start, late join, ghosts, leaderboard, verified results across seven local nodes. The whole experience, without sats. | 23–33 |
| **M3 — testnet sats** | Real Lightning mechanics on testnet: hold invoices, VSS, threshold settlement. | 31–45 |
| **M4 — mainnet, lowest bracket** | Real sats, plus external review. | 36–52 |

**M1 is the milestone to steer for.** It is not merely early — it retires the
two largest risks in the whole undertaking: does determinism hold across four
engines, and does the fixed-point model still *drive well*? The WheelCollider
behaviour behind the handbrake, the grip and the camera pitch has to be
derived again from scratch. That is an iteration with the player at the
wheel, not a mechanical port.

**M1 army on screen.** Tanks, infantry and gunships are not decoration. Armour and infantry doctrine, truck exception: **WAR_TACTICS.md** (was TANK_TACTICS.md; 2026-09-16).
Each pursues a real goal: close on the front, hold the line, engage a
foe, or fall back if overrun — the same jobs `Army.cs` already names.
Gunships run the length of the front on their own side and always aim a
target or a cluster near the front, not a blind drop on the track. They stand and fly where the front is, not in a clump on
their own rear. A hull faces the way it drives. That is playability,
not a later polish letter.

**M1 liquidation bombers.** A Binance futures liquidation scrambles a
bomber with an atomic load. Rare in live tape, so a simulation toggle
fires them when the feed is quiet (HUD says sim). The strike is tactical
near the front; blast size follows liquidation size; the crater lasts
10–20 rounds and units avoid it. Driving the truck through fallout
costs health and can kill, with a warning and the atom symbol.

**M1 liquidation picture (2026-09-03).** The rules above are not
enough until the player can see them. For now: stand-in models (plane,
atom bomb, crater bowl). Claude Design later. The crater is a hole in the
ground: after a bomb, the truck drives *into* that hole (core surface =
uploaded relief minus crater). Radiation is visible on the ground; the
warning and atom symbol stay. Presentation only — do not reopen the core
rules.

**M1 liquidation feeds and HUD (2026-09-04).** There is no free
all-exchange liquidation feed. Subscribe BTC forced orders from Binance,
Bybit, OKX, Bitget, Gate.io, MEXC, Kraken Futures and Hyperliquid, and
merge them into the same OnLiquidation. Wait with no time cap until each
exchange has delivered at least one. The HUD shows how much was
liquidated on which exchange. Many in the same tick: one summary, sums
and the exchanges named, not a row per order. Sim-toggle stays.

### 15.3 What drives the spread

**Driving feel (stage 1)** is the largest uncertainty and the only one that
cannot be resolved alone — it needs judgement, repeatedly. The camera and the
handbrake each took three or four rounds on the *existing* model.

**Cross-engine determinism (stage 0)** is the headline risk. If it holds
first time, three sessions. If Safari diverges on some corner nobody
considered, stage 0 doubles and everything downstream sits behind it.

**FROST (stage 7)** is implementation against an RFC with test vectors, so it
is tractable craft. The external cryptographic review before it is calendar
time, not session time — weeks, not hours, and it is not in the table.

**Lightning integration always surprises.** There is padding in the table,
but hold invoices, routing failures and recovery after a crash are reliably
where five sessions become eight.

### 15.4 What is not in the estimate

Two things sit on the critical path between M3 and M4 and depend on no
programming at all: the legal review, and finding seven independent, willing
node operators with bonds posted. The second is an organisational problem,
not a technical one — and without a solution the whole federated architecture
is theatre, as §31 of the specification says plainly.

### 15.5 Recommendation

Before committing to thirty-five sessions: **one or two sessions as a pure
risk spike**, answering two questions rather than one. No protocol, no Unity,
no money.

**A — does hand-built fixed point hold?** *Answered 31 August 2026: yes.*
Ten thousand ticks of a vehicle and forty-eight units, ten checkpoints,
identical SHA-256 state hashes from V8, SpiderMonkey, JavaScriptCore and a
second V8 build. Throughput measured at **4050× realtime**, against the
15–30× this document expected — two orders of magnitude of headroom that
spec §34's player cap can now be derived from rather than guessed at. The one
half of the criterion still open is the second architecture: the machine was
arm64 only.

**B — does WASM hold, and would it be cheaper?** *Partly answered, and the
answer changed what B is for.* Plain float arithmetic — two million
iterations of a chaotic integration using only `+ - * /` — is bit-identical
across all four runtimes, as IEEE-754 requires. The library functions are
not, and §3.1 now carries the table. So WASM's advantage is real and narrow:
it compiles its own libm in, which is exactly the gap that divides the
engines.

But since A passed and the core is built, B is no longer a fork in the road.
It becomes the fallback to reach for if stage 1's driving model turns out to
need trigonometry the table cannot serve cheaply — not a competing plan.

Half a session more, and the outcomes are worth it:

| A | B | What it means |
|---|---|---|
| holds | — | Stages 0 and 1 as costed. The plan of record. |
| holds | also holds | A choice, made on measurement: build fixed point, or pin a WASM binary and skip most of stage 0. Weigh it against the trust-path cost in §1.1. |
| **fails** | holds | The saving is enormous — most of stage 0 disappears and stage 1 becomes wiring plus feel. |
| fails | fails | Neither is viable in the browser and the whole architecture needs rethinking. Better to learn this in session two than in session fifteen. |

The bottom-left row is the reason B is worth running even if A succeeds: it is
the only outcome where the estimate is badly wrong in the *cheap* direction,
and the only way to find out is to measure.

---

## 16. What this choice costs

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

If the spike's option B is taken, item 1 above is what changes: determinism
would be enforced by the WASM specification rather than by an AST guard, and
stage 0 shrinks to the harness and the state layout. What is bought instead
is a binary in the trust path — pinned by hash and committed, per §1.1, but
still a thing nobody can read.

What the all-JS choice buys, and it is not small: **one language, one protocol
implementation, one core, shared between the browser and every node.** No
Rust toolchain, no WASM build step, no napi-rs, no `node-gyp`. Canonical
encoding, contract validation, sortition, the payout function and the
simulation exist exactly once — and the places where two implementations
would silently disagree simply have no second implementation to disagree
with.
