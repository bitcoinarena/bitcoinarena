# BTC Logistics War — Providerless P2P Multiplayer Protocol (BLWP)

Written 2026-08-30, revised 2026-08-31 (**v1.1**). Concept specification only
— no implementation.

This document redesigns the existing centrally-operated real-money
architecture (`MULTIPLAYER.MD` v2) into a **providerless multiplayer
protocol** with the existing Unity WebGL game as its reference client.
Gameplay, vehicles, cargo, mempool-derived maps, enemies, ghost multiplayer,
the lobby concept and late joining are preserved. What is removed is the
operator: there is no house bankroll, no custodial balances, no authoritative
game server, no central payout authority.

> **Design principle: centralized infrastructure is acceptable.
> Centralized trust is not.**

### Revision notes v1.1 (what changed and why)

| # | Change | Why | Where |
|---|---|---|---|
| 1 | **Player-level finality.** Results become irreversible per player (`EVIDENCE_FINAL`) the moment their transcript is complete and sequenced; later outages delay settlement but can never erase a known result. Round-level VOID is gone; only runs that never reached evidence-finality can be annulled. | v1.0 refunded whole rounds on infrastructure failure — a losing player could erase a known loss by DDoSing the relay. The refund-by-default prize for attackers is removed. | §10.5, §12.4, §13.4, §16, §22 |
| 2 | **Verifier power split.** The single t-of-n set that both judged results and held the keys to losing stakes is split into **Attestors** (judge, hold no shares) and **Share Custodians** (hold shares, judge nothing, release only by a mechanical rule with a public objection window). A victim can veto a fabricated loss with their own signed transcript. | In v1.0, t colluding verifiers could fabricate a loss and (with the coordinator, or as Sybil players profiting from the pool) steal stakes quietly. Now theft additionally requires suppressing publicly checkable counter-evidence — it can still be attempted, but never quietly. | §13.4, §4, §17 |
| 3 | **The relay is an explicit event sequencer.** Beacons become signed sequence roots (MMR) countersigned by independent witnesses; equivocation is self-proving; epoch closure and join order derive from sequence position, objectively. | v1.0's relay could show different parties different histories (entry order, epoch cutoffs) without proof of misbehaviour. | §7.5, §10.3, §17 |
| 4 | **Honest time claims.** Beacons prevent backdating, rewind of published segments, and gross slow-motion. They do **not** prevent forward simulation: a fast bot may explore many candidate futures within each real second. The security model says so and leans on the zero-sum economics, not on pacing. | v1.0 implied pacing throttled bots. It throttles wall-clock, not compute. | §10.3–10.4 |
| 5 | Corrections: bandwidth arithmetic made consistent (~600 B/s up); verifier replay speed demoted from assumption to benchmark target; NWC budgets described as wallet policy, not cryptographic round-binding; the Settlement Coordinator is described as **temporarily custodial during settlement execution**, not "non-custodial". | Accuracy. | §18, §13.1, §13.5, §19 |

Unchanged by design: Unity WebGL client, dynamic rounds, lobby + late join,
ghost multiplayer, deterministic Rust/WASM simulation, Round/Entry contracts,
non-custodial player wallets, hold-invoice stake commitment, replaceable
infrastructure, pool economics.

---

## 1. Executive architecture summary

Three ideas carry the whole design:

1. **The ghost architecture is the scalability and trust model.** Each
   player's financially relevant simulation depends only on round statics,
   their own seed, and their own inputs. Other players are non-authoritative
   ghosts. Therefore each browser runs **its own authoritative deterministic
   simulation** (Rust/WASM, fixed-point) and publishes an authenticated
   transcript (input log + rolling state commitments). A player's result *is*
   whatever deterministic replay of their transcript yields — verifiable by
   anyone, forgeable by no one. There is no server simulation at all.

2. **The relay is an event sequencer: it provides order and time, not
   truth.** *(revised v1.1)* It publishes signed **sequence roots** —
   append-only MMR commitments over every entry, checkpoint receipt, epoch
   closure and attestation — countersigned by independent witnesses. A
   checkpoint must embed the latest root and arrive within a real-time
   window, which sandwiches each transcript segment in wall-clock time and
   fixes the round's history objectively. A malicious sequencer can stall
   (liveness) or fork visibly (self-proving equivocation); it cannot bias an
   outcome or rewrite an order it already committed to.

3. **Stakes are Lightning hold invoices, and results carry player-level
   finality.** *(revised v1.1)* A stake is an in-flight HTLC, not a balance
   in anyone's database. A player's result becomes **evidence-final** the
   moment their complete transcript is sequenced — from then on, no outage,
   no relay death, no verifier absence can erase it; infrastructure failure
   only delays settlement. Refunds exist solely for runs that never reached
   evidence-finality. Claiming a lost stake requires attestation by judges
   who hold no keys, release by custodians who judge nothing, and the
   absence of a counter-proof the victim themselves can supply.

Honesty up front: **fully trustless N-player pool settlement with
browser-only clients does not exist on Bitcoin/Lightning today.** Browsers
cannot run Lightning nodes, stay online for justice transactions, or
participate reliably in N-party on-chain ceremonies. V1 therefore contains
one precisely-bounded residual: a **replaceable Settlement Coordinator**
that is non-custodial for held stakes but **temporarily custodial during
settlement execution** — it holds each round's claimed loser pool between
claiming and paying out, bounded by bracket sizes and covered by a published
bond (§13.5).

Because there is no house, the economics are **zero-sum pools between
players**. Bots cannot "beat the house" because there is none; pool-in
equals pool-out minus declared fees, structurally. Bots are a *fairness*
problem (brackets, skill pools — §15), not a solvency problem.

---

## 2. High-level architecture

```
                OPTIONAL / REPLACEABLE INFRASTRUCTURE
   Lobby & round discovery ── Matchmaking ── Leaderboard ── Indexer/Mirrors
                              │
              WebRTC signaling ── STUN / TURN
                              │
                    ROUND SEQUENCER (relay)           (time beacons, signed
                              │                        sequence roots, fan-out)
                    Root witnesses (w-of-k)           (co-sign roots; equivocation
                              │                        detection — no gameplay role)
              Attestor set (t_a-of-n_a)               (replay & judge results;
                              │                        hold NO preimage shares)
              Share custodians (t_c-of-n_c)           (hold preimage shares;
                              │                        mechanical release rule)
                 Settlement Coordinator (V1)          (LN node: hold invoices,
                              │                        pool payouts; bonded;
      ┌───────────────────────┼──────────────────┐     temporarily custodial
      │                       │                  │     during payout — §13.5)
   PLAYER A                PLAYER B           PLAYER C   … PLAYER N
   Wallet A (NWC/QR)       Wallet B           Wallet C
      │                       │                  │
 Unity WebGL (render/UI) Unity WebGL       Unity WebGL
      │                       │                  │
 WASM deterministic sim  WASM sim           WASM sim      ← authoritative
      │                       │                  │           per player
      └── signed entries, inputs, checkpoints, results ──┘
                              │
                   PARTICIPANT REGISTRY (append-only, MMR,
                   sequenced under co-signed roots, mirrorable)
                              │
                    Deterministic payout function
                              │
                     Bitcoin / Lightning settlement
```

