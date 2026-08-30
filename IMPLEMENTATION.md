# BLWP Implementation Plan

Written 2026-08-30. This is the build plan for the **providerless P2P
protocol** specified in `multiplayer_p2p.md`, starting from the existing
Unity WebGL single-player game (live at btc-logistics-war.pages.dev, 103
passing PlayMode tests).

It deliberately does **not** implement the operator model of
`MULTIPLAYER.MD` v2: the quote engine, UCB pricing, settlement authority and
wallet-daemon stack existed to keep a house solvent, and the P2P design has
no house. The two specs share exactly one component — the deterministic
simulation core — and that is where this plan starts.

---

## 1. Strategy

Four rules govern the ordering:

1. **Highest-risk first.** The deterministic Rust/WASM core is the
   foundation of gameplay, verification, settlement and disputes at once. If
   fixed-point determinism across browsers fails, nothing else matters —
   so it is Phase 0, not Phase 3.
2. **Playable at every milestone.** The current game keeps working
   throughout; each phase ships something a player can touch. No six-month
   dark tunnel.
3. **Play-money until Phase 6.** Every protocol mechanism — transcripts,
   relays, verifiers, disputes, even "settlement" — runs and soaks on
   play-money rounds before a single real sat is staked.
4. **The test discipline of this repo continues.** This project's history is
   a catalogue of "code correct, thing broken" bugs caught only by measuring
   (pixel tests, corner probes, frame diffs). The protocol gets the same
   treatment: golden replays, cross-browser hash comparisons, chaos tests —
   never "it compiles, ship it".

---

## 2. Target repository layout

```
btc-logistics-war/
  unity-proto/            existing Unity client (rendering, UI, audio)
  core/                   Rust workspace
    blwp-sim/             deterministic simulation (fixed-point, no_std-ish)
    blwp-proto/           message/contract types, signatures, MMR, serialization
    blwp-replayer/        headless verifier/replay binary (native)
    blwp-wasm/            wasm-bindgen wrapper exposing sim + proto to the browser
  services/
    relay/                round relay: beacons, fan-out, registry streaming (Rust, axum/tokio)
    lobby/                round discovery + contract publication (thin, stateless)
    verifier/             attestation service wrapping blwp-replayer
    coordinator/          settlement node glue (LND/CLN + hold invoices + VSS)
  contracts/              round contract templates, fee schedules, versioned
  tools/                  input recorder, transcript inspector, load bots
  docs/                   MULTIPLAYER.MD, multiplayer_p2p.md, this file
```

---

## 3. Phases

### Phase 0 — Deterministic core (the hard part)

**Goal:** `result = Replay(sim_hash, statics, seed, inputs)` — bit-identical
on native x86/ARM and WASM in Chrome, Firefox, Safari, Edge.

Tasks:
- Port the financial game rules from C# to `blwp-sim` in fixed-point (i32.16
  or i64.32): terrain heightfield from mempool snapshot (`MempoolTerrain`),
  road surface (`RoadNetwork.SurfaceHeight`), simplified vehicle model
  (replaces WheelCollider *outcomes*; a bicycle-model with the tuned
  handbrake/grip behaviour), armies (`Army.cs` is already pure logic — the
  one lucky break), heat/targeting, damage, cargo, gate, round clock.
- PRNG: single splitmix64-style stream per sub-seed; every roll drawn in a
  defined order (document the order — replay depends on it).
- 30 Hz tick, allocation-free step function, state-hash function (blake3 of
  canonical state serialization).
- `blwp-wasm` build: no threads, no SIMD initially (Safari), `--locked`
  reproducible build, content hash published by CI.

Exit criteria (measured, not asserted):
- 10-minute synthetic input log → identical state hash every 100 ticks,
  native vs WASM, across 4 browsers × 2 OS. Zero divergence.
- Replay speed ≥ 20× realtime native, ≥ 3× realtime in-browser.
- Fuzz: 10k random 60 s input logs, native-vs-WASM hash equality.

Risks: fixed-point vehicle feel differs from PhysX (accepted — Phase 1 gates
on feel sign-off); Safari WASM quirks (no threads/SIMD keeps us on MVP
features on purpose).

### Phase 1 — Unity renders the core

**Goal:** the existing game, visually unchanged, with financial state driven
by `blwp-wasm` instead of PhysX.

