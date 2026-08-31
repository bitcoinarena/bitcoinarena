# BLWP v4.6.1 — Node.js Implementation Design

Written 2026-08-31. **Design document only — nothing here is implemented.**

This describes, in concrete engineering terms, how I would build the
providerless protocol specified in `multiplayer_p2p.md` (BLWP v4.6.1) with
Node.js as the primary implementation language. It replaces the earlier
Rust-first plan (superseded; still in git history), which was written for
the v1.x role split before the census/committee architecture existed.

Read `multiplayer_p2p.md` first — this document assumes its vocabulary
(census, committee, Entry Contract, checkpoint, objection window, hold
invoice, VSS shares) and only says *how*.

---

## 1. Scope: what is Node.js, and what deliberately is not

Node.js is the right choice for most of this system and the wrong choice for
exactly one part of it. Being precise about the boundary up front is more
useful than pretending otherwise.

| Component | Language | Why |
|---|---|---|
| `blwp-node` daemon (all roles) | **Node.js** | I/O-bound: websockets, HTTP, Bitcoin RPC, Lightning gRPC, SQLite. Node is excellent at exactly this. |
| Protocol library: encoding, hashing, signatures, contract validation, sortition, payout function | **Node.js (isomorphic)** | The single strongest argument for this stack: **the same package runs in the browser next to Unity and in the node.** One implementation of canonical encoding means one place for the encodings to be wrong. |
| Browser client glue, wallet integration, Unity bridge | **Node.js/JS** | Same package, no second implementation. |
| **Deterministic simulation core** | **Rust → WASM** | Not Node.js, on purpose (§1.1). |
| Threshold signing (FROST) | **Rust via napi-rs**, or an external federation | JS implementations are immature (§9.3). |

### 1.1 Why the simulation core must not be JavaScript

The core decides money. Its only requirement is that two independent
machines, in different engines, produce **bit-identical** state hashes from
the same inputs. JavaScript makes that unnecessarily hard:

- Numbers are IEEE-754 doubles. `Math.sin`, `Math.pow`, `**` and friends are
  *not* specified to the last bit and differ between V8, SpiderMonkey and
  JavaScriptCore. Any float in settled state is a latent divergence bug.
- Writing the core in fixed-point `BigInt` is possible but slow (BigInt
  allocates), and `Int32Array`-based fixed point in plain JS is workable but
  gives up the compiler's help in keeping floats out.
- The core has to run in the browser *anyway*, inside a Unity WebGL page.

A Rust core compiled to `wasm32-unknown-unknown` — no threads, no SIMD, no
floats in settled state, fixed-point `i64.32` — is deterministic by
construction, and **Node.js loads the exact same `.wasm` file the browser
does**:

```js
// packages/sim/src/load.js — sketch, not implementation
const bytes = await readFile(wasmPath);              // node
const bytes = await (await fetch(wasmUrl)).arrayBuffer();  // browser
const { instance } = await WebAssembly.instantiate(bytes, imports);
```

Same bytes, same hash, same result. Verifying `sim_wasm_hash` becomes a
`sha256` of a file both sides already have.

> If a pure-JS core were mandated anyway: all state as `Int32Array` /
> `BigInt64Array`, a hand-written fixed-point math library (no `Math.*`
> except integer ops), a lookup-table trig implementation, and a
> cross-engine differential test on every commit. It is doable. It is more
> work than writing it in Rust and buys nothing.

---

## 2. Repository and package layout

npm workspaces, one repo, no publishing required to run.