No component above the player row can both determine a result **and** move
player funds. Most can do neither.

---

## 3. Providerless: definition and control questions

| Question | Answer |
|---|---|
| Who controls funds? | The player's own wallet until stake-in; then an in-flight HTLC. Loser stakes move only with attestation + custodian shares + no standing objection. The V1 coordinator is temporarily custodial for the claimed loser pool during payout (bounded, bonded, replaceable — §13.5). |
| Who determines outcomes? | The deterministic WASM simulation, replayable by anyone from the signed transcript. Nobody *decides*; everybody can *check*, including the affected player, whose counter-proof vetoes a fabricated loss. |
| Who changes rules? | Nobody, per round: the Round Contract is immutable once published. |
| Who can admit/exclude participants? | Entry is permissionless given a valid signed Entry Contract + funded hold invoice, sequenced under a co-signed root. Infrastructure can refuse service (availability), not invalidate a sequenced entry. |
| Who can stop joining? | Any infrastructure outage stops *new* joins (fail-closed, no money at risk). |
| Who can stop settlement? | Outages and refusals **delay** settlement of evidence-final results; they cannot reverse them. The ultimate backstop is HTLC expiry (§13.4). |
| Indispensable infrastructure? | None permanently: sequencer, witnesses, attestors, custodians, coordinator are per-round roles defined by the protocol, not identities. |
| Mandatory fee recipient? | None protocol-wide. Fees are per-round line items in the Round Contract. |
| Who can shut the system down? | No single party. Disappearance of every V1 default halts new rounds; running rounds settle what is evidence-final and refund what is not. |

---

## 4. Trust model — stated first, so the rest can be read against it

A player must trust:
1. **Bitcoin consensus** and, where used, **standard Lightning assumptions**.
2. **Cryptographic primitives** (ed25519, SHA-256, Shamir/VSS, BLS for drand).
3. **Their own wallet** (keys never enter the browser page).
4. **The deterministic simulation build** they verified or accepted (§14).
5. **The Round Contract and their own Entry Contract** they signed.

Residual trust, stated precisely (V1, revised v1.1):
6. **Attestor liveness and honesty (t_a-of-n_a)** for judging results.
   Attestors hold no money keys; a false attestation is disprovable by the
   victim's own transcript during the objection window, so attestor collusion
   alone cannot move a stake — it can only delay honest settlement.
7. **Custodian rule-following (t_c-of-n_c)**: custodians release preimage
   shares only per the mechanical rule (attestation + elapsed objection
   window + no valid counter-evidence). Custodians judge nothing and cannot
   fabricate the inputs to their own rule. **The stated worst case:**
   ≥t_a attestors + ≥t_c custodians + the coordinator colluding *and* the
   victim's transcript being unavailable (player and all mirrors offline)
   can steal that player's stake — loudly, leaving a permanently checkable
   contradiction, against posted bonds. Disjointness (no attestor is a
   custodian) is a contract rule.
8. **Sequencer + witness non-collusion (w-of-k)** for history uniqueness.
   Equivocation requires the sequencer plus ≥w witnesses signing two
   branches, and the double-signed roots are themselves the proof.
   Sequencer alone: liveness only.
9. **Coordinator honesty during payout execution**: it is *temporarily
   custodial* for each round's claimed loser pool; worst case abscond =
   one round's pool, publicly provable, bond-covered (§13.5).
10. **Time integrity is partial by design** *(v1.1)*: beacons prevent
    rewind, backdating and slow-motion — not forward simulation (§10.4).
11. **The loaded web page** is trusted at load time; the wallet's own
    approval UI and budget ceiling are the real boundary — and that budget
    is **wallet policy, not a cryptographic round-binding** (§13.1).
12. **drand** (or the Bitcoin-blockhash fallback) as unpredictable public
    randomness.

A player does **not** trust: the lobby, matchmaking, signaling, STUN/TURN,
the sequencer (for truth), the leaderboard, the web host (beyond item 11),
other players, any house, any central ledger, any payout authority.

---

## 5. Unity WebGL reference client

Hard constraint honoured: the game is 100% Unity WebGL in a normal browser.
No extension, daemon, node, or native software.

Division of labour inside the page:

- **Unity WebGL**: rendering, UI, input capture, audio, animation, ghosts,
  lobby screens. Unchanged product experience.
- **Deterministic core (Rust → WASM)**: all financially relevant state —
  vehicle movement, collisions with world objects, damage, AI/enemies,
  cargo, gates, delivery, timeout. Fixed-point arithmetic; no floats in
  financial state; no reliance on Unity PhysX/FixedUpdate for anything
  settled. Unity renders *from* core state, never writes to it except via
  the input API.
- **JS bridge**: Unity ⇄ core ⇄ network ⇄ wallet links.

Browser constraints addressed explicitly:
- **Threads**: the core runs single-threaded; no SharedArrayBuffer/COOP/COEP
  requirement (keeps mirror hosting trivial).
- **Float determinism**: avoided entirely by fixed-point in the core.
- **Background tabs / suspension / mobile lock / CPU throttling**: the sim
  may stall — missing checkpoint cadence is handled deterministically
  (§12); a suspended tab drifts toward forfeit like any disconnect.
- **GC pauses / memory pressure**: core state ≤ ~32 MB, allocation-free tick
  loop; a GC pause shorter than the cadence tolerance is invisible.
- **Networking**: WSS to the sequencer for protocol traffic; optional WebRTC
  DataChannels (unreliable) for ghost snapshots. Loss/ordering handled by
  tick-numbered, idempotent messages.
- **Reconnect**: the client rebuilds its own run by fetching its streamed
  input log back and replaying locally (§12.5).
- Compatibility target: current Chrome, Firefox, Edge, Safari (WASM MVP +
  WebSocket + WebCrypto only; WebRTC optional).

---

## 6. Protocol vs reference client

The **protocol** is: message formats, contracts, registry/sequencing
structure, randomness derivation, transcript and checkpoint rules,
verification and objection rules, payout function, settlement flows —
everything in §§7–19. Any compatible client (headless Rust client included)
may participate. The **Unity build** is one client. Protocol identity
derives from `(protocol_version, sim_wasm_hash)`, never from a domain.

---

## 7. Rounds, lobby, and dynamic membership

### 7.1 Lobby
The lobby is a discovery view over Round Contracts: upcoming and running
rounds, status (`WAITING / ACTIVE / CLOSING / SETTLING / FINAL`), committed
player count, stake bracket, payout curve, start condition, late-join
policy, elapsed time, leaderboard. The V1 lobby service is centralized and
**non-authoritative**: every fact it displays is a signed artifact that any
replacement lobby can serve identically.

