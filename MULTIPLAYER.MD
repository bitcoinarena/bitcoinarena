# BTC Logistics War — Multiplayer & Real-Money Architecture (v2)

Written 2026-08-30, revised 2026-08-30 (v2). This document specifies how the
single-player prototype becomes an anonymous multiplayer game played for real
sats: Lightning in, cargo as the stake, payout only on arrival, a 10% target
house edge — and an architecture in which the client decides **nothing**.

v2 is a revision, not a redesign. Everything that held in v1 still holds:
server-authoritative deterministic gameplay, the client as input and rendering
only, no client-assertable outcomes, private worlds with ghost multiplayer, a
shared Rust/WASM deterministic core, a double-entry ledger, Lightning in and
out, separated game and wallet infrastructure, provably fair rounds, and the
principle that money buys capacity and variance reduction, never expected
value. What v2 changes is the **economic security model** and the machinery
around it — because v1 made one claim it could not keep.

---

## 0. Guiding principles

### 0.1 The client is an input device and a television

Once money is on the table, not one outcome-deciding quantity may be computed
in the browser. The client sends inputs only (steering, throttle, brake) and
renders what the server tells it. Whether the truck was hit, whether it is
alive, whether it reached the gate — the server simulates all of it.

**There is no "I have arrived" API call.** Arrival is an event the server
observes in its own simulation. The attack class "forged game result" does not
exist structurally, because the endpoint is not there.

### 0.2 Solvency must not depend on players being bad at the game

This is the v2 core assumption, and it replaces v1's claim that "bots do not
beat the house":

> **A sufficiently motivated attacker may eventually drive the game nearly
> perfectly. The house must remain solvent anyway.**

v1 argued that population-level calibration erodes any individual edge. That
is not mathematically true. If a bucket is priced from a population success
rate of 50% (`M_shown = 0.90 / 0.50 = 1.80`), an agent that succeeds 80% of
the time earns `EV = 0.80 × 1.80 = 1.44` — a +44% expected return under a
nominal 10% house edge. If that agent is 1% of volume, its wins barely move
the population statistic; calibration alone reacts too slowly and too weakly.

The objective is therefore **not** to make optimized play impossible. The
objective is to guarantee that optimized play cannot become an *unbounded or
persistent* extraction channel. v2 achieves this with four independent layers
(§4): conservative pricing, statistical circuit breakers, hard exposure caps,
and wallet-tier limits — where the last two hold **even if the pricing model
is completely wrong**.

Skill is deliberately preserved. A good driver succeeds more often than a bad
one at the same quoted multiplier and therefore does better. What skill cannot
do is scale without limit: extraction is bounded per run, per account, per
bucket, per window and globally.

### 0.3 Revision map (what changed, why, what it prevents, what remains)

| # | Change | Why | Prevents | Remaining limitation |
|---|---|---|---|---|
| 1 | Economic model rebuilt around bounded loss (§4) | v1's "calibration beats bots" was false | Skill/bot arbitrage draining the bankroll | Optimized play can be transiently +EV within caps |
| 2 | Dedicated **Quote Engine**; payout terms frozen before escrow (§4.2) | Shards must never price; calibration must never reprice a live run | Post-hoc repricing, compromised-shard pricing, quote disputes | Quotes reveal the current model (uniform for all, so no targeted leak) |
| 3 | Multiplier becomes a **frozen payout curve** over realized exposure (§4.3) | Route freedom and frozen quotes contradicted each other in v1 | Both post-hoc repricing *and* forced-route designs | Curve family adds model complexity |
| 4 | **UCB pricing** + hierarchical loadout calibration, keyed by sim version (§4.4–4.5) | Point-estimate pricing and coarse truck classes invite config arbitrage | Cold-start free lunch, dominant-config arbitrage, patch arbitrage | New content pays conservatively until data exists |
| 5 | **Exposure caps + sequential breakers** (§4.6) | Theoretical edge is not a defense | A newly found optimal strategy draining funds before the model adapts | Caps also throttle legitimate high-volume play |
| 6 | Randomness split into **information tiers** (§7) | Full pre-run seed disclosure enables trivial perfect-route solving; full hiding breaks prediction and verifiability | Operator outcome-tailoring *and* deterministic route solving of combat outcomes | Offline optimization of static terrain remains possible — treated as skill, bounded by §4 |
| 7 | Explicit outcome classes **DELIVERED / PLAYER_LOST / VOID** (§3.3) | The operator must not profit from technical failure | House profiting from crashes; ambiguous settlements | VOID conditions must be conservatively engineered |
| 8 | **Deterministic disconnect policy** (§6.4) | Disconnects must not be an escape hatch, nor a hidden loss | Disconnect manipulation; unfair losses on operator faults | A genuine player-side crash still loses a losing run (deliberate) |
| 9 | **Run Records + versioned simulation archive + crash replay** (§6.5) | Real-money runs must be reproducible forever | Unverifiable settlements; unrecoverable shard crashes | Storage and artifact-archival operations |
| 10 | Ledger **Merkle + external anchoring** (§2.2) | An operator-held hash chain does not prevent operator rewrites | Silent history rewriting | Anchoring detects, it does not physically prevent; cadence gap |
| 11 | **Settlement Authority** + independent **Wallet Daemon limits** (§2.4–2.6) | Assume the app tier will eventually be compromised | Unbounded theft via forged payouts/withdrawals | Residual loss = wallet rate caps × detection time, bounded by float |
| 12 | **BIP39 recovery**, backup-gated balance caps (§1) | "Lost key = lost money" was an operational hazard | Mass loss events, support nightmares | Phrase theft equals theft (self-custody reality) |
| 13 | **Sybil stance made explicit** (§4.7) | IP/PoW limits are spam control, not identity | Solvency depending on account uniqueness | Per-account courtesies are evadable; bucket/global caps are the real bound |
| 14 | Scaling claims demoted to **hypotheses with a benchmark plan** (§9) | "Hundreds of runs per core" was asserted, not measured | Capacity planning on fiction | Real numbers pending the benchmarks |