```
blwp/
  package.json                    # workspaces root, node >= 22
  packages/
    protocol/                     # @blwp/protocol   — isomorphic, zero deps beyond noble
      src/
        encode.js                 # canonical binary encoding (§3)
        hash.js                   # sha256, tagged hashes
        keys.js                   # ed25519 sign/verify, x25519 ECDH
        contracts.js              # RoundContract / PlayerEntryContract types + validate
        census.js                 # canonical census list + Merkle root (§5)
        sortition.js              # linear-weight committee selection (§6)
        payout.js                 # F(contract, membership, results) (§7)
        vss.js                    # Feldman VSS share/verify/combine (§9.2)
        messages.js               # wire message codecs (§8)
        constants.js              # tags, versions, limits
      test/
        vectors/                  # golden test vectors, shared with any implementation
    sim/                          # @blwp/sim        — WASM loader + replay API
      src/load.js, replay.js
      wasm/                       # built artifacts, content-addressed by hash
    node/                         # blwp-node        — the daemon
      src/
        index.js                  # CLI, config, role wiring
        chain/                    # Bitcoin: census verification, bond checks (§5)
        census/                   # census build + cache
        rounds/                   # contract intake, timestamp receipts
        entries/                  # entry acceptance, receipts
        ingest/                   # checkpoint + input batch ingest, gossip
        store/                    # SQLite + transcript files (§10)
        replay/                   # worker_threads pool (§11)
        results/                  # signing, objection handling
        payout/                   # payout table, signing
        settlement/               # hold invoices, VSS custody, threshold signing (§9)
        api/                      # fastify HTTP + ws server (§8)
        metrics/
    client/                       # @blwp/client     — browser protocol client
      src/
        session.js                # connects to committee nodes
        wallet-nwc.js             # Nostr Wallet Connect (§12.3)
        unity-bridge.js           # .jslib glue (§12.1)
    replayer/                     # blwp-replay      — standalone CLI verifier
  crates/
    sim-core/                     # Rust, the deterministic simulation
    frost-addon/                  # Rust + napi-rs, threshold signing (§9.3)
  test-vectors/                   # cross-implementation fixtures
```

Two rules keep this honest:

1. **`@blwp/protocol` has no Node-only imports.** No `node:crypto`, no `fs`.
   It uses `@noble/*` so the identical file runs in the browser. Anything
   platform-specific is injected.
2. **Nothing outside `packages/protocol` and `crates/sim-core` may compute a
   protocol hash.** If a hash is computed in two places, it will eventually
   be computed two ways.

---

## 3. Canonical encoding — the foundation everything else stands on

Every signature, every Merkle leaf, every `round_id` is a hash over bytes.
If two implementations serialize a contract differently, they compute
different `round_id`s and the protocol silently forks.

**Decision: hand-written fixed-layout binary encoding. Not JSON, not CBOR.**

- JSON has no canonical form worth relying on: key order, number
  representation, unicode escaping, `-0`. `JSON.stringify` is not a
  specification.
- Deterministic CBOR (RFC 8949 §4.2) is defensible, but every library has
  its own interpretation of "canonical", and a library upgrade must never
  change a `round_id`.
- A hand-written encoder is ~300 lines, has no dependencies, and is trivially
  portable to a second implementation.

Shape:

```js
// packages/protocol/src/encode.js — sketch
// Every type has an explicit, versioned field order. No maps, no optionals
// without an explicit presence byte, no variable-width integers.

const w = new Writer();          // growable Uint8Array
w.u8(TYPE_ROUND_CONTRACT);
w.u16(PROTOCOL_VERSION);
w.bytes32(simWasmHash);
w.u64(startTimeMs);              // BigInt in, 8 bytes big-endian out
w.u32(censusHeight);
w.bytes32(censusRootGameVerify);
w.vec(nodes, (n) => w.bytes32(n.pubkey));   // u16 length prefix, then items
// ...
const bytes = w.finish();
```

Rules enforced by the encoder itself:

- Integers are fixed width, big-endian. No `Number` above 2^53 anywhere —
  amounts and timestamps are `BigInt`, encoded as `u64`.
- Strings are UTF-8 with a `u16` length prefix and are rejected if they
  contain unpaired surrogates.
- Arrays carry a `u16` count and are **required to be pre-sorted** where the
  protocol says so (census entries, committee lists); the encoder asserts the
  ordering rather than sorting silently.
- Every hash is a **tagged hash** to prevent cross-type collisions:
  `H_tag(x) = sha256(sha256(tag) ‖ sha256(tag) ‖ x)`, BIP-340 style, with
  tags like `"BLWP/v1/RoundContract"`, `"BLWP/v1/Checkpoint"`.