Player states: `OBSERVING → READY → ENTRY_SIGNED → STAKE_COMMITTED →
ACTIVE`. Only `STAKE_COMMITTED` has money at risk; disconnecting in any
earlier state is free.

### 7.2 Round Contract
Immutable, published at creation, content-addressed (`round_id` = hash of
the contract):

```
RoundContract {
  round_id, protocol_version, sim_wasm_hash
  map_params            // mempool snapshot reference + derivation rules
  randomness_rules      // drand chain hash, epoch schedule, sub-seed formula
  schedule              // open_time, start_condition, epoch length,
                        // entry_close_tick, end_tick, max_duration
  late_join_policy      // enabled, per-epoch terms, T_run per entry
  tick_rate: 30 Hz      // checkpoint cadence 1 Hz, tolerance ±2 s
  stake_bracket         // fixed stake per entry, e.g. 100 sat
  payout_model          // qualification rule + rank curve + tie rules
                        //   + zero-qualifier rule (full refund)
  fee_schedule          // named recipients & pool percentages
  disconnect_rules      // neutral-input + cadence-forfeit definitions
  suspension_rules      // same as disconnect (explicitly)
  finality_rules        // evidence-finality criteria, objection window W,
                        //   annulment conditions (v1.1 — §10.5)
  sequencer             // sequencer id, standby id, witness set (k, w),
                        //   liveness thresholds (v1.1)
  attestor_set          // n_a pubkeys, threshold t_a, bonds (v1.1)
  custodian_set         // n_c pubkeys, threshold t_c, bonds; disjoint from
                        //   attestors by rule (v1.1)
  settlement_rules      // coordinator node id, hold-invoice params, CLTV
                        //   (sized in days — §13.4), claim windows, bond
  dispute_rules         // replay procedure, checkpoint bisection, deadlines
  registry_rules        // event schema, MMR parameters, mirrors
}
```

### 7.3 Player Entry Contract
Signed by the player's entry key; one per join, late joins included:

```
PlayerEntryContract {
  round_id, player_pubkey
  entry_epoch, join_tick        // derived from sequence position (§7.5)
  stake, payment_hash           // hash of the player-generated preimage P
  vss_shares_ref                // P Shamir-shared to the CUSTODIAN set (VSS,
                                //   encrypted per-custodian) (v1.1)
  seed_commitment = H(s_p)      // player randomness secret (§11)
  vehicle, loadout, cargo_tier
  accepted: payout_model_hash, fee_hash, disconnect_rules_hash,
            finality_rules_hash, sim_wasm_hash, protocol_version, max_payout
  session_pubkey                // per-run signing key, certified here
  signature
}
```

The two-contract split is what makes late joining a first-class feature:
the global contract never changes; membership grows by appending entries.

### 7.4 Start, epochs, late join
- **Start condition** is deterministic and pre-published (fixed time,
  "every 120 s", optionally `min_players`). No party discretionarily starts
  a round after seeing stakes.
- The round is divided into **entry epochs** (e.g. 60 s). An entry binds to
  the epoch in which its stake confirms. Entries close at
  `entry_close_tick = end_tick − T_run` so every entrant gets the full
  mission duration `T_run` inside the round window.
- **Pool consent**: the Round Contract states *"all valid entries up to
  entry_close_tick contribute to and share one pool, computed over
  evidence-final results (§10.5)."* Every entrant signed that sentence.
- **Epoch closure is objective** *(v1.1)*: epoch *e* closes at the first
  co-signed sequence root whose timestamp ≥ the epoch boundary; an entry
  belongs to epoch *e* iff it is sequenced under a root before that closure.
  `join_tick` is a function of sequence position, not of a relay's claim.

### 7.5 Participant registry and the sequencer *(revised v1.1)*
The registry is an append-only event log: entries, seed reveals, checkpoint
receipts, terminal results, attestations, objections, share releases,
settlement records. Events are **self-authenticating** (player-, attestor-
or custodian-signed).

The **Round Sequencer** (the relay's formal role) assigns each event a
position and, at 1 Hz, publishes a **sequence root**:

```
SequencedRoot { round_id, seq, unix_ms, mmr_root, relay_sig }
```

- Each root's MMR must extend the previous one (witnesses check the
  consistency proof — an O(log n) check, no gameplay knowledge needed).
- **Witnesses (w-of-k, e.g. 2-of-3 independent parties)** countersign each
  root. An event *is sequenced* only when included under a root carrying
  relay + ≥w witness signatures.
- **Equivocation is self-proving**: two roots with the same `seq` and
  different `mmr_root` — signed by the same keys — are portable proof of
  fraud. Clients and services treat a proven fork as sequencer failure from
  the fork point (§10.5 annulment rules apply to anything not sequenced on
  the common prefix).
- **Handover**: the contract may name a standby sequencer; it resumes from
  the last co-signed root. Mirrors serve the full event log; a player holds
  inclusion proofs for their own events — *"I joined round X at tick 2910
  under exactly these terms"* is provable against any mirror.

Integrity comes from signatures + MMR + witnesses; availability from
mirrors. There is no trusted database administrator.

---

## 8. Round-global vs player-private state; ghosts

**Round-global (shared, small):** round_id, clock/roots, map parameters,
seed commitments, registry, leaderboard, status.

**Player-private (financial, per player):** vehicle state, damage, cargo,
their world's enemies, mission progress, inputs, result. Derived *only*
from (round statics, player sub-seed, own inputs) — never from other
players.

**Ghost multiplayer** is preserved exactly as in the current game: no
collisions, no pushing, no cross-player AI influence, no shared physics.
Ghost snapshots `{pubkey, pos, rot, speed, tick, sig-or-relay-envelope}`
(~30 B) flow at 5 Hz over the low-trust path, are interest-managed (each
client subscribes to ~K = 20), may be lossy/approximate, and **cannot touch
financial state by construction** — the deterministic core has no input
channel for them. The live leaderboard is informational; payouts derive
only from verified transcripts.

---

## 9. Deterministic simulation and protocol tick

- Fixed protocol tick **30 Hz**; rendering FPS free.
- `result = Replay(sim_wasm_hash, round_statics, sub_seed, input_log)` —
  bit-identical everywhere.
- Inputs are quantized and bound to tick numbers; missing ticks auto-fill
  with the contract's neutral policy (throttle 0, steering decay, brake
  ramp) — the same rule as the operator design, now a contract term.
- Historical sim versions are archived content-addressed; any old round
  replays forever.

---

## 10. Authenticated transcripts, time, and finality

### 10.1 Input stream
No per-packet signatures at 30 Hz. Input batches (10 Hz, ~30 B) are
**hash-chained**; each 1 Hz **checkpoint** signs the chain head:

```
Checkpoint {
  round_id, player_pubkey, tick
  state_hash                    // core state digest at tick
  input_chain_head              // binds every input since entry
  root_ref                      // latest co-signed sequence root (v1.1)
  prev_checkpoint_hash
  session_signature             // ed25519, ~1 sig/s
}
```