Tasks:
- JS bridge: Unity → inputs → core; core state → Unity interpolation layer.
- Unity keeps cosmetic suspension/roll; positions, damage, delivery, heat
  and clock come from core state.
- Keep the 103-test PlayMode suite green where it applies; port the
  outcome-relevant tests (crash writes off, gate banks, heat targeting) into
  Rust unit tests against `blwp-sim`.
- Record/replay tool: capture input logs from live play for use as golden
  corpus everywhere downstream.

Exit criteria: playable build; **driving-feel sign-off by the owner** (this
is a taste gate, explicitly); replay of a recorded session reproduces the
same score.

### Phase 2 — Transcripts

**Goal:** every run produces the authenticated transcript of the spec (§10).

Tasks: session keys (WebCrypto ed25519), input hash-chain (10 Hz),
checkpoints (1 Hz, signed), terminal checkpoint with seed reveal, local
transcript store, `blwp-replayer` verifies a transcript end-to-end,
data-availability framing (inputs streamed out within ≤5 s).

Exit criteria: tamper tests — flip any input bit, any checkpoint, reorder
any batch → replayer rejects with the exact divergent tick; honest
transcript verifies in < run-time/20.

### Phase 3 — Relay, registry, ghost multiplayer (play money)

**Goal:** first real multiplayer rounds, no money.

Tasks:
- `relay`: WSS, time beacons (1 Hz signed), checkpoint receipt
  countersigning, ghost fan-out with interest management (K≈20),
  registry event stream + MMR peaks, per-round rooms.
- Registry archive: append-only log + MMR proofs, mirror endpoint.
- Unity: lobby screen (rounds from `lobby` service), ghost rendering from
  snapshots (the ghost art already exists), live leaderboard.
- Disconnect semantics exactly per spec §12: cadence tolerance, neutral-
  input fill, transcript-stops-is-a-result, client self-recovery by
  replaying its own log from the relay.
- Beacon liveness → VOID path (play-money: round simply annulled).

Exit criteria: 20-browser play-money round end-to-end; kill one client
mid-run → FORFEIT scored deterministically; kill the relay → round VOIDs;
reload a client mid-run → resumes from own log; beacon sandwich test — a
client running the sim at 0.5× or forking its last second is rejected by
cadence/receipt rules.

### Phase 4 — Contracts, randomness, epochs, late join

**Goal:** rounds are governed by signed artifacts, not server config.

Tasks: RoundContract + PlayerEntryContract types in `blwp-proto`
(content-addressed, signed); entry state machine
(OBSERVING→…→STAKE_COMMITTED with a play-money stub for the stake step);
drand client (verify BLS) + Bitcoin-blockhash fallback; epoch scheduler;
sub-seed derivation with `H(s_p)` commitment; entry close at
`end_tick − T_run`; scoring/payout function `F` as a pure library shared by
client, verifier and coordinator.

Exit criteria: property tests on `F` (partition exactness: pool in = pool
out + fees, tie handling, zero-qualifier refund); commit-before-seed test —
an entry created after epoch_rand publication is rejected; late-join
walkthrough (spec §22) executed on play money, including
late-join-then-instant-disconnect.

### Phase 5 — Verifiers and disputes

**Goal:** results become attested facts.

Tasks: `verifier` service (subscribe → replay → sign attestation → registry);
t-of-n aggregation; sampling policy + full replay on dispute; checkpoint
bisection tooling; fraud-proof path (publish divergent tick + inputs);
verifier bonds as registry records (slashing = social/blacklist in V1,
documented as such).

Exit criteria: seeded-fraud drill — a deliberately falsified transcript in a
100-player play-money round is caught, bisected to the exact tick, and
forfeited automatically; honest load: 3 verifiers keep up with a 100-player
round in ≤ 2× round duration.

### Phase 6 — Money (the gated phase)

**Goal:** real sats at the smallest bracket, with the V1 residual exactly as
specified and no wider.

Tasks:
- Wallets: NWC pairing (budget-scoped) + bolt11 QR fallback; payout invoice
  collection (NWC `make_invoice` or paste).
- `coordinator`: LND or CLN with hold invoices (LND `invoicesrpc` supports
  this today); stake-in flow (player-generated preimage, payment_hash into
  entry, VSS shares encrypted to verifier set); settle/cancel per outcome;
  claim-window payout executor with route retries; CLTV margins sized to
  round + verification + claim windows.
