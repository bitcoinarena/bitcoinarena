# BTC Logistics War — Providerless P2P Multiplayer Protocol (BLWP)

Written 2026-08-30, revised 2026-08-31 (**v1.2**). Concept specification only
— no implementation.

This document redesigns the existing centrally-operated real-money
architecture (`MULTIPLAYER.MD` v2) into a **providerless multiplayer
protocol** with the existing Unity WebGL game as its reference client.
Gameplay, vehicles, cargo, mempool-derived maps, enemies, ghost multiplayer,
the lobby concept and late joining are preserved. What is removed is the
operator: there is no house bankroll, no custodial balances, no
authoritative game server, no central payout authority — and as of v1.2,
**no single-party custody of anything at any moment**.

> **Design principle: centralized infrastructure is acceptable.
> Centralized trust is not.**

### Revision notes v1.2 (what changed and why)

| # | Change | Why | Where |
|---|---|---|---|
| 1 | **The BLWP Federation Node.** Sequencer, witnesses, attestors, custodians and the settlement coordinator collapse into **one node software** run by n independent operators. Every infrastructure duty is a duty of the federation, executed under thresholds. | Four separately-staffed roles were operationally unrealistic and left one singleton (the coordinator). One binary, many operators, no singleton. | §2, §7.5, §13, §19 |
| 2 | **Unilateral custody eliminated.** The v1.1 coordinator's "temporary custody during payout" is gone: the settlement wallet is controlled by **t-of-n threshold keys**. No single node can settle, cancel, sweep or pay anything alone — the in-transit pool is collectively controlled at every instant. Honest limit: custody does not vanish, it becomes **threshold custody**; ≥t colluding nodes can steal in-transit pools (the same trust class as Fedimint or Liquid), stated as *the* residual. | "Temporarily custodial single party" was the worst remaining trust item. | §13.5, §4 |
| 3 | **Sequencer decentralized.** A rotating leader from the federation proposes 1 Hz event batches; a root is valid only with **≥t_root co-signatures**. Leader stall ⇒ deterministic rotation; equivocation now requires a colluding quorum and remains self-proving. The separate witness role is absorbed. | The v1.1 sequencer was one machine with witnesses bolted on. | §7.5, §10.3 |
| 4 | **Per-round committee split inside the federation.** For each round, a seeded shuffle partitions the roster into an **attestor committee** and a **custody committee** — no node is in both for the same round. The v1.1 principle "whoever signs the truth holds no key to the money" survives the merger into one software. | Merging roles must not silently merge powers. | §7.5, §13.4 |
| 5 | **Fee model fixed in the default contract template:** 2% of each round's pool split automatically across all federation nodes that met the round's liveness bar, and 2% as a donation to the developer key. Both are contract line items with **zero attached control power**; players accept them at entry; alternative contracts may set other values. | Sustainable node operation and development funding without recreating a mandatory house. | §15.3 |

### Revision notes v1.1 (retained)

| # | Change | Where |
|---|---|---|
| 1 | Player-level finality (`EVIDENCE_FINAL`) replaces round-level VOID; refunds only for never-final runs; refund/DDoS prize removed | §10.5, §12.4, §16 |
| 2 | Truth/money power split with a public objection window and the victim's mirror-uploaded veto | §13.4 |
| 3 | Relay formalized as event sequencer with signed MMR roots; equivocation self-proving | §7.5, §10.3 |
| 4 | Honest time claims: no backdating/rewind/slow-motion — forward simulation explicitly not prevented | §10.3–10.4 |
| 5 | Corrected bandwidth arithmetic, replay-speed as benchmark target, NWC budgets as wallet policy | §18, §13.1 |

Unchanged by design: Unity WebGL client, dynamic rounds, lobby + late join,
ghost multiplayer, deterministic Rust/WASM simulation, Round/Entry
contracts, non-custodial player wallets, hold-invoice stake commitment,
replaceable infrastructure, pool economics.

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

2. **The federation sequences and settles; no member acts alone.**
   *(revised v1.2)* A roster of n independent **BLWP nodes** runs one shared
   binary. A rotating leader orders events into 1 Hz **sequence roots**,
   valid only with ≥t_root co-signatures — order and time, never truth.
   Per-round seeded committees keep judging (attestors) and key-holding
   (custodians) disjoint. The settlement wallet exists only behind
   **t_s-of-n threshold signatures**: every HTLC settle, cancel and payout
   is a quorum ceremony, sequenced and auditable.

3. **Stakes are Lightning hold invoices, and results carry player-level
   finality.** A stake is an in-flight HTLC, not a balance in anyone's
   database. A player's result becomes **evidence-final** the moment their
   complete transcript is sequenced — from then on, no outage and no quorum
   loss can erase it; infrastructure failure only delays settlement.
   Refunds exist solely for runs that never reached evidence-finality.
   Claiming a lost stake requires a committee attestation, an elapsed public
   objection window the victim can veto with their own transcript, and a
   threshold signing quorum.

Honesty up front: **fully trustless N-player pool settlement with
browser-only clients does not exist on Bitcoin/Lightning today.** Browsers
cannot run Lightning nodes, stay online for justice transactions, or
participate reliably in N-party on-chain ceremonies. v1.2's answer is
**federated threshold custody**: at no point does any single party control
player funds — and the residual is stated without cosmetics: **≥t_s of n
federation nodes colluding can steal in-transit pools.** That is the same
trust class as Fedimint or Liquid, it is the minimum achievable under the
browser constraint today, and everything else in this document is built to
keep that quorum honest, visible and bonded.

Because there is no house, the economics are **zero-sum pools between
players**. Bots cannot "beat the house" because there is none; pool-in
equals pool-out minus declared fees, structurally. Bots are a *fairness*
problem (brackets, skill pools — §15), not a solvency problem.

---

## 2. High-level architecture *(revised v1.2)*