`test-vectors/` contains, for each type, a JSON description and the expected
hex encoding + hash. Any second implementation is correct iff it reproduces
them.

---

## 4. Crypto choices

| Purpose | Library | Note |
|---|---|---|
| ed25519 sign/verify (players, nodes, receipts) | `@noble/curves/ed25519` | Audited, isomorphic, ~1.5k sigs/s in Node — plenty at 1 checkpoint/s/player |
| x25519 ECDH (encrypting VSS shares to custodians) | `@noble/curves/ed25519` (`x25519`) | |
| Symmetric encryption of shares | `@noble/ciphers/chacha` — XChaCha20-Poly1305 | 24-byte nonce, no nonce-reuse footgun |
| SHA-256 | `@noble/hashes/sha2` in the protocol lib; `node:crypto` in the daemon's hot paths | Same output; the daemon may use the faster native one outside `@blwp/protocol` |
| secp256k1 Schnorr (Bitcoin bond scripts) | `@noble/curves/secp256k1` | For building/verifying bond transactions |
| Bitcoin tx construction | `bitcoinjs-lib` + `@bitcoinerlab/descriptors` | Taproot script paths (§9.1) |
| Threshold Schnorr (FROST) | Rust `frost-secp256k1` via `napi-rs` | §9.3 — no mature JS option |

Session keys: each run generates an ephemeral ed25519 keypair in the browser
(`crypto.subtle` or noble), certified by the player's entry key inside the
Entry Contract. Checkpoints are signed by the session key so the long-term
key touches disk once.

---

## 5. Census: verifying, not scanning

The spec (§5A.2–5A.4) says the census is derived from chain state at
`census_height`. The naive reading — "scan the whole chain for outputs
matching the bond template" — is impractical without a custom index. The
implementation inverts it, with the identical result set:

> **Nodes announce their bond outpoint. The daemon *verifies* each announced
> outpoint against the chain. An unannounced bond is invisible anyway,
> because the advertisement body it commits to could not be retrieved.**

Announcement transport is deliberately unimportant (gossip between nodes, an
HTTP directory, a Nostr relay) — it is a hint, not authority. Everything is
re-derived from the chain.

```js
// packages/node/src/chain/verifyBond.js — sketch
async function verifyBond(announcement, censusHeight) {
  // 1. Is the outpoint unspent at censusHeight, deep enough?
  const txout = await rpc.gettxout(txid, vout, /* include_mempool */ false);
  if (!txout) return reject('spent_or_missing');
  const conf = tipHeight - txout.confirmationHeight + 1;
  if (conf < CENSUS_CONFIRMATIONS) return reject('immature');
  if (txout.height > censusHeight)  return reject('after_cutoff');

  // 2. Does the script match the bond template of the declared version?
  if (!matchesBondTemplate(txout.scriptPubKey, announcement)) return reject('script');

  // 3. Does it commit to this advertisement?
  const committed = await readCommitment(txid);      // OP_RETURN or taproot leaf
  if (!equal(committed, sha256Tagged('BLWP/v1/Advert', encodeAdvert(ad))))
    return reject('commitment');

  // 4. Signature, roles, protocol version, bond_amount >= bond_min
  ...
  return { outpoint, ad, bondAmount: txout.value };
}
```

**Chain access.** Node operators should run `bitcoind` and talk to it over
RPC (`gettxout`, `getrawtransaction`, `getblockhash`) — it is the only fully
self-sufficient option and a node operator running a Bitcoin node is a
reasonable expectation. Fallbacks for developers and for the browser:
Esplora REST (`mempool.space`, Blockstream) or an Electrum server via
`electrum-client`, with two independent providers required to agree.

**Building the census** (§5A.4 steps 4–6):

```js
entries.sort(compareOutpoints);          // (txid bytes asc, then vout asc)
const leaves = entries.map(encodeCensusLeaf);
const root = merkleRoot(leaves, 'BLWP/v1/CensusLeaf');
```