≈150 B/s upstream, acknowledged by sequencer **receipts** that are
themselves sequenced. Inputs must be *published* (streamed to mirrors)
within a data-availability window (≤5 s); a transcript whose inputs were
withheld is unverifiable and forfeits by rule.

### 10.2 Why rewriting is impossible
Once a checkpoint's receipt is sequenced under a co-signed root, every input
before its tick is frozen under the player's own signature. Discovering a
bad outcome at tick 3000 cannot un-say tick 2900.

### 10.3 What the time mechanism guarantees *(rewritten v1.1)*
Sequence roots double as time beacons. A checkpoint for tick `T` must embed
a recent root and arrive within `|root.time − T/30| ≤ tolerance`; receipts
fix arrival. Consecutive receipts sandwich each 1 s transcript segment in
wall-clock time. This gives exactly three guarantees:

1. **No backdating** — a segment cannot claim to have been played earlier
   than the root it embeds.
2. **No rewind past publication** — forking is limited to the
   un-receipted last ≤1 s, and shows as a cadence gap priced as
   neutral-input time.
3. **No gross slow-motion** — segments must be produced at 1× (±tolerance);
   a client running at 0.5× misses cadence and forfeits forward from there.

### 10.4 What it does **not** guarantee — stated honestly *(rewritten v1.1)*
With no server there is **no per-player hidden randomness**: the client must
know every roll to simulate. Consequently:

- **Forward simulation is not prevented and cannot be.** Within each real
  second, a fast agent may simulate thousands of candidate input sequences
  for the *next* segment before committing one. Beacons bound wall-clock,
  not compute; superhuman play quality is bought with CPU/GPU.
- The design therefore does **not** rely on pacing for economic safety. It
  relies on the pool being **zero-sum between players**: optimizers take
  money from other players, never from a bankroll that does not exist. That
  is a fairness problem, handled by brackets, rating-gated pools and
  declared-bot rounds (§15.2) — and it is the honest price of removing the
  operator.

### 10.5 Player-level finality *(new in v1.1 — replaces round-level VOID)*
Each entry's result moves along a one-way ladder:

```
PROVISIONAL      transcript in progress
EVIDENCE_FINAL   the result's complete evidence exists and is ordered:
                   - DELIVERED/FAILED: terminal checkpoint sequenced under a
                     co-signed root, full input log mirrored (availability
                     receipt sequenced)
                   - FORFEIT: cadence expiry relative to the last sequenced
                     receipt, itself established by a later co-signed root
ATTESTED         ≥t_a attestor signatures over the replayed result, sequenced
SETTLED          HTLC settled/cancelled; payout executed
ANNULLED         terminal refund state — reachable ONLY from PROVISIONAL
```

**The finality rule:** once `EVIDENCE_FINAL`, a result can never change
class and can never be refunded. Sequencer death, witness loss, attestor
outage, coordinator refusal — all of it *delays* the remaining ladder steps;
none of it reverses a known result. A known loser stays a loser through any
outage.

**Annulment (bounded refunds):** only runs still `PROVISIONAL` when an
operator-side failure occurs (sequencer liveness threshold exceeded, proven
equivocation after the common prefix, witness quorum permanently lost) are
`ANNULLED`: their HTLCs simply expire → refund. Client-side silence is never
annulment — it is the forfeit rule (§12.2).

**Pool arithmetic under mixed outcomes:** the pool and rank curve are
computed over `EVIDENCE_FINAL` results only; `ANNULLED` entries neither
contribute to nor draw from the pool. This is deterministic and was
consented to in the Entry Contract (`finality_rules_hash`).

**Why this kills the refund/DDoS incentive:** in v1.0, killing the relay
refunded the whole round — a losing player's stake back for the price of a
DDoS. Now: results reach evidence-finality within seconds of happening
(terminal checkpoint + receipt), attestation and share release run **eagerly
per player** (§13.4), and an attacker who downs the sequencer annuls only
runs that were still in progress — including their own, recovering at most
their own stake, never profiting, at infrastructure-attack cost against
bracket-sized money. The residual is stated: a player *currently losing but
not yet forfeit* who successfully kills the sequencer before their cadence
expiry can still convert a probable loss into an annulment-refund. Standby
sequencer handover (§7.5) and second-scale finality shrink that window;
bracket caps bound its value.

---

## 11. Randomness

Requirements: no operator to trust; late joiners neither choose their luck
nor abort after seeing it; everything verifiable afterwards.

```
round_seed    = H(RoundContract ‖ btc_blockhash_at_creation)
epoch_rand(e) = drand.round(scheduled_at_epoch_open(e))     // unpredictable
epoch_seed(e) = H(round_seed ‖ e ‖ epoch_rand(e))
sub_seed(p)   = H(epoch_seed(e_p) ‖ player_pubkey ‖ s_p ‖ join_tick)
```

- **drand** is public, BLS-verifiable, browser-fetchable; fallback per
  contract: next Bitcoin block hash with coarser epochs. Nobody in this
  protocol chooses randomness.
- `s_p` is committed (`H(s_p)` in the Entry Contract) **before** the
  entry's `epoch_rand` exists → no seed grinding; no operator to tailor.
- **No abort advantage**: the stake is committed at entry; `epoch_seed`
  becomes known only after the epoch's entries close (closure is objective,
  §7.4). Refusing to play after seeing the seed is the neutral-input policy
  driving a parked truck.
- `s_p` must be revealed (in the terminal checkpoint at latest) or the
  transcript is unverifiable → forfeit.
- **Late-join asymmetry**: ghosts reveal *other players' worlds*; per-player
  sub-seeds and per-run jitter keep a late joiner's own world unknown until
  committed. Terrain is round-global and public to everyone equally from
  round start. Residual meta-information ("heat seems high today") is
  priced by identical stakes, identical `T_run`, rank scoring, and the
  entry cutoff.

---

## 12. Liveness rules: disconnects, suspension, recovery

### 12.1 Before commitment
`OBSERVING/READY/ENTRY_SIGNED` (unfunded): disconnect = nothing. An entry
whose hold invoice is not funded by epoch close expires.

### 12.2 The one rule after commitment
**A transcript that stops is a result.** Missing inputs become neutral
inputs (deterministic in-sim braking); missing checkpoints beyond the
cadence tolerance — *measured against sequenced receipts, so it is
objective* — end the valid transcript at the last receipted checkpoint. The
outcome is scored from that state, typically FORFEIT. This single rule
covers WebRTC drops, browser close, crash, power loss, net loss, background
tab, device sleep, intentional freeze, and refusal to send input. The stake
was committed before the first financial tick and settlement needs no
cooperation from the player. Late-join-then-instant-disconnect is the same
rule at a later join_tick.

### 12.3 Finishing players
Delivery emits a terminal checkpoint (marked `TERMINAL`, containing the
delivery event, final score and the `s_p` reveal) — sent *before* the
client celebrates, and the client also pushes its full transcript to ≥2
mirrors before declaring success in the UI *(v1.1: this upload is what arms
the objection veto of §13.4)*. A player who closes the browser one frame
after delivery has already produced everything settlement needs.

