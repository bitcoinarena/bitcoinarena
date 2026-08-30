# BTC Logistics War — Providerless P2P Multiplayer Protocol (BLWP)

Written 2026-08-30. Concept specification only — no implementation.

This document redesigns the existing centrally-operated real-money architecture
(`MULTIPLAYER.MD` v2) into a **providerless multiplayer protocol** with the
existing Unity WebGL game as its reference client. Gameplay, vehicles, cargo,
mempool-derived maps, enemies, ghost multiplayer, the lobby concept and late
joining are preserved. What is removed is the operator: there is no house
bankroll, no custodial balances, no authoritative game server, no central
payout authority.

> **Design principle: centralized infrastructure is acceptable.
> Centralized trust is not.**

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

2. **The relay provides time, not truth.** The one thing a purely client-side
   simulation cannot self-certify is *when* it was computed (rewind and
   slow-motion cheating). A replaceable Round Relay broadcasts signed,
   content-free **time beacons**; every player checkpoint must embed the
   latest beacon and arrive within a real-time window. Beacons sandwich each
   transcript segment in wall-clock time. A malicious relay can stall the
   round (liveness), never bias an outcome (truth).

3. **Stakes are Lightning hold invoices whose default is refund.** A stake is
   an in-flight HTLC, not a balance in anyone's database. If the round fails,
   *inaction refunds everyone* (HTLC expiry). Claiming a lost stake requires a
   threshold of independent verifiers to release preimage shares after
   deterministic replay — no single party can take a player's money.

Honesty up front (§62 of the brief): **fully trustless N-player pool
settlement with browser-only clients does not exist on Bitcoin/Lightning
today.** Browsers cannot run Lightning nodes, stay online for justice
transactions, or participate reliably in N-party on-chain ceremonies. V1
therefore contains one precisely-bounded residual trust: a **replaceable,
non-custodial-by-default Settlement Coordinator** whose worst-case power is
transient control of a single round's loser pool at payout time — never
standing balances, never active stakes, never outcomes (§13, §17).

Because there is no house, the economics are **zero-sum pools between
players**. This dissolves the solvency problem of the operator model: bots
cannot "beat the house" because there is none; pool-in equals pool-out minus
declared fees, structurally. Bots become a *fairness* problem (brackets,
skill pools — §15), not a solvency problem.

---

## 2. High-level architecture

```
                OPTIONAL / REPLACEABLE INFRASTRUCTURE
   Lobby & round discovery ── Matchmaking ── Leaderboard ── Indexer/Mirrors
                              │
              WebRTC signaling ── STUN / TURN
                              │
                        ROUND RELAY(s)                (time beacons, fan-out,
                              │                        registry streaming)
                     Verifier set (t-of-n)            (replay, preimage shares)
                              │
                 Settlement Coordinator (V1)          (LN node: hold invoices,
                              │                        pool payouts; bonded)
      ┌───────────────────────┼───────────────────────┐
      │                       │                       │
   PLAYER A                PLAYER B                PLAYER C   … PLAYER N
   Wallet A (NWC/QR)       Wallet B                Wallet C
      │                       │                       │
 Unity WebGL (render/UI) Unity WebGL            Unity WebGL
      │                       │                       │
 WASM deterministic sim  WASM sim                WASM sim      ← authoritative
      │                       │                       │           per player
      └─── signed entries, inputs, checkpoints, results ──┘
                              │
                   PARTICIPANT REGISTRY (append-only, MMR,
                   self-authenticated events, mirrorable)
                              │
                    Deterministic payout function
                              │
                     Bitcoin / Lightning settlement
```

No component above the player row can both determine a result **and** move
player funds. Most can do neither.

---

## 3. Providerless: definition and control questions (§58)

| Question | Answer |
|---|---|
| Who controls funds? | The player's own wallet until stake-in; then an in-flight HTLC that refunds by default. Loser stakes move only with t-of-n verifier shares. The V1 coordinator transiently handles the loser pool during payout (bounded, bonded, replaceable). |
| Who determines outcomes? | The deterministic WASM simulation, replayable by anyone from the signed transcript. Nobody *decides*; everybody can *check*. |
| Who changes rules? | Nobody, per round: the Round Contract is immutable once published. New rules = new round versions players opt into. |
| Who can admit/exclude participants? | Entry is permissionless given a valid signed Entry Contract + funded hold invoice. A lobby/relay can refuse service (availability), not invalidate a valid entry. |
| Who can stop joining? | Any infrastructure outage stops *new* joins (fail-closed, no money at risk). |
| Who can stop settlement? | Coordinator refusal delays winner payouts of one round (bounded grief, §13.5); refunds happen by HTLC expiry regardless. |
| Indispensable infrastructure? | None permanently: lobby, relay, coordinator, verifiers are replaceable roles defined by the protocol, not identities. |
| Mandatory fee recipient? | None protocol-wide. Fees are per-round line items declared in the Round Contract; players choose rounds (§18). |
| Who can shut the system down? | No single party. Disappearance of every V1 default service halts new rounds; running rounds refund by default; any party can stand up compatible replacements. |

---

## 4. Trust model (§57) — stated first, so the rest can be read against it