Sorting by outpoint rather than by `H(pubkey)` matters and the code should
carry the comment: a pubkey can be ground to land anywhere in a sorted list;
a txid cannot be chosen after the transaction is funded.

**Caching.** Census results are keyed by `census_height` and are immutable
once computed — store them in SQLite and never recompute. A node serving many
rounds at the same height does the work once.

---

## 6. Sortition

Pure function, in the protocol package, used identically by node, client and
replayer:

```js
// packages/protocol/src/sortition.js — sketch
export function selectCommittee({ censusEntries, committeeSeed, role, slots, bondMin }) {
  const scored = censusEntries
    .filter(e => e.roles.includes(role))
    .map(e => {
      const ticket = bytesToBigInt(
        taggedHash('BLWP/v1/Ticket', concat(committeeSeed, encodeOutpoint(e.outpoint), roleByte(role)))
      );                                             // 0 .. 2^256-1
      const weight = e.bondAmount / bondMin;         // BigInt division, floor, >= 1n
      // score = ticket / weight in fixed point; compare as ticket_a * w_b ? ticket_b * w_a
      return { entry: e, ticket, weight };
    });

  scored.sort((a, b) => cmpBigInt(a.ticket * b.weight, b.ticket * a.weight));
  return scored.slice(0, slots).map(s => s.entry);
}
```

Implementation notes that actually matter:

- **Never compute `ticket / weight` as a float.** Compare cross-multiplied
  BigInts. A float comparison here would be a consensus bug that appears only
  when two nodes are close in score.
- `weight` is linear (`bond / bond_min`), per v4.6.1. A comment should record
  *why* square root is wrong, because it looks like the obvious "anti-whale"
  choice and someone will try to reintroduce it: under `sqrt`, splitting one
  bond into four doubles total weight.
- Committee-of-settlement selection runs after removing the game/verify
  winners and their declared operator siblings (§5A.9), then re-sorts.
- The function is deterministic and side-effect free — it is the single
  most test-vector-covered piece of the protocol package.

---

## 7. The payout function

```js
// packages/protocol/src/payout.js
export function computePayoutTable(contract, membership, results) { ... }
```

Requirements:

- **Integer arithmetic in millisatoshi only.** `BigInt` throughout. No
  floating point anywhere near money.
- Deterministic remainder handling exactly as the spec says: floor each
  share, then distribute leftover msat in ascending
  `H(round_id ‖ node_pubkey)` (fees) or `H(round_id ‖ player_pubkey)`
  (pool shares) order.
- A hard assertion at the end:
  `sum(payouts) + sum(fees) === sum(activated stakes)`. If it ever fails, the
  node refuses to sign rather than signing something inconsistent. This is
  the kind of invariant that catches a whole class of mistakes for free.
- Property tests (fast-check): random memberships and result sets, assert the
  sum invariant, tie handling, zero-qualifier refund, and that `VOID` entries
  neither contribute nor draw.

---

## 8. Wire protocol and the daemon's network surface

Two transports, deliberately different:

**HTTP (fastify)** — everything cacheable and occasional:

```
GET  /v1/contract/:round_id            RoundContract bytes
POST /v1/contract                      submit a contract, get a timestamp receipt
GET  /v1/census/:height                census list + root
GET  /v1/round/:id/committees          published committees + verification data
POST /v1/entry                         Entry Contract -> EntryReceipt
GET  /v1/round/:id/transcript/:pubkey  transcript for replay/objection
POST /v1/objection                     submit an objection (§13A)
GET  /v1/round/:id/results             signed results
GET  /v1/round/:id/payout              signed payout table
GET  /v1/health                        role status, census height, replay lag
```

**WebSocket (`ws`)** — the per-run hot path, binary frames encoded with
`@blwp/protocol/messages`, never JSON:

```
C -> S  HELLO { round_id, player_pubkey, session_pubkey, entry_proof }
C -> S  INPUT_BATCH { first_tick, last_tick, inputs[], prev_hash }      ~10 Hz, ~30 B
C -> S  CHECKPOINT  { tick, state_hash, input_chain_hash, prev, sig }    ~1 Hz, ~150 B
S -> C  RECEIPT     { checkpoint_hash, received_at, node_sig }
S -> C  GHOSTS      { entries[] }                                        ~5 Hz
S -> C  NOTICE      { kind, payload }        // equivocation, void, finality
```

Practical concerns the implementation must handle:

- **Backpressure.** `ws` will happily buffer forever. Track
  `socket.bufferedAmount`; above a threshold drop *ghost* frames first (they
  are non-authoritative by definition), never receipts.
- **Ordering and loss.** Batches are tick-numbered and idempotent; a repeat
  is a no-op, a gap is filled by the contract's neutral-input policy. The
  daemon never asks for retransmission of inputs — the client is responsible
  for publishing, and unpublished inputs cost the player the run.
- **Per-connection quotas.** A funded entry is required before the node
  stores a single byte of transcript. This is the main anti-DoS lever: disk
  is only spent on stakes that exist.
- **Clock.** Receipts use `Date.now()` (wall clock, NTP-synced); intervals use
  `performance.now()` (monotonic). Mixing them is a subtle source of skew.

Ghost fan-out uses interest management: each connection subscribes to ~20
others (nearest by last known position plus the leaderboard top), recomputed
every few seconds — an O(N·K) loop, not O(N²).

---

## 9. Settlement role

### 9.1 The bond output (Bitcoin side)

Built with `bitcoinjs-lib` (taproot) — three spend paths per §5A.3B:

```js
// packages/node/src/settlement/bond.js — sketch
const internalKey = musig2Aggregate(nodeKey, arbitrationAggregate);  // key path
const recovery = script.compile([                                    // path A
  bip65Encode(bondMaturity), OP_CHECKLOCKTIMEVERIFY, OP_DROP,
  toXOnly(nodeKey), OP_CHECKSIG,
]);
const slash = script.compile([                                       // path B
  ...arbitrationKeys.flatMap((k, i) => [toXOnly(k), i === 0 ? OP_CHECKSIG : OP_CHECKSIGADD]),
  arbitrationK, OP_NUMEQUAL,
]);
const tree = { left: { output: recovery }, right: { output: slash } };
```

A slashing transaction additionally carries
`OP_RETURN <H(fraud_proof)> <uri>`; the daemon refuses to co-sign one whose
committed proof it cannot retrieve and verify itself. That check is what
makes "slash without cause" detectable rather than theoretical.

### 9.2 VSS custody of the stake preimage

Feldman VSS over the ristretto255 scalar field:

```js
// packages/protocol/src/vss.js — sketch
// P is 32 bytes. Split into two 16-byte halves so each fits a scalar.
// For each half: polynomial a0 + a1*x + ... + a{t-1}*x^{t-1}, a0 = half.
// Commitments C_j = g^{a_j}. Share for custodian i: (i, f(i)).
// Custodian verifies: g^{f(i)} == prod_j C_j^{i^j}
```

- Each share is encrypted to that custodian's x25519 key with
  XChaCha20-Poly1305 and published (encrypted) in the Entry Contract's
  `vss_shares_ref`, so it is publicly available but only readable by the
  intended custodian.
- Custodians verify their share on receipt and refuse the entry if it fails —
  a player must not be able to commit a stake whose preimage cannot be
  reconstructed.
- Reconstruction is Lagrange interpolation at `x = 0` over any 5 valid
  shares.

Constant-time discipline matters here: use noble's field arithmetic rather
than hand-rolled BigInt modular ops.

### 9.3 Threshold Lightning — the honest part

The spec requires that no single party can move funds. In Node.js today:

- **`ln-service` / raw gRPC to LND** gives clean access to hold invoices —
  `addHoldInvoice`, `subscribeSingleInvoice`, `settleInvoice`,
  `cancelInvoice`. This is exactly the primitive the design needs, and it is
  production-grade.
- **But one LND node has one set of channel keys.** Wrapping the *decision*
  in a 5-of-7 vote while a single operator holds the keys is theatre: that
  operator can settle unilaterally.