```
                REPLACEABLE CONVENIENCE INFRASTRUCTURE
   Lobby & round discovery ── Matchmaking ── Leaderboard ── Indexers/Mirrors
              WebRTC signaling ── STUN / TURN
                              │
        ┌─────────────────────┴──────────────────────────┐
        │           BLWP FEDERATION  (n nodes,           │
        │            one binary, bonded operators)       │
        │                                                │
        │  duty                        acting as         │
        │  ── event sequencing ──────  rotating leader   │
        │                              + ≥t_root co-sign │
        │  ── result attestation ────  per-round attestor│
        │                              committee (t_a)   │
        │  ── preimage share custody ─ per-round custody │
        │                              committee (t_c),  │
        │                              disjoint from     │
        │                              attestors         │
        │  ── settlement wallet ─────  t_s-of-n threshold│
        │     (LN node, hold invoices) signing — no node │
        │                              can move funds    │
        │                              alone             │
        │  ── transcript mirroring ──  every node        │
        └─────────────────────┬──────────────────────────┘
      ┌───────────────────────┼──────────────────┐
      │                       │                  │
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
                   sequenced under quorum-signed roots, mirrorable)
                              │
                    Deterministic payout function
                              │
                     Bitcoin / Lightning settlement
```

No single machine anywhere in this picture can determine a result, move a
sat, or rewrite an order. Quorums can move money; quorums cannot quietly
invent results (§13.4); and everything a quorum does is sequenced.

---

## 3. Providerless: definition and control questions

| Question | Answer *(v1.2)* |
|---|---|
| Who controls funds? | The player's own wallet until stake-in; then an in-flight HTLC. Every movement afterwards requires a t_s-of-n threshold signature of the federation. **No single party has custody at any moment.** ≥t_s collusion is the stated residual. |
| Who determines outcomes? | The deterministic WASM simulation, replayable by anyone. Committees attest; the victim can veto a false attestation with their own transcript; nobody *decides*. |
| Who changes rules? | Nobody, per round: the Round Contract is immutable once published. |
| Who can admit/exclude participants? | Entry is permissionless given a valid signed Entry Contract + funded hold invoice, sequenced under a quorum root. |
| Who can stop joining? | Loss of the sequencing quorum stops *new* joins (fail-closed, no money at risk). |
| Who can stop settlement? | Quorum loss **delays** settlement of evidence-final results; it cannot reverse them. Ultimate backstop: HTLC expiry (§13.4). |
| Indispensable infrastructure? | The federation as a *role* — but its members are replaceable, its roster is versioned per round, and rival federations can run rival rounds under the same protocol. |
| Mandatory fee recipient? | None with control power. The default template pays 2% to participating nodes and 2% to the developer donation key — line items players accept at entry; other contracts may differ (§15.3). |
| Who can shut the system down? | No single party. Below t_root the federation halts new sequencing: provisional runs refund by expiry, final results settle when a quorum returns. |

---

## 4. Trust model — stated first, so the rest can be read against it

A player must trust:
1. **Bitcoin consensus** and, where used, **standard Lightning assumptions**.
2. **Cryptographic primitives** (ed25519, SHA-256, Shamir/VSS, FROST-style
   threshold Schnorr, BLS for drand).
3. **Their own wallet** (keys never enter the browser page).
4. **The deterministic simulation build** they verified or accepted (§14).
5. **The Round Contract and their own Entry Contract** they signed.

Residual trust, stated precisely (v1.2):
6. **The federation quorum, ≥t_s of n, is THE residual.** t_s colluding
   nodes can steal in-transit pools (held-stake settles, unpaid payouts) —
   the same trust class as a Fedimint federation or the Liquid functionary
   set. Everything below exists to keep that collusion unlikely, loud and
   expensive: independent bonded operators, per-round disjoint committees,
   the victim's objection veto, full sequencing of every quorum action,
   and slashable, publicly attributable misbehaviour.
7. **Committee honesty within the federation**: attestors (t_a) judge but
   hold no key material for the round; custodians (t_c) hold shares but
   judge nothing and release only on the mechanical rule (sequenced
   attestation + elapsed objection window + no counter-evidence). A false
   loss additionally requires the victim's mirrored transcript to be
   unavailable — and every federation node is a mirror, plus any third
   party may mirror.
8. **Sequencing quorum honesty (t_root)** for history uniqueness.
   Equivocation requires t_root signers on two branches and is self-proving
   from the double-signed roots.
9. **Time integrity is partial by design**: roots prevent rewind,
   backdating and slow-motion — not forward simulation (§10.4).
10. **The loaded web page** is trusted at load time; the wallet's own
    approval UI and budget ceiling are the real boundary — wallet policy,
    not cryptographic round-binding (§13.1).
11. **drand** (or the Bitcoin-blockhash fallback) as unpredictable public
    randomness.
12. **Maturity note, honestly:** federated *custody* (Fedimint-class) is
    production technology today; a Lightning node whose channel operations
    are signed by an external **t-of-n threshold signer quorum**
    (VLS-style remote signing generalized to FROST) is emerging technology.
    V1 may interim-operate the settlement wallet as a Fedimint-style
    federation with an LN gateway (mature) while threshold-LN hardens; the
    trust statement — no single signer, ≥t_s to move funds — is identical
    in both constructions.

A player does **not** trust: the lobby, matchmaking, signaling, STUN/TURN,
any single federation node, the leaderboard, the web host (beyond item 10),
other players, any house, any central ledger, any single payout authority.

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
- **Networking**: WSS to the current leader (with automatic failover to the
  rotation successor) for protocol traffic; optional WebRTC DataChannels
  (unreliable) for ghost snapshots. Loss/ordering handled by tick-numbered,
  idempotent messages.
- **Reconnect**: the client rebuilds its own run by fetching its streamed
  input log back and replaying locally (§12.5).
- Compatibility target: current Chrome, Firefox, Edge, Safari (WASM MVP +
  WebSocket + WebCrypto only; WebRTC optional).