### 12.4 Grace and annulment *(revised v1.1)*
Short gaps (≤ tolerance) are neutral-input time. A sequencer/witness outage
beyond the contract's liveness threshold **annuls only the still-provisional
runs** (§10.5): their HTLCs expire → automatic refund, with no one's
cooperation. Evidence-final results are untouched and settle when
infrastructure returns — the failure mode of the infrastructure is *pending
runs refund, known results stand*.

### 12.5 Player-side recovery
The client streams its inputs out; after a reload it fetches its own log
back, replays locally to the last receipted checkpoint, and resumes.
Downtime ticks were neutral-input per rule — reconnect changes the future,
never the past.

---

## 13. Money: wallets, stake commitment, settlement

### 13.1 Wallets — what actually works in a browser today *(corrected v1.1)*
- **Nostr Wallet Connect (NWC)**: extension-free over a websocket relay;
  supports `make_invoice` / `pay_invoice` with per-connection **budgets**.
  Honest scope: those budgets and permissions are **enforced by the wallet
  as local policy** (amount ceilings, per-period limits, per-connection
  revocation). They are *not* cryptographically bound to a `round_id` or an
  Entry Contract — the binding the player sees is the invoice description
  in their wallet's own UI. The hard, reliable boundary is the budget
  ceiling and the wallet's confirmation screen; the protocol treats it as
  exactly that and nothing more.
- **bolt11 QR / deep links**: universal fallback; any wallet can pay the
  stake invoice by scan. Payouts: player supplies an invoice (or NWC
  `make_invoice`) during the claim window.
- **WebLN** where an extension happens to exist — never required.
- The wallet seed never enters Unity, JS, WASM, or any service.

### 13.2 The payout function is code, not a decision
`payouts = F(RoundContract, registry, EntryContracts, evidence-final
results)` — deterministic, replayable by anyone. Result classes per entry:
`DELIVERED(score) / FAILED / FORFEIT / ANNULLED` (§10.5).

### 13.3 Stake-in: hold invoices
1. Player generates preimage `P`, puts `payment_hash = H(P)` in the Entry
   Contract, and Shamir-shares `P` (VSS, threshold t_c, encrypted
   per-**custodian**) into the registry.
2. The settlement node issues a **hold invoice** for `payment_hash`; the
   player's wallet pays it; the HTLC sits **in-flight** — not in anyone's
   balance — with CLTV sized **in days**, comfortably beyond round +
   objection + claim windows *(v1.1: the long CLTV is what makes
   settlement-delay safe for winners and expensive to abuse for losers)*.
3. `STAKE_COMMITTED` is sequenced when the HTLC is held. Play begins only
   after this.

### 13.4 Settlement: judged by attestors, released by custodians, vetoed by
victims *(rewritten v1.1)*

Roles are **disjoint by contract**: no attestor key may appear in the
custodian set. *"Whoever signs the truth holds no key to the money; whoever
holds a key to the money judges nothing."*

Eager, per-player flow (no waiting for round end except the pool split):

- **DELIVERED**: upon `EVIDENCE_FINAL`, attestors replay and attest;
  the coordinator **cancels** the winner's HTLC (stake returns — cancelling
  is always safe, it can only give money back to its owner). The pool share
  is paid after round `FINAL` when the pool is known.
- **FAILED / FORFEIT**: upon `EVIDENCE_FINAL`, attestors attest the loss;
  the attestation is sequenced; the **objection window W** (e.g. 10 min)
  starts. If no valid counter-evidence is sequenced within W, custodians
  release their shares of `P` per their mechanical rule; the coordinator
  reconstructs `P` and **settles** the hold invoice — only now does the
  stake move. A loser cannot escape: the money left their wallet at entry,
  and every step after their loss runs without them.
- **Objection (the victim's veto)**: a *counter-evidence* is a player-signed
  transcript with sequenced receipts that replays to `DELIVERED` under the
  contract's `sim_wasm_hash`. It is mechanically checkable by anyone
  running the open replayer. A sequenced valid objection freezes the
  release; the conflict is then resolved by replay (one of the two
  artifacts provably does not verify — signatures and determinism leave no
  middle ground). The client's mirror-upload at delivery (§12.3) means the
  veto works even if the player closes the browser; any mirror or
  watchtower can raise it on their behalf.
- **ANNULLED**: nobody attests, nobody releases, the HTLC expires → refund.

**What collusion can and cannot do now:**
- Attestors alone (≥t_a): can sign a false loss — which any mirror disproves
  within W; they hold no shares, so nothing moves. Can delay by refusing to
  attest — the backstop is HTLC expiry (refund), never theft.
- Custodians alone (≥t_c): hold shares but their rule's inputs (sequenced
  attestation, elapsed W, absent objection) are public facts they cannot
  fabricate; premature release is provable misbehaviour against bonds, and
  still requires the coordinator to act on it.
- The full worst case is trust item 7 (§4): attestors + custodians +
  coordinator, *plus* unavailability of the victim's evidence. Possible,
  loud, bonded, and narrow — the v1.0 design allowed the same theft
  quietly with a single set.
- **V2/experimental** *(flagged as such)*: a zk proof-of-replay would make
  share release cryptographically contingent on a verified loss, removing
  the custodian trust almost entirely. Not assumed for V1.

### 13.5 The V1 coordinator, described honestly *(corrected v1.1)*
The Settlement Coordinator is a well-known Lightning node named in the
Round Contract. For **held stakes** it is non-custodial in the strict
sense: in-flight HTLCs are not spendable by it without custodian shares.
During **settlement execution it is temporarily custodial**: settled loser
stakes accumulate in its channel balance until winner payouts complete.
It **cannot**: fabricate entries or signatures, alter contracts or results,
settle a stake without shares, or touch anything outside its rounds. It
**can**: refuse service, stall payouts (delay, bounded by the claim
window), and — the one real exposure — **abscond with a round's claimed
loser pool during the payout step**. Bounds and remedies: bracket-limited
pool sizes; a **published bond ≥ max concurrent pool**; misbehaviour
provable from signed artifacts; blacklisting; per-round replaceability.
The V2 path replaces it with a threshold/federated settlement node.

### 13.6 Settlement scalability
For N players per round: N stake HTLCs in, ≤N payout payments out, zero
on-chain transactions in the normal path. 1,000 × 100 sat = 100k sat
inbound liquidity — trivial; brackets keep liquidity predictable. Payouts
are retried across routes within a long claim window (e.g. 30 days);
routing failure is delay, never loss. Dust floor: bracket minimums keep
HTLCs routable. On-chain appears only in disaster recovery of the
settlement node itself.

---

## 14. Distribution, builds, versioning, compromised hosts

- The client is **static assets** servable from the official site, mirrors,
  IPFS gateways, or localhost. Protocol identity =
  `(protocol_version, sim_wasm_hash)`, not a domain.