---

## 1. Accounts & anonymity

**No email, no password, no PII.** An account is a keypair.

- The browser derives an ed25519 signing key from a **BIP39-style recovery
  phrase**: `mnemonic → master secret → deterministic account key`
  (SLIP-0010-style derivation). The public key **is** the account ID. The
  operator never sees the private key or the phrase.
- Login is challenge-response: the server sends a nonce, the client signs it.
  There is no password database that could leak.
- The display name is derived deterministically from the pubkey
  (`brave-otter-4711`) — collision-free and not choosable, so there is no
  impersonation and nothing to moderate.
- **Backup gating**: an account whose phrase backup has not been verified
  (re-enter three random words) is capped — configurable, e.g. max balance
  50,000 sat and deposits blocked beyond it. Verified backup lifts the cap.
  This keeps the passwordless design and removes the v1 hazard where one
  cleared browser profile silently destroyed a large balance.
- Losing the phrase still loses the balance; the phrase is the account. That
  is self-custody and it is said to the user in exactly those words.
- Account creation is free but throttled (per-IP limits plus a small client
  proof-of-work). This is **abuse control, not identity** — see §4.7 for what
  is and is not assumed about Sybils.

---

## 2. Money flow

```
                 ┌──────────────────────────── Player ─────────────────────────────┐
                 │  ed25519 account (BIP39)      Browser client (Unity WebGL)      │
                 └───────┬───────────────────────────────┬──────────────────────────┘
                         │ REST (wallet, quotes)         │ WebSocket (game: inputs only)
                 ┌───────▼──────────┐            ┌───────▼─────────┐
                 │  API gateway     │            │  Game shards    │  authoritative
                 │  (stateless)     │            │  (simulation)   │  simulation only —
                 └───────┬──────────┘            └───────┬─────────┘  shards NEVER price
                         │                               │ signed outcome facts
                 ┌───────▼─────────┐             ┌───────▼──────────────────────────┐
                 │  Quote Engine   │────────────▶│  Ledger (Postgres, double-entry, │
                 │  (pricing, risk,│  frozen     │  append-only hash chain,         │
                 │  exposure caps) │  quotes     │  Merkle-anchored)                │
                 └─────────────────┘             └───────┬──────────────────────────┘
                                                         │ settlement requests
                                                 ┌───────▼──────────┐
                                                 │  Settlement      │  narrow, signed,
                                                 │  Authority (HSM) │  single-use payout
                                                 └───────┬──────────┘  authorisations
                                                         │
                                                 ┌───────▼──────────┐
                                                 │  Wallet daemon   │  independent hard
                                                 │  (own host, no   │  limits (§2.6)
                                                 │  inbound)        │
                                                 └───────┬──────────┘
                                                         │
                                                 Lightning node (hot wallet, small float,
                                                 cold sweep above threshold)
```

### 2.1 Deposit
- `POST /deposit {amount}` → the server issues a Lightning invoice (label =
  account). The settlement callback credits the account **idempotently**
  (invoice ID as key). Lightning settles atomically; the on-chain 0-conf
  problem does not arise.
- Minimum 1,000 sat; per-account maximum per §1 backup gating and §4.6 caps.

### 2.2 Ledger
- **Double-entry**: every movement is a posting between accounts
  (player ↔ escrow ↔ house ↔ fees). No code path "sets a balance".
- Continuously checked invariant:
  `Σ player balances + escrow + house = Σ deposits − Σ withdrawals`.
- Every posting carries the hash of its predecessor (append-only hash chain),
  and balance mutations run under serialisable transactions / row locks, so
  double-spend races are excluded at the database level.
- **External anchoring (new in v2).** An operator-held hash chain proves
  internal consistency, not history: the operator could rewrite everything
  and re-hash. Therefore, per epoch (e.g. every 10 minutes, and daily):
  1. all postings of the epoch are leaves of a **Merkle tree**;
  2. the root is **anchored externally** — via OpenTimestamps aggregation
     and/or a periodic Bitcoin `OP_RETURN` (on-theme and cheap at daily
     cadence);
  3. players receive, on demand, a **signed receipt plus a Merkle inclusion
     proof** for their own postings against an anchored root
     (`GET /receipts/{entry}`).
  Nothing per-transaction is published; only roots are public. Rewriting
  history now requires contradicting an external, timestamped commitment that
  any player may hold a proof against — rewrites become *detectable by third
  parties*, which is the strongest property achievable without a public
  ledger. Residual limitation: anchoring detects, it does not physically
  prevent, and the current epoch (pre-anchor) is not yet covered.

### 2.3 Withdrawal (player view)
- `POST /withdraw {bolt11, idempotency_key}` → checks: amount ≤ balance,
  ≥ minimum, per-account rate limits.
- Order of operations: **debit as pending first**, then authorise, then pay;
  re-credit on failure. Idempotency keys make duplicates harmless.
- Amounts above a review threshold (e.g. 250,000 sat) pay out on a delay.

### 2.4 Settlement Authority (new in v2)
A dedicated service between ledger and wallet daemon, holding the settlement
key in an HSM (or equivalent isolation). The key exists **nowhere** on the web
tier, the shards, or the quote engine.

For each withdrawal it verifies against the ledger: the pending debit exists,
is unconsumed, and matches account and amount — then signs a **narrow,
single-use authorisation**:

```
Authorization {
  withdrawal_id      // single-use, never reissued
  account_id
  payment_hash       // hash of the bolt11 the daemon must pay — binds the destination
  amount_msat
  expiry             // short, e.g. 10 minutes
  ledger_ref         // the pending-debit posting
  signature          // ed25519, settlement key
}
```

### 2.5 Wallet daemon
Runs on its own host, accepts **no inbound connections**, polls for
authorisations. It pays only if: signature valid, `withdrawal_id` never seen
before (persistent dedupe set → replay-proof), `payment_hash` matches the
bolt11 it is about to pay, expiry not passed, and **its own limits** (§2.6)
permit. Generic or re-playable signatures are structurally impossible: every
field of the authorisation is bound, and one ID pays at most once.

### 2.6 Independent wallet limits (new in v2)
Configured on the wallet host itself, not readable or writable from the
application database, changeable only out-of-band:

| Limit | Example value |
|---|---|
| Max single withdrawal | 500,000 sat |
| Max sats per minute | 100,000 |
| Max sats per hour | 1,000,000 |
| Max sats per day | 5,000,000 |
| Max outstanding (authorised, unpaid) | 1,000,000 |
| Hot wallet ceiling (excess swept cold) | 5,000,000 |
| Emergency stop | manual/dead-man switch |

**Why this bounds catastrophe:** assume the entire application tier — web,
shards, quote engine, even the ledger database — is attacker-controlled and
produces perfectly forged, correctly signed-looking state. The attacker still
cannot exceed the daemon's own rate caps, and cannot take more than the hot
float in any case. Worst-case realized loss ≈
`min(daily cap × days-to-detection, hot float)` — with the values above and
even slow (one-day) detection: about 5M sat. That is the deepest of the four
defense layers, and the only one that assumes everything above it has failed.

---

## 3. A run, end to end

### 3.1 The happy path
1. **Round**: the server runs the block clock. One round seed → identical
   terrain and army composition for everyone (§7).
2. **Quote**: the player loads parcels; the client requests a quote. The
   **Quote Engine** (never the shard) prices it and returns a signed quote
   (§4.2), valid ~60 seconds.
3. **Accept / ROLL OUT**: the client accepts the quote. Atomically: the quote
   is frozen, the stake moves from balance to escrow, exposure counters are
   consumed, and a run is created bound to `quote_id`.
4. **Drive**: inputs up, corrections and events down (§6). The shard produces
   the authoritative outcome as a **fact**, not a price.
5. **Settle**: outcome class (§3.3) + frozen quote → ledger postings. Payouts
   flow escrow/house → player; losses flow escrow → house.

### 3.2 Once accepted, a quote never changes
Calibration, breakers and repricing affect **future quotes only**. A frozen
quote is honoured even if the model learns mid-run that it was mispriced. The
loss from that honesty is bounded by exposure caps (§4.6), and the gain is
absolute: no settlement dispute can ever hinge on "the price moved".

### 3.3 Outcome classes (new in v2)

| Class | Meaning | Money |
|---|---|---|
| `DELIVERED` | The authoritative simulation confirms gate arrival within the round | Escrowed stake + winnings per the frozen payout curve to the player; fee share to house |
| `PLAYER_LOST` | Deterministic game rules confirm legitimate failure: destroyed, or round ended without arrival — including while disconnected (§6.4) | Stake to house |
| `VOID` | The run could not be completed *and verified* for reasons on the operator's side | **Stake returned in full**; exposure released; quote consumed |

`VOID` conditions — exhaustive list, all server-side:
- unrecoverable game-shard crash (recovery replay impossible or checksum-
  divergent, §6.5);
- missing or invalid randomness commitment for the run;
- simulation divergence (core checksum mismatch that a correction snapshot
  cannot reconcile);
- corrupted or incomplete durable run state;
- simulation-version mismatch between quote and shard;
- internal consistency failure at settlement (e.g. ledger/quote mismatch);
- declared infrastructure failure windows (operator incident).

Two rules make VOID safe:
1. **The operator must never profit from a technical failure** — VOID always
   returns the stake, never forfeits it.
2. **No client-triggerable condition may cause VOID** — everything a client
   can do (disconnect, stall, send garbage) deterministically maps to normal
   gameplay or `PLAYER_LOST` (§6.4). Otherwise VOID becomes a free re-roll on
   losing runs.

---

## 4. The economic security model

This section replaces v1 §4 entirely. It is built on four independent layers.
Layers 1–2 make mispricing rare and short-lived. Layers 3–4 bound the damage
**even when layers 1–2 fail completely**.

```
Layer 1  Conservative pricing        (UCB quotes — §4.4)
Layer 2  Statistical circuit breakers (sequential tests — §4.6)
Layer 3  Hard exposure caps           (unconditional bounds — §4.6)
Layer 4  Wallet-tier limits           (bounds even under full compromise — §2.6)
```

### 4.1 What the 10% house edge actually means
```
M_shown = 0.90 × M_fair        where  M_fair = 1 / p̂
```
This means: **if the estimated success probability p̂ is correct for the
strategy actually being played, the expected return to player (RTP) is ~90%
of the stake.** It does *not* mean the operator takes 10% of winnings.

Numerical example — stake 10,000 sat, bucket estimate p̂ = 0.50:
- `M_fair = 2.00`, `M_shown = 1.80`. Arrival pays 18,000 (net +8,000); failure
  pays 0.
- `EV = 0.50 × 18,000 = 9,000` → expected cost 1,000 sat = **10% of the
  stake**. RTP 90%.
- A "10% of winnings" scheme would instead pay 0.5 × (20,000 − 1,000) →
  EV 9,500, RTP 95% — a different and weaker edge. We do the former.
- **The edge exists only under correct calibration.** If the true success
  probability of the strategy being played is 0.80 while the quote assumed
  0.50: `EV = 0.80 × 18,000 = 14,400` → RTP 144%, house loses 44% of every
  stake until layers 2–3 intervene. This sentence is the design driver for
  everything below.

