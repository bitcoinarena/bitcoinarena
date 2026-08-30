# BTC Logistics War — Multiplayer & Real-Money Concept

Written 2026-08-30. This document describes how the single-player prototype
becomes an anonymous multiplayer game played for real sats: Lightning in,
cargo as the stake, payout only on arrival, a 10% house fee — and an
architecture in which the client decides **nothing**.

---

## 0. Guiding principle

> **The client is an input device and a television.**

Once money is on the table, not one outcome-deciding quantity may be computed
in the browser. The client sends inputs only (steering, throttle, brake) and
renders what the server tells it. Whether the truck was hit, whether it is
alive, whether it reached the gate — the server simulates all of it.

The consequence is the single most important security property of this design:
**there is no "I have arrived" API call.** Arrival is an event the server
observes in its own simulation. The attack class "forged game result" therefore
does not exist structurally — it does not need defending against, because the
endpoint is not there.

A tampered client can achieve exactly one thing: driving perfectly. That is not
a security problem but an economic one, and it is handled in §4.4
(calibration).

---

## 1. Accounts & anonymity

**No email, no password, no PII.** An account is a keypair.

- On first visit the browser generates an ed25519 keypair (WebCrypto). The
  public key **is** the account ID.
- Login is challenge-response: the server sends a nonce, the client signs it,
  done. There is no password database that could leak.
- The display name is derived deterministically from the pubkey
  (`brave-otter-4711`) — random-looking, collision-free, and not choosable.
  Not choosable means: no impersonation, no abusive names, no moderation
  needed.
- Losing the key means losing the balance. The client offers a seed phrase to
  write down, once. That is the honest consequence of anonymity without an
  identity anchor, and the user is told exactly that.
- Account creation is free but throttled (per-IP rate limit plus a small
  client-side proof-of-work), so flooding the system with accounts costs
  something.

---

## 2. Money flow

```
                    ┌──────────────────────── Player ────────────────────────┐
                    │  ed25519 account        Browser client (Unity WebGL)   │
                    └───────┬──────────────────────────┬─────────────────────┘
                            │ REST (wallet)            │ WebSocket (game: inputs only)
                    ┌───────▼──────────┐       ┌───────▼─────────┐
                    │  API gateway     │       │  Shard server   │  authoritative
                    │  (stateless)     │       │  (game sim)     │  simulation
                    └───────┬──────────┘       └───────┬─────────┘
                            │                          │ signed outcomes
                    ┌───────▼──────────────────────────▼─────────┐
                    │        Ledger (Postgres, double-entry,     │
                    │        append-only hash chain)             │
                    └───────┬────────────────────────────────────┘
                            │ signed payout authorisations
                    ┌───────▼──────────┐
                    │  Wallet daemon   │── Lightning node (hot wallet, small float)
                    │  (own host, no   │── cold sweep above threshold
                    │  inbound from    │
                    │  the internet)   │
                    └──────────────────┘
```

### 2.1 Deposit
- `POST /deposit {amount}` → the server issues a Lightning invoice (label =
  account).
- The settlement callback credits the account **idempotently** (invoice ID as
  the key). Lightning settles atomically — the 0-conf problem of on-chain does
  not arise here.
- Minimum 1,000 sat; configurable per-account maximum (exposure cap, §8).

### 2.2 Ledger
- **Double-entry**: every movement is a posting between two accounts
  (player ↔ escrow ↔ house). There is no code path that "sets a balance".
- Continuously checked invariant:
  `Σ player balances + escrow + house = Σ deposits − Σ withdrawals`
- Every posting carries the hash of its predecessor → an **append-only hash
  chain**. Altering a posting after the fact breaks the chain visibly. The
  current chain head is public (`GET /audit/head`), and players receive a
  signed receipt for each of their own postings.
- Balance operations run under `SELECT … FOR UPDATE` / serialisable
  transactions — races (spending the same balance twice through parallel
  requests) are ruled out at the database level, not merely in application
  code.

### 2.3 Withdrawal
- `POST /withdraw {bolt11}` → checks: amount ≤ balance, ≥ minimum, rate limits,
  daily cap.
- Order of operations: **debit as pending first**, then pay, and re-credit on
  failure. An idempotency key per request means a duplicate request never pays
  twice.