Two real options, both describable now:

1. **Fedimint-style federation with a Lightning gateway (recommended for
   V1).** The guardians hold the money under threshold consensus; the
   `blwp-node` settlement role talks to the federation client. Mature today.
   The Node.js side is an RPC client, not a custody implementation.
2. **Threshold-signed LND via a remote signer.** LND's `signrpc`/VLS-style
   remote signing, with the signer implemented as a FROST quorum
   (`frost-secp256k1` in Rust behind `napi-rs`). This is the cleaner
   architecture and the less mature technology.

The daemon should therefore expose a `SettlementBackend` interface with two
implementations (`fedimint`, `lnd-single` for development) so the trust
model is a deployment choice rather than a code rewrite — and so that
`lnd-single` can be loudly labelled *development only, custodial*.

### 9.4 Settlement state machine

Per entry, persisted, crash-safe, idempotent at every step:

```
AWAITING_INVOICE -> HELD -> (result FINAL)
   -> qualifying:     CANCEL_REQUESTED -> CANCELLED -> PAYOUT_QUEUED -> PAID
   -> losing:         SHARES_REQUESTED -> PREIMAGE_READY -> SETTLE_REQUESTED -> SETTLED
   -> void/expired:   EXPIRED (refund happened by itself)
```

Every transition writes to SQLite *before* the external call and reconciles
on startup by asking LND/the federation for the true state. Lightning
operations must be assumed to be interrupted mid-flight; the invariant is
that a repeated `settleInvoice` with the same preimage is harmless.

---

## 10. Storage

**SQLite via `better-sqlite3`** — synchronous, single-file, fast, and
transactional. There is no multi-writer requirement: one daemon owns its
database.

```sql
CREATE TABLE rounds        (round_id BLOB PRIMARY KEY, contract BLOB, census_height INT, state TEXT);
CREATE TABLE census        (height INT, role TEXT, root BLOB, entries BLOB, PRIMARY KEY (height, role));
CREATE TABLE entries       (round_id BLOB, player BLOB, contract BLOB, payment_hash BLOB,
                            state TEXT, join_tick INT, PRIMARY KEY (round_id, player));
CREATE TABLE checkpoints   (round_id BLOB, player BLOB, tick INT, state_hash BLOB,
                            input_chain_hash BLOB, sig BLOB, received_at INT,
                            PRIMARY KEY (round_id, player, tick));
CREATE TABLE results       (round_id BLOB, player BLOB, result TEXT, score INT,
                            transcript_hash BLOB, sigs BLOB, final_at INT,
                            PRIMARY KEY (round_id, player));
CREATE TABLE objections    (id INTEGER PRIMARY KEY, round_id BLOB, player BLOB,
                            artifact_path TEXT, verdict TEXT);
CREATE TABLE settlement    (round_id BLOB, player BLOB, state TEXT, preimage BLOB,
                            invoice TEXT, updated_at INT, PRIMARY KEY (round_id, player));
CREATE UNIQUE INDEX equiv ON checkpoints(round_id, player, tick);  -- equivocation detector
```

That last index is doing real work: an `INSERT` of a second, different
checkpoint for the same `(round, player, tick)` fails the uniqueness
constraint, and the conflict handler turns the pair into an equivocation
proof (§13B of the spec) instead of silently overwriting.

**Input logs are files, not rows.** Append-only
`transcripts/<round>/<player>.log`, one length-prefixed batch per record,
with SQLite holding only the offset index. A 1,000-player round is ~180 MB
of transcript; SQLite would be the wrong container. Retention: delete when
the objection *and* claim windows have both closed, tracked by a nightly job.

---

## 11. Replay: worker threads

Replay is the only CPU-bound part of the daemon, and it must not block the
event loop that is issuing checkpoint receipts.

```js
// packages/node/src/replay/pool.js — sketch
const pool = new WorkerPool({
  size: Math.max(1, os.cpus().length - 1),
  script: './worker.js',                 // each worker loads its own WASM instance
});
const result = await pool.run({ simWasmHash, contract, subSeed, inputLogPath });
```