### 4.2 The Quote Engine (new in v2)
Pricing is a **separate service**. Game shards simulate; they never compute,
store, or influence a payout amount. The quote engine prices, enforces
exposure (§4.6), and signs:

```
Quote {
  quote_id, account_id, round_id
  stake
  payout_curve            // frozen M(x) over realized exposure x — §4.3
  payout_cap              // absolute sats cap for this run
  truck_loadout           // full configuration vector, not just class
  cargo[]                 // parcel ids + stake tiers
  bucket_id               // pricing bucket this quote was drawn from
  quote_model_version
  sim_version_hash        // the exact core the run must execute under
  risk_params             // caps consumed, exposure window id
  seed_commitment         // H(seed_run) — §7
  issued_at, expires_at   // ~60 s validity
  signature               // quote-engine key
}
```

Acceptance is atomic (freeze quote + escrow stake + consume exposure). The
shard receives the accepted quote's identifiers only; at settlement the ledger
recomputes the payout from the *frozen* curve and the shard's signed outcome
facts (exposure integral, outcome class). A compromised shard can therefore
lie about at most one thing — the outcome of its own runs — and that is
bounded by per-shard exposure caps and detected by replay audits (§6.5).

Quotes are **uniform**: identical inputs produce identical quotes for every
account. Prices are public; *limits* are personal (§4.6). This forecloses
quote-shopping (nothing personalized to shop for) and keeps the game fair to
inspect.

### 4.3 The frozen payout curve
v1 had a contradiction: the multiplier depended on the route actually driven
(exposure integral), but a frozen quote must fix payout terms before the run.
v2 resolves it: **the quote freezes a function, and the run supplies its
argument.**

- The quote contains a monotone piecewise curve `M(x)` mapping the realized
  exposure integral `x` (time-and-depth in the combat corridor, heat-weighted
  — computed by the authoritative sim) to a multiplier.
- Example curve (front-corridor family, after fee):
  `x ∈ [0, 0.2) → 0.90 · x ∈ [0.2, 0.5) → 1.30 · x ∈ [0.5, 0.8) → 1.75 ·
  x ≥ 0.8 → 2.10`, capped by `payout_cap`.
- The curve is frozen at acceptance; later calibration changes future curves
  only. Route freedom survives: the player chooses the risk during the run;
  the price of every choice was fixed before it.

The **safe-route principle is preserved**: a near-certain path sits at the
bottom of the curve, below 1.0 after fee. Nobody is forced into the fight;
staying out simply prices at ×0.90 — a −10% EV by arithmetic, not by rule.

### 4.4 Conservative (UCB) pricing — layer 1
Quotes are never priced off the point estimate. Per bucket, success counts
feed a Beta posterior, and the quote uses the **upper credible bound**:

```
p_UCB  = upper bound of the 97.5% credible interval for p in this bucket
M_shown(x) = 0.90 × M_fair_curve(x)  scaled so peak M = 0.90 / p_UCB(x-band)
```

Consequences, deliberate:
- A player is +EV only if their personal success rate exceeds
  `p_UCB / 0.90 ≈ 1.11 × p_UCB` — they must beat not the average but the
  *optimistic-for-the-house* estimate.
- **Cold start pays the house, never the player.** An unknown or thin bucket
  has a wide posterior; `p_UCB` sits near 1, so `M_shown` starts near 0.90
  and *rises only as observed failures prove the danger is real*. The house
  never extends credit to its own ignorance. (Cost: new content is initially
  unattractive; seeded from play-money telemetry to shorten that phase.)
- **Sim-version keying.** Calibration data is keyed by `sim_version_hash`. A
  new version (a patch that makes some route easier) re-initialises affected
  buckets to conservative priors instead of inheriting stale danger estimates
  — closing "patch arbitrage", where yesterday's hard route is today's easy
  one at yesterday's generous price.

Worked example used throughout: bucket with n = 4,800 runs, 2,400 successes
→ posterior mean 0.500, `p_UCB ≈ 0.514`, peak `M_shown = 0.90/0.514 ≈ 1.75`
(naive pricing would have shown 1.80).

### 4.5 Calibration granularity — pricing the loadout, not the class
v1 calibrated per (route band × heat band × *truck class*). That invites
**configuration arbitrage**: the strongest loadout inside a broad class is
priced against the class average and becomes +EV.

v2 buckets on the **full configuration vector**: route/exposure band × heat
band × truck chassis × armour tier × engine tier × cargo-weight band × stake
band × sim version. That fragments samples, so the estimator is a
**hierarchical (partial-pooling) model**: a leaf's posterior shrinks toward
its parent (loadout → chassis → global) in proportion to its own sample size.

The statistical trade-off, stated plainly:
- Coarse buckets → large n, tight bounds, but systematic mispricing across
  configurations inside a bucket (exploitable, directional).
- Fine buckets → no cross-config mispricing, but small n. Under UCB pricing,
  small n means **conservative quotes, not generous ones** — fragmentation
  degrades player payouts, never house solvency.
- Partial pooling gives leaves with little data approximately their parent's
  price (plus extra caution), and lets a leaf that accumulates volume — which
  is exactly what a dominant config being farmed does — earn its own, rapidly
  correcting estimate. Monotonicity constraints (more armour ⇒ p̂ not lower)
  keep sparse leaves from random inversions.

### 4.6 Exposure management and circuit breakers — layers 2 and 3
Illustrative configuration (all values operator-tunable, enforced by the
quote engine at issuance and acceptance):