- The **sim core is reproducibly buildable**; anyone can go source → build →
  hash → compare with the Round Contract. Historical versions stay archived.
  The Unity build is content-addressed and manifest-signed as a whole
  (bit-reproducibility of Unity itself is not promised — the financial
  layer is the WASM, and that one is).
- **No privileged admin key exists**: nothing can alter active rounds,
  seize funds, rewrite results, or force-upgrade clients. Versions coexist;
  players accept a version by signing an entry that names it.
- **Compromised web host**: phishing-grade power, not fund-seizure power —
  bounded by the wallet's budget ceiling and approval UI (which, per §13.1,
  is wallet policy; the page cannot raise it). It cannot forge entries,
  results, or settlements for existing funds.

---

## 15. Economics without a house

### 15.1 Model (unchanged)
A **success pool within fixed-stake brackets** with a rank curve: pool =
stakes of evidence-final `FAILED` + `FORFEIT`; qualification = `DELIVERED`
with score ≥ contract minimum; distribution by rank curve over qualifiers'
scores (ties split); qualifiers also get their stake back (HTLC cancel);
zero qualifiers ⇒ refund round. Scores are time-normalized by identical
`T_run`. Solvency is structural: payouts partition collected stakes minus
declared fees.

### 15.2 Skill and bots (unchanged in substance, honest per §10.4)
Bots take money from players, not from a house: fairness controls, not
solvency controls. Brackets; rating-gated pools (Glicko-2 over verified
results, computable by anyone from the registry); declared-bot rounds;
no bonuses ⇒ Sybil splitting buys nothing mechanical; ghost isolation ⇒
in-round collusion yields nothing mechanical. Residual: rating manipulation
via feeder accounts — mitigated by rating-from-verified-transcripts only,
and accepted as imperfect. Bot detection is not assumed to work; forward
simulation (§10.4) is assumed to exist.

### 15.3 Fees
Per-round line items in the Round Contract, skimmed from the pool at
settlement to named pubkeys: sequencer/witness fee, attestor fees,
custodian fees, coordinator fee, optional client-developer tip
(default-on, removable). Players price rounds by their fee schedules.
No mandatory protocol-wide recipient; no fee key with control power.

### 15.4 Finality of the round
`end_tick` → all entries' ladders complete (eager attestation means most
already have) → last objection window closes → round `FINAL`: pool and
allocation immutable; claim window opens (30 days); unclaimed remainders
per contract.

---

## 16. Failure matrix *(revised v1.1)*

| Failure | Effect | Classification |
|---|---|---|
| Lobby down before round | No discovery; running rounds unaffected | JOIN IMPOSSIBLE |
| Lobby down after start | Cosmetic | NO IMPACT |
| Matchmaking down | Manual round selection still works | DEGRADED |
| Signaling/STUN/TURN down | Ghosts degrade; finances untouched | DEGRADED |
| Sequencer down < threshold | Receipt gap ⇒ neutral-input grace | DEGRADED |
| Sequencer down ≥ threshold, no standby | Provisional runs ANNULLED (refund by expiry); **evidence-final results stand, settle late** | PARTIAL ANNUL + SETTLEMENT DELAY |
| Sequencer equivocates (proven) | Fork point established by double-signed roots; common-prefix results stand; rest annulled; sequencer bond slashed/blacklisted | PARTIAL ANNUL |
| Witness quorum lost | Sequencing halts ⇒ as sequencer-down row | PARTIAL ANNUL + DELAY |
| Attestors unavailable | Evidence-final results wait; **losses cannot be erased**; ultimate backstop: unsettled HTLCs expire | SETTLEMENT DELAY → (backstop) REFUND of unsettled |
| Custodians unreachable ≥ CLTV | Loser HTLCs expire unclaimed | REFUND of those losses (stated backstop, why CLTV is days) |
| One browser crashes | Transcript ends | PLAYER FORFEIT |
| Many browsers crash | Many forfeits; round proceeds | PLAYER FORFEIT (each) |
| Player network partition | As disconnect | PLAYER FORFEIT |
| Wallet unavailable at entry | Entry unfunded, expires | JOIN IMPOSSIBLE |
| Wallet unavailable at payout | Claim window (30 d) | SETTLEMENT DELAY |
| LN route fails (stake) | Entry not committed | JOIN IMPOSSIBLE |
| LN route fails (payout) | Retry within claim window | SETTLEMENT DELAY |
| Coordinator vanishes pre-claim | Nothing claimable; HTLCs expire | REFUND |
| Coordinator vanishes mid-payout | Bounded loss = that round's claimed pool; bond/blacklist | bounded loss (§13.5) |
| Bitcoin fee spike | Off-chain protocol unaffected | NO IMPACT |
| Late join during outage | Entry can't be sequenced | JOIN IMPOSSIBLE |

Every cell ends in REFUND, FORFEIT, DELAY, PARTIAL ANNUL, or
bounded-and-attributable loss — and no cell erases an evidence-final
result.

---

## 17. Verification and disputes

- **Attestor** = anyone in the round's attestor set running the open
  replayer: fetch transcript, replay WASM, compare state hashes, sign.
  No custody, no outcome creation. Anyone *outside* the set can also
  replay and raise objections — the set is who settlement listens to,
  not who truth belongs to.
- **Disputes are player-specific** (ghost isolation) and mechanical:
  divergence ⇒ bisect the 1 Hz checkpoints to the first divergent second ⇒
  replay 30 ticks ⇒ the signed inputs either produce the signed hash or
  not. A transcript that fails replay, breaks cadence against receipts, or
  withheld data ⇒ FORFEIT by rule. Attestor-vs-objection conflicts resolve
  by replay (§13.4); attestor-vs-attestor beyond t_a without resolution ⇒
  affected runs remain unsettled until the backstop (never silently
  decided).

### Threat model (condensed; v1.1 rows marked)