- Amounts above a threshold (say 250,000 sat) are paid out on a delay (review
  window). That caps the damage of **any** still-unknown bug at threshold ×
  rate — the safety net underneath everything else.
- Routing fees are borne by the recipient and shown transparently; the house
  fee lives in the game (§4), not in the withdrawal.

### 2.4 Key separation (why a compromised game server cannot drain the node)
The wallet daemon runs on its own host, accepts **no** inbound connections from
the internet, and pays only against a valid ed25519 signature from the
settlement key **plus** a matching ledger posting **plus** rate caps. The
settlement key does not live on the web or game tier. Whoever compromises the
gateway or a shard cannot produce a payout with it — at most they can
manipulate rounds, which calibration (§4.4) and the caps (§8) bound. The hot
wallet holds only a small float (e.g. 2–5M sat); the rest is swept cold
automatically.

---

## 3. A run, end to end

1. **Round**: the server runs the block clock (today `BlockClock`, later
   server-side). One seed per round → identical terrain and identical armies
   for everyone (§7).
2. **Load**: the player picks parcels. Each parcel has a **price in sats**
   (§4.1). On "ROLL OUT" the total is moved from the balance into an escrow
   account. No balance, no freight.
3. **Drive**: the client sends inputs, the server simulates, the client renders
   with prediction and gets corrected (§6).
4. **Outcome**:
   - **Gate reached** → the server observes the arrival event and posts
     `stake × multiplier` (§4.2) from the house/pool to the player.
   - **Wrecked, or the round ends without arrival** → the stake goes to the
     house in full. No partial payout (requirement 4: only arrival pays).
5. **Repair or replacement** afterwards, from the balance (§5).

---

## 4. Stake, payout, and the 10% house fee

### 4.1 Parcels as the stake
Parcels still come from the real mempool (look, size, heat), but their **stake
price** is a server-side figure in tiers derived from the transaction's fee
band: e.g. 100 / 500 / 1,000 / 5,000 sat. The total stake is the sum of the
loaded parcels, bounded by both the bed and the truck's stake cap (§5). "A
5,000 sat truck" means: 5,000 sat of stake aboard, and arriving by the normal
route returns roughly 5,000 sat of profit (M ≈ 2.0 after the fee — see the
example).

### 4.2 The payout formula
```
payout on arrival = stake × M_shown
M_shown           = 0.90 × M_fair(route, heat, truck class)
```
The **10% house fee is baked into the multiplier that is shown** — the player
always sees the number they will actually receive. `M_fair` is the multiplier
at which expected payout equals the stake (the fair odds): if statistically
one truck in two makes it through the front corridor, `M_fair = 2.0` there and
×1.8 is displayed.

**Example:** stake 5,000 sat, front corridor, `M_fair = 2.22` → shown ×2.0 →
arrival pays 10,000 sat (net +5,000). Of the fair 11,111 the house kept 1,111,
which is 10% — measured across all players.

### 4.3 Route multiplier and proximity to the fighting (requirement 5)
The server knows the path driven, because it simulated it, and computes an
**exposure integral**: how long and how deeply the truck was inside the combat
corridor, weighted by the heat at the time.

- Front corridor (middle, high heat): up to ×2.4 fair.
- Normal route: about ×1.6 fair.
- Edge route / map boundary: falls towards ×1.0 fair — **so ×0.9 after the
  fee**.