| Cap | Example |
|---|---|
| Stake per run | ≤ 50,000 sat |
| Payout per run (`payout_cap`) | ≤ 250,000 sat |
| Stakes per account per round | ≤ 200,000 sat |
| Accepted stakes per bucket per window (window ≈ recalibration period) | ≤ 3,000,000 sat |
| Outstanding potential payout per bucket | ≤ 2,000,000 sat |
| Outstanding potential payout, global | ≤ 20,000,000 sat |
| Auto-derate | new/low-confidence buckets get reduced stake caps |
| Auto-suspend | breaker trip halts quoting for the bucket |

**Breaker**: per bucket, a sequential probability ratio test (SPRT) compares
the priced probability `p₀ = p_UCB` against an elevated alternative
`p₁ = min(1.3 × p₀, 0.98)` over settled runs:

```
LLR += ln(p₁/p₀)              on success
LLR += ln((1−p₁)/(1−p₀))      on failure
trip when LLR ≥ ln(1/α), α = 0.01  →  threshold ≈ 4.6
```

On trip: quoting suspends for the bucket, the bucket reprices with the new
data, per-account monitors flag the contributing accounts (realized-EV SPRT
per account), and risk review decides resumption. Skilled-but-honest players
trip nothing dramatic: their edge is small (§4.8 scenario b), and their data
simply feeds calibration.

**Why a newly discovered optimal strategy cannot drain the bankroll:**
1. It must be *executed* to be exploited — and every execution is a sample
   feeding the breaker. Exploration is self-defeating: proving a bucket is
   mispriced is the same act that suspends it.
2. Until the breaker trips, extraction per bucket is bounded by the window
   stake cap: `loss ≤ S_window × (p_true × M_shown − 1)`.
3. Whatever happens across all buckets simultaneously, the **global
   outstanding-payout cap bounds the total unconditionally**: even if every
   open quote were maximally mispriced and every run succeeded, one window's
   loss ≤ 20M sat (minus collected stakes). This bound needs no statistics,
   no detection and no correct model.
4. Realized outflow is additionally bounded by the wallet tier (§2.6),
   independent of everything above.

**Per-account limiting** (bookmaker-style): accounts with persistently
positive realized EV get progressively reduced stake caps. This is friction,
not a security boundary — it is Sybil-evadable (§4.7) — but it slows manual
arbitrage and keeps quotes uniform (limits are personal, prices are not).

### 4.7 Sybil assumptions, stated honestly
IP limits and proof-of-work are **spam controls**. The design assumes one
actor may control hundreds of accounts:
- No bonuses, no faucets, no per-account subsidies → splitting a bankroll
  across accounts yields nothing.
- All solvency-relevant caps that matter are **account-independent**: bucket
  window caps, global outstanding cap, wallet-tier caps. Sybil multiplies
  only the per-account courtesies (stake caps, limiting), never the bounds.
- Account-uniqueness is used for nothing solvency-critical.

### 4.8 Solvency scenarios — the numbers
Reference bucket: `p̂ = 0.500, p_UCB = 0.514, peak M_shown = 1.75`, stake cap
50k, bucket window stake cap 3M, breaker as in §4.6
(`p₀ = 0.514, p₁ = 0.668`; LLR: success +0.262, failure −0.381; trip ≈ 4.6).

| Scenario | Assumption | EV per stake | Outcome for the house |
|---|---|---|---|
| (a) Average humans | true p = 0.50 | `0.50 × 1.75 = 0.875` | RTP 87.5% (UCB margin makes realized edge slightly better than the 10% target) — solvent |
| (b) Skilled human | true p = 0.60 | `0.60 × 1.75 = 1.05` | +5% per stake for the player; bounded ≤ 200k stakes/round → expected extraction ≤ ~10k sat/round; their successes raise p̂ → M falls; per-account limiting adds friction. Deliberately tolerated — this **is** skill mattering |
| (c) Perfect-input bot | true p = 0.85 | `0.85 × 1.75 = 1.49` | E[LLR] = 0.85·0.262 − 0.15·0.381 ≈ 0.166/run → breaker trips after ≈ 28 runs. At max stakes: ~1.4M staked, expected extraction ≈ 1.4M × 0.49 ≈ **690k sat, then the bucket suspends**. Absolute worst (all 28 succeed): ≤ 1.05M |
| (d) Bot at 1% of volume | 99% avg + 1% bot | blended RTP ≈ 0.99·0.875 + 0.01·1.49 ≈ **0.881** | Edge dips ~0.6 points — solvent without any intervention; account-level SPRT still flags the bot |
| (e) Bots at 10% of volume | 90% avg + 10% bot | blended RTP ≈ 0.9·0.875 + 0.1·1.49 ≈ **0.937** | Edge ≈ 6% — still solvent; observed bucket rate rises to ≈ 0.535 → recalibration lowers M within one window; breakers fire earlier in the bots' specific buckets |
| (f) Coordinated bots on one mispriced bucket | true p → 1 (worst case) | up to `M_shown` | Loss ≤ min(breaker path ≈ 18–30 runs × stake × (M−1), window stake cap × (M−1)) ≈ **≤ 2.3M sat absolute worst per bucket per window**; ≤ 20M globally by the outstanding cap — regardless of how wrong the model was |
| (g) Mispriced "safe" route (true p = 0.99 priced at 0.514) | EV = 1.73 | All-success stream trips the breaker fastest: E[LLR] ≈ 0.256/run → ≈ 18 runs → loss ≈ 18 × 50k × 0.73 ≈ **660k sat**, then suspension. UCB cold-start makes this class rare: unknown-safe prices near 0.90 by construction; the dangerous residual is *stale* data, which sim-version keying (§4.4) truncates |