A player must trust:
1. **Bitcoin consensus** and, where used, **standard Lightning assumptions**
   (HTLC semantics, their own node/wallet's channel counterparties).
2. **Cryptographic primitives** (ed25519, SHA-256, Shamir/VSS, BLS for drand).
3. **Their own wallet** (keys never enter the browser page).
4. **The deterministic simulation build they verified or chose to accept**
   (reproducible, content-addressed — §21).
5. **The Round Contract and their own Entry Contract** they signed.

Residual trust, stated precisely (V1):
6. **Verifier threshold honesty (t-of-n)** for two powers only: releasing
   preimage shares of genuinely lost stakes, and refusing fraudulent
   transcripts. Collusion of ≥t verifiers + coordinator can steal *committed
   stakes of that round*; fewer cannot (§13.4).
7. **Settlement Coordinator liveness and honesty at payout time**, bounded to
   one round's loser pool in transit; misbehaviour is publicly provable from
   signed artifacts and covered by a published bond (§13.5).
8. **Time-beacon availability** (relay): affects liveness, never outcomes
   (§10.3).
9. **The web page loaded** is trusted at load time — a fundamental web
   limitation. The wallet's independent approval screen with per-round
   budgets is the real security boundary (§14, §22).
10. **drand** (or the Bitcoin-blockhash fallback) as an unpredictable public
    randomness beacon (§11).

A player does **not** trust: the lobby, matchmaking, signaling, STUN/TURN,
the relay (for truth), the leaderboard, the web host (beyond item 9), other
players, any house, any central ledger, any payout authority.

---

## 5. Unity WebGL reference client (§1, §5, §15, §18)

Hard constraint honoured: the game is 100% Unity WebGL in a normal browser.
No extension, daemon, node, or native software.

Division of labour inside the page:

- **Unity WebGL**: rendering, UI, input capture, audio, animation, ghosts,
  lobby screens. Unchanged product experience.
- **Deterministic core (Rust → WASM)**: all financially relevant state —
  vehicle movement, collisions with world objects, damage, AI/enemies,
  cargo, gates, delivery, timeout (§16 of the brief). Fixed-point
  arithmetic; no floats in financial state; no reliance on Unity
  PhysX/FixedUpdate for anything settled. Unity renders *from* core state
  (interpolated), never writes to it except via the input API.
- **JS bridge**: Unity ⇄ core ⇄ network ⇄ wallet links.

Browser constraints addressed explicitly:
- **Threads**: the core runs single-threaded; no SharedArrayBuffer/COOP/COEP
  requirement (keeps mirror hosting trivial).
- **Float determinism**: avoided entirely by fixed-point in the core; Unity's
  floats are cosmetic.
- **Background tabs / suspension / mobile lock / CPU throttling**: the sim
  may stall — the protocol treats missing checkpoint cadence deterministically
  (§12.4); a suspended tab cannot gain anything, it can only drift toward
  forfeit like any disconnect.
- **GC pauses / memory pressure**: core state ≤ ~32 MB, allocation-free tick
  loop; a GC pause shorter than the cadence tolerance is invisible.
- **Networking**: WSS to the relay (ordered, TLS) for protocol traffic;
  optional WebRTC DataChannels (unreliable mode) for ghost snapshots.
  Packet loss/ordering handled by tick-numbered, idempotent messages.
- **Reconnect**: the client can rebuild its own run by fetching its streamed
  input log back from the relay and replaying it locally (§12.5).
- Compatibility target: current Chrome, Firefox, Edge, Safari (WASM MVP +
  WebSocket + WebCrypto only — all universally available; WebRTC optional).

---

## 6. Protocol vs reference client (§44)

The **protocol** is: message formats, contracts, registry structure,
randomness derivation, transcript and checkpoint rules, verification rules,
payout function, settlement flows, dispute rules — everything in §§7–19.
Any compatible client (headless Rust client included) may participate.
The **Unity build** is one client. Protocol identity derives from
`(protocol_version, sim_wasm_hash)`, never from a domain (§21).

---

## 7. Rounds, lobby, and dynamic membership

### 7.1 Lobby (§5–6 of the brief)
The lobby is a discovery view over Round Contracts: upcoming and running
rounds, status (`WAITING / ACTIVE / CLOSING / SETTLING / FINAL`), committed
player count, stake bracket, payout curve, start condition, late-join policy,
elapsed time, leaderboard. The V1 lobby service is centralized and
**non-authoritative**: every fact it displays is a signed artifact (contracts,
registry events) that any replacement lobby can serve identically.

Player states: `OBSERVING → READY → ENTRY_SIGNED → STAKE_COMMITTED → ACTIVE`.
Only `STAKE_COMMITTED` has money at risk; disconnecting in any earlier state
is free (§12.1).

### 7.2 Round Contract (§9)
Immutable, published at creation, content-addressed (`round_id` = hash of the
contract):

```
RoundContract {
  round_id, protocol_version, sim_wasm_hash
  map_params            // mempool snapshot reference + derivation rules
  randomness_rules      // drand chain hash, epoch schedule, sub-seed formula
  schedule              // open_time, start_condition, epoch length,
                        // entry_close_tick, end_tick, max_duration
  late_join_policy      // enabled, per-epoch terms, T_run per entry
  tick_rate: 30 Hz      // checkpoint cadence 1 Hz, tolerance ±2 s
  stake_bracket         // fixed stake per entry, e.g. 100 sat (§15.2)
  payout_model          // qualification rule + rank curve + tie rules
                        //   + zero-qualifier rule (full refund)
  fee_schedule          // named recipients & pool percentages (§18)
  disconnect_rules      // neutral-input + cadence-forfeit definitions (§12.4)
  suspension_rules      // same as disconnect (explicitly)
  verifier_set          // n pubkeys, threshold t, bonds, share-release rules
  settlement_rules      // coordinator node id, hold-invoice params, CLTV,
                        //   claim windows, bond reference
  dispute_rules         // replay procedure, checkpoint bisection, deadlines
  registry_rules        // event schema, MMR parameters, mirrors
}
```

### 7.3 Player Entry Contract (§9)
Signed by the player's entry key; one per join, late joins included:

```
PlayerEntryContract {
  round_id, player_pubkey
  entry_epoch, join_tick
  stake, payment_hash          // hash of the player-generated preimage P
  vss_shares_ref               // P Shamir-shared to the verifier set (VSS,
                               //   encrypted per-verifier) — enables forfeit
  seed_commitment = H(s_p)     // player randomness secret (§11)
  vehicle, loadout, cargo_tier
  accepted: payout_model_hash, fee_hash, disconnect_rules_hash,
            sim_wasm_hash, protocol_version, max_payout
  session_pubkey               // per-run signing key, certified here
  signature
}
```

The two-contract split is what makes **late joining a first-class feature**:
the global contract never changes; membership grows by appending entries.

### 7.4 Start, epochs, late join (§7–8, §26–27)
- **Start condition** is deterministic and pre-published (e.g. fixed time, or
  "every 120 s", optionally `min_players`). No party discretionarily starts a
  round after seeing stakes.
- The round is divided into **entry epochs** (e.g. 60 s). An entry binds to
  the epoch in which its stake confirms. Entries close at
  `entry_close_tick = end_tick − T_run` so every entrant gets the full
  per-player mission duration `T_run` (e.g. 3 min) inside the round window.
- **Pool consent (§26)**: the Round Contract states *"all valid entries up to
  entry_close_tick contribute to and share one pool."* Every entrant signed
  that sentence — early players have consented to pool growth in advance.
  Nothing about an accepted entry is ever rewritten.
- Epochs also carry randomness (§11) and simplify accounting: per-epoch
  entry lists are MMR-batched.

### 7.5 Participant registry (§10)
An append-only event log: entries, seed reveals, checkpoint roots, terminal
results, verifier attestations, settlement records. Events are
**self-authenticating** (player- or verifier-signed), batched into a
**Merkle Mountain Range**; peaks are broadcast via the relay each second and
mirrored freely. A player holds inclusion proofs for their own events:
*"I joined round X at tick 2910 under exactly these terms"* is provable
against any mirror. Integrity comes from signatures + MMR, availability from
mirrors — there is no trusted database administrator to trust or to subvert.

---

## 8. Round-global vs player-private state; ghosts (§11–12, §39–40)

**Round-global (shared, small):** round_id, clock/beacons, map parameters
(derived from the referenced mempool snapshot), seed commitments, registry
peaks, leaderboard, status.

**Player-private (financial, per player):** vehicle state, damage, cargo,
their world's enemies, mission progress, inputs, result. Derived *only* from
(round statics, player sub-seed, own inputs) — never from other players.

**Ghost multiplayer** is preserved exactly as in the current game and does
the heavy lifting: no collisions, no pushing, no cross-player AI influence,
no shared physics. Ghost snapshots
`{pubkey, pos, rot, speed, tick, sig-or-relay-envelope}` (~30 B) flow at
5 Hz over the low-trust path, are interest-managed (each client subscribes to
~K = 20: nearby + leaderboard top), may be lossy/approximate, and **cannot
touch financial state by construction** — the deterministic core has no input
channel for them. The live leaderboard is likewise informational; final
payouts derive only from verified transcripts (§13.2).

---

## 9. Deterministic simulation and protocol tick (§16–17)

- Fixed protocol tick **30 Hz**; rendering FPS free.
- `result = Replay(sim_wasm_hash, round_statics, sub_seed, input_log)` —
  bit-identical everywhere, browsers and verifiers alike.
- Inputs are quantized and bound to tick numbers; the core refuses gaps
  (missing ticks auto-fill with the contract's neutral policy: throttle 0,
  steering decay, brake ramp — the same rule as the operator design, now a
  *contract term*).
- Historical sim versions are archived content-addressed; any old round
  replays forever (§21).

---

## 10. Authenticated transcripts (§19–21 of the brief)

### 10.1 Input stream
No per-packet signatures at 30 Hz. Instead: input batches (10 Hz, ~30 B) are
**hash-chained**; each 1 Hz **checkpoint** signs the chain head with the
session key:

```
Checkpoint {
  round_id, player_pubkey, tick
  state_hash                    // core state digest at tick
  input_chain_head              // binds every input since entry
  beacon_token                  // latest relay time beacon (§10.3)
  prev_checkpoint_hash
  session_signature             // ed25519, ~1 sig/s
}
```

≈150 B/s upstream. Inputs must be *published* (streamed via relay to mirrors/
verifiers) within a data-availability window (≤5 s); a transcript whose
inputs were withheld is unverifiable and forfeits by rule — withholding is
never an advantage.

### 10.2 Why rewriting is impossible
Once checkpoint `C_t` is relayed and folded into the registry MMR, every
input before `t` is frozen under the player's own signature. Discovering a
bad outcome at tick 3000 cannot un-say tick 2900.

### 10.3 Why time-cheating is impossible: beacons
Pure client-side simulation invites two attacks: **rewind scumming** (fork
from an old state, retry) and **bullet time** (run the sim slower than
reality to think). The relay defeats both without gaining authority:

- Every second the relay signs `Beacon{round_id, seq, unix_ms}` — content-
  free, outcome-blind — and fans it out.
- A checkpoint for tick `T` must embed a beacon with
  `|beacon.time − T/30| ≤ tolerance` and must *arrive* at the relay within
  the same window; the relay countersigns receipt into the registry stream.
- Consecutive checkpoints therefore sandwich each 1 s transcript segment in
  wall-clock time: it was computed live, once, at 1× speed (±2 s).
- Retrying is limited to the un-checkpointed last ≤1 s and shows up as a
  cadence gap, which the contract prices as neutral-input time.
- A malicious relay can *withhold* beacons (stall → §12.4 grace →
  round VOID → automatic refunds). It cannot forge a player's checkpoint
  signature nor bias any outcome. Multiple co-signing beacon relays are the
  V2 hardening (§20).

### 10.4 What client-side simulation concedes — stated honestly
With no server, **there is no per-player hidden randomness**: the client must
know every roll to simulate (§11). A strong bot can therefore
lookahead-simulate its own world during the run and approach `p → 1` for
delivery. In the operator model this was a solvency threat; here it is not:
**pools are zero-sum among players** (§15). The concession is a *fairness*
matter handled by brackets and skill pools, and it is the honest price of
removing the operator. (Mid-run lookahead is also throttled in practice by
the 1× beacon pacing — the bot must think in real time — but the design does
not *depend* on that.)

---

## 11. Randomness (§22–23)

Requirements: no operator to trust; late joiners neither choose their luck
nor abort after seeing it; everything verifiable afterwards.

```
round_seed    = H(RoundContract ‖ btc_blockhash_at_creation)
epoch_rand(e) = drand.round(scheduled_at_epoch_open(e))     // unpredictable
epoch_seed(e) = H(round_seed ‖ e ‖ epoch_rand(e))
sub_seed(p)   = H(epoch_seed(e_p) ‖ player_pubkey ‖ s_p ‖ join_tick)
```

- **drand** (League of Entropy) is a public, BLS-verifiable randomness
  beacon fetchable from a browser; fallback per contract: next Bitcoin block
  hash with coarser epochs. Either way: nobody in this protocol chooses it.
- `s_p` is committed (`H(s_p)` in the Entry Contract) **before** the entry's
  `epoch_rand` exists → the player cannot grind seeds; the operator cannot
  tailor them (there is no operator); the relay never touches randomness.
- **No abort advantage**: the stake is committed at entry; `epoch_seed`
  becomes known only after the epoch's entries close. Inspect-then-refuse is
  impossible; refusing to *play* after seeing the seed is just the neutral-
  input policy driving a parked truck (forfeit-shaped, §12.4).
- `s_p` must be revealed (in the terminal checkpoint at latest) or the
  transcript is unverifiable → forfeit. Refusal-to-reveal is never profitable.
- **Late-join asymmetry (§23)**: a late joiner has watched the round — but
  ghosts reveal *other players' worlds*, and per-player sub-seeds plus
  per-run enemy jitter mean their own world is fresh and unknown until they
  are already committed. Terrain is round-global and public to everyone
  equally from round start (same information at every entry time). Remaining
  asymmetry (meta-reads like "heat seems high today") is priced by the
  contract's late-entry terms: identical stake, identical `T_run`, entry
  closes `T_run` before round end. No entry-time multiplier exists to
  arbitrage because payouts are rank-based within the pool, and every
  qualifier played the same mission length under equally unknown seeds.

---

## 12. Liveness rules: disconnects, suspension, recovery (§32–34)

### 12.1 Before commitment
`OBSERVING/READY/ENTRY_SIGNED` (unfunded): disconnect = nothing. An entry
whose hold invoice is not funded by epoch close simply expires.

### 12.2 The one rule after commitment
**A transcript that stops is a result.** Missing inputs become neutral inputs
(deterministic in-sim braking); missing *checkpoints* beyond the cadence
tolerance end the valid transcript at the last accepted checkpoint. The
outcome is scored from that state — typically non-qualifying → the stake
feeds the pool. This single rule covers WebRTC drops, browser close, crash,
power loss, net loss, background tab, device sleep, intentional freeze, and
refusal to send input. There is nothing to distinguish, no ambiguity, and no
escape: **the stake was committed before the first financial tick, and
settlement needs no cooperation from the player** (verifier shares release it,
§13.4). Late-join-then-instant-disconnect (§33) is the same rule at a later
join_tick.

### 12.3 Finishing players
Delivery emits a terminal checkpoint (marked `TERMINAL`, containing the
delivery event, final score and `s_p` reveal) — sent *before* the client
celebrates. A player who closes the browser one frame after delivery has
already produced everything settlement needs.

### 12.4 Grace and VOID
Short gaps (≤ contract tolerance, e.g. 2 s) are neutral-input time. A relay/
beacon outage that exceeds the contract's liveness threshold (e.g. 60 s
without beacons) VOIDs the round: **all hold invoices simply expire →
everyone is refunded automatically, with no one's cooperation**. Fail-safe by
construction; the infrastructure dying can never take money.