- Each worker instantiates the WASM module **once** and resets state between
  runs; instantiation is the expensive part.
- The pool is a priority queue: objected runs first, then top-ranked runs,
  then the rest. When the round's result window is at risk, this ordering is
  what keeps the economically important runs verified first.
- **Capacity is measured, not assumed** (spec §34). The daemon records
  replay-seconds per simulated-second and exposes it at `/v1/health`; the
  client refuses rounds whose player count exceeds what the committee's
  published throughput supports.
- A replay that exceeds a hard time or memory budget is aborted and treated
  as an invalid transcript — this is also the defence against a maliciously
  expensive input log.

---

## 12. The browser side

### 12.1 Unity ⇄ JS

Unity WebGL calls JavaScript through a `.jslib` plugin; JS calls back via
`SendMessage`. Concretely:

```
Assets/Plugins/blwp.jslib        // mergeInto(LibraryManager.library, { ... })
```

- Unity → JS: `BLWP_SubmitInput(tickStart, ptr, len)` — inputs are written
  into a `Uint8Array` view of the Unity heap; no per-frame string marshalling.
- JS → Unity: `unityInstance.SendMessage('Net', 'OnState', base64)` for state
  corrections, or better, JS writes into a pre-allocated buffer Unity polls
  each frame — string marshalling at 30 Hz is avoidable overhead.
- The WASM sim runs in JS-land, not in Unity's heap. Unity renders *from* the
  state the JS layer exposes. This keeps the money-relevant core in the same
  module the node runs.

### 12.2 Client session flow

`@blwp/client` implements, with the same protocol package as the daemon:

1. Fetch and validate the RoundContract; check `sim_wasm_hash` against the
   client's known-good list (spec §5); refuse real money otherwise.
2. Wait for `committee_time`; fetch the beacon; **recompute the committees
   locally** with `selectCommittee` and compare — never trust the published
   list.
3. Verify the census root against 2+ independent chain providers.
4. Build the Entry Contract, generate `P`, VSS-share it to the *verified*
   settlement committee.
5. Request the hold invoice; show the full cost breakdown (§22A of the spec);
   hand it to the wallet.
6. On receipts from ≥5 nodes: start the run.
7. During the run: maintain the input chain, sign checkpoints, keep a local
   copy of everything.
8. On delivery: emit the terminal checkpoint, then **upload the full
   transcript to ≥2 nodes and a mirror before showing the victory screen** —
   this is what arms the objection veto.

### 12.3 Wallet

Nostr Wallet Connect via `nostr-tools`: parse the `nostr+walletconnect://`
URI, connect to the relay, send NIP-47 `pay_invoice` / `make_invoice`
requests encrypted to the wallet service pubkey. Fallback: render a BOLT11
QR (`qrcode`) and poll invoice status.

The client must display, and the code must not be able to bypass: stake,
node fee, donation (capped, with a second confirmation above 5%), total,
committee identities, overlap count, and whether any selected operator is
declared as playing.

---

## 13. Testing — the part that decides whether this works

The project's history is a catalogue of "code correct, thing broken" bugs
caught only by measuring. The protocol gets the same treatment.

**Determinism harness (highest priority).** A CI job that runs a corpus of
recorded input logs through the WASM core in: Node.js, headless Chrome,
Firefox and WebKit (Playwright), on x86 and ARM. Assert byte-equal state
hashes every 100 ticks. Any divergence fails the build. This must exist
before anything else is built on top of the core.

**Golden vectors.** `test-vectors/` holds, as JSON + expected hex: canonical
encodings, tagged hashes, census roots, committee selections for fixed
inputs, payout tables. Any second implementation is validated against them.

**Property tests** (`fast-check`): payout sum invariance; sortition
distribution converging to bond weights over 10⁵ rounds; VSS
share/reconstruct round-trips at every threshold; encoder/decoder round-trips.

**Adversarial integration tests**, each asserting the *specified* outcome:

| Scenario | Must produce |
|---|---|
| Two conflicting checkpoints, same tick | Equivocation proof, `FORFEIT` |
| Fabricated result signed by 5 of 7 | Objection accepted, result overturned, slashing artifact emitted |
| Transcript with withheld inputs | Unverifiable, `FORFEIT` |
| Entry attempted before `committee_time` | Rejected, no receipts |
| Contract with mismatched census root | Rejected by every node |
| Contract grinding attempt (published after the beacon) | No timestamp receipts, unusable |
| Committee cannot reach 5-of-7 | `VOID`, HTLC expires, refund |
| Node killed mid-round | Recovers from SQLite + transcript files, no double receipts |
| LND restarted mid-settlement | Idempotent reconciliation, no double payment |

**Load tests.** Synthetic clients (`packages/node/test/load`) driving 100 /
1,000 concurrent runs against a 7-node local committee, measuring receipt
latency, replay lag, WebSocket buffer growth and SQLite write throughput.

---

## 14. Operations

- **Runtime:** Node 22 LTS, `--max-old-space-size` tuned to transcript
  buffering, systemd unit per role.
- **Config:** a single TOML file plus environment overrides; roles as an
  explicit array (`roles = ["game_verify"]`).
- **Keys:** node identity key in a file with `0600` and an optional PKCS#11 /
  HSM path; the settlement share never on the same host as the web API.
- **Metrics:** Prometheus (`prom-client`) — census height, replay lag,
  receipts/s, objection count, settlement state histogram, bond confirmation
  depth, LND channel liquidity.
- **Logging:** `pino`, structured, with `round_id`/`player_pubkey` as
  first-class fields. Never log preimages or shares.
- **Backups:** SQLite via the online backup API, transcripts via ordinary
  file sync; both must survive the objection window or the node cannot defend
  its own signatures.

---

## 15. Build order

| Stage | Content | Done when |
|---|---|---|
| 0 | Rust sim core + WASM build + determinism harness across 4 browsers and Node | Zero divergence on a 10-minute corpus; replay speed measured and published |
| 1 | `@blwp/protocol`: encoding, hashes, contracts, census, sortition, payout + full vectors | A second implementation could be written from `test-vectors/` alone |
| 2 | `blwp-node` skeleton: HTTP + ws, SQLite, entry receipts, checkpoint ingest, transcripts | Seven local nodes accept a play-money round end to end |
| 3 | Replay pool, result signing, 5-of-7 finality, objection window, equivocation, no-quorum | The adversarial table in §13 passes |
| 4 | Chain integration: bond verification, census build, committee publication, timestamp receipts | A contract with a wrong census root is rejected by every node |
| 5 | Unity bridge + `@blwp/client` + NWC wallet | A browser plays a play-money round against real nodes |
| 6 | Settlement: VSS custody, hold invoices, `SettlementBackend` (fedimint first) | Testnet round settles; a killed node recovers without double-paying |
| 7 | Bonds and arbitration on-chain; load tests at 100/1,000; external review | Real sats at the lowest bracket |

---

## 16. Where the Node.js choice costs something

Stated plainly, so nobody discovers it in month four:

1. **The core is not Node.js and should not be.** §1.1. Accept a Rust
   toolchain in the project.
2. **Threshold signing has no mature JS implementation.** Either a Rust addon
   or an external federation. §9.3.
3. **CPU work needs worker threads.** Replay in the main thread would stall
   checkpoint receipts and cause spurious cadence failures — a correctness
   bug wearing a performance costume. §11.
4. **BigInt discipline is manual.** Nothing stops someone writing
   `Number(satoshis)`. Enforce with a lint rule banning `Number()` in
   `packages/protocol` and `settlement`, and with the payout sum assertion.
5. **`@noble/*` is fast for JS and slow for crypto.** Fine at this protocol's
   rates (≈1 signature per player per second); if a node ever serves
   thousands of concurrent runs, signature verification moves to a native
   addon.

What the choice buys, and why it is still the right call: **one protocol
implementation shared by the browser and the node.** Canonical encoding,
contract validation, sortition and the payout function are the places where a
second implementation would silently disagree — and here there is no second
implementation.