**What is explicitly not claimed:** that bots cannot beat the house. Scenario
(c) shows a bot extracting ~0.7M sat from one mispriced bucket before
suspension. The claim that *is* made, and follows from the caps arithmetic:
**per window, aggregate extraction is bounded by hard limits that hold under
arbitrary skill, arbitrary Sybil counts, and an arbitrarily wrong pricing
model — and realized outflow is independently bounded by the wallet tier.**
Solvency is a property of the caps, not of the players.

---

## 5. Trucks: buying and repairing

Unchanged in spirit; sharpened in mechanism:
- Starter truck free (small bed = low stake cap, little armour). Better
  trucks cost sats: more capacity, more armour, more speed. Damage persists;
  repair costs; a write-off means replacement.
- **Money buys capacity and variance reduction, never expected value** — now
  enforced by construction rather than by intent: every loadout is its own
  pricing leaf (§4.5), so an armoured configuration's higher survival rate is
  priced into *its* multiplier as fast as it accumulates volume, with UCB
  conservatism in the gap.

---

## 6. Authoritative simulation, protocol, and recovery

### 6.1 A shared deterministic core
Game logic (armies, fire, simplified truck model, hits, gate) lives in a
**shared deterministic core** (Rust → native for shards, WASM for clients;
fixed-point arithmetic, bit-identical on both). Unity keeps WheelColliders
and suspension as cosmetics; position, damage, death and arrival come from
the server. Each core build is **content-addressed and archived immutably**
(`sim_version_hash`); quotes, runs and calibration all bind to it.

### 6.2 Traffic budget (updated: battle-roll events added, §7)
| Message | Direction | Rate | Size |
|---|---|---|---|
| InputBatch (tick + 10× quantised steer/throttle/brake, HMAC) | C→S | 10/s | ~30 B |
| TruckCorrection (pos, vel, heading, HP, quantised) | S→C | 10/s | ~40 B |
| BattleEvent (hit rolls, damage, kills — authoritative) | S→C | bursty, ~5–20/s in combat | ~15 B |
| GhostUpdate (≤ 8 nearest players, delta-coded) | S→C | 5/s | ~10 B/ghost |
| ArmyChecksum | S→C | 1/s | 8 B |
| Lifecycle events (delivery, death, block close) | S→C | rare | ~20 B |

Still **under ~2.5 KB/s per player**. One platform-side mempool fetcher
serves everyone.

### 6.3 Ghosts, unchanged
Other trucks are visible ghosts without collision; each run's armies react
only to its own truck (private world instance). In a money game no other
player may be able to change my odds — shared armies would invite drafting,
ramming and collusion. The per-block leaderboard is global and server-side.

### 6.4 Deterministic disconnect behavior (new in v2)
The core rule: **missing inputs are themselves deterministic input.**

- For any tick without a client input batch, the core applies the neutral
  policy: throttle 0, steering decays to 0 over 10 ticks, brake ramps to
  full. The truck pulls up and stops, deterministically, wherever it is.
- A stopped truck is still in the world: armies still shoot it, the round
  clock still runs. If it is destroyed, or the round ends → `PLAYER_LOST`.
- **No client-side event ever voids a run**: WebSocket drop, browser close,
  input silence, packet loss — all of it reduces to the neutral policy.
  Pulling the plug during a losing run changes nothing; the run continues on
  the server and settles normally. Disconnect-to-escape does not exist.
- Reconnection: the client rejoins by `run_id` (session in Redis), receives a
  state snapshot, resumes control at the current tick. Grace is generous —
  reconnect any time before the round ends.
- Packet loss: input batches are tick-numbered and overlapping; the shard
  accepts a batch within a bounded window, drops duplicates idempotently,
  and applies the neutral policy for gaps. Late inputs beyond the window are
  discarded (no retroactive driving).
- **Server-side failures are different in kind**: shard crash → recovery
  (§6.5); recovery impossible → `VOID`, stake returned. Gateway failure →
  clients reconnect through another gateway; shards are unaffected. The
  boundary is precise: *client-attributable silence = gameplay;
  operator-attributable failure = VOID*.

### 6.5 Run records, replay, and crash recovery (new in v2)
Every real-money run produces an immutable **Run Record**:

```
RunRecord {
  run_id, account_id, quote_id, round_id
  stake, frozen payout_curve, payout_cap
  truck_loadout, cargo[]
  seed_commitment, seed_reveal          // §7
  input_log_ref                          // durable, append-only, complete
  input_log_hash
  sim_version_hash                       // pins the archived core build
  start_tick, end_tick
  outcome_class, exposure_integral, payout
  ledger_refs[]                          // escrow, settle postings
  shard_signature
}
```

- **During the run**, the shard appends every accepted input batch and a
  state snapshot every N seconds to durable storage (append-only log).
- **Crash recovery**: a replacement shard loads the last snapshot, replays
  the logged inputs through the same `sim_version_hash` core, and — by
  determinism — arrives at the identical state, then continues. Target
  recovery time ~10 s; the affected client sees a stall, not a loss. If the
  log is incomplete or the replay checksum diverges → `VOID` (§3.3).
- **Reproducibility forever**: because core builds are archived immutably and
  the record pins `sim_version_hash`, any historical run can be re-executed
  bit-identically years later, regardless of how physics, AI or maps have
  changed since. Disputes reduce to `replay(record) == recorded outcome`.
- The `input_log_hash` and outcome land in the settle posting → run records
  are transitively covered by the ledger's Merkle anchoring (§2.2).
- Replay is also run **routinely by an auditor process** on a sample of
  settled runs (and on every large payout) as the detection mechanism for a
  compromised shard signing false outcomes.

---

## 7. Randomness architecture (reworked in v2)

v1 published one round seed and called it provably fair. That created a
conflict: a fully pre-known seed lets a bot simulate the entire world and
compute an optimal route before driving; a fully hidden seed breaks client
prediction and verifiability. v2 splits the randomness into tiers:

| Tier | Contents | Visible when | Purpose |
|---|---|---|---|
| **Round-static** | Terrain, roads, army composition & formation seeds | Public at round start | Shared world for all players; deterministic client prediction; fairness of the arena |
| **Run-committed** | `seed_run` = HMAC(secret_d, round ‖ run_id ‖ account): per-run spawn jitter + the combat-roll stream | `H(seed_run)` inside the signed quote (**before** stake acceptance); `seed_run` revealed at settlement | Operator provably cannot re-roll or tailor outcomes after seeing the stake; bots cannot precompute exact rolls |
| **Server-private during the run** | The individual combat rolls as they are drawn from `seed_run` | Streamed as authoritative `BattleEvent`s at the moment they occur | Keeps the outcome stochastic under offline optimization |
| **Post-run** | `seed_run`, full run record | At settlement | Anyone can verify `replay(inputs, seeds) == outcome` with the archived core |

Daily secrets are pre-committed in a chain (`H(secret_d)` published the day
before), and round seeds mix the Bitcoin block hash — public entropy the
operator cannot choose.

What the client needs for prediction, it has: its own truck responds only to
its own inputs (deterministic), and army *movement* follows from round-static
data plus the truck's trajectory. What it cannot predict — hit rolls, damage
amounts, per-run spawn jitter — arrives as small authoritative events and is
folded in; checksums and rare correction snapshots absorb residual drift.

**The acknowledged residual**, per the core principle: round-static data is
public, so offline route optimization against terrain and army layout is
possible and cannot be prevented without destroying either prediction or
verifiability. v2 accepts it explicitly: static-world optimization is the
bot-face of *skill*, it raises an agent's p toward some `p_max < 1` (hidden
combat rolls keep `p_max` strictly below 1 for any exposed route), and the
economic layers of §4 are sized for agents at `p_max`. Per-run spawn jitter
additionally makes one precomputed solution non-transferable across runs.

---

## 8. Threat model (expanded in v2)

Format per row: **capability / financial impact / preventive control /
detection / max residual exposure**.

| Threat | Capability | Impact | Prevention | Detection | Residual exposure |
|---|---|---|---|---|---|
| Forged arrival via API | Craft API calls | Unlimited if possible | **Endpoint does not exist**; outcomes are server sim events | — | None |
| Modified client | Any client-side change | None directly | Client decides nothing (§0.1) | Checksum divergence stats | None beyond bot cases below |
| Perfect-input bot | Frame-perfect driving | +EV per §4.8(c) | UCB pricing, caps | Bucket + account SPRT | ≈ 0.7–1M sat per bucket-window, then suspension |
| Route-solving / offline sim (Monte Carlo, RL) | Pre-computes optimal static route | Raises p toward p_max | Hidden combat rolls (p_max < 1), per-run jitter, caps | Same SPRTs | Same bound as above |
| Quote arbitrage (shopping/timing) | Mass quote requests, accept only favourable | Skim on model updates | Quotes uniform + deterministic per bucket-state; short expiry; request rate limits; acceptance consumes exposure | Quote/accept ratio monitoring | Negligible |
| Configuration arbitrage | Search loadout space for mispricing | +EV on mispriced leaf | Per-loadout hierarchical pricing + UCB (unexplored = conservative); sim-version re-init | Leaf-level SPRT | ≤ bucket window bound |
| Sybil accounts | Hundreds of accounts, one bankroll | Evades per-account courtesies | No bonuses; solvency caps account-independent (§4.7) | Clustering heuristics (advisory) | None beyond bucket/global bounds |
| Disconnect manipulation | Drop connection strategically | Escape losing runs | Deterministic neutral-input policy; client events never VOID (§6.4) | — | None |
| Input replay | Replay old batches | Ghost driving | Tick windows + session HMAC + idempotent batch handling | Protocol counters | None |
| Withdrawal replay | Re-submit authorisations | Double payout | Single-use `withdrawal_id`, bound `payment_hash`, expiry (§2.4–2.5) | Daemon dedupe log | None |
| Compromised game shard | Sign false outcomes for its runs | Steal payouts on those runs | Shards can't price (quote engine) or pay (SA); per-shard exposure caps | **Routine replay audit** of settled runs (§6.5) | ≤ shard's outstanding cap until audit catches it |
| Compromised web tier | Full API manipulation | Session abuse | No authority anywhere in the tier; SA + wallet checks | Invariant + anchor monitors | ≤ wallet-tier caps (§2.6) |
| Compromised quote engine | Issue generous quotes | Systematic overpayment | Quote-key isolation; **global outstanding cap enforced at ledger acceptance**, not only in the engine | RTP monitors, anchor audits | ≤ global outstanding cap per window (≤ 20M sat) |
| Compromised Settlement Authority | Sign arbitrary payouts | Direct theft | HSM isolation; daemon independently re-checks limits | Wallet-side anomaly alarms | ≤ wallet rate caps × detection time, ≤ hot float |
| Database manipulation | Rewrite balances/postings | Fabricated wealth | Serialisable postings; SA cross-checks; hash chain | **External Merkle anchors** break on rewrite; invariant checks | ≤ wallet-tier caps |
| Ledger history rewrite (insider) | Full DB + code access | Cover-up of theft | Anchoring makes rewrites third-party detectable (§2.2) | Player-held Merkle proofs vs anchors | Detection, not prevention; funds bounded by wallet tier |
| DDoS during real-money runs | Take down gateways/shards | Force losses / chaos | Client loss ⇒ neutral policy (no forced loss unless the *game* kills you); operator-side outage ⇒ **VOID, stakes returned** | Infra monitoring | Operating cost only; no EV transfer to house or attacker |
| Rigged terrain/spawns | Operator tailors world to a stake | Player harm / reputation | Seed commitment **inside the signed quote, before acceptance** (§7) | Commit-reveal verification by players | None if commitments verified |