### 12.5 Player-side recovery
The client streams its inputs out (§10.1); after a reload it fetches its own
log back from the relay, replays locally to the last checkpoint, and resumes.
Downtime ticks were neutral-input per rule — reconnect changes the future,
never the past.

---

## 13. Money: wallets, stake commitment, settlement (§24, §28–31)

### 13.1 Wallets — what actually works in a browser today
- **Nostr Wallet Connect (NWC)**: works extension-free in any browser over a
  websocket relay; supports `make_invoice` / `pay_invoice` with per-
  connection **budgets and permissions**. Primary path.
- **bolt11 QR / deep links**: universal fallback; any wallet can pay the
  stake invoice by scan. Payouts: player supplies an invoice (or NWC
  `make_invoice`) during the claim window.
- **WebLN** where an extension happens to exist — never required.
- The wallet seed never enters Unity, JS, WASM, lobby, relay, verifier, or
  another player. Authorizations are amount-limited, time-limited, revocable,
  and shown by the wallet's own UI — which is the trust boundary that a
  compromised web page cannot cross (§22 of the brief, §14 below).

### 13.2 The payout function is code, not a decision
`payouts = F(RoundContract, registry, EntryContracts, verified_results)` —
deterministic, replayable by anyone. Nobody chooses winners (§37 of the
brief). Result classes per player: `DELIVERED(score) / FAILED / FORFEIT`
(transcript-ended) — plus round-level `VOID`.