| Threat | Capability | Impact | Prevention / Detection | Recovery / Residual |
|---|---|---|---|---|
| Malicious player, modified client/WASM, bots, automation | Anything client-side | Plays well | Nothing client-side trusted; transcripts + replay decide | Fairness residual (§15.2) |
| Input rewriting after outcome | Fork own past | Forge wins | Checkpoint chain + sequenced receipts freeze the past | None |
| Fake checkpoints / divergence | Publish wrong hashes | Forge wins | Deterministic replay; bisection | Forfeit; none |
| Rewind / slow-motion / suspension | Local clock control | Escape cadence | Root-embedding + receipts (§10.3) | ≤1 s retry residue |
| **Forward simulation (fast bot)** *(v1.1)* | Simulate candidate futures each second | Superhuman play | **Not preventable**; declared openly | Zero-sum economics; fairness pools |
| Seed manipulation / grinding | Choose entries | Favorable worlds | Commit `s_p` before epoch_rand; stake precedes seed | None |
| Withhold inputs / refuse reveal | Withhold data | Block verification | Data-availability windows; reveal-or-forfeit | None |
| Late-entry arbitrage | Join informed | Edge | Fresh sub-seeds, equal `T_run`, objective epoch closure | Meta-info residue, accepted |
| Pool manipulation via Sybil/collusion | Many entries | Shift distribution | Zero-sum + ghost isolation; no bonuses | Rating-manipulation residue |
| **Disconnect / refund gaming** *(v1.1)* | Kill own feed; DDoS sequencer | Escape a loss | Transcript-stops-is-a-result; **player-level finality**: known results survive outages; annulment ⇒ own stake back at most, never profit | Narrow window: losing-but-not-yet-forfeit player killing the sequencer converts probable loss to refund; shrunk by standby + second-scale finality; bounded by bracket |
| Ghost spoofing | Fake visuals | Mislead humans | Signed/enveloped snapshots; zero financial coupling | Cosmetic |
| Message replay | Re-send traffic | Duplicates | Tick/seq numbers; idempotent sequencing; single-use payment_hash | None |
| Settlement refusal by loser | Do nothing | Keep stake | Stake in-flight; eager attestation + custodian release (§13.4) | None |
| **Sequencer equivocation** *(v1.1)* | Two histories | Conflicting rounds | Witness co-signing; double-signed roots are portable fraud proof | Fork ⇒ partial annul; bond/blacklist |
| Malicious sequencer (liveness) | Withhold roots/receipts | Stall | Standby handover; annulment refunds provisional runs only | Liveness only |
| **Attestor collusion (≥t_a)** *(v1.1)* | Sign false loss | Attempt theft | Hold no shares; objection window; victim's mirror-uploaded transcript disproves | Delay only, unless combined below |
| **Custodian collusion (≥t_c)** *(v1.1)* | Release shares early | Attempt theft | Rule inputs are public sequenced facts; premature release provable vs bonds; coordinator must still act | Bounded, loud |
| **Full collusion: attestors + custodians + coordinator + evidence suppression** *(v1.1)* | Everything above at once | **Steal targeted stakes** | Disjoint sets, bonds, mirrors/watchtowers, permanent public contradiction | The stated V1 worst case (§4.7) |
| Coordinator abscond at payout | Take one round's claimed pool | Bounded loss | Temporary custody named honestly; bond ≥ pool; provable | §13.5 residual |
| Compromised website/CDN/DNS | Serve lying build | Phish stakes | Hashes/manifests/mirrors; wallet budget ceiling (policy) | Bounded to approved amounts |
| DDoS during rounds | Kill infra | Stall | **Finality first**: known results stand; provisional runs refund; attacker never profits | Availability cost only |
| Protocol fragmentation | Incompatible forks | Split liquidity | Versioned contracts; players sign what they accept | Social |

---

## 18. Scalability *(figures corrected v1.1)*

Per player, upstream: inputs 300 B/s (10 Hz × 30 B) + checkpoints 150 B/s
(1 Hz × ~150 B) + ghost snapshots 150 B/s (5 Hz × 30 B) ≈ **600 B/s**.
Downstream: K = 20 ghosts × 30 B × 5 Hz = 3.0 KB/s + roots/receipts
~0.4 KB/s + registry deltas ~0.3 KB/s ≈ **3.5–4 KB/s**. Independent of N —
interest management, never full mesh.

Sequencer, 1,000-player round: ingest ≈ 0.6 MB/s, egress ≈ 4 MB/s, plus
registry streaming to mirrors/attestors ≈ 0.5 MB/s — one modest server;
regional relays shard by subscription, not by authority. Witness overhead:
k × (150 B/s roots + consistency proofs) — negligible.

Registry per 1,000-player round: entries ~0.4 MB; checkpoints ~19 MB
(600 s × 32 B × N plus envelopes); input logs ~180 MB streamed, archived
for the objection/claim windows, then prunable to roots + terminal proofs.

Attestor workload *(corrected v1.1)*: replay speed is a **benchmark
target, not an assumption** — the implementation plan gates on measured
native ≥20× and in-browser ≥3× realtime, and capacity planning uses the
measured figure. Independent of that number, the workload is bounded by
design: eager per-player attestation spreads replays across the round's
duration instead of bunching them at the end, sampling covers the honest
mass, and full replay concentrates on objections.

Settlement: ≤2 LN operations per player per round.

---

## 19. Infrastructure matrix *(v1.1: roles split, custody cell corrected)*

| Component | Required? | Centralizable? | Custody? | Can steal? | Decides result? | Blocks join? | Blocks play? | Blocks settlement? | Replaceable? | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|
| Unity WebGL host | yes* | yes | no | no² | no | yes | no | no | yes | mirrors/IPFS/local |
| CDN | no | yes | no | no² | no | yes | no | no | yes | any host |
| Lobby | no | yes | no | no | no | yes | no | no | yes | direct round_id |
| Matchmaking | no | yes | no | no | no | yes | no | no | yes | manual choice |
| Signaling / STUN / TURN | no | yes | no | no | no | no | ghosts only | no | yes | relay-fanout ghosts |
| Sequencer (relay) | yes (per round) | yes | no | no | no | yes | stall ⇒ partial annul | delays | yes (standby) | annul provisional ⇒ refund |
| Root witnesses | yes (w-of-k) | partly | no | no | no | no | with sequencer | delays | yes | as sequencer row |
| Leaderboard | no | yes | no | no | no | no | no | no | yes | registry-derived |
| Indexer/mirror | no³ | yes | no | no | no | no | no | no | yes | any mirror |
| Attestor set | yes (per round) | partly | **no** | no alone⁴ | attests only | no | no | delays | yes (per round) | HTLC-expiry backstop |
| Custodian set | yes (per round) | partly | shares only | no alone⁴ | no | no | no | delays | yes (per round) | HTLC-expiry backstop |
| Bitcoin | yes | no | n/a | no | no | no | no | ultimate settlement | n/a | n/a |
| Lightning infra | yes | partly | in-flight only | no | no | funding path | no | delays | yes | retry routes |
| Settlement coordinator | yes (V1, per round) | yes | **held stakes: no; claimed loser pool during payout: yes (temporary, bounded, bonded)** | one round's pool⁴ | no | yes (new rounds) | no | delays | yes (per round) | refund-by-expiry |

\* some host, any host. ² phishing-grade, bounded by wallet budget policy.
³ mirrors are required *for the objection veto* in the sense that at least
one honest copy of a victim's transcript must exist — the client uploads to
≥2 at delivery. ⁴ see §17 collusion rows for the exact combinations.

---

## 20. V1 and V2

**Pragmatic V1 (buildable now):** one official site + mirrors; one default
lobby; one sequencer per round with a named standby and 3 witnesses
(w = 2); attestor set of 5 (t_a = 3) and **disjoint** custodian set of 5
(t_c = 3), all bonded; one bonded settlement coordinator per round;
NWC + QR wallets; drand randomness; the full transcript/replay, finality,
and objection machinery of this document.