That is the elegant form of "penalty points": a player who keeps away from the
battlefield does not lose to a rule, they lose to arithmetic. Driving risk-free
is −10% EV. It also closes the single-player exploit twice over ("carry only
cheap, safe freight and earn forever"): the block clock limits runs per unit of
time, and safe runs are structurally loss-making.

### 4.4 Calibration — the economic defence
`M_fair` is not a constant. It is tracked continuously from the **global,
observed arrival rates** per (route band × heat band × truck class), targeting
a 90% payout ratio overall.

This is the answer to perfect driving bots and to multi-accounting. A bot that
arrives more often than average raises the measured arrival rate of its band →
the multiplier drops for everyone in that band → its own edge shrinks with it.
Bots do not beat the house; they worsen the odds, including their own.
Multi-accounting does not help either, because there are no bonuses and
calibration is global.

The honest trade-off: good human drivers share that adjustment too. The
granularity (per band, not global) keeps the effect local, and individual
skilled players **can** be +EV for a while — that is accepted the way poker
rake is, as long as the aggregate holds. Guard rails: stake caps per run and
per account per round, daily recalibration, and an alert when a band's arrival
rate exceeds 95%.

---

## 5. Trucks: buying and repairing (requirement 6)

- **Starter truck**: free, small bed (low stake cap), little armour.
- Better trucks cost sats from the balance: more bed (higher stake cap), more
  armour (higher survival rate), more speed.
- Damage persists after a run; repair costs in proportion. A write-off means
  the truck is gone and has to be replaced.
- **Principle: money buys capacity and variance reduction, never expected
  value.** Each truck class has its own calibration column (§4.4). An armoured
  truck arrives more often — and carries correspondingly lower multipliers.
  Otherwise "buy armour" would be a money printer, and quiet +EV paths like
  that are precisely the security holes of game economies.

---

## 6. Authoritative simulation and the wire protocol (requirements 8, 9)

### 6.1 A shared deterministic core
The game logic (armies, fire, the truck as a simplified driving model, hits,
the gate) is extracted from `Army.cs` and friends into a **shared
deterministic core** (Rust → native for the server, WASM for the client; fixed
point arithmetic so both compute bit-identically).

- The **server** runs the core authoritatively at 20–30 Hz, with a private
  world instance per run (§6.3). The core is small (~200 units, 2D logic) — a
  conservative estimate is **several hundred concurrent runs per CPU core**.
- The **client** runs the same core locally as prediction. The armies follow
  entirely from the round seed, so the server does **not** stream them, only a
  checksum heartbeat; on drift it sends a correction snapshot, which should be
  rare.
- Unity keeps WheelColliders and suspension as **cosmetics only** — the feel
  survives, but position, death and arrival come from the server. (This is the
  one migration change a player might notice: the model that decides the
  outcome is simpler than PhysX.)

### 6.2 Traffic budget
| Message | Direction | Rate | Size |
|---|---|---|---|
| InputBatch (tick number + 10× quantised steer/throttle/brake) | C→S | 10/s | ~30 B |
| TruckCorrection (position, velocity, heading, HP, quantised) | S→C | 10/s | ~40 B |
| GhostUpdate (≤ 8 nearest players, delta-coded) | S→C | 5/s | ~10 B/ghost |
| ArmyChecksum | S→C | 1/s | 8 B |
| Events (hit, death, delivery, block close) | S→C | rare | ~20 B |

**Under 2 KB/s per player.** A further platform win: today every client polls
mempool.space itself; in future **one** server-side fetcher pulls the data and
distributes it in the round seed — one external call for everybody instead of
one per player.

### 6.3 Other players: ghosts, deliberately
Other trucks are visible **ghosts with no collision**, and the armies in each
run react **only to that run's own truck** (a private world instance).

This is a reasoned choice, not a convenience. In a game played for money, no
other player may be able to change my odds. Shared armies would be richer but
immediately exploitable: drafting behind a whale who pulls every tank onto
himself, deliberate ramming, collusion. Ghosts give the multiplayer feeling —
you watch the competition drive, die and arrive — without a single coupling
exploit. A "convoy mode" with real interaction remains possible later as a
play-money variant.

The **per-block leaderboard** (today local, in `BlockClock.Board`) becomes
server-side and visible to everyone: who earned how many sats in this block,
and how much BTC they moved.

---

## 7. Provably fair (round seeds)

So that nobody has to wonder whether the terrain or the armies were rolled
against them:

1. The server commits in advance to a chain of daily secrets: `H(secret_d)` is
   published the day before.
2. Round seed: `seed = HMAC(secret_d, btc_blockhash ‖ round_number)` — the
   Bitcoin block hash is public entropy the house cannot choose.
3. At round start `H(seed)` is published; at round end, `seed` itself.
4. Anyone can recompute with the open WASM core that terrain and army spawns
   follow exactly from the seed — and that the server did not tailor them to a
   particular player after the fact.

---

## 8. Threat model

| Attack | Defence |
|---|---|
| Forged arrival via the API | **The endpoint does not exist.** Arrival is a server simulation event (§0). |
| Tampered client / speed hack / teleport | The client sends inputs only; the server's clock and physics decide. Inputs outside the tick window are dropped. |
| Replaying old inputs or results | Tick numbers plus a per-message session HMAC; runs are bound to round ID and seed. |
| Double payout / race on a balance | Double-entry ledger, serialisable transactions, idempotency keys (§2.2, §2.3). |
| Compromised game server drains the node | Key separation: the wallet daemon pays only signed, ledger-backed, rate-capped authorisations (§2.4). Small hot float. |
| A perfect driving bot | Economic: global calibration lowers its band (§4.4); stake caps limit throughput. |
| Multi-accounting | No bonuses; calibration is global; account creation is throttled (PoW + IP limits). |
| Player-versus-player griefing | Structurally impossible: private world instances, ghosts without collision (§6.3). |
| Rigged terrain or spawns ("the house rolls against me") | Commit-reveal seeds with Bitcoin block hash entropy, recomputable (§7). |
| Insider tampering with the ledger | Append-only hash chain, public chain head, signed player receipts (§2.2). |
| DoS / flooding | CDN and WS gateway with rate limits, per-session message quotas, stateless gateways scaled horizontally. |
| Invoice / withdrawal probing | Minimums and maximums, rate caps, pending states, review threshold (§2.3). |

**An honest limit:** no serious design can promise "there are no security
holes". What this one does deliver: the most dangerous attack classes are
**structurally impossible** (forged results, client authority, PvP coupling),
the rest are **bounded in damage** (exposure caps, a small hot float, review
thresholds, key separation) and **visible** (hash chain, invariant monitoring,
odds alerts). That is the state an exchange or a casino realistically reaches.

---

## 9. Scaling and operations

- **Gateway**: stateless, behind a CDN (WebSocket termination, rate limits).
- **Shards**: one process simulates n runs; assignment by consistent hashing.
  Horizontal scaling is trivial because runs are independent (§6.3).
- **Ledger**: a single Postgres primary (money is small and transactional,
  which scales a long way); read replicas for leaderboards and audit.
- **Sessions**: Redis.
- **One** mempool fetcher for the whole platform (§6.2).
- Monitoring: the ledger invariant, payout ratio per band, hot wallet float,
  checksum drift rate.

---

## 10. Legal note (out of scope, but not ignorable)

Playing for real money with an element of chance is licensable gambling — or
skill gaming — in most jurisdictions, and full anonymity without KYC collides
with anti-money-laundering rules in several. The concept is cut so that the
limits exist technically (stake caps, loss limits per period, self-exclusion),
but the legal question itself needs its own answer before a real-money launch.
Until then everything runs identically on play money (phases 1–2).

---

## 11. Delivery plan

| Phase | Content | Builds on |
|---|---|---|
| **0** | Extract the deterministic core (Rust: armies, truck driving model, hits, gate; fixed point; WASM build). Golden tests: core replays against recorded Unity runs. | `Army.cs` is already pure logic — portable for exactly this. |
| **1** | Accounts (ed25519), ledger, play-money deposit and withdrawal, audit chain. Still single-player. | `BlockClock`, `DeliveryGate` |
| **2** | Server-authoritative runs: input protocol, prediction and correction in the client, ghosts, global per-block leaderboard, one central mempool fetcher. | §6 |
| **3** | Lightning for real (LND/CLN plus wallet daemon, key separation), small caps, commit-reveal seeds, the calibration pipeline. | §2, §4.4, §7 |
| **4** | Scaling (shards, CDN), truck shop and repair, review processes, limits and self-exclusion, load tests, an external security audit before raising caps. | §5, §9 |

---

## 12. API surface (complete — its brevity is the security argument)

```
REST  POST /account            {pubkey}                → name
      POST /login              {pubkey}→challenge→sig  → session token
      POST /deposit            {amount}                → bolt11 invoice
      POST /withdraw           {bolt11, idempotency}   → pending/paid
      GET  /balance
      GET  /rounds/current                             → seed commit, clock, board
      GET  /audit/head                                 → ledger chain head
      GET  /receipts/{entry}                           → signed receipt

WS    join_run   {truck, cargo[]}   → server validates and escrows the stake
      inputs     {tick, [steer,throttle,brake]×10, hmac}
      ← state    {correction | ghost | checksum | event}
```

That is all of it. In particular there is no endpoint through which a client
can *assert* a position, a hit, an arrival or a balance — and what does not
exist cannot be abused.