### 13.3 Stake-in: hold invoices with refund as the default
1. Player generates preimage `P`, puts `payment_hash = H(P)` in the Entry
   Contract, and Shamir-shares `P` (verifiable secret sharing, threshold t,
   encrypted per-verifier) into the registry.
2. The settlement node issues a **hold invoice** for `payment_hash`; the
   player's wallet pays it; the HTLC now sits **in-flight** — not in anyone's
   balance, not spendable by the coordinator, CLTV comfortably beyond
   round + verification + claim windows.
3. `STAKE_COMMITTED` is registry-recorded when the HTLC is held. Play begins
   only after this — "play first, refuse to fund later" cannot occur (§28).

### 13.4 Settlement outcomes
- **DELIVERED / qualifying**: verifiers attest the replay; the coordinator
  **cancels** the winner's HTLC (stake returns) and pays the pool share as a
  Lightning payment to the player's invoice during the claim window.
- **FAILED / FORFEIT**: ≥t verifiers, after replay (or after observing the
  transcript end), release their shares of `P`; the coordinator reconstructs
  `P`, **settles** the hold invoice — only now does the stake move — into the
  round pool. A loser cannot escape payment: the money left their wallet at
  entry, and claiming it needs nothing from them.
- **VOID**: nobody releases anything; every HTLC expires; every stake
  returns. The infrastructure cannot profit from failure — it cannot even
  *act* to profit from failure.