**Honest limits.** No serious design claims "no vulnerabilities". This one
makes the worst classes structurally impossible (forged results, client
authority, PvP coupling, disconnect escape, replayable payouts), bounds the
rest in sats (caps at four independent layers), and makes the remainder
visible (anchoring, replay audits, SPRT monitors, invariants). Two residuals
are accepted by design and stated: optimized play can extract a bounded
amount from a mispriced bucket before suspension (§4.8), and ledger rewriting
is made detectable rather than impossible (§2.2).

---

## 9. Scaling: hypotheses and benchmarks (revised in v2)

v1 asserted "several hundred concurrent runs per CPU core". v2 treats every
such number as a **hypothesis to be benchmarked** before capacity planning.

Benchmark targets (per run unless noted, on production-class hardware):

| Metric | Target (hypothesis) |
|---|---|
| Core tick rate | 30 Hz authoritative |
| Full sim step (≈200 units, AI + movement + fire) | ≤ 300 µs avg, ≤ 1 ms p99 |
| AI decision slice | ≤ 150 µs |
| Collision/overlap pass | ≤ 50 µs |
| Input batch apply | ≤ 5 µs |
| Snapshot serialization (every 5 s) | ≤ 1 ms |
| Durable log append | ≤ 0.5 ms amortized |
| Memory per run | ≤ 2 MB |
| Bandwidth per player | ≤ 2.5 KB/s |
| Crash recovery (snapshot + replay) | ≤ 10 s |

Methodology:
1. **Micro**: criterion benches per system (AI, movement, serialization) on
   the native core.
2. **Replay corpus**: ≥ 1,000 recorded human runs replayed headless;
   distribution of tick costs, not just means.
3. **Swarm load**: synthetic input bots (recorded traces + adversarial
   full-throttle + random) at **100 / 1,000 / 10,000 concurrent runs**,
   scaling from one shard to a full mesh behind real gateways, with real
   ledger writes. Measured: p50/p99 tick time, correction rate, checksum
   divergence rate, settlements/s at the ledger, gateway CPU, memory ceiling.
4. **Chaos**: kill shards mid-run at each load tier — verify recovery ≤ 10 s,
   zero incorrect settlements, correct VOIDs; kill gateways — verify
   reconnect; partition the wallet tier — verify withdrawals queue, never
   double-pay.
5. **Soak**: 24 h at the 1,000-run tier; leak and drift detection.

Acceptance for real-money launch: the 1,000-run tier passes all targets with
≥ 2× headroom; the 10,000-run tier documents the scaling curve and the
sharding plan to reach it.

Operations otherwise as v1: stateless gateways behind CDN, consistent-hash
shard assignment (runs are independent), one Postgres primary for money plus
read replicas, Redis sessions, one platform mempool fetcher. Monitoring adds:
per-bucket realized RTP, SPRT states, exposure headroom, anchor freshness,
replay-audit backlog, wallet float and rate-cap headroom.

---

## 10. Legal note (out of scope, not ignorable)

Playing for real money with an element of chance is licensable gambling — or
regulated skill gaming — in most jurisdictions, and anonymity without KYC
collides with AML rules in several. The design carries the technical
prerequisites for limits (stake caps, loss limits per period, self-exclusion,
backup-gated balances), but the legal question needs its own answer before a
real-money launch. Until then, everything runs identically on play money.

---

## 11. Delivery plan (revised)

| Phase | Content | New in v2 |
|---|---|---|
| **0** | Extract the deterministic core (Rust, fixed-point, WASM+native, content-addressed builds; golden replay tests against recorded Unity runs) | Immutable version archive from day one |
| **1** | Accounts (BIP39→ed25519), ledger, play-money in/out, hash chain, **Merkle anchoring**, receipts with proofs | Anchoring, backup gating |
| **2** | Server-authoritative runs: input protocol, prediction/correction, ghosts, run records + durable logs + crash replay, disconnect policy, outcome classes, global leaderboard | Run records, VOID machinery, benchmarks tier 100→1,000 |
| **3** | **Quote Engine** (curves, UCB pricing, hierarchical calibration, exposure caps, SPRT breakers) on play money; randomness tiers with committed run seeds | The entire §4 economic layer, proven on play money first |
| **4** | Real sats: wallet daemon + **Settlement Authority** (HSM), independent wallet limits, small caps, replay auditor, review processes, self-exclusion, load tier 10,000, external security audit **before any cap raise** | SA, wallet-tier limits, audit gate |

---

## 12. API surface (complete — its brevity is the security argument)

```
REST  POST /account            {pubkey}                          → name
      POST /login              {pubkey} → challenge → sig        → session token
      POST /deposit            {amount}                          → bolt11 invoice
      POST /withdraw           {bolt11, idempotency_key}         → pending/paid
      POST /quote              {truck_loadout, cargo[]}          → signed Quote (§4.2)
      GET  /balance
      GET  /rounds/current                                       → seed commits, clock, board
      GET  /runs/{run_id}                                        → own RunRecord (§6.5)
      GET  /audit/head                                           → ledger chain head
      GET  /audit/anchor/{epoch}                                 → Merkle root + external anchor ref
      GET  /receipts/{entry}                                     → signed receipt + Merkle proof

WS    join_run   {quote_id}          → server validates quote, escrows stake, starts run
      inputs     {tick, [steer,throttle,brake]×10, hmac}
      ← state    {correction | battle_event | ghost | checksum | lifecycle}
```

That is all of it. There is still no endpoint through which a client can
*assert* a position, a hit, an arrival, a payout, or a balance — and what
does not exist cannot be abused. The quote endpoint issues prices; it accepts
none of the client's opinions about them.