---

## 6. Protocol vs reference client

The **protocol** is: message formats, contracts, registry/sequencing
structure, committee derivation, randomness derivation, transcript and
checkpoint rules, verification and objection rules, payout function,
settlement flows — everything in §§7–19. Any compatible client (headless
Rust client included) may participate; any compatible node implementation
may join a roster. The **Unity build** is one client. Protocol identity
derives from `(protocol_version, sim_wasm_hash)`, never from a domain.

---

## 7. Rounds, lobby, and dynamic membership

### 7.1 Lobby
The lobby is a discovery view over Round Contracts: upcoming and running
rounds, status (`WAITING / ACTIVE / CLOSING / SETTLING / FINAL`), committed
player count, stake bracket, payout curve, start condition, late-join
policy, elapsed time, leaderboard, **federation roster and fee schedule**.
The V1 lobby service is centralized and non-authoritative: every fact it
displays is a signed artifact any replacement lobby can serve identically.

Player states: `OBSERVING → READY → ENTRY_SIGNED → STAKE_COMMITTED →
ACTIVE`. Only `STAKE_COMMITTED` has money at risk.

### 7.2 Round Contract *(fields revised v1.2)*
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
  fee_schedule          // v1.2 default: 2% → federation nodes (liveness-
                        //   weighted, equal split), 2% → developer donation
                        //   key; line items, no control power attached
  federation {          // v1.2
    roster[]            //   n node pubkeys + bonds + endpoints
    t_root, t_a, t_c, t_s
    committee_seed_rule //   deterministic per-round attestor/custody split;
                        //   disjointness REQUIRED
    leader_rotation     //   order, stall grace, handover rule
    liveness_bar        //   share of roots a node must co-sign to earn fees
  }
  finality_rules        // evidence-finality criteria, objection window W,
                        //   annulment conditions (§10.5)
  disconnect_rules      // neutral-input + cadence-forfeit definitions
  suspension_rules      // same as disconnect (explicitly)
  settlement_rules      // federated wallet id, hold-invoice params, CLTV
                        //   (sized in days), claim windows, threshold t_s
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
  vss_shares_ref                // P Shamir-shared to the round's CUSTODY
                                //   committee (VSS, encrypted per-member)
  seed_commitment = H(s_p)      // player randomness secret (§11)
  vehicle, loadout, cargo_tier
  accepted: payout_model_hash, fee_hash, disconnect_rules_hash,
            finality_rules_hash, federation_hash, sim_wasm_hash,
            protocol_version, max_payout
  session_pubkey                // per-run signing key, certified here
  signature
}
```

### 7.4 Start, epochs, late join
- **Start condition** is deterministic and pre-published. No party
  discretionarily starts a round after seeing stakes.
- Entry epochs (e.g. 60 s); entries close at
  `entry_close_tick = end_tick − T_run` so every entrant gets the full
  mission duration.
- **Pool consent**: the contract states *"all valid entries up to
  entry_close_tick contribute to and share one pool, computed over
  evidence-final results."* Every entrant signed that sentence.
- **Epoch closure is objective**: epoch *e* closes at the first
  quorum-signed root with timestamp ≥ the boundary; membership and
  `join_tick` follow from sequence position, not from anyone's claim.

### 7.5 Sequencing and committees *(revised v1.2)*

**Sequencing.** Per round, the contract fixes a leader rotation over the
roster (deterministic order from `round_id`). The current leader collects
events (entries, checkpoint receipts, epoch closures, attestations,
objections, share releases, settlement records), assigns positions, and
proposes a 1 Hz root:

```
SequencedRoot { round_id, seq, unix_ms, mmr_root, leader_sig,
                cosigs[] }        // valid iff |cosigs| ≥ t_root
```

- Every co-signing node checks the MMR consistency proof (append-only
  extension) before signing — an O(log n) check with no gameplay knowledge.
- **Leader stall** > grace (e.g. 3 s) ⇒ the next node in rotation resumes
  from the last quorum root; clients fail over automatically. Liveness
  requires any t_root honest reachable nodes, not one machine.
- **Equivocation** now requires ≥t_root signers on two branches — and two
  quorum roots with equal `seq` and different `mmr_root` are portable proof
  against every signer of both.

**Committees.** Per round, a public seeded shuffle
(`H(round_seed ‖ "committees")`) partitions the roster into the **attestor
committee** (size a, threshold t_a) and the **custody committee** (size c,
threshold t_c), disjoint by rule. Example genesis parameters: n = 9,
t_root = 5, a = 4/t_a = 3, c = 5/t_c = 3, t_s = 5. A node attests some
rounds and custodies others — never both for the same round. *"Whoever
signs the truth holds no key to the money"* survives inside one binary.

**Registry.** As before: append-only, self-authenticating events, MMR
inclusion proofs, mirrored by every node and by anyone else. There is no
trusted database administrator.

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
Ghost snapshots `{pubkey, pos, rot, speed, tick, envelope}` (~30 B) flow at
5 Hz over the low-trust path, interest-managed (K ≈ 20), lossy and
approximate — and **cannot touch financial state by construction**: the
deterministic core has no input channel for them. The live leaderboard is
informational; payouts derive only from verified transcripts.

---

## 9. Deterministic simulation and protocol tick

- Fixed protocol tick **30 Hz**; rendering FPS free.
- `result = Replay(sim_wasm_hash, round_statics, sub_seed, input_log)` —
  bit-identical everywhere.
- Inputs are quantized and bound to tick numbers; missing ticks auto-fill
  with the contract's neutral policy (throttle 0, steering decay, brake
  ramp).
- Historical sim versions are archived content-addressed; any old round
  replays forever.

---

## 10. Authenticated transcripts, time, and finality

### 10.1 Input stream
Input batches (10 Hz, ~30 B) are **hash-chained**; each 1 Hz **checkpoint**
signs the chain head:

```
Checkpoint {
  round_id, player_pubkey, tick
  state_hash, input_chain_head
  root_ref                      // latest quorum-signed root
  prev_checkpoint_hash
  session_signature             // ed25519, ~1 sig/s
}
```

≈150 B/s upstream, acknowledged by leader **receipts** that are themselves
sequenced. Inputs must be published to mirrors within ≤5 s; a transcript
with withheld inputs is unverifiable and forfeits by rule.

### 10.2 Why rewriting is impossible
Once a checkpoint's receipt is sequenced under a quorum root, every input
before its tick is frozen under the player's own signature.

### 10.3 What the time mechanism guarantees
Roots double as time beacons; a checkpoint for tick `T` must embed a recent
root and arrive within `|root.time − T/30| ≤ tolerance`. Receipts sandwich
each 1 s segment in wall-clock time. Exactly three guarantees:
1. **No backdating.**
2. **No rewind past publication** (forking limited to the un-receipted last
   ≤1 s, visible as a cadence gap priced as neutral-input time).
3. **No gross slow-motion** (cadence at 1× ± tolerance or forfeit forward).

### 10.4 What it does **not** guarantee — stated honestly
With no server there is **no per-player hidden randomness**: the client
must know every roll to simulate. **Forward simulation is not prevented and
cannot be** — a fast agent may explore thousands of candidate futures per
real second. The design does not rely on pacing for economic safety; it
relies on the pool being **zero-sum between players** (§15.2).

### 10.5 Player-level finality
Each entry's result moves along a one-way ladder:

```
PROVISIONAL      transcript in progress
EVIDENCE_FINAL   complete evidence exists and is ordered:
                   - DELIVERED/FAILED: terminal checkpoint sequenced under a
                     quorum root, full input log mirrored (availability
                     receipt sequenced)
                   - FORFEIT: cadence expiry relative to the last sequenced
                     receipt, established by a later quorum root