### 13.5 The V1 residual, exactly (§31)
The Settlement Coordinator is a well-known Lightning node named in the Round
Contract. It **cannot**: spend held HTLCs without verifier shares, fabricate
entries or signatures, alter contracts or results, or touch anything outside
its rounds. It **can**: refuse service (no new rounds), stall winner payouts,
and — the one real exposure — **abscond during the payout step with the loser
pool it just claimed** for one round. Bounds and remedies: pool sizes are
public and bracket-limited; the coordinator posts a **published bond ≥ max
concurrent pool**; every misbehaviour is provable from signed artifacts
(claimed HTLCs vs. unpaid winners); clients blacklist provably-bad
coordinators; coordinators are competitive and replaceable per round.
Collusion of coordinator + ≥t verifiers can steal active-round stakes — that
is the honest worst case, and shrinking `t`-collusion odds (open bonded
verifier sets) plus replacing the single node with a **threshold-signature /
federated settlement node (Fedimint-style guardians)** is the V2 path (§20).

### 13.6 Settlement scalability (§30)
For N players per round: N stake HTLCs in, ≤N payout payments out, **zero
on-chain transactions in the normal path**. 1,000 × 100 sat round = 100k sat
inbound liquidity — trivial; brackets keep liquidity needs predictable.
Payouts are aggregated per rank-curve bucket where possible, retried across
routes, and claimable for a long window (e.g. 30 days); routing failure is a
delay, not a loss (§16). Dust floor: stakes ≥ bracket minimum (e.g. 50 sat)
keep HTLCs routable. On-chain appears only in disaster recovery of the
settlement node itself — standard Lightning force-close mechanics.

---

## 14. Distribution, builds, versioning, compromised hosts (§42–43, §45, §51)

- The client is **static assets** (index.html, loader, Unity build, sim
  WASM, protocol config) servable from the official site, mirrors, community
  hosts, IPFS gateways, or localhost. Protocol identity =
  `(protocol_version, sim_wasm_hash)`, not a domain.
- The **sim core is reproducibly buildable** (pinned Rust toolchain,
  `cargo --locked`, deterministic WASM output); anyone can go
  source → build → hash → compare with the Round Contract. Historical
  versions stay archived for replay. The Unity build is content-addressed and
  manifest-signed as a whole (bit-reproducibility of Unity itself is not
  promised — the *financial* layer is the WASM, and that one is).
- **No privileged admin key exists** (§45): nothing can alter active rounds,
  seize funds, rewrite results, or force-upgrade clients. Versions coexist;
  players accept a version by signing an entry that names it.
- **Compromised web host** (§51): it can serve a lying page — phishing-grade
  power, not fund-seizure power. Defenses: published hashes + signed release
  manifests + mirrors for the diligent; **wallet-side budgets and the
  wallet's own approval UI** for everyone (a fake page can request at most a
  stake-sized, round-bound payment, visibly). It cannot forge entries,
  results, or settlements for existing funds.

---

## 15. Economics without a house (§25–27, §37–38, §48–49)

### 15.1 Model choice
Evaluated: (A) shared round pool, (B) success pool, (C) peer-backed markets,
(D) stake brackets. **Chosen: B inside D — a success pool within fixed-stake
brackets — with A's rank curve for distribution.**

- **Fixed stake per bracket-round** (10 / 100 / 1,000 sat rounds): keeps the
  pool zero-sum and symmetric, kills stake-size gaming, simplifies liquidity
  and settlement, and gives players self-selected risk tiers.
- **Pool** = Σ stakes of `FAILED` + `FORFEIT` entries.
- **Qualification** = `DELIVERED` with score ≥ contract minimum.
- **Distribution** = rank curve over qualifiers' scores (e.g. exponential
  weights over ranks; ties split); qualifiers *also* get their own stake back
  (HTLC cancel). Zero qualifiers ⇒ full refund round (declared in contract).
- Scores are time-normalized by construction: every entry plays the same
  `T_run` (§7.4), scored by the same deterministic function (delivered value,
  exposure, time) — early and late entrants compete on identical missions.

**Solvency is structural**: payouts are a partition of collected stakes minus
declared fees. There is no bankroll to drain, no RTP to miscalibrate, no
quote to arbitrage. The entire Quote-Engine/UCB apparatus of the operator
design becomes unnecessary — it existed to protect a house that no longer
exists.

### 15.2 Skill and bots (§49) — the honest reframing
Bots take money from *players*, not from a house. So the controls are
fairness controls:
- **Brackets** already separate casual sats from serious sats.
- **Skill pools**: rounds may declare entry gates from a public, replayable
  rating (Glicko-2 over verified results — computable by anyone from the
  registry, no trusted rater). Smurfing/Sybil newcomers start in open pools;
  rating gates are advisory floors, not identity claims.
- **Declared-bot rounds**: explicitly bot-welcome pools (compute
  competitions) drain optimizers away from casual pools.
- **Collusion/Sybil** (§53): ghosts cannot touch each other, so in-round
  collusion yields nothing mechanical; N Sybils = N stakes = N chances —
  splitting a bankroll buys no edge (no bonuses exist). Residual: rating
  manipulation via feeder accounts — mitigated by rating-from-verified-
  transcripts only, and accepted as imperfect. Bot detection is **not**
  assumed to work.
- Perfect play (§10.4) concentrates winnings among the best agents per pool
  — visible in public results, self-correcting via pool choice: humans
  migrate to gated pools; a pool full of bots is bots eating bots.

### 15.3 Fees (§48)
Per-round line items in the Round Contract, skimmed from the pool at
settlement to named pubkeys: relay fee, verifier fees, coordinator fee,
optional client-developer tip (default-on, removable). Players price rounds
by their fee schedules; anyone can run cheaper infrastructure. No mandatory
protocol-wide recipient; no fee key with any control power.