**Decentralized V2 (real technology, staged):** multiple lobbies and round
discovery over Nostr; multiple co-equal sequencers with witness rotation;
open bonded attestor/custodian registration with per-round random
selection and FROST threshold signatures; **federated settlement**
(Fedimint-style guardians or a threshold-Schnorr LN node) removing §4.9
almost entirely; content-addressed client releases as default; registry-
derived reputation. **Experimental, flagged:** zk proof-of-replay for
cryptographically contingent share release (§13.4); PTLC/adaptor-signature
stake conditioning; N-party pooled DLCs per epoch.

**Current technical limitations, plainly:**
1. Browser-only trustless N-party settlement does not exist → V1
   coordinator with temporary payout custody (§13.5).
2. No hidden per-player randomness without a server → forward simulation
   and ~p_max bots are assumed; harmless to solvency (zero-sum), handled
   as fairness (§15.2).
3. Time integrity is partial (§10.3–10.4): rewind/backdating/slow-motion
   are prevented; forward simulation is not.
4. A losing-but-not-yet-forfeit player who kills the sequencer can still
   reach annulment-refund of their own stake (never profit) — shrunk by
   standby handover and second-scale finality, bounded by brackets.
5. The loaded web page is trusted at load; wallet budgets are policy, not
   cryptographic round-binding.
6. drand/blockhash beacons are external dependencies (replaceable,
   verifiable).

---

## 21. Complete round lifecycle

| # | Step | Message / artifact | Guarded by | On failure |
|---|---|---|---|---|
| 1 | Open game | static assets | hashes/manifest | try mirror |
| 2 | Verify build/protocol | manifest sig, `sim_wasm_hash` | reproducible build | refuse to stake |
| 3 | Connect wallet | NWC pairing (budget policy) or QR | wallet UI | QR fallback |
| 4–5 | Lobby, discover rounds | RoundContracts (signed, content-addressed) | signatures | direct round_id |
| 6 | Pick round + stake | — | — | — |
| 7 | Entry Contract draft | fields incl. `H(s_p)`, payment_hash, VSS→custodians | client-side generation | abort free |
| 8 | Sign entry | ed25519; session key certified | player key | abort free |
| 9 | Commit stake | wallet pays **hold invoice**; HTLC held | LN; CLTV in days | entry expires |
| 10 | Sequencing | entry event under co-signed root; join_tick = sequence position | roots + witnesses | re-submit via mirror |
| 11–12 | Wait; start fires | roots as clock; deterministic schedule | contract | annul provisional ⇒ refund |
| 13 | Epoch seed | H(round_seed ‖ e ‖ drand) after objective epoch closure | drand verifiability | blockhash fallback |
| 14–15 | Play | 10 Hz input chain; 30 Hz core; 1 Hz checkpoints + receipts | §10 | neutral-input rule |
| 16 | Ghosts | 5 Hz snapshots via relay | non-authoritative | cosmetic loss |
| 17–20 | Late joins (until close) | new Entry Contracts, own epochs/sub-seeds | §7.4, §11 | JOIN IMPOSSIBLE |
| 21 | Finish/fail/timeout | terminal checkpoint (+`s_p`), transcript → ≥2 mirrors | §12.3 | forfeit rule |
| 22 | **Evidence-finality** *(v1.1)* | terminal/forfeit evidence sequenced | §10.5 | remains provisional ⇒ annul-able |
| 23 | Eager attestation + objection window | attestations sequenced; W runs per player | §13.4 | delay; expiry backstop |
| 24 | Round FINAL | last window closes; pool = F(evidence-final results) | §15.4 | fraud proof reopens specific entry |
| 25 | Cooperative settlement | cancel winners' HTLCs; custodian shares ⇒ settle losers'; pay pool shares | §13.4 | retries |
| 26 | Non-cooperative paths | loser absent: shares claim anyway; winner absent: 30 d claim; infra absent: expiry refund of unsettled | §13.4–5 | bounded §13.5 |
| 27 | Permanent replayability | archived transcripts + WASM versions | content addressing | mirrors |

## 22. Walkthrough: Round #92831 and Alice *(updated v1.1)*

12:00:00 — the contract for #92831 (100-sat bracket, epochs 60 s,
`T_run` = 3 min, end 12:10, entry close 12:07, objection window 10 min) is
public. 37 players commit (held HTLCs, entries sequenced at join_tick 0);
13 observers risk nothing. 12:00:30 — start fires; epoch-0 seed derives
from drand after the epoch's objective closure; 37 transcripts begin under
receipt cadence.

12:01:15 — **Alice** joins the active round: 100 sat, preimage `P_A`
(VSS-shared to the five **custodians**), secret `s_A` committed, entry
signed and sequenced in epoch 1 — **committed before her world is
knowable**. Her sub-seed exists only after epoch 1 closes; her sim starts
within the contract window; ghosts render around her; her enemies are hers
alone.

12:03 — a losing player disconnects forever. His transcript ends at his
last receipted checkpoint; cadence expiry against later co-signed roots
makes his FORFEIT **evidence-final within seconds**. Attestors attest it
eagerly; his 10-minute objection window ends 12:13-ish; custodian shares
release; his stake is claimable — *and from 12:03 onward, no outage
anywhere can ever un-lose it*.

12:04:40 — Alice delivers: terminal checkpoint with delivery event, score
and `s_A` reveal, sequenced; her client pushes the full transcript to two
mirrors **before** showing the victory screen — that upload is her
insurance: if attestors ever signed a false FAILED against her, any mirror
raises the objection and the replay decides. She closes her laptop and
goes outside; nothing more is needed from her. Her HTLC is cancelled
(stake back) on attestation; her pool share waits for round FINAL.

12:10 — round ends; 12:20-ish — last objection windows close; FINAL. Say
61 entries: 24 DELIVERED, 31 FAILED, 6 FORFEIT → pool 3,700 sat; declared
fees 2% → 3,626 distributable over the rank curve; Alice ranks 7th →
~185 sat, paid to the invoice her wallet issues via NWC within the 30-day
claim window.

**If Lightning routing fails** for her payout: retried across routes for
30 days; her stake-refund (cancel) is unaffected. **If the sequencer dies
at 12:05** *(the v1.1 difference)*: the standby resumes from the last
co-signed root; if there is no standby, then after the liveness threshold
every run still `PROVISIONAL` at 12:05 is annulled — those HTLCs expire and
refund — while Alice's 12:04:40 delivery and the 12:03 forfeit **stand**,
attested and settled when infrastructure returns. The failure mode of the
infrastructure is: *pending runs get their money back; known results are
kept.* Nobody — not a DDoS attacker, not a losing whale, not the operator
that no longer exists — can turn a sequenced loss back into a refund.

---

*Deliverable cross-reference unchanged from v1.0 except: finality → §10.5;
sequencing/witnesses → §7.5, §10.3; attestor/custodian split → §13.4;
corrected figures → §18; NWC scope → §13.1; coordinator custody → §13.5.*