ATTESTED         ≥t_a attestor-committee signatures, sequenced
SETTLED          HTLC settled/cancelled; payout executed (threshold-signed)
ANNULLED         terminal refund state — reachable ONLY from PROVISIONAL
```

**The finality rule:** once `EVIDENCE_FINAL`, a result can never change
class and can never be refunded. Quorum loss, leader death, committee
outage — all of it *delays* the remaining steps; none of it reverses a
known result.

**Annulment (bounded refunds):** only runs still `PROVISIONAL` when the
*federation side* fails (sequencing quorum lost beyond the liveness
threshold, proven equivocation past the common prefix) are `ANNULLED`:
their HTLCs expire → refund. Client-side silence is never annulment — it is
the forfeit rule.

**Pool arithmetic under mixed outcomes:** pool and rank curve are computed
over `EVIDENCE_FINAL` results only; `ANNULLED` entries neither contribute
nor draw. Deterministic, and consented to in the Entry Contract.

**Why this kills the refund/DDoS incentive:** results reach
evidence-finality within seconds; attestation and share release run eagerly
per player; an attacker who somehow downs a *quorum* of independent nodes
annuls only in-progress runs — recovering at most their own stake, never
profiting. The stated residual: a losing-but-not-yet-forfeit player who
manages to break sequencing before their cadence expiry converts a probable
loss into an annulment-refund; rotation across n nodes makes that an attack
on t_root machines at once, for bracket-sized money.

---

## 11. Randomness

```
round_seed    = H(RoundContract ‖ btc_blockhash_at_creation)
epoch_rand(e) = drand.round(scheduled_at_epoch_open(e))     // unpredictable
epoch_seed(e) = H(round_seed ‖ e ‖ epoch_rand(e))
sub_seed(p)   = H(epoch_seed(e_p) ‖ player_pubkey ‖ s_p ‖ join_tick)
```

- **drand** is public, BLS-verifiable, browser-fetchable; fallback:
  Bitcoin block hashes with coarser epochs. Nobody in this protocol chooses
  randomness — including the federation.
- `s_p` committed (`H(s_p)`) **before** the entry's `epoch_rand` exists →
  no grinding; stake committed before the seed is knowable → no abort
  advantage; `s_p` revealed by the terminal checkpoint or the transcript is
  unverifiable → forfeit.
- **Late-join asymmetry**: ghosts reveal *other players' worlds*;
  per-player sub-seeds keep a late joiner's own world unknown until
  committed; identical stakes, identical `T_run`, rank scoring, objective
  entry cutoff. Residual meta-information accepted and stated.

---

## 12. Liveness rules: disconnects, suspension, recovery

### 12.1 Before commitment
Unfunded states: disconnect = nothing; entries expire.

### 12.2 The one rule after commitment
**A transcript that stops is a result.** Missing inputs become neutral
inputs; missing checkpoints beyond the cadence tolerance — measured against
sequenced receipts, objectively — end the valid transcript at the last
receipted checkpoint, scored as-is (typically FORFEIT). Covers every
client-side failure and strategy identically. The stake was committed
before the first financial tick; settlement needs nothing from the player.

### 12.3 Finishing players
Delivery emits a terminal checkpoint (delivery event, score, `s_p` reveal),
sent before the client celebrates; the client pushes its full transcript to
≥2 mirrors (federation nodes and/or third parties) before declaring success
— this upload arms the objection veto of §13.4.

### 12.4 Grace and annulment
Short gaps are neutral-input time. Federation-side liveness failure beyond
the threshold annuls only still-provisional runs (HTLC expiry → refund).
Evidence-final results are untouched and settle when a quorum returns.

### 12.5 Player-side recovery
The client streams its inputs out; after a reload it fetches its own log
back from any mirror, replays locally, resumes. Reconnect changes the
future, never the past.

---

## 13. Money: wallets, stake commitment, federated settlement

### 13.1 Wallets — what actually works in a browser today
- **Nostr Wallet Connect (NWC)**: extension-free; `make_invoice` /
  `pay_invoice` with per-connection **budgets — enforced by the wallet as
  local policy**, not cryptographically bound to a round. The hard boundary
  is the budget ceiling and the wallet's own confirmation UI; the protocol
  claims exactly that and nothing more.
- **bolt11 QR / deep links**: universal fallback for stake-in; payouts to a
  player-supplied invoice during the claim window.
- **WebLN** where present — never required.
- The wallet seed never enters Unity, JS, WASM, or any node.

### 13.2 The payout function is code, not a decision
`payouts = F(RoundContract, registry, EntryContracts, evidence-final
results)` — deterministic, replayable by anyone. Result classes:
`DELIVERED(score) / FAILED / FORFEIT / ANNULLED`.

### 13.3 Stake-in: hold invoices against the federated wallet
1. Player generates preimage `P`; `payment_hash = H(P)` goes into the Entry
   Contract; `P` is VSS-shared (threshold t_c) to the round's **custody
   committee**.
2. The **federated settlement wallet** — an LN node whose every channel
   operation requires t_s-of-n threshold signatures (§13.5) — issues a hold
   invoice; the player's wallet pays; the HTLC sits in-flight, CLTV sized
   in days.
3. `STAKE_COMMITTED` is sequenced. Play begins only after this.

### 13.4 Settlement: judged by one committee, keyed by another, vetoed by
victims, signed by a quorum *(revised v1.2)*

Eager, per-player flow:

- **DELIVERED**: on `EVIDENCE_FINAL`, the attestor committee replays and
  attests; a t_s quorum **cancels** the winner's HTLC (cancelling only ever
  returns money to its owner). The pool share is paid after round `FINAL`.
- **FAILED / FORFEIT**: attestation is sequenced; the **objection window
  W** (e.g. 10 min) runs. Absent valid counter-evidence, the custody
  committee releases shares per its mechanical rule; a t_s quorum settles
  the hold invoice — only now does the stake move, into the
  threshold-controlled pool. A loser cannot escape: the money left their
  wallet at entry, and every later step runs without them.
- **Objection (the victim's veto)**: counter-evidence = a player-signed
  transcript with sequenced receipts that replays to `DELIVERED` under the
  contract's `sim_wasm_hash` — mechanically checkable by anyone. A
  sequenced valid objection freezes release; replay decides (determinism
  leaves no middle ground). Mirror-upload at delivery (§12.3) makes the
  veto work even for a player who closed the browser; any third party can
  raise it for them.
- **ANNULLED**: nobody attests, nobody releases, HTLCs expire → refund.

**What collusion can and cannot do:**
- Attestor committee alone (≥t_a): can sign a false loss — disprovable by
  any mirror within W; holds no key material for the round; nothing moves.
- Custody committee alone (≥t_c): holds shares, but its rule's inputs are
  public sequenced facts it cannot fabricate, and moving the stake still
  needs a t_s signing quorum.
- Sequencing quorum alone: order and delay games, all self-proving.
- **The full worst case is trust item 6 (§4)**: ≥t_s nodes spanning the
  committees colluding — able to fabricate, release and sign together —
  *plus* suppression of the victim's mirrored evidence. Possible, loud,
  bonded, permanently provable. This is the federated-custody trust class,
  named without cosmetics.
- **V2/experimental**: zk proof-of-replay would make release
  cryptographically contingent on a verified loss, shrinking committee
  trust further. Not assumed.

### 13.5 The federated settlement wallet *(replaces the v1.1 coordinator)*

There is **no settlement coordinator**. The settlement wallet is operated
by the federation itself:

- Its keys exist only as **t_s-of-n threshold shares** (FROST-style
  Schnorr). Every hold-invoice issue, settle, cancel, payout and any
  on-chain action is a threshold ceremony whose participants and inputs are
  sequenced in the registry.
- **No single node — and no minority — can move a satoshi.** The v1.1
  "temporary custody during payout" by one party is gone: pools in transit
  are collectively controlled at every instant.
- What remains, said plainly: **threshold custody**. ≥t_s colluding nodes
  control in-transit funds (claimed-but-unpaid pools, and they could refuse
  to co-sign honest payouts). Delay by an honest-minority outage ends at
  the backstops: winners' cancels and unclaimed loser HTLCs expire →
  refund; the claim window governs payouts.
- **Construction maturity (§4.12)**: threshold-signed LN channel operation
  is emerging; a Fedimint-style federation with an LN gateway delivers the
  identical trust statement with production technology and may serve as the
  interim construction. The contract names which construction a round uses.
- Bonds: every roster member posts a published bond; provable misbehaviour
  (double-signed roots, false attestation against a replaying transcript,
  signing a settlement that violates the mechanical rule) is attributable
  per-signature and slashable/blacklistable at roster level.

### 13.6 Settlement scalability
N stake HTLCs in, ≤N payouts out, zero on-chain transactions in the normal
path. Threshold ceremonies batch naturally (one signing session covers many
settles/payouts). 1,000 × 100 sat = 100k sat inbound liquidity — trivial;
brackets keep liquidity predictable; payouts retry across routes within a
30-day claim window; dust floors per bracket. On-chain appears only in
disaster recovery of the federated node itself (standard force-close
mechanics, threshold-signed).

---

## 14. Distribution, builds, versioning, compromised hosts

- The client is **static assets** servable from the official site, mirrors,
  IPFS gateways, or localhost. Protocol identity =
  `(protocol_version, sim_wasm_hash)`, not a domain.
- The **sim core is reproducibly buildable**; historical versions archived.
  The Unity build is content-addressed and manifest-signed as a whole (the
  financial layer is the WASM, and that one is bit-reproducible).
- **No privileged admin key exists** — for the game *or the federation*:
  roster changes are per-round facts in new contracts players opt into,
  never retroactive edits.
- **Compromised web host**: phishing-grade power, bounded by the wallet's
  budget ceiling and approval UI. It cannot forge entries, results, or
  settlements.

---

## 15. Economics without a house

### 15.1 Model (unchanged)
A **success pool within fixed-stake brackets** with a rank curve: pool =
stakes of evidence-final `FAILED` + `FORFEIT`; qualification = `DELIVERED`
with score ≥ minimum; distribution by rank curve (ties split); qualifiers
also get their stake back; zero qualifiers ⇒ refund round. Identical
`T_run` time-normalizes scores. Solvency is structural.

### 15.2 Skill and bots (unchanged in substance)
Bots take money from players, not from a house: fairness controls —
brackets, rating-gated pools (Glicko-2 over verified results, computable by
anyone), declared-bot rounds; no bonuses ⇒ Sybil splitting buys nothing;
ghost isolation ⇒ in-round collusion yields nothing mechanical. Forward
simulation (§10.4) is assumed to exist; bot detection is not assumed to
work.

### 15.3 Fees *(revised v1.2)*
The default contract template sets, as pool line items at settlement:

- **2% → the federation**, split equally among roster nodes that met the
  round's **liveness bar** (co-signed ≥ the contract's share of roots and
  performed their committee duties). Paid automatically inside the
  threshold payout batch. This is what funds sequencing, attestation,
  custody, mirroring and the settlement wallet — infrastructure pays for
  itself without a house.
- **2% → the developer donation key**, funding client and protocol
  development. A donation line item with **no control power attached**: the
  key can neither sign roots, attest, custody shares, nor block anything.
- Both percentages are template defaults, visible in the lobby, accepted by
  signature at entry. Alternative contracts may set other values or other
  recipients — the protocol has **no hard-coded fee recipient**; rounds
  that want players must offer fee schedules players accept.

### 15.4 Finality of the round
`end_tick` → ladders complete (eager attestation) → last objection window
closes → `FINAL`: pool and allocation immutable; claim window (30 days);
unclaimed remainders per contract.

---

## 16. Failure matrix *(revised v1.2)*

| Failure | Effect | Classification |
|---|---|---|
| Lobby down | Discovery only; direct round_id entry works | JOIN IMPOSSIBLE / NO IMPACT |
| Matchmaking/signaling/STUN/TURN down | Ghosts degrade; finances untouched | DEGRADED |
| **Leader node stalls** | Rotation successor resumes from last quorum root within grace | NO IMPACT (brief hiccup) |
| **Minority of nodes down (< n − t_root)** | Quorums still form; fees dock the absentees | NO IMPACT |
| **Sequencing quorum lost (≥ threshold time)** | Provisional runs ANNULLED (refund by expiry); **evidence-final results stand, settle late** | PARTIAL ANNUL + SETTLEMENT DELAY |
| **Quorum equivocation (proven)** | Double-signed roots incriminate every signer; common-prefix results stand; rest annulled; bonds slashed | PARTIAL ANNUL |
| Attestor committee unavailable | Losses cannot be erased; settlement waits; backstop: unsettled HTLCs expire | SETTLEMENT DELAY → (backstop) REFUND of unsettled |
| Custody committee unreachable ≥ CLTV | Loser HTLCs expire unclaimed | REFUND of those losses (stated backstop; why CLTV is days) |
| **Settlement quorum (t_s) unavailable** | No settles/cancels/payouts until quorum returns; expiry backstops | SETTLEMENT DELAY → REFUND of unsettled |
| One browser crashes / player partition | Transcript ends | PLAYER FORFEIT |
| Wallet unavailable at entry / payout | Entry expires / 30 d claim window | JOIN IMPOSSIBLE / SETTLEMENT DELAY |
| LN route fails (stake / payout) | Not committed / retried in window | JOIN IMPOSSIBLE / SETTLEMENT DELAY |
| Bitcoin fee spike | Off-chain protocol unaffected | NO IMPACT |
| Late join during outage | Entry can't be sequenced | JOIN IMPOSSIBLE |

Every cell ends in REFUND, FORFEIT, DELAY, PARTIAL ANNUL — and no cell
erases an evidence-final result or hands funds to a single party.

---

## 17. Verification and disputes

- Attestor committee members run the open replayer; **anyone outside the
  committee can also replay and raise objections** — the committee is who
  settlement listens to, not who truth belongs to.
- Disputes are player-specific and mechanical: bisect the 1 Hz checkpoints
  to the first divergent second; replay 30 ticks; signatures and
  determinism leave no middle ground. Committee-vs-objection conflicts
  resolve by replay; unresolved conflicts leave runs unsettled until the
  expiry backstop (never silently decided).

### Threat model (condensed; v1.2 rows marked)

| Threat | Capability | Impact | Prevention / Detection | Recovery / Residual |
|---|---|---|---|---|
| Malicious player, modified client/WASM, bots | Anything client-side | Plays well | Nothing client-side trusted; transcripts + replay | Fairness residual (§15.2) |
| Input rewriting | Fork own past | Forge wins | Chained checkpoints + sequenced receipts | None |
| Fake checkpoints / divergence | Wrong hashes | Forge wins | Deterministic replay; bisection | Forfeit; none |
| Rewind / slow-motion / suspension | Local clock control | Escape cadence | Root embedding + receipts | ≤1 s residue |
| Forward simulation (fast bot) | Candidate futures each second | Superhuman play | **Not preventable**; declared | Zero-sum economics; fairness pools |
| Seed grinding / abort advantage | Choose entries | Favorable worlds | Commit before epoch_rand; stake precedes seed | None |
| Withheld inputs / no reveal | Withhold data | Block verification | Availability windows; reveal-or-forfeit | None |
| Late-entry arbitrage | Join informed | Edge | Fresh sub-seeds, equal T_run, objective closure | Meta-info residue |
| Sybil / in-round collusion | Many entries | Shift pool | Zero-sum + ghost isolation; no bonuses | Rating-manipulation residue |
| Disconnect / refund gaming | Kill own feed; attack nodes | Escape a loss | Finality ladder; annulment ⇒ own stake at most; **attack now needs a quorum of machines** *(v1.2)* | Narrow window, bracket-bounded |
| Ghost spoofing | Fake visuals | Mislead humans | Enveloped snapshots; zero financial coupling | Cosmetic |
| Message replay | Re-send traffic | Duplicates | Seq numbers; idempotent sequencing; single-use payment_hash | None |
| Settlement refusal by loser | Do nothing | Keep stake | Eager attestation + committee release + t_s signing | None |
| **Leader censorship** *(v1.2)* | Drop events selectively | Grief specific players | Client resubmits via next leader; rotation; receipts prove submission where obtained | Delay only |
| **Quorum equivocation** *(v1.2)* | Two histories | Conflicting rounds | ≥t_root must double-sign — self-proving against each signer | Partial annul; bonds slashed |
| **Attestor committee collusion (≥t_a)** | Sign false loss | Attempt theft | No round keys; objection window; every node + third parties mirror | Delay only, unless full collusion |
| **Custody committee collusion (≥t_c)** | Release early | Attempt theft | Rule inputs public; t_s still required; provable vs bonds | Bounded, loud |
| **Federation collusion ≥t_s** *(v1.2)* | Fabricate + release + sign | **Steal in-transit pools** | Disjoint committees raise the bar; bonds; permanent public proof; roster diversity | **The stated residual (§4.6)** |
| Compromised website/CDN/DNS | Lying build | Phish stakes | Hashes/manifests/mirrors; wallet budget policy | Bounded to approved amounts |
| DDoS during rounds | Attack nodes | Stall | Rotation + quorums; finality first; provisional refunds | Availability cost only |
| Protocol fragmentation | Forks | Split liquidity | Versioned contracts; players sign what they accept | Social |

---

## 18. Scalability

Per player, upstream: inputs 300 B/s + checkpoints 150 B/s + ghost
snapshots 150 B/s ≈ **600 B/s**. Downstream: 20 ghosts × 30 B × 5 Hz =
3.0 KB/s + roots/receipts ~0.4 KB/s + registry deltas ~0.3 KB/s ≈
**3.5–4 KB/s**. Independent of N.

Leader node, 1,000-player round: ingest ≈ 0.6 MB/s, egress ≈ 4 MB/s, plus
registry streaming ≈ 0.5 MB/s — one modest server's load, now failover-able
across the roster. Co-signing overhead: t_root signatures over a 32 B root
per second — negligible. Threshold-ceremony overhead: batched, dozens of
signing sessions per round, not per event.

Registry per 1,000-player round: entries ~0.4 MB; checkpoints ~19 MB;
input logs ~180 MB streamed, archived for the objection/claim windows, then
prunable to roots + terminal proofs — replicated across nodes (every node
is a mirror).

Attestor workload: replay speed is a **benchmark target, not an
assumption** (implementation plan gates: native ≥20×, in-browser ≥3×
realtime); eager per-player attestation spreads replays across the round;
sampling covers the honest mass; full replay concentrates on objections.

Settlement: ≤2 LN operations per player per round, threshold-signed in
batches.

---

## 19. Infrastructure matrix *(collapsed for v1.2)*

| Component | Required? | Centralizable? | Custody? | Can steal? | Decides result? | Blocks join? | Blocks play? | Blocks settlement? | Replaceable? | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|
| Unity WebGL host / CDN | yes* | yes | no | no² | no | yes | no | no | yes | mirrors/IPFS/local |
| Lobby / matchmaking | no | yes | no | no | no | yes | no | no | yes | direct round_id |
| Signaling / STUN / TURN | no | yes | no | no | no | no | ghosts only | no | yes | leader-fanout ghosts |
| **BLWP node (single)** | — | — | **no — key share only** | **no** | attests some rounds | no | no | no | yes | rotation & quorums |
| **Federation quorum (≥t)** | yes (per round) | partly (independent operators) | **threshold custody of in-transit pools** | **≥t_s collusion: yes — the stated residual** | attest + veto-checked | roster-wide outage only | stall ⇒ partial annul | delays; expiry backstop | per-round roster in new contracts | HTLC expiry ⇒ refund |
| Developer donation key | no | — | no | no | no | no | no | no | removable per contract | — |
| Bitcoin / Lightning | yes | no / partly | n/a / in-flight only | no | no | funding path | no | ultimate settlement / delays | n/a / yes | retry routes |

\* some host, any host. ² phishing-grade, bounded by wallet budget policy.

**Decentralization-theater check:** the only row that can move funds is a
*quorum*; no single machine row can both fabricate a result and move a sat;
every role rotates or is replaceable per round; total disappearance of the
roster refunds provisional runs by expiry and leaves final results
settleable by any future quorum holding resharing state — or, failing that,
refunded by the same expiry backstop.

---

## 20. V1 and V2

**Pragmatic V1 (buildable now):** one genesis federation of 5–9 named,
bonded, independent operators (the developer may operate a minority of
nodes at genesis — stated openly; a minority can neither sequence nor
settle alone). Rotating leader + t_root co-signing; per-round disjoint
committees; settlement wallet as **Fedimint-style federation with LN
gateway** (mature) or threshold-signed LN node (as it hardens) — identical
trust statement either way; NWC + QR wallets; drand randomness; the full
transcript/replay, finality and objection machinery; default fees 2% nodes
+ 2% developer donation.

**Decentralized V2:** open bonded roster membership with epoch-based
resharing (DKG) on membership change; multiple lobbies and round discovery
over Nostr; larger rosters with per-round sortition of committees;
registry-derived reputation; content-addressed client releases as default.
**Experimental, flagged:** zk proof-of-replay for cryptographically
contingent release; PTLC/adaptor-signature stake conditioning; N-party
pooled DLCs per epoch.

**Current technical limitations, plainly:**
1. Browser-only trustless N-party settlement does not exist → federated
   **threshold custody** with ≥t_s collusion as the stated residual (§4.6).
2. Threshold-signed LN channel operation is emerging tech → interim
   Fedimint-class construction with the same trust statement (§4.12).
3. No hidden per-player randomness → forward simulation and ~p_max bots
   assumed; harmless to solvency (zero-sum), handled as fairness.
4. Time integrity is partial: rewind/backdating/slow-motion prevented;
   forward simulation not.
5. A losing-but-not-yet-forfeit player who breaks the sequencing quorum can
   still reach annulment-refund of their own stake (never profit) — now an
   attack on t_root machines, bracket-bounded.
6. The loaded web page is trusted at load; wallet budgets are policy, not
   cryptographic round-binding.
7. drand/blockhash beacons are external dependencies (replaceable,
   verifiable).

---

## 21. Complete round lifecycle

| # | Step | Message / artifact | Guarded by | On failure |
|---|---|---|---|---|
| 1 | Open game | static assets | hashes/manifest | try mirror |
| 2 | Verify build/protocol | manifest sig, `sim_wasm_hash` | reproducible build | refuse to stake |
| 3 | Connect wallet | NWC pairing (budget policy) or QR | wallet UI | QR fallback |
| 4–5 | Lobby, discover rounds | RoundContracts incl. roster + fees | signatures | direct round_id |
| 6 | Pick round + stake | — | — | — |
| 7 | Entry Contract draft | `H(s_p)`, payment_hash, VSS→custody committee | client-side generation | abort free |
| 8 | Sign entry | ed25519; session key certified | player key | abort free |
| 9 | Commit stake | wallet pays hold invoice to federated wallet; HTLC held | LN; CLTV in days; threshold-issued | entry expires |
| 10 | Sequencing | entry under quorum root; join_tick = sequence position | leader + t_root cosigs | resubmit via next leader |
| 11–12 | Wait; start fires | roots as clock; deterministic schedule | contract | annul provisional ⇒ refund |
| 13 | Epoch seed | H(round_seed ‖ e ‖ drand) after objective closure | drand verifiability | blockhash fallback |
| 14–15 | Play | 10 Hz input chain; 30 Hz core; 1 Hz checkpoints + receipts | §10 | neutral-input rule |
| 16 | Ghosts | 5 Hz snapshots via leader fan-out | non-authoritative | cosmetic loss |
| 17–20 | Late joins (until close) | new Entry Contracts, own epochs/sub-seeds | §7.4, §11 | JOIN IMPOSSIBLE |
| 21 | Finish/fail/timeout | terminal checkpoint (+`s_p`); transcript → ≥2 mirrors | §12.3 | forfeit rule |
| 22 | Evidence-finality | terminal/forfeit evidence sequenced | §10.5 | remains provisional ⇒ annul-able |
| 23 | Eager attestation + objection window | committee attestations sequenced; W per player | §13.4 | delay; expiry backstop |
| 24 | Round FINAL | pool = F(evidence-final results); fees 2%+2% applied | §15.3–15.4 | fraud proof reopens entry |
| 25 | Cooperative settlement | t_s quorum: cancel winners, settle losers via committee shares, pay shares + fees | §13.4–13.5 | retries |
| 26 | Non-cooperative paths | loser absent: shares + quorum claim anyway; winner absent: 30 d claim; quorum absent: expiry refund of unsettled | §13.4–13.5 | expiry backstop |
| 27 | Permanent replayability | archived transcripts + WASM versions on every node | content addressing | any mirror |

## 22. Walkthrough: Round #92831 and Alice *(updated v1.2)*

12:00:00 — the contract for #92831 is public: 100-sat bracket, epochs 60 s,
`T_run` = 3 min, end 12:10, objection window 10 min, **federation roster of
9 bonded nodes (t_root 5, committees 4/5 disjoint, t_s 5), fees 2% nodes +
2% developer**. 37 players commit; entries sequenced under quorum roots.
12:00:30 — start fires.

12:01:15 — **Alice** joins the active round: preimage `P_A` VSS-shared to
the round's five custody nodes, `s_A` committed, entry signed, her wallet
pays the hold invoice **issued by the federated wallet — a wallet no single
operator can touch**. Committed before her world is knowable.

12:03 — a losing player disconnects forever; cadence expiry against quorum
roots makes his FORFEIT evidence-final within seconds; the attestor
committee attests eagerly; his objection window ends ~12:13; custody shares
release; a t_s signing quorum settles his HTLC into the pool. From 12:03
on, no outage can un-lose him — and no single node could have taken his
stake either.

12:04:40 — Alice delivers: terminal checkpoint sequenced, transcript pushed
to two mirrors before the victory screen — her veto insurance. Her HTLC is
cancelled by a threshold ceremony (stake back); her pool share waits for
FINAL. She closes her laptop; nothing more is needed from her.

12:20-ish — FINAL. 61 entries: 24 DELIVERED, 31 FAILED, 6 FORFEIT → pool
3,700 sat; **fees 4% = 148 sat (74 split across the nine nodes that met
the liveness bar, 74 to the developer key)**; 3,552 distributable over the
rank curve; Alice ranks 7th → ~181 sat, paid by a threshold-signed batch to
the invoice her wallet issues, within the 30-day claim window.

**If Lightning routing fails** for her payout: retried for 30 days; her
stake-cancel is unaffected. **If the leader node dies at 12:05**: the next
node in rotation resumes from the last quorum root within seconds — nobody
notices. **If five of nine nodes die at 12:05**: sequencing halts; runs
still provisional are annulled (HTLCs expire → refund) while Alice's
delivery and the 12:03 forfeit stand and settle when a quorum returns.
The failure mode of the whole federation is: *pending runs get their money
back; known results are kept; and at no point — running, stalled, or dead —
did any single party hold the money.*

---

*Deliverable cross-reference: as v1.1, with sequencing/witnesses and
settlement now under the federation (§7.5, §13.4–13.5), fees under §15.3.*