### 15.4 Finality (§38)
`end_tick` → verification window (e.g. 10 min: replays + attestations) →
challenge window (fraud proofs, §17) → `FINAL`: payout set immutable, claim
window opens (30 days), unclaimed remainders per contract (donation address /
rollover — declared up front).

---

## 16. Failure matrix (§54)

| Failure | Effect | Classification |
|---|---|---|
| Lobby down before round | No discovery; running rounds unaffected | JOIN IMPOSSIBLE |
| Lobby down after start | Cosmetic | NO IMPACT |
| Matchmaking down | Manual round selection still works | DEGRADED |
| Signaling/STUN/TURN down | Ghosts degrade or vanish; finances untouched | DEGRADED |
| Relay down < threshold | Beacon gap ⇒ neutral-input grace | DEGRADED |
| Relay down ≥ threshold | Round VOID ⇒ HTLC expiry | REFUND |
| Verifiers unavailable | Settlement waits; refund at CLTV if permanent | SETTLEMENT DELAY → REFUND |
| One browser crashes | That transcript ends | PLAYER FORFEIT |
| Many browsers crash | Many forfeits; round proceeds | PLAYER FORFEIT (each) |
| Network partition (player side) | As disconnect | PLAYER FORFEIT |
| Wallet unavailable at entry | Entry unfunded, expires | JOIN IMPOSSIBLE |
| Wallet unavailable at payout | Claim window (30 d) | SETTLEMENT DELAY |
| Lightning route fails (stake) | Entry not committed | JOIN IMPOSSIBLE |
| Lightning route fails (payout) | Retry within claim window | SETTLEMENT DELAY |
| Coordinator vanishes pre-claim | Nothing claimable; HTLCs expire | REFUND |
| Coordinator vanishes mid-payout | Bounded loss = that round's pool; bond/blacklist | SETTLEMENT DELAY / bounded loss (§13.5) |
| Bitcoin fee spike | Off-chain protocol unaffected (CLTV margins sized) | NO IMPACT |
| Late join during outage | Entry can't commit | JOIN IMPOSSIBLE |

No ambiguous monetary states: every cell ends in REFUND, FORFEIT, DELAY, or
bounded-and-attributable loss.

---

## 17. Verification and disputes (§35–36)

- **Verifier** = anyone running the open replayer: fetch transcript
  (contract, sub-seed, input log, checkpoints), replay WASM, compare state
  hashes, sign an attestation. No custody, no outcome creation.
- **Round verifier set**: named in the contract (V1: a default set of
  independent operators with published bonds; V2: open registration, random
  per-round selection weighted by bond, threshold signatures).
- **Disputes are player-specific** (ghost isolation) and mechanical:
  attestation mismatch ⇒ binary-search the 1 Hz checkpoints to the first
  divergent second ⇒ replay 30 ticks ⇒ the signed inputs either produce the
  signed state hash or they do not. A transcript that fails replay, breaks
  cadence, or withholds data ⇒ FORFEIT by rule. Verifier-vs-verifier
  disagreement beyond t ⇒ round VOID (refund) — the safe direction.

### Threat model (§53, condensed to the decisive columns)

| Threat | Capability | Impact | Prevention / Detection | Recovery / Residual |
|---|---|---|---|---|
| Malicious player, modified client/WASM, bots, CV, input automation | Anything client-side | Plays well | Nothing client-side is trusted; transcripts + replay decide | Residual: skill/fairness (§15.2) |
| Input rewriting after outcome | Fork own past | Would forge wins | Checkpoint chain + MMR + beacon receipts freeze the past | None |
| Fake checkpoints / sim divergence | Publish wrong hashes | Would forge wins | Deterministic replay catches at first divergent tick | Forfeit; none |
| Time cheating (rewind / slow-mo / suspension) | Local clock control | Superhuman play | Beacon sandwich + cadence rules (§10.3) | ≤1 s retry residue, priced as neutral time |
| Seed manipulation / grinding | Choose entries | Favorable worlds | Commit `s_p` before epoch_rand exists; stake precedes seed | None |
| Refusal to reveal `s_p` / withhold inputs | Withhold data | Block verification | Reveal-or-forfeit; data-availability window | None |
| Late-entry arbitrage | Join informed | Edge over early | Fresh sub-seeds, equal `T_run`, rank scoring, entry cutoff (§11) | Meta-information residue, accepted |
| Pool manipulation via Sybil/collusion | Many entries | Shift distribution | Zero-sum + ghost isolation ⇒ no mechanical gain; no bonuses | Rating-manipulation residue (§15.2) |
| Disconnect attacks | Kill own feed | Escape a loss | Transcript-stops-is-a-result + pre-committed stake (§12.2) | None |
| Ghost spoofing | Fake visuals | Mislead humans | Signed/relay-enveloped snapshots; zero financial coupling | Cosmetic only |
| Replay of old messages | Re-send traffic | Duplicate events | Tick/seq numbers, idempotent registry, single-use payment_hash | None |
| Settlement refusal by loser | Do nothing | Keep stake | Stake already in-flight; verifier shares claim it (§13.4) | None |
| Double-spend of stake | LN tricks | Fake funding | Stake = held HTLC, not a promise | Standard LN assumptions |
| Malicious lobby/matchmaking/signaling/TURN/leaderboard | Serve lies, censor | Availability, phishing UX | Non-authoritative; signed artifacts; replaceable | Censorship → use another instance |
| Malicious relay | Withhold/delay beacons & traffic | Stall, selective grief | Cannot forge signatures or outcomes; VOID⇒refund on outage | Liveness only; multi-relay in V2 |
| Malicious verifier(s) < t | Wrong attestations | Noise | Threshold + bonds + anyone-can-replay fraud proofs | Slash/blacklist |
| Verifier collusion ≥ t (+coordinator) | Release shares wrongly | **Steal active stakes of a round** | Bonds, open set, public provability | The stated V1 worst case (§4.6) |
| Coordinator theft at payout | Abscond with one pool | Bounded loss | Bond ≥ pool, public proof, blacklist, replaceability | §13.5 residual |
| Compromised website/CDN, DNS seizure | Serve malicious build | Phish stakes | Hashes/manifests/mirrors; wallet budgets & approval UI | Bounded to approved amounts |
| DDoS during rounds | Kill infra | Stall rounds | VOID ⇒ automatic refunds; no EV for attacker | Availability only |
| Protocol fragmentation | Incompatible forks | Split liquidity | Versioned contracts; players sign what they accept | Social, not financial |