- VSS: Feldman shares over ed25519-compatible field in `blwp-proto`;
  verifier share-release endpoint gated on attested FORFEIT/FAILED.
- Coordinator bond: published on-chain address + signed statement in the
  Round Contract; abscond-proof kit (tooling that assembles the evidence
  bundle from registry + LN data).
- **Gates before first real round:** external review of the
  preimage/VSS/hold-invoice flow; legal review sign-off (spec §10 note —
  out of my scope, on the checklist by name); kill-switch runbook.

Exit criteria: 10-sat-bracket round with real wallets on mainnet, ≤ 20
players, run end-to-end twice: once clean, once with a forced coordinator
restart mid-payout (payouts resume from durable state); a VOID drill on
mainnet: relay stopped → **every HTLC observed to auto-refund at expiry**.

### Phase 7 — Hardening and scale

Load tests with `tools/` input bots at 100 → 1,000 players per round
(relay ingest/egress, registry growth, verifier lag — targets from spec
§18); chaos suite (kill relay/verifier/coordinator at every lifecycle step,
assert the failure-matrix cell); reproducible-build CI publishing
`sim_wasm_hash` + signed manifests; mirror deployment (second host + IPFS
snapshot); soak: one week of scheduled play-money rounds alongside real
small-bracket rounds.

---

## 4. Cross-cutting

- **CI:** every commit — Rust tests, native-vs-WASM hash equality on the
  golden corpus, Unity PlayMode suite, contract/payout property tests.
  Release tags — reproducible WASM build, hash into `contracts/`.
- **Versioning:** `sim_wasm_hash` is the protocol-critical identity; core
  changes bump it; old versions archived from Phase 0 onward (the archive is
  a Phase-0 deliverable, not an afterthought).
- **Telemetry:** none beyond what the registry already is; the registry *is*
  the analytics, and it is public by design.

## 5. Risk register (top 6)

| Risk | Phase | Mitigation |
|---|---|---|
| Fixed-point driving feels wrong | 0–1 | Feel gate with the owner; tune bicycle model against recorded PhysX runs; cosmetic suspension stays in Unity |
| Browser WASM nondeterminism (Safari) | 0 | MVP feature set only; hash-equality CI on real browsers via Playwright |
| NWC wallet coverage too thin for users | 6 | QR/bolt11 fallback is first-class, not an afterthought |
| Hold-invoice CLTV vs round+claim windows | 6 | Short rounds first; explicit CLTV budget in RoundContract; tested VOID expiry on mainnet |
| Verifier set too small/colluding at launch | 5–6 | Start with named independent operators + bonds; keep brackets tiny until set grows |
| Scope creep from the operator spec | all | This plan implements `multiplayer_p2p.md` only; MULTIPLAYER.MD v2 machinery is explicitly out |

## 6. Effort (rough, honest ranges; one experienced dev + the owner)

| Phase | Estimate |
|---|---|
| 0 Core | 4–7 weeks (the long pole) |
| 1 Unity integration | 2–3 weeks |
| 2 Transcripts | 1–2 weeks |
| 3 Relay/ghosts | 3–4 weeks |
| 4 Contracts/randomness | 2–3 weeks |
| 5 Verifiers/disputes | 2–3 weeks |
| 6 Money | 3–5 weeks (+ external review latency) |
| 7 Hardening | 2–4 weeks |
| **Total** | **~5–7 months** to first real-sat rounds |

## 7. V2 backlog (post-launch, from spec §20)

Multi-relay beacon co-signing → open bonded verifier registration with FROST
threshold attestations → federated settlement (Fedimint-style guardians)
replacing the single coordinator → Nostr round discovery → content-addressed
client releases as default → PTLC/adaptor-signature stake conditioning
(experimental).

## 8. Decisions needed from the owner (blocking at the marked phase)

1. Bracket sizes and default fee schedule (Phase 4).
2. Initial verifier operators — who are the 5 named parties? (Phase 5)
3. Coordinator node: self-operated LND vs partner node, and bond size (Phase 6).
4. Legal review before any real-sat round — commissioned externally (gate on Phase 6).
5. Driving-feel sign-off after the fixed-point port (gate on Phase 1).