---

## 18. Scalability (§41, §53)

Per player: **up** ≈ 400 B/s (inputs 300 B/s + checkpoint 150 B/s amortized +
ghost 150 B/s); **down** ≈ 3–4 KB/s (K = 20 ghosts at 5 Hz + beacons +
registry peaks). Independent of N — interest management, never full mesh.

Relay, 1,000-player round: ingest ≈ 0.6 MB/s, egress ≈ 3.5 MB/s, plus
registry streaming to verifiers/mirrors ≈ 0.5 MB/s — one modest server;
regional relays shard by subscription, not by authority. 10,000 players
across rounds = horizontal relay instances.

Registry per 1,000-player round: entries ~0.4 MB, checkpoints ~19 MB
(600 s × 32 B × N), inputs ~180 MB streamed but only MMR roots retained
hot; full logs archived to cheap storage for the challenge window, then
prunable to roots + terminal proofs.

Verifier workload: replay = faster-than-realtime headless WASM (≥20× RT
budgeted) ⇒ one core verifies ~20 player-runs per elapsed run; sampling +
fraud-proof fallback means full verification of every transcript is only
needed on dispute or for forfeit share-release quorums.

Settlement: ≤2 LN operations per player per round (§13.6).

---

## 19. Infrastructure matrix (§46–47)

| Component | Required? | Centralizable? | Custody? | Can steal? | Decides result? | Blocks join? | Blocks play? | Blocks settlement? | Replaceable? | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|
| Unity WebGL host | yes* | yes | no | no² | no | yes | no | no | yes | mirrors/IPFS/local |
| CDN | no | yes | no | no² | no | yes | no | no | yes | any host |
| Lobby | no | yes | no | no | no | yes | no | no | yes | direct round_id entry |
| Matchmaking | no | yes | no | no | no | yes | no | no | yes | manual choice |
| Signaling | no | yes | no | no | no | no | ghosts only | no | yes | relay-fanout ghosts |
| STUN/TURN | no | yes | no | no | no | no | ghosts only | no | yes | relay-fanout ghosts |
| Round relay | yes (per round) | yes | no | no | no | yes | stall⇒VOID | no | yes (per round) | VOID ⇒ refund |
| Leaderboard | no | yes | no | no | no | no | no | no | yes | registry-derived |
| Indexer/mirror | no | yes | no | no | no | no | no | no | yes | any mirror |
| Verifier set | yes (per round) | partly | no | ≥t collusion³ | attests only | no | no | delays | yes (per round) | CLTV refund |
| Bitcoin | yes | no | n/a | no | no | no | no | ultimate settlement | n/a | n/a |
| Lightning infra | yes | partly | in-flight only | no | no | funding path | no | delays | yes | retry/other routes |
| Settlement coordinator | yes (V1, per round) | yes | transient pool³ | one pool³ | no | yes (new rounds) | no | delays | yes (per round) | refund-by-expiry |

\* some host, any host. ² phishing-grade only, bounded by wallet budgets.
³ the stated residuals (§4.6–7, §13.5).

**Decentralization-theater check (§47)**: for every row, "if malicious" is
answered above; no row can both fabricate a result and move funds; every row
is replaceable; permanent disappearance of all defaults halts *new* rounds
and refunds running ones.

---

## 20. V1 and V2 (§55–56)

**Pragmatic V1 (buildable now):** one official site + mirrors; one default
lobby/matchmaking; one relay per round (beacons + fan-out + registry
streaming); public STUN, a few TURN servers; a default verifier set (5
independent operators, t = 3, published bonds); one bonded settlement
coordinator per round; NWC + QR wallets; drand randomness; the full
transcript/replay machinery. Everything in this document except items below.

**Decentralized V2 (real technology, staged):** multiple lobby providers and
round discovery over Nostr; multi-relay beacon co-signing; open bonded
verifier registration with per-round random selection and threshold (FROST)
attestation signatures; **federated settlement** (Fedimint-style t-of-n
guardians or a threshold-Schnorr LN node) replacing the single coordinator —
this removes residual §4.7 almost entirely; content-addressed client
releases as default (IPFS); rating and reputation derived purely from the
registry. **Experimental, flagged as such:** PTLC/adaptor-signature stake
conditioning (binds HTLC claims cryptographically to attestation signatures
— removes the verifier-share reconstruction step), and N-party pooled DLCs
per epoch (on-chain funding per epoch; conflicts with 100-sat stakes and
browser liveness today).

**Current technical limitations, plainly (§56/§61):**
1. Browser-only trustless N-party settlement does not exist → V1 coordinator
   residual (§13.5).
2. No hidden per-player randomness without a server → bots reach ~p_max ≈ 1;
   harmless to solvency (zero-sum), handled as fairness (§15.2).
3. Time integrity requires an external beacon → relay liveness dependency
   (VOID⇒refund on failure).
4. The loaded web page is axiomatically trusted at load → wallet budgets are
   the boundary.
5. drand/blockhash beacons are external dependencies (replaceable, verifiable).

---

## 21. Complete round lifecycle (§60)

| # | Step | Message / artifact | Guarded by | On failure |
|---|---|---|---|---|
| 1 | Open game | static assets | hashes/manifest | try mirror |
| 2 | Verify build/protocol | manifest sig, `sim_wasm_hash` | reproducible build | refuse to stake |
| 3 | Connect wallet | NWC pairing (budgeted) or QR mode | wallet UI | QR fallback |
| 4–5 | Lobby, discover rounds | RoundContracts (signed, content-addressed) | signatures | direct round_id |
| 6 | Pick round + stake | — | — | — |
| 7 | Receive Entry Contract draft | contract fields incl. `H(s_p)`, payment_hash, VSS refs | client-side generation | abort free |
| 8 | Sign entry | ed25519 entry sig; session key certified | player key | abort free |
| 9 | Commit stake | wallet pays **hold invoice**; HTLC held | LN; CLTV window | entry expires |
| 10 | Registry inclusion | entry event + MMR proof to player | signatures + MMR | re-submit via mirror |
| 11–12 | Wait; start condition fires | beacons; deterministic schedule | contract | VOID⇒refund |
| 13 | Committed players start | epoch_seed = H(round_seed‖e‖drand) | drand verifiability | fallback blockhash |
| 14–15 | Play: inputs + deterministic sim | 10 Hz input chain; 30 Hz core | §10 | neutral-input rule |
| 16 | Ghost distribution | 5 Hz snapshots via relay | non-authoritative | cosmetic loss |
| 17–20 | Late joins (until entry_close) | new Entry Contracts, own epochs/sub-seeds | §7.4, §11 | JOIN IMPOSSIBLE |
| 21 | Finish/fail/timeout | terminal checkpoint (+`s_p` reveal) | §12.3 | forfeit rule |
| 22 | Verification window | verifier attestations (≥t) into registry | replay | delay → CLTV refund |
| 23 | Finalization | challenge window closes; payout set = F(...) | §15.4 | fraud proof reopens |
| 24 | Allocation computed | deterministic function, anyone can recompute | code | dispute = replay |
| 25 | Cooperative settlement | cancel winners' HTLCs; settle losers' via shares; pay pool shares | §13.4 | retries |
| 26 | Non-cooperative paths | loser absent: shares claim anyway; winner absent: 30 d claim; infra absent: CLTV refund | §13.4–5 | bounded §13.5 |
| 27 | Permanent replayability | archived transcripts + WASM versions | content addressing | mirrors |

## 22. Walkthrough: Round #92831 and Alice (§61)

12:00:00 — the contract for #92831 (100-sat bracket, epochs 60 s,
`T_run` = 3 min, end 12:10, entry close 12:07) is public. 50 in lobby, 37
committed (held HTLCs, registry entries at join_tick 0). 13 observers risk
nothing. 12:00:30 — start condition fires; epoch-0 seed =
H(round_seed ‖ 0 ‖ drand@12:00:30); 37 transcripts begin under beacon
cadence. They see each other as ghosts; none can touch another.

12:01:15 — **Alice** opens the game, sees #92831 ACTIVE with late join
enabled. She picks 100 sat, generates preimage `P_A` and secret `s_A`, signs
her Entry Contract (join epoch 1, `H(s_A)`, `H(P_A)`, VSS shares of `P_A` to
the 5 verifiers, accepted payout/fee/disconnect hashes), and her wallet —
via NWC with a 100-sat budget — pays the hold invoice. Her HTLC is held; her
entry event and MMR proof land in the registry: **committed, irrevocably,
before she has seen her world.** At 12:02:00 epoch-1's drand value exists;
her `sub_seed = H(epoch1_seed ‖ pk_A ‖ s_A ‖ join_tick)`; her WASM sim
initializes; she must reach checkpoint cadence within the contract's start
window. Ghosts of the 37 render around her; her enemies are hers alone.

She delivers at 12:04:40: terminal checkpoint with delivery event, score, and
`s_A` reveal — signed, relayed, registered. One player disconnects while
losing at 12:03 and never returns: his transcript ends at his last
checkpoint; rule §12.2 scores it FORFEIT; nobody needs him again — his
stake's preimage shares sit with the verifiers. Another winner closes her
browser a second after her terminal checkpoint: nothing else was needed.

12:07 entries close (pool now fixed: say 61 entries → 6,100 sat). 12:10 the
round ends. Verification window: verifiers replay transcripts (or sample +
respond to challenges); ≥3-of-5 attest each result. Suppose 24 DELIVERED, 31
FAILED, 6 FORFEIT → pool = 3,700 sat; fees (2% relay+verifier+coordinator,
declared) = 74; distributable 3,626 across the rank curve. Alice ranks 7th →
curve weight say 5.1% → 185 sat. Settlement: her held 100 sat HTLC is
**cancelled** (stake back), and 185 sat arrive via Lightning to the invoice
her wallet issues on NWC `make_invoice`. Losers' invoices are settled with
reconstructed preimages; their 100 sat each fund the pool — none of them can
prevent it.

**If Lightning routing fails** for Alice's payout: retried across routes for
the 30-day claim window; her stake-refund (HTLC cancel) is unaffected.
**If the Round Relay dies at 12:05**: beacons stop; after the 60 s liveness
threshold the round is VOID; nobody releases any preimage share; every held
HTLC — all 61 — expires and refunds automatically. The failure mode of the
whole infrastructure is *everyone gets their money back*.

---

*Cross-reference to the required deliverable list (§63): items 1–4 → §§1–4;
5 → §5; 6 → §7.1; 7–13 → §7; 14 → §8; 15–16 → §8; 17–18 → §9; 19–23 → §5,
§10.3, §2; 24–25 → §13.1, §13.3; 26–27 → §11; 28–29 → §10; 30 → §8;
31–32 → §12; 33 → §17; 34 → §15.4; 35–37 → §15; 38–39 → §13; 40–41 → §17;
42–43 → §13; 44 → §15.3; 45 → §19; 46–48 → §14; 49 → §4, §15.2 (privacy:
pseudonymous keys throughout; WebRTC IP leakage avoided by relay-fanout
ghosts by default, TURN optional; wallet correlation minimized by per-round
invoices; no perfect anonymity claimed); 50 → §15.2; 51 → §17; 52 → §16;
53 → §18; 54–55 → §20; 56 → §20; 57 → §4; 58 → §22.*
