# BTC Logistics War — BLWP v4.6
## Providerless P2P Multiplayer Protocol

**Status:** architecture concept, security-hardened
**Version:** 4.6.1 (supersedes v4.4/v4.5 and the earlier v1.x P2P drafts; all remain in git history)
**Date:** 2026-08-31

> **Revision 4.6.1 — four release blockers closed.** The v4.6 architecture is
> unchanged; four under-specified places that would have blocked a real-money
> release are now concrete.
>
> | # | Blocker | Resolution |
> |---|---|---|
> | 1 | The canonical census was asserted, not derived — every observer could have had a different eligible set, with no way to agree | The census is a **function of Bitcoin chain state**: a node is eligible iff its bond output is confirmed and unspent at `census_height` and commits to its advertisement. Subjective criteria (uptime, heartbeats, reputation) are removed from eligibility (§5A.2–5A.4) |
> | 2 | "Slashable" was a word, not a construction | Concrete bond output with three spend paths, a fraud-proof-committing slashing transaction, and the **named residual**: Bitcoin cannot verify a WASM replay, so slashing needs an arbitration set that could in principle slash without cause. Bounds and why player funds never depend on it: §5A.3B |
> | 3 | `sqrt(bond)` weighting was **wrong in the attacker's favour** — four nodes at 1× give total weight 4, one node at 4× gives 2, so splitting *increased* selection chances | Linear `weight = bond / bond_min`. Splitting the same capital is now exactly neutral; control probability is a function of **capital share**, not identity count (§5A.6, with numbers) |
> | 4 | Stake commitment was allowed before the settlement committee was known — impossible, since the preimage shares are encrypted *to* that committee | Hard ordering: publish → future randomness → committees selected and verified → VSS shares → hold invoice → stake committed → play. A new `committee_time` sits between publication and `start_time` so pre-start entry still works (§5A.5, §9, §23.1) |
>
> Also corrected: `operator_id` is described as a **self-declaration**, not
> identity proof — it prevents declared conflicts and creates a slashing hook,
> but an anonymous attacker can simply not declare. Economic Sybil resistance
> comes from bonds and sortition, and self-dealing is caught by the threshold
> and the objection window, not by the declaration (§5A.13).

BLWP v4.6 keeps the simplified v4.4 architecture — one open-source node
package, deterministic local simulation, quorum verification, P2P pool
economics — and closes the security holes that made v4.4 unsafe for real
money.

---

# 0A. What changed in v4.6, and why

Six changes are load-bearing. Four of them close holes through which an
attacker could take the whole pool.

| # | Change | Closes | Cost |
|---|---|---|---|
| 1 | **Committee seed comes from randomness published *after* the round_id** (drand round at `committee_time`, §5A.5). | **Grinding attack.** In v4.4 the creator chose `round_id`, and `committee_seed = H(public_randomness ‖ census_epoch ‖ round_id)` with randomness already known. An attacker could brute-force round_ids offline until the deterministic selection returned his own nodes for *both* committees, publish that round, and sign himself the win and the payout. §5A.11 did not help — he overwrote nothing, he computed legally. | Committee is unknown until `committee_time`; the lobby shows "committee pending" until then, and entry opens only afterwards. |
| 2 | **Bonds are mandatory and slashable; thresholds raised to 5-of-7 for both roles; selection is linear bond-weighted stateless sortition.** | **Free Sybil + thin quorums.** v4.4 made bonds optional ("if the protocol adopts bonding"), defined no slashing, and used 2-of-3 settlement. Two colluding operators drained a round. With a free identity and 12 eligible settlement nodes of which an attacker ran 4, P(≥2 of 3 selected are his) = **23.6%**; for game/verify (20 eligible, 8 his, 5 chosen, 3 needed) = **29.6%**. Roughly every third to fourth round was fully controllable at zero cost. | Node operation now requires capital. Small networks must run at capped stakes (§5A.10). |
| 3 | **A node may not sign for a round in which its operator plays.** | **Self-signing.** v4.4 separated game/verify from settlement but never separated *player* from *node*. | Nodes declare an operator identity; overlapping entries forfeit the fee and the signature right. |
| 4 | **The custody chapter exists** (§23): hold invoice, preimage VSS-shared to the settlement committee, threshold-signed movement, expiry-as-default refund. | **The missing mechanism.** v4.4 said "stake commitment" and "2-of-3 Lightning settlement" but never stated where a stake lives during a round or which key moves it. Without it, "non-custodial" was unsupported and outages had no refund path. | The most complex part of the protocol; the interim construction is named honestly (§23.6). |
| 5 | **Objection window with a replay veto** (§13A) before finality. | **Unappealable lies.** In v4.4, a colluding quorum's signature was the end of the story. The veto existed in the earlier v1.1/v1.2 drafts and was dropped in the simplification; it is the cheapest defence in the whole design. | Finality is delayed by the window `W` (reference: 10 minutes). |
| 6 | **Explicit equivocation and no-quorum rules** (§13B, §13C). | **Undefined states.** v4.4 never said what happens if a player publishes two conflicting checkpoint chains, or if the committee cannot agree on a result — the latter left funds stuck with no defined path. | Two short rules; one of them (equivocation ⇒ forfeit) must be in the Entry Contract. |

Smaller corrections, all listed here so nothing is silently changed:

- **Stateful rotation removed.** v4.5's shuffled round-robin needed a global
  cursor, and §5A.8 admitted the canonical assignment log was unsolved —
  i.e. it needed consensus, which the simplification was trying to avoid.
  Bond-weighted **stateless sortition** gives fair long-run selection with
  no shared cursor and no path dependence (§5A.6).
- **"No Sybil reward" corrected** (§22A). It was false as written: extra
  nodes do not collect extra fees directly, but they *do* buy extra
  selection chances. Bonds are what make identity expensive; the document
  now says that instead.
- **Replay cost stated instead of assumed** (§34). Every committee member
  replays every run — that is what the 2% pays for — so round size is
  *derived* from measured replay throughput rather than hoping for 20×.
- **Donation capped** at 100% of stake with a mandatory client confirmation
  above 5% (§22A).
- **`sim_wasm_hash` must be on the client's known-good list** for
  real-money entry (§5, §6).
- **Score inflation** added to the threat model (§35A): colluding nodes
  need not fabricate a win, it is enough to inflate a rank.

Everything else from v4.4 — the game, ghosts, private worlds, permissionless
rounds, one node binary, player-level finality, the disconnect rule, the
fee-on-top model, the P2P pool — is unchanged.

---

# 0. Original game concept — the foundation BLWP preserves

BLWP is the P2P/network/settlement redesign of the existing **BTC Logistics
War** real-money concept. This section defines the game the protocol exists
to run. The later sections replace the original central authority and money
architecture; they do not replace the game's trucks, freight, terrain,
combat, delivery loop or ghost-player philosophy.

## 0.1 Product premise

BTC Logistics War is a logistics/driving game built in Unity and delivered
as **Unity WebGL in a normal browser**.

The player drives a truck carrying Bitcoin-themed freight through a
dangerous logistics route. Terrain, armies, heat, obstacles and the selected
route create the risk. The objective is simple:

> **Load freight, drive through the map, survive, and reach the delivery
> gate.**

A run combines driving skill, route selection, vehicle characteristics,
cargo/stake selection, battlefield exposure, survival, and delivery
performance.

## 0.2 The basic run

```text
ROUND / MAP
    -> SELECT TRUCK
    -> LOAD PARCELS / CARGO
    -> COMMIT STAKE
    -> ROLL OUT
    -> DRIVE THROUGH TERRAIN + COMBAT
    -> DAMAGE / SURVIVE / CHOOSE ROUTE
    -> REACH DELIVERY GATE
    -> RESULT + SCORE + PAYOUT
```

1. A round defines the map/world and its randomness.
2. The player selects a truck.
3. The player loads parcels subject to truck capacity and round rules.
4. The stake is committed before the run begins.
5. The player drives using steering, throttle and brake.
6. The truck travels through terrain and the combat environment.
7. Enemies, fire, obstacles and route exposure may damage truck and cargo.
8. The player may choose a safer outer route or a riskier one near the
   fighting.
9. Reaching the gate produces `DELIVERED`.
10. Wrecking or failing to complete produces a losing result.
11. Result and score feed the multiplayer ranking and P2P payout.

The real-money result is never based on a client-side button such as
`I arrived`. It follows from the deterministic simulation and authenticated
inputs.

## 0.3 Parcels and cargo

Parcels are central, not cosmetic. Their appearance and properties derive
from the real Bitcoin mempool: transaction appearance, size, fee/heat band.

BLWP simplifies the financial model to **fixed-stake round brackets** but
preserves the cargo fantasy and the relationship between truck, loadout,
cargo and run. A Round Contract may define stake bracket, allowed cargo
tiers, truck capacity and cargo configuration rules — without reintroducing
a house multiplier.

## 0.4 Trucks

The starter truck is free, small, low capacity, lightly armoured. Better
trucks may provide larger capacity, greater armour, higher survivability,
more speed, different handling. Damage may persist; repairs cost; a
written-off truck needs replacement.

The economic principle from the original concept remains:

> **A better truck may change capacity, survival probability and variance,
> but must not secretly create guaranteed positive expected value.**

Because BLWP replaces house odds with player-versus-player pooled
competition, truck balance belongs to the Round Contract and the game rules
rather than to a recalibrated house multiplier.

## 0.5 Terrain, armies and combat

The financially relevant world includes deterministic logic for terrain,
armies, fire, truck movement, hits, damage, cargo effects, the delivery
gate and mission timeout. Existing logic (e.g. `Army.cs`) is extracted into
the deterministic Rust core. Unity may keep richer visual physics and
suspension, but settled state comes from the core.

## 0.6 Route choice and battlefield exposure

```text
front / combat corridor   = greater exposure and danger
normal route              = intermediate exposure
edge / boundary route     = lower exposure and danger
```

The original house-banked design turned exposure into payout multipliers.
BLWP does **not** keep the house multiplier, because the economics are now a
P2P success pool. Route choice instead affects survival, delivery, time,
score and ranking. The scoring function may reward risk, speed, cargo
objective or exposure, but it is fixed in the Round Contract and
deterministic. A safe route needs no operator-adjusted payout — but "a
weaker rank" is not enough on its own, and **§18A dimensions what it has to
be**: a route that is nearly certain to arrive must earn nearly nothing, or
the cautious player free-rides on the losses of the bold.

## 0.7 Driving and controls

```text
steering
throttle
brake
```

Unity captures these. The deterministic Rust/WASM simulation consumes the
canonical quantised input stream. Unity may render WheelColliders,
suspension, particles, impacts, animation and camera effects — but Unity
presentation must never change settled position, damage, failure, cargo
state, delivery or score.

## 0.8 Multiplayer lobby

A round supports a dynamically growing number of competitors.

```text
12:00  37 players committed, round active
12:01  +8 players
12:03  +11 players
12:06  +5 players
12:07  entry closes
       61 total competitors
```

Late join is a normal feature, not merely reconnect. Each accepted entrant
receives the same contract-defined mission duration `T_run`, even when
wall-clock start times differ.

## 0.9 Ghost players — a fundamental game rule

Other trucks are visible **ghosts with no collision**.

Another player must not be able to change my financial odds by ramming me,
blocking a road, pushing me, damaging me, drawing my enemies away, pulling
enemies toward me, sacrificing themselves for me, or colluding physically.

Each player's enemies react only to that player's own truck in their
financially relevant world.

> You can watch other competitors drive, struggle, fail and arrive —
> without allowing them to manipulate your outcome.

A future play-money convoy mode may use real interaction; it is outside the
settled BLWP competition.

## 0.10 Private financial world per player

```text
financial_world(p)
=
deterministic_sim(RoundContract, map, player_seed, player_inputs)
```

Ghost snapshots are never inputs to this calculation.

```text
Alice's physics cannot change Bob's result.
Bob's physics cannot change Alice's result.
```

The shared competition is produced by comparing independent results. This is
what lets the architecture support many competitors without one giant
synchronized physics state.

## 0.11 Leaderboard

Derived from signed final protocol results. It may show pseudonym, live run
status, delivered/failed state, score, rank, cargo statistics and payout.
The leaderboard is presentation, not authority.

## 0.12 Player identity

A keypair. The public key identifies the player; the private key signs Entry
Contracts, session data and protocol messages. Clients may derive a friendly
pseudonym (`brave-otter-4711`). No email or password. Wallet identity and
game identity need not be the same key.

## 0.13 Original money model vs BLWP money model

**Original centralized concept:**

```text
player balance -> stake escrow -> house-backed route multiplier
-> 10% house fee -> payout on arrival
payout = stake x shown_multiplier
```

**BLWP:**

```text
fixed stake + player-vs-player success pool + deterministic rank distribution
```

There is no house bankroll, no RTP target, no centrally adjusted odds, no
house-funded multiplier, no standing custodial player balance.

## 0.14 BLWP P2P success pool

```text
61 players x 100 sat
24 DELIVERED, 31 FAILED, 6 FORFEIT
loser pool = 37 x 100 = 3,700 sat
```

Qualifying delivered players receive their own stake back plus a
rank-weighted share of the loser pool. The rank curve is fixed before
players enter. No operator changes odds after observing performance.

## 0.15 Score

A Round Contract defines a deterministic score from factors already in the
game: delivery success, delivery time, cargo objective, truck/cargo
condition, route exposure, combat exposure, mission objectives. The protocol
does not dictate the creative balance formula, but it does constrain it:
**exposure must enter the score multiplicatively** and the rank curve must be
steep (§18A). Without that constraint the safe route is strictly positive
expected value and the risk premise collapses. Beyond that it requires only:

```text
same inputs + same seed + same sim version = same score
```

## 0.16 End-to-end player experience

Alice opens the Unity WebGL game and sees an active round: 100 sat stake,
49 players, late join open, entry closes 12:07, mission time 3 minutes. She
picks a truck and cargo, commits 100 sat from her external Lightning wallet,
and rolls out. She steers, brakes, chooses her route, meets deterministic
armies and fire, takes damage, sees competitors as ghosts, reaches the gate.
Independent BLWP nodes replay her authenticated input history and confirm
`DELIVERED, score 18,321`. After membership and results are finalized, her
rank determines her share of the loser pool, settled to her external wallet.

## 0.17 What changes technically

```text
BEFORE:  Unity WebGL -> authoritative shard -> central ledger
         -> wallet daemon -> Lightning

AFTER:   Unity WebGL -> deterministic Rust/WASM
         -> independent BLWP node quorum
         -> independent settlement quorum -> Lightning
         -> external player wallets
```

The gameplay fantasy stays the same. The trust architecture changes.

## 0.18 Deliberately removed from the original central concept

Central authoritative game server; central player ledger; persistent
custodial balances; operator hot-wallet float as bankroll; house-backed
multipliers; 90% RTP target; global operator calibration; mandatory 10%
house fee; central withdrawal endpoint; one operator deciding results.

## 0.19 Deliberately preserved

BTC Logistics War theme; Unity WebGL; trucks; cargo/parcels; mempool-derived
world; terrain; armies; combat; damage; route choice; delivery gate; driving
skill; deterministic core; many simultaneous competitors; private player
worlds; non-colliding ghosts; public leaderboard; cryptographic identity;
real sats via Lightning; replayable game state.

---

# 1. Multiplayer model

Any practical number of players; no 1v1 assumption. All accepted players
belong to the same logical round and payout pool. Every player receives the
same mission duration `T_run`. Late join is normal.

---

# 2. Ghost architecture

Ghosts may affect visuals, animation, labels, approximate position/speed and
the leaderboard. Ghosts may **not** affect collision, damage, enemies,
cargo, RNG, score, qualification or payout.

```text
financial_world(player)
=
deterministic_sim(RoundContract, map, player_seed, player_inputs)
```

Other players are not inputs. This is the main scalability simplification:
no globally authoritative multiplayer physics server is required.

---

# 3. The whole architecture

One downloadable server package, `blwp-node`, plus the browser client.

```text
OPEN SOURCE CLIENT
      |
      v
blwp-node software
      |
      +-- 7 selected GAME/VERIFY role slots      5-of-7 agreement
      |
      +-- 7 selected SETTLEMENT role slots       5-of-7 agreement
                    |
                    v
                LIGHTNING
```

There is no separate settlement product and no second private package.
Every operator downloads the same open-source software and enables
capabilities in configuration:

```text
roles = ["game_verify"]
roles = ["settlement"]
roles = ["game_verify", "settlement"]
```

Roles are logically and cryptographically separated even though the binary
is identical. A settlement-capable instance cannot invent a game result:
settlement requires the protocol-defined 5-of-7 result and payout
signatures.

**Thresholds changed in v4.6.** v4.4 used 3-of-5 and 2-of-3. Two colluding
settlement operators drained a round, and with free identities that
combination arrived by itself in roughly a quarter of rounds (§0A, fix 2).
5-of-7 with mandatory bonds means an attacker must corrupt five bonded
operators simultaneously and forfeit five bonds to do it.

---

# 4. Open source

```text
/client-unity
/sim-core
/protocol
/blwp-node
/replayer
/test-vectors
```

`/blwp-node` contains all server-side capabilities: entry and checkpoint
handling, transcript storage, replay and signing, and optional Lightning
settlement support. No proprietary daemon is required.

GitHub may be primary, but no domain or account is authoritative. Anyone may
build and host the client, run the node, enable either role, create rounds,
build a competing frontend or a compatible client. No API key and no
developer approval is required.

---

# 5. Unity vs deterministic core

Unity is not trusted for money. Unity handles rendering, audio, UI, input
capture, animation, ghosts and lobby. A deterministic Rust core compiled to
WASM handles vehicle state, movement, world collision, damage, cargo,
enemies, delivery, failure, timeout and score.

Requirements: fixed-point arithmetic; deterministic simulation; fixed
protocol tick; no Unity PhysX for settled state; canonical serialization;
versioned `sim_wasm_hash`.

**Build trust (v4.6).** The `sim_wasm_hash` is chosen by the round creator,
so the client must not accept it blindly. For real-money rounds the client
MUST verify the hash against its **known-good list** of reproducibly built
core versions, and MUST refuse — or require an explicit, clearly worded
override — for unknown hashes. Otherwise a creator could publish a round
running a backdoored core.

A modified Unity client cannot invent a valid win. A claimed result is
accepted only if replay reproduces it.

---

# 5A. Census Protocol — discovering eligible nodes

The protocol must not assume that exactly the required number of nodes
exists. There may be 40 game/verify-capable and 25 settlement-capable nodes
while a round needs 7 and 7.

The Census Protocol produces a deterministic eligible-node set before each
round: permissionless participation, deterministic selection, fair
long-run distribution, real Sybil cost, no operator choosing favourites,
and independent reproducibility by everyone.

## 5A.1 Node advertisement

```text
NodeAdvertisement {
  node_pubkey
  operator_id                  // SELF-DECLARED, not proof of identity (§5A.13)
  supported_protocol_versions
  roles_supported              // game_verify | settlement | both
  endpoint, region, capacity_class
  software_hash
  settlement_capabilities
  lightning_capabilities
  bond_outpoint                // MANDATORY; the census entry itself (§5A.2)
  bond_script_template_version
  payout_pubkey                // where fee shares are paid
  timestamp
  signature                    // by node_pubkey over all of the above
}
```

The advertisement is **not** what makes a node eligible. The bond output is
(§5A.2). The advertisement is the body that the bond output commits to, so
that chain data alone identifies both the node and its terms.

## 5A.2 Census anchoring — the census is Bitcoin chain state
*(rewritten in 4.6.1 — blocker 1)*

v4.6 said advertisements are "canonicalized" without saying how independent
observers converge on the same set. They would not have: advertisements
arrive over gossip, and any criterion that depends on what a given observer
happened to receive produces a different census for every observer, with no
mechanism to agree — the very consensus problem the architecture avoids
elsewhere.

The fix is to stop treating the census as a gossip artifact and derive it
from a ledger that already has consensus:

> **A node is in the census if and only if it has a bond output on Bitcoin,
> confirmed and unspent at `census_height`, that commits to its
> NodeAdvertisement.**

```text
census_height            a Bitcoin block height, named in the Round Contract
census_confirmations     minimum depth for the bond output (reference: 6)
```

The eligible set is therefore a pure function of the chain up to
`census_height`. Two parties with the same chain compute the same census;
disagreement about the census reduces to disagreement about Bitcoin, which
is out of scope by assumption.

**Commitment.** The bond output commits to `H(NodeAdvertisement)` either in
an `OP_RETURN` output of the funding transaction or in the taproot script
tree, plus an optional retrieval hint (URI). The body is served by the node,
by mirrors, or by anyone — the hash makes retrieval trust-free. A body that
cannot be retrieved by `census_height` excludes that node, and it excludes
it for everyone identically, because the hash is public and the content is
missing for all.

**What this costs.** A node cannot join the census instantly: it must fund a
bond and wait for confirmations. That is intended — the delay is what makes
census membership expensive, and it is the same property that makes the
census objective.

## 5A.3 Eligibility — objective criteria only *(tightened in 4.6.1)*

Every eligibility criterion must be decidable from chain state plus the
committed advertisement body. Nothing else may enter, or the census stops
being canonical.

**Eligible iff all of:**

```text
bond output exists at census_height, unspent, >= census_confirmations deep
bond output uses the protocol's bond script template (5A.3B)
bond_amount >= bond_min(role)
committed advertisement body retrievable and hash-matching
advertisement signature valid under node_pubkey
advertisement declares the role and a supported protocol version
```

**Deliberately NOT eligibility criteria** *(removed in 4.6.1)*: uptime,
heartbeat history, reputation, latency, geographic spread, or "no unslashed
misbehaviour" as a live judgement. None of these is objectively observable
by every participant at a common instant; each would hand different
observers a different census. v4.6 listed uptime and heartbeats here, which
alone would have broken canonicalization.

Liveness is handled *after* selection instead, where it costs nothing to
disagree about: an absent node earns no fee share (§22A), and a committee
that cannot reach its threshold triggers the void-and-refund path (§13C).
Proven misbehaviour removes a node the only objective way — by its bond
being spent by a slashing transaction, which makes the output no longer
unspent at the next `census_height`.

```text
bond_min(settlement)  >= max_round_pool of the rounds it may serve
bond_min(game_verify) >= max_round_pool of the rounds it may serve
```

The bond is what makes identity expensive. Without it, a Sybil attacker
creates arbitrarily many nodes for free and buys arbitrarily many selection
chances — the flaw that made v4.4 unsafe.

**Slashing offences.** A bond is forfeit on *objectively provable*
misbehaviour, each a portable artifact anyone can check. How a proof becomes
a transaction is §5A.3B.

| Offence | Proof |
|---|---|
| Signing two different results for the same (round, player) | The two signed results |
| Signing a result contradicted by replay of the canonical transcript | Transcript + receipts + replay |
| Signing a payout table that does not equal `F(contract, membership, results)` | The table and its inputs |
| Settlement action without the required 5-of-7 result and payout signatures | The settlement record |
| Signing for a round in which the operator played (§5A.13) | Entry Contract + node signature |
| Claiming a fee share without meeting the availability rule (§22A) | Receipt record |

Slashed bonds are distributed: half to the affected players of that round,
half burned or to the remaining honest committee members of the round, as
fixed by the Round Contract.

## 5A.3B Bond construction and how a fraud proof becomes a slash
*(new in 4.6.1 — blocker 2)*

v4.6 said "slashable" without saying where the bond sits or who can move it.
This section makes it implementable and then states plainly what cannot be
made trustless.

### The bond output

A P2TR output with three spend paths:

```text
key path      MuSig2(node_key, arbitration_aggregate_key)
              -> cooperative release or cooperative slash, one signature,
                 indistinguishable on chain, cheapest and most private

script path A (recovery, unilateral)
              <node_key> CHECKSIGVERIFY
              <bond_maturity> CHECKLOCKTIMEVERIFY DROP
              -> the node alone, after maturity

script path B (slash)
              <k-of-m arbitration keys> CHECKMULTISIG
              -> the arbitration quorum, any time before maturity
```

`bond_maturity` is an absolute locktime set beyond the last round the node
may serve plus the objection and challenge windows (reference: 30 days after
the node stops advertising). Its purpose is that **arbitration can never
freeze a bond forever**: if arbitration disappears, path A returns the money
to its owner.

### From proof to transaction

```text
1. Anyone publishes a fraud proof: the two contradicting signatures, or the
   transcript + receipts + replay, or the payout table + its inputs.
2. The proof is mechanically checkable — every offence in the table above is
   either a signature comparison or a deterministic replay. No judgement.
3. k-of-m arbitration keys sign a slashing transaction spending path B.
4. That transaction MUST carry OP_RETURN = H(fraud_proof) ‖ retrieval hint.
5. Outputs pay the distribution fixed by the Round Contract.
```

Because the slashing transaction commits to the proof, **every slash is
permanently auditable**: anyone can fetch the proof later and re-verify it.
A slash whose committed proof does not retrieve, or does not check, is
itself public evidence against the arbitration set.

### The residual, named

> **Bitcoin cannot verify a WASM replay.** No script, no covenant proposal
> and no soft fork changes this. A fraud proof about "this transcript
> replays to DELIVERED, not FAILED" is not expressible on chain. Therefore
> any slashing mechanism needs an off-chain party to attest that the proof
> checks — and that party can, in principle, slash without cause.

BLWP therefore does not claim trustless slashing. It bounds the trust:

- **Arbitration is disjoint from the round committees** and from settlement.
  It touches bonds only; it can never move a player stake, delay a round, or
  influence a result.
- **Slashing without a valid committed proof is provable misconduct**, which
  destroys the arbitration set's standing and, where the arbitration members
  are themselves bonded, their bonds.
- **Path A caps the damage in time**: an inactive or hostile arbitration set
  cannot hold a bond past `bond_maturity`.
- **A DLC with an attesting oracle is the same trust in different plumbing**
  — the oracle decides, the chain only enforces. It is a valid alternative
  construction, not a stronger one.

### Why player funds do not depend on any of this

Slashing is **deterrence, not safety**. Player money is protected by three
things that keep working if arbitration fails entirely: the 5-of-7
thresholds, the refund-by-default custody of §23 (doing nothing returns the
stake), and the objection window of §13A (anyone can overturn a false result
by replay). If the arbitration set vanished tomorrow, rounds would still
settle correctly and refunds would still happen; what would be lost is the
economic penalty for getting caught.

## 5A.4 Canonical census set — the exact derivation
*(specified in 4.6.1 — blocker 1)*

Given `census_height`, every participant runs the same five steps:

```text
1. SCAN     all outputs created at or before census_height whose script
            matches the bond template (5A.3B) and that are unspent at
            census_height with >= census_confirmations depth.

2. RESOLVE  for each, read the committed H(advertisement) and retrieve the
            body from the node, a mirror, or any peer. Hash must match.
            Unretrievable body -> excluded (identically for everyone: the
            hash is public, the content is missing for all).

3. FILTER   apply 5A.3. Objective criteria only.

4. SORT     ascending by (funding_txid, vout) as raw bytes.
            Outpoints are unique, so the order is total and tie-free.
            NOTE: sorting by H(node_pubkey), as v4.6 said, is grindable —
            a node can mine a pubkey to sit anywhere it likes. Outpoints
            cannot be chosen after the fact.

5. COMMIT   census_list[role]  = the filtered, sorted entries
            census_root[role]  = Merkle root over their canonical
                                 serialization (outpoint || advertisement
                                 hash || bond_amount || role bits)
```

The Round Contract names `census_height` and both roots. Any participant
recomputes them; a contract whose roots do not match the chain is invalid
and no honest node will issue receipts against it.

**In a browser.** The client cannot run a full node. It verifies the census
root by (a) following the block-header chain and checking Merkle inclusion
of the bond transactions (SPV), and/or (b) querying several independent
chain providers and requiring agreement. This is a **named residual**: a
browser client's view of Bitcoin is only as good as its header source. It is
the same assumption every browser Bitcoin application makes, it is bounded
(a wrong census means a wrong committee, not stolen funds — funds still need
5-of-7 and still refund by expiry), and it is why the reference client ships
with multiple providers and a hard-coded checkpoint.

## 5A.5 Committee seed — from randomness published *after* the round
*(changed in v4.6 — closes the grinding attack)*

```text
committee_seed =
H(
  census_root_game_verify
  || census_root_settlement
  || round_id
  || round_randomness
)
```

with the hard rule:

```text
round_randomness = drand.round(committee_time)
```

that is, a public randomness beacon value that **does not exist yet** when
`round_id` is published. The Round Contract commits to *which* beacon round
will be used (`randomness_rule`), not to its value.

> **Why:** in v4.4 the creator chose `round_id` while `public_randomness` was
> already known, so committee selection was a pure function of a value the
> attacker controlled. Grinding round_ids offline until both committees
> consisted of his own nodes was trivial and undetectable — §5A.11's
> "committee cannot be overwritten" check passed, because nothing was
> overwritten. Sourcing the seed from a *future* beacon makes the committee
> unknowable at creation time. Grinding now requires predicting drand, which
> is the beacon's security assumption.

### The `committee_time` window *(4.6.1 — blocker 4)*

v4.6 placed committee selection at `start_time` and then permitted stake
commitment before the committee was known. That is not merely a policy
choice, it is impossible: the preimage shares are **encrypted to the
settlement committee** (§23.1), so the committee must exist before an entry
can be constructed at all.

A dedicated `committee_time` is therefore inserted between publication and
`start_time`, which also restores pre-start lobby entry:

```text
published_at        contract exists; committee unknowable
                    |
committee_time      beacon value appears -> committees selected & verified
                    |  ENTRY WINDOW OPENS HERE
start_time          round begins for everyone committed so far
                    |
entry_close_time    last late join
                    |
end_time
```

Constraints:

```text
committee_time  >= published_at + min_publication_lead   (reference: 5 min)
entry_open_time == committee_time
start_time      >= committee_time + min_entry_window     (reference: 60 s)
```

**Anti-grinding still holds, and is now checkable.** The creator must obtain
timestamp receipts for the contract from at least 5 census nodes, and those
receipts must predate `round_randomness`. A node refuses to timestamp a
contract whose `committee_time` has already passed. A contract without valid
pre-randomness receipts is invalid, and entries against it get no entry
receipts — so a creator cannot publish after seeing the beacon and backdate.

- Between `published_at` and `committee_time` the lobby shows
  **"committee: pending"**. No stake may be committed in this state, and the
  client offers no entry button.
- Fallback if the beacon is unavailable at `committee_time`: the contract's
  declared fallback (hash of the first Bitcoin block after `committee_time`).
  If neither is available within the grace period, the round never opens for
  entry; since no stake was committed, nothing needs refunding.

## 5A.6 Selection — bond-weighted stateless sortition
*(replaces the stateful rotation of v4.5)*

For each role independently:

```text
for each eligible node:
    ticket(node) = H(committee_seed || outpoint || role)      // 256-bit int
    weight(node) = floor( bond_amount / bond_min )            // >= 1, LINEAR
    score(node)  = ticket(node) / weight(node)                // 512-bit fixed point

select the `slots` nodes with the lowest score
```

**Linear, not square-root** *(corrected in 4.6.1 — blocker 3)*. v4.6 used
`sqrt(bond / bond_min)` and claimed it made splitting neutral. It did the
opposite: four nodes at 1× have weight 1 each, total 4, while one node at 4×
has weight 2 — under square-root weighting **splitting a bond doubles the
attacker's total selection weight**. Linear weighting makes the same capital
produce the same total weight however it is divided:

```text
capital C, one identity   : weight C/bond_min
capital C, j identities   : weight C/(j*bond_min) each, total C/bond_min
```

- **Stateless.** No cursor, no shared counter, no assignment history. v4.5's
  round-robin needed a global rotation cursor, and §5A.8 conceded that the
  canonical assignment log was unsolved — i.e. it required exactly the
  consensus the simplification was trying to avoid. Sortition removes the
  problem instead of deferring it.
- **Fair in the long run.** Expected selection frequency is proportional to
  bonded capital, verifiable by anyone over any window of rounds.
- **Deterministic tie-breaking.** Tickets are drawn over the *outpoint*, not
  the pubkey, so a node cannot mine a favourable identity: it would have to
  choose a txid.

### What the weighting does and does not buy

Because a node can occupy at most one slot, an attacker who wants a
threshold needs at least that many identities — so identity count is not
irrelevant, and the honest claim is narrower than "Sybil-proof":

> **Control probability is a function of the attacker's share of total
> bonded capital. Splitting the same capital across more identities does not
> reduce the capital needed.**

With 7 slots and each node's inclusion probability ≈ `7 · w_i / W_total`:

| Attacker's share of all bonded capital | Identities | P(controls ≥5 of 7) |
|---|---|---|
| 28% (5 nodes × 5.7% each) | 5 | ≈ 1% |
| 50% (5 nodes × 10% each) | 5 | ≈ 17% |
| 50% (10 nodes × 5% each) | 10 | ≈ 23% |

Splitting the same 50% across ten identities instead of five moves the
attacker from 17% to 23% — a marginal gain from having more draws, not the
multiplicative gain that square-root weighting handed him. The binding
constraint is capital: **to threaten a meaningful fraction of rounds, an
attacker must bond about as much as the entire honest network**, keep it
locked, and lose five bonds when the objection window (§13A) exposes the
fabricated result anyway.

This is what §5A.10 turns into a rule: the stake ceiling is set so that the
capital required to reach these probabilities exceeds the pools it could
take.

## 5A.7 Committee size and thresholds *(changed in v4.6)*

```text
GAME/VERIFY:  7 slots, threshold 5
SETTLEMENT:   7 slots, threshold 5
```

## 5A.8 (removed)

The stateful rotation cursor of v4.5 is gone; see §5A.6. Nothing in v4.6
requires a canonical assignment log.

## 5A.9 Role separation between committees

Selection runs separately per role, and by default overlap is minimized:

```text
select 7 GAME/VERIFY
remove those nodes (and their operator_id siblings) from the settlement pool
select 7 SETTLEMENT from the remainder
```

Fallback if too few remain: overlap is permitted but `overlap_count` is
published, and the client MUST display material overlap before the player
commits funds.

## 5A.10 Minimum census size and stake ceiling *(tightened in v4.6)*

A real-money round must not start unless the eligible population is
meaningfully larger than the committee. The maximum stake bracket is
**derived** from census health, so a young network runs safely at small
stakes rather than unsafely at large ones:

Both figures matter, and the binding one is capital (§5A.6): identity count
sets whether a threshold is *reachable*, bonded capital sets how *likely* it
is.

| Eligible nodes (per role) | Total bonded capital (per role) | Max bracket |
|---|---|---|
| < 10 | any | play money only |
| ≥ 10 | ≥ 20 × max_round_pool | 10 sat |
| ≥ 15 | ≥ 50 × max_round_pool | 100 sat |
| ≥ 25 | ≥ 100 × max_round_pool | 1,000 sat |
| ≥ 50 | ≥ 200 × max_round_pool | contract-defined |

Rationale: at 100 × max_round_pool, an attacker reaching the ~17% control
probability of §5A.6 must bond ≈ 50 × the pool he could steal, and forfeits
five bonds when caught. The ceiling exists so that the arithmetic stays that
way as the network grows rather than being asserted once.

Both quantities are computable by anyone from `census_root` and the chain,
so a client can enforce this rule itself and refuse a round whose bracket
exceeds what its census supports.

## 5A.11 Selection cannot be overwritten

The Round Contract contains:

```text
census_height, census_confirmations
game_verify_census_root
settlement_census_root
randomness_rule                 // WHICH future beacon round, at committee_time
selection_algorithm_version     // linear-weight sortition
timestamp_receipts[]            // >=5, predating the beacon (§5A.5)
```

and, published at `committee_time` once the beacon value exists:

```text
round_randomness
selected_game_verify_nodes[7]
selected_settlement_nodes[7]
```

Every participant verifies

```text
selected nodes == deterministic_select(census_root, committee_seed, algo_version)
```

A round whose published committee does not match is invalid, and any node
that acts under it is slashable.

## 5A.12 Fee fairness under sortition

The 2% node fee goes only to the committee that actually serves the round
(§22A). Because selection is bond-weighted and stateless, long-run fee
income is proportional to bonded capital and uptime, not to the number of
identities. No node holds a permanent slot, and no developer, lobby or round
creator decides who earns.

## 5A.13 Player–node separation *(new in v4.6)*

> **A selected node may not sign anything for a round in which its operator
> has an Entry Contract.**

Concretely:

- Every advertisement declares an `operator_id` (a pubkey). Nodes sharing a
  declared operator are siblings for all conflict rules.
- If a selected node's `operator_id` also signed an Entry Contract in that
  round, the node is **conflicted**: its result signatures, payout-table
  signatures and settlement participation are invalid, and it earns no fee
  share. Signing anyway is a slashable offence with a one-artifact proof.
- If conflicts reduce a committee below its threshold, the round's affected
  entries are `ENTRY_VOID` (refund) rather than settled by a compromised
  committee.
- The client MUST show, before commitment, whether any selected node's
  operator is playing.

> **Why:** v4.4 separated game/verify from settlement but never separated
> player from node. Combined with the grinding attack this was the complete
> exploit; even without grinding, an operator with a moderate share of the
> census could sign himself wins in the rounds he happened to be selected
> for. Nothing in v4.4 forbade it.

### What `operator_id` is, and what it is not *(clarified in 4.6.1)*

`operator_id` is a **self-declaration**. It is not a proof of identity, and
nothing in a pseudonymous protocol can make it one: an attacker who runs
nodes and plays simply declares nothing, or declares unrelated ids, and the
rule does not fire.

So this rule is **defence in depth, not a Sybil control**. What it actually
achieves:

- honest operators cannot accidentally serve their own rounds;
- a declared conflict is machine-checkable before entry and shown to the
  player;
- if a hidden link is ever established — reused payout keys, reused
  endpoints, self-admission, a leaked correlation — the false declaration is
  itself a slashable offence with a one-artifact proof.

**Where anonymous self-dealing is actually stopped:** by the two mechanisms
that do not depend on identity at all. An attacker must control 5 of 7
selected slots, which §5A.6 prices in bonded capital, and a fabricated
result is overturnable by anyone through deterministic replay inside the
objection window (§13A). Economic Sybil resistance comes from **bonds and
sortition**; `operator_id` only removes the easy, declared case.

---

# 6. Permissionless round creation

There is no central `CreateRound` server. Anyone may create a Round
Contract; it is valid because its fields satisfy the protocol. No developer
signature is required.

```text
RoundContract {
  round_id
  protocol_version
  sim_wasm_hash                    // client checks against known-good list (§5)

  map
  start_time, entry_close_time, end_time
  player_run_duration              // T_run
                                   // ordering: published_at < committee_time
                                   //   = entry_open_time < start_time
                                   //   < entry_close_time < end_time

  stake                            // bracket, bounded by census health (§5A.10)
  payout_model
  fee_schedule

  census_height                    // Bitcoin height; census is chain state (§5A.2)
  census_confirmations
  game_verify_census_root
  settlement_census_root
  selection_algorithm_version      // linear-weight sortition (§5A.6)
  randomness_rule                  // WHICH future beacon, at committee_time
  randomness_fallback              // first block hash after committee_time
  published_at
  committee_time                   // >= published_at + min_publication_lead
  entry_open_time                  // == committee_time (§5A.5)
  timestamp_receipts[]             // >=5 census-node receipts predating the beacon

  game_verify_slots = 7,  game_verify_threshold = 5
  settlement_slots  = 7,  settlement_threshold  = 5

  node_fee_bps = 200
  donation_bps_max = 10000         // protocol cap (v4.6)

  bond_min_game_verify
  bond_min_settlement
  bond_script_template_version     // §5A.3B
  slashing_rules_hash
  arbitration_set                  // k-of-m keys; bonds only, never stakes
  arbitration_k, arbitration_m
  bond_maturity                    // absolute locktime for unilateral recovery

  objection_window_W               // v4.6, reference 10 minutes
  equivocation_rule_hash           // v4.6
  no_quorum_rule_hash              // v4.6

  custody_rules                    // v4.6, see §23
  htlc_cltv_days
  claim_window_days

  disconnect_rule
  finality_rule

  creator_pubkey
  creator_signature
}
```

The creator gains no administrative power after publication — and, since
v4.6, no influence over the committee either.

---

# 7. Player Entry Contract

```text
PlayerEntryContract {
  round_id
  player_pubkey
  operator_id_declaration          // v4.6: "none" or the operator this player is

  stake
  join_time
  vehicle, loadout, cargo

  seed_commitment                  // H(player_secret)
  payment_hash                     // H(P), P = player-generated preimage (§23)
  vss_shares_ref                   // P shared to the settlement committee (§23)

  sim_wasm_hash
  payout_hash, fee_hash
  equivocation_rule_hash           // v4.6: player accepts forfeit-on-equivocation
  finality_rule_hash

  donation_bps                     // player-chosen, <= donation_bps_max
  donation_recipient

  session_pubkey
  signature
}
```

Late joins simply add more Entry Contracts. The Round Contract is never
rewritten.

---

# 8. One downloadable BLWP node software

One open-source package, `blwp-node`. Depending on enabled roles, an
installation can accept and timestamp entries, receive checkpoints and
transcripts, store enough data for replay, replay and sign results, and
participate in threshold Lightning settlement.

```text
7 GAME/VERIFY role slots  -> 5 matching signatures required
7 SETTLEMENT role slots   -> 5 matching authorizations required
```

These are roles of the same software, not different products. Selected slots
SHOULD be operated by genuinely independent parties; the same operator may
technically enable both roles, but §5A.9 minimizes overlap and the client
displays it.

No single instance is authoritative.

---

# 9. Entry acceptance

**Nothing may be committed before the committees are known.** The order is
mandatory, because an Entry Contract cannot even be *constructed* earlier:
its `vss_shares_ref` encrypts the preimage shares to the settlement
committee (§23.1).

```text
1. round published                 committee unknowable; no entry possible
2. committee_time reached          beacon value appears
3. committees selected + verified  client recomputes them itself (§5A.11)
4. player builds Entry Contract    P generated, VSS shares to THIS committee
5. hold invoice issued             by the settlement committee's endpoint
6. player's wallet pays            HTLC held, not settled
7. >=5 EntryReceipts               STAKE_COMMITTED
8. play
```

A player is financially admitted if:

```text
valid Entry Contract
+ built against the round's published, verified committees
+ stake committed as a held HTLC (§23)
+ 5-of-7 game/verify nodes issued an EntryReceipt
+ between entry_open_time and entry_close_time
```

```text
EntryReceipt {
  round_id, player_pubkey, entry_hash
  received_at, node_pubkey, signature
}
```

Order inside the entry window is economically irrelevant; no global ordering
is required.

---

# 10. Time and checkpoints

The protocol does not claim to prove human-speed play. It prevents obvious
rewrite and rewind behaviour.

```text
Checkpoint {
  round_id, player_pubkey, tick
  state_hash
  input_chain_hash
  previous_checkpoint_hash
  session_signature
}
```

A checkpoint is accepted when enough nodes receive it within the required
window; nodes timestamp receipt and return a signed `CheckpointReceipt`.
This proves the player committed to that state at approximately that real
time.

It does **not** prove that a human played, that no bot was used, or that no
local forward simulation was performed. BLWP makes no such claim.

**Receipt gossip (v4.6).** Committee members exchange digests of the
checkpoint receipts they issued once per window. This is what makes player
equivocation surface quickly (§13B) rather than at settlement time.

---

# 11. Input transcript

Player inputs are hash-chained:

```text
InputBatch { first_tick, last_tick, inputs, previous_hash }
```

The client periodically sends batches and checkpoints; nodes store the
transcript until the challenge and finality windows have passed; the player
keeps a local copy. The seven committee nodes provide redundancy, so no
separate data-availability network is required.

A transcript whose inputs were never published cannot be replayed and
therefore cannot be finalized as a win — withholding is never an advantage.

---

# 12. Randomness

```text
round_randomness = drand.round(committee_time)      // also the committee seed source
player_seed      = H(round_randomness || player_pubkey || player_secret)
```

The player's secret is committed (`seed_commitment`) in the Entry Contract.
For entries made before `start_time` the beacon is already known at
commitment time, so grinding is prevented instead by the sub-seed binding to
`player_pubkey` and `join_tick`, both fixed by the entry itself: a player can
grind `player_secret`, but every candidate world is equally unknown to them
until they play it, since terrain and army behaviour derive from the same
round statics for everyone. Where a deployment wants strict
commit-before-reveal, the contract may declare a second beacon at
`start_time` mixed into `player_seed`; that is a contract option, not a
protocol requirement. Because the client must know the
resulting randomness to simulate, advanced bots may forward-simulate future
states. That is accepted and stated; BLWP does not claim bot resistance
(§33).

---

# 13. Results

Each committee node independently replays the player's canonical transcript
(§13C) using the pinned simulation version and signs:

```text
PlayerResult {
  round_id, player_pubkey
  result, score
  transcript_hash, sim_wasm_hash
  node_pubkey, signature
}
```

Once **5-of-7** nodes sign the identical result, the result becomes
`PROVISIONALLY_FINAL` and the objection window opens (§13A). It becomes
`FINAL` when the window closes without a valid objection.

> v4.4 made 3 matching signatures immediately final. v4.6 inserts the
> window, because a signature quorum that lies had no counterparty in v4.4.

---

# 13A. Objection window and replay veto *(new in v4.6)*

After a result is `PROVISIONALLY_FINAL`, the window `W` (reference: 10
minutes, contract-defined) runs.

**Who may object:** anyone — the affected player, another player in the
round, a non-selected node, a spectator, a watchtower.

**What a valid objection is:** a portable artifact consisting of

```text
Objection {
  round_id, player_pubkey
  transcript                      // inputs + checkpoints
  receipts[]                      // CheckpointReceipts from committee nodes
  claimed_result                  // what replay of this transcript produces
  objector_signature
}
```

It is valid iff every checkpoint carries genuine receipts, the chain is
consistent, and deterministic replay under the round's `sim_wasm_hash`
produces `claimed_result ≠ signed_result`. Anyone can check this; there is
no judgement involved, only replay.

**Effect:** a valid objection suspends finality. The full committee re-runs
the canonical transcript; the replay outcome is authoritative. Every node
that signed the contradicted result is slashed (§5A.3). If the committee
cannot reach 5-of-7 on the re-run, §13C applies.

**Client duty:** on delivery, the reference client uploads its complete
transcript to at least two committee nodes and, if configured, to an
independent mirror **before** showing the victory screen. This is what makes
the veto work for a player who closes the browser immediately afterwards.

**Effect on the collusion bar:** five colluding bonded operators must now
also ensure that no honest node, no third-party mirror and no watchtower
holds the victim's receipted transcript. Their fabrication is permanently
provable afterwards, and their bonds are slashable by whoever proves it.

---

# 13B. Player equivocation *(new in v4.6)*

> **A player who publishes two different checkpoints for the same
> `(round_id, player_pubkey, tick)`, or two chains that diverge at any tick,
> forfeits the entry.**

- Result: `FORFEIT`; the stake joins the loser pool.
- The two conflicting signed checkpoints are a complete, portable proof; no
  replay is needed.
- Nodes MUST publish such a proof when they hold one, and receipt gossip
  (§10) exists so that a divergence sent to disjoint node subsets surfaces
  within a window rather than at settlement.
- The rule is bound into the Entry Contract via `equivocation_rule_hash`,
  so the player accepted it before staking.

> **Why:** v4.4 had 5 nodes and threshold 3, so two 3-subsets always overlap
> in at least one node — divergence was in principle detectable. But the
> document never said what that node must *do*, which left "run several
> forks and submit the winning one" as an open question. With 7 slots and
> threshold 5, any two 5-subsets overlap in at least three nodes; combined
> with gossip and an explicit forfeit rule, the strategy is not merely
> detectable but priced.

---

# 13C. Canonical transcript and the no-quorum rule *(new in v4.6)*

**Canonical transcript.** For each player, the canonical transcript is the
**longest checkpoint chain that carries receipts from at least 5 committee
nodes**, together with the input batches whose hashes it commits to. All
nodes replay that object, so "node A saw more than node B" cannot by itself
produce disagreement.

**No-quorum rule.** If, after the result window, no result has 5-of-7
signatures:

1. If the disagreement is explained by proven player equivocation (§13B) →
   `FORFEIT`.
2. Otherwise the fault is on the operator side → the entry becomes `VOID`,
   the stake is refunded by letting the HTLC expire, and the entry is
   excluded from the pool and from the payout table.
3. Nodes whose signature contradicts a replay of the canonical transcript
   are slashed.

This is deliberately asymmetric: a player cannot manufacture a refund by
causing disagreement, because the only way a player can cause it is
equivocation, and equivocation forfeits. Everything else that goes wrong is
the infrastructure's fault and refunds.

> **Why:** v4.4 had no rule at all. A committee that could not agree left
> funds in an undefined state with no path forward.

---

# 14. Finality

> Once a player's result is `FINAL`, later infrastructure failure does not
> erase it.

```text
final loser + later DDoS  !=  refund
```

A later outage may delay settlement. It cannot convert `FAILED -> REFUND` or
`FORFEIT -> REFUND` after finality. This is unchanged from v4.4 and remains
one of the most important properties in the design.

The one-way ladder:

```text
PROVISIONAL -> PROVISIONALLY_FINAL -> FINAL -> SETTLED
                        |
                        +-> (valid objection) -> re-replay -> FINAL
PROVISIONAL -> VOID / ENTRY_VOID          (refund; reachable only from PROVISIONAL)
```

---

# 15. Disconnect rule

After stake commitment:

> A transcript that stops becomes a deterministic result.

Missing inputs follow the neutral-input policy; if checkpoints stop beyond
tolerance, the valid run ends at the last receipted checkpoint; replay
determines the final state; the player normally becomes `FAILED` or
`FORFEIT`. Closing the browser does not escape a losing stake.

---

# 16. Infrastructure outage before finality

**Before stake commitment:** no financial entry exists; no loss.

**After commitment, before the first financial tick:** if fewer than 5
game/verify nodes are available, the entry becomes `ENTRY_VOID` and the
stake is refunded by HTLC expiry.

**During active play:** with 5-of-7 available, continue. Below threshold,
protocol progress pauses; a short grace period is allowed. No finalized
result is erased, and known losses never become refunds because of a later
attack.

---

# 17. Round membership

After `entry_close_time`, membership is the set of players holding ≥5 valid
EntryReceipts issued before the cutoff, minus entries voided under §13C or
§5A.13. The list is deterministic; no central database decides it.

---

# 18. P2P economics

The house does not fund winnings. Fixed brackets (10 / 100 / 1,000 sat,
capped by census health per §5A.10).

```text
loser_pool = Σ FAILED stakes + Σ FORFEIT stakes
```

Qualifiers (`DELIVERED` and score ≥ minimum) receive their own stake back
plus a rank-weighted share of `loser_pool`. Node fees and the player-selected
donation are charged **on top** of the stake at entry and therefore do not
reduce the pool. `VOID` and `ENTRY_VOID` entries neither contribute to nor
draw from the pool.

---

# 18A. Score, exposure and the rank curve

This section exists because §18 dropped the operator's route multiplier and,
for a while, put nothing dimensioned in its place.

## 18A.1 The hole

In the house-banked design, staying away from the fighting was punished
arithmetically: a near-certain route was priced down to ×0.9 and carried −10%
EV. In a pool, nothing prices it. A cautious player simply arrives,
qualifies under §18, and takes a rank-weighted share of a pool funded
entirely by other people's failures.

Worked example — 100 players, 100 sat stake, 2% in fees on top, 50 taking
the map edge and all arriving, 50 taking the corridor with half of them dying:

```text
loser_pool = 25 x 100 = 2,500 sat
flat-ish rank curve: bottom 50 collectively take 20% -> 10 sat each
```

| Route | Expected value | Variance |
|---|---|---|
| Edge | 100 back + 10 share − 2 fee = **+8%** | ~zero |
| Corridor | 0.5 × (100 + 80) − 102 = **−12%** | high |

Exactly backwards. It is the same exploit class as "carry only the cheapest
parcels" in the operator model, wearing a different costume, and the block
clock does not contain it: if safe is +EV, it is +EV every round.

## 18A.2 The target

Not to forbid the edge route. §14 rules out arbitrary minimum-danger
requirements, and rightly — a rule that says "you must be shot at" is a rule
players will satisfy in the cheapest possible way. The target is that a
zero-exposure delivery **earns approximately zero**:

| Route | Target EV |
|---|---|
| Edge | −2% (the fee), near-zero variance |
| Corridor | −2% on average, with real upside for skill |

Both pay only the fee. The choice becomes variance and skill rather than
arithmetic, and a driver whose personal survival beats the population's is
+EV — which is exactly where skill should be paid.

## 18A.3 The reference score

All factors multiplicative, so that any one of them at zero collapses the
score:

```text
score = 1000 · E · T · C

E  exposure  in [0,1]      time and depth in the corridor, heat-weighted
T  time      in [0.5,1.5]  reference_time / elapsed, clamped
C  cargo     in [0,1]      value delivered / capacity
```

with the exposure integral accumulated per simulation tick:

```text
proximity(t) = 1 − clamp01( |z − frontline_z(x)| / corridor_half_width )
rate(t)      = proximity(t) · (1 + heat(t))
E_raw        = Σ rate(t) · dt
E            = clamp01( E_raw / E_reference )
```

`E_reference` is the exposure of a full run spent on the seam at zero heat,
and is a Round Contract constant.

Two guards belong in `rate(t)`, and playtesting found both the hard way:

```text
rate(t) = 0   within spawn_free_radius of the start
rate(t) = 0   below min_speed
```

The frontline moves with the chain state, so it can drift within a few dozen
metres of the spawn point — at which point a freshly loaded truck, parked and
still under spawn protection, accrues exposure for doing nothing whatsoever.
And without the speed floor the strongest opening is to stop on the seam and
wait, which is neither driving nor a decision. Exposure is meant to price
*hauling freight through* a battle, not standing near one; both constants
belong in the Round Contract alongside the rest.

Multiplicative is the whole point. Under an additive score a fast, full, safe
run out-scores a slow, damaged, brave one — which is precisely the inversion
this section exists to prevent. Under a multiplicative one, arriving with a
full bed in record time and `E ≈ 0.05` yields `score ≈ 50` against the
corridor's `≈ 900`.

## 18A.4 The reference rank curve

Geometric over the top quarter of qualifiers:

```text
K       = ceil(0.25 · qualifier_count)
w_i     = r^(i−1),  r = 0.75,  i = 1..K
share_i = loser_pool · w_i / Σ w_j
```

Everyone below rank K gets their stake back and nothing else. That is the
mechanism that moves the edge route from +8% to −2%: it qualifies, it keeps
its stake, it simply does not place.

## 18A.5 Qualification stays generous

`score ≥ min_score` with `min_score` set low — reference value 1. The
cautious player is **not** disqualified and does **not** forfeit.

Disqualifying them is the obvious-looking fix and it is wrong. Their stakes
would fall into the pool, raising it to 7,500 sat, handing corridor survivors
+98% and the cautious −100%. That is not balancing, it is a levy on a legal
strategy, and it re-creates the minimum-danger rule through the back door.
The mechanism throughout is "earn nothing", never "lose everything".

## 18A.6 The same round, re-run

```text
50 edge players       E ≈ 0.05 -> score ≈ 50   -> ranks 26..75, share 0
25 corridor survivors E ≈ 0.9  -> score ≈ 900  -> ranks 1..25
25 corridor deaths                             -> loser_pool 2,500
K = ceil(0.25 · 75) = 19, all of them corridor survivors
```

| Route | Expected value |
|---|---|
| Edge | 100 − 102 = **−2%** |
| Corridor | 0.5 × (100 + 100) − 102 = **−2%** |
| Corridor at 70% personal survival | 0.7 × 200 − 102 = **+38%** |

Zero-sum holds: 100 players × −2 sat = −200 sat, exactly the fees collected
under §18.

**And if everyone plays it safe?** The pool is empty, nobody earns anything,
and everybody still pays the fee. There is no equilibrium in which caution
wins — the property the operator model bought with a multiplier, this one
gets from the shape of the curve.

## 18A.7 What the Round Contract must pin

`E_reference`, `corridor_half_width`, the clamps on `T`, `min_score`, `K` and
`r`. These are game balance, not protocol, and §0.15's determinism
requirement is the only hard constraint on them.

But a contract that leaves the rank curve flat, or exposure additive, is a
contract whose safe route is +EV. Clients SHOULD warn before entry when
`r ≥ 0.95`, when `K > 0.5 · qualifier_count`, or when the declared score
function is not exposure-multiplicative.

---

# 19. No house

```text
no house bankroll, no RTP promise, no server-funded multiplier,
no central player balance, no required protocol treasury

payouts <= validly collected game stakes
```

Bots may outperform humans. They cannot create unlimited liability for a
house, because there is no house.

---

# 20. Final payout table

Once entry is closed, membership is known and every accepted player has a
`FINAL` result:

```text
PayoutTable = F(RoundContract, Membership, FinalResults)
```

Deterministic. Nodes sign the payout-table hash; **5-of-7 matching
signatures** make it final. A node signing a table that does not equal `F(...)`
of its published inputs is slashable.

---

# 21. Settlement role of the same node software

```text
blwp-node --roles game_verify
blwp-node --roles settlement
blwp-node --roles game_verify,settlement
```

**GAME/VERIFY role:** receives entries and checkpoints; stores transcripts;
replays the deterministic simulation; signs final results; signs the final
payout table; **does not move funds**.

**SETTLEMENT role:** verifies the Round Contract; verifies 5-of-7 final
result and payout signatures; holds one share of each entry preimage;
participates in threshold Lightning settlement; **cannot change a result or
the payout formula**.

The same software implements both, but the protocol requires the
result/payout quorum before any settlement authorization.

---

# 22. Node trust model

BLWP does not pretend browser-only Lightning settlement is perfectly
trustless. The honest statement:

> Anyone can download the same node software and, with a bond, become
> eligible. No single node decides a result or moves funds. A 5-of-7
> game/verify quorum determines final results; a separate 5-of-7 settlement
> quorum authorizes Lightning settlement; and a public objection window lets
> anyone overturn a fabricated result by replay.

Residual assumptions:

```text
5-of-7 malicious GAME/VERIFY slots
  AND the victim's receipted transcript unavailable to every honest party
    -> can corrupt result finality

5-of-7 malicious SETTLEMENT slots
    -> can corrupt or censor settlement of in-transit funds
```

Both require five bonded operators to collude and forfeit five bonds, in a
round whose committee they could not choose (§5A.5) and in which they may
not be playing (§5A.13). This is the same trust class as a Fedimint
federation, stated without cosmetics.

---

# 22A. Node fee and developer donation

## Fee base

```text
gross_round_volume = Σ stake of every financially activated entry
```

`ENTRY_VOID` and `VOID` entries are excluded.

```text
61 active players x 100 sat = 6,100 sat
```

## Node fee: 2% mandatory, to the selected slots

```text
node_fee = 2.00% of gross_round_volume
1.00% -> GAME/VERIFY pool     (7 slots)
1.00% -> SETTLEMENT pool      (7 slots)
```

Each eligible slot receives `1.00% / 7 ≈ 0.1429%` of gross volume for its
role. An operator selected for both roles earns both shares, because it
performs both services.

**Availability qualification.** A selected node earns its share only if it
performed the contract-defined minimum service: for game/verify, the
required receipts plus replay and signing; for settlement, participation in
the settlement protocol during the settlement window. A conflicted node
(§5A.13) never qualifies. Unearned shares are redistributed pro rata among
the other eligible nodes in the same role pool, keeping the total at 2%.

**Remainders.** Calculate in millisatoshis, floor each base share, and
distribute the remaining msat in ascending `H(round_id ‖ node_pubkey)` order.

## Sybil economics — corrected statement *(v4.6)*

v4.4 claimed "no Sybil reward". That was false as written: fees do go only
to selected slots, but **more identities buy more selection chances**, and
§5A.12 said so in the same document. The accurate statement is:

> Extra identities are not rewarded, because selection weight is **linear**
> in the bond (§5A.6): capital `C` split across `j` identities yields total
> weight `C / bond_min` for every `j`. Four nodes at the minimum bond have
> exactly the same total expected selection as one node at four times the
> minimum — while costing four times as much to operate and exposing four
> bonds to slashing. What buys long-run fee income is **bonded capital and
> availability**, not identity count.
>
> v4.6 used square-root weighting here and claimed the same property. It had
> it backwards: under `sqrt`, four nodes at 1× total weight 4 against a
> single node at 4× with weight 2, so splitting a bond *doubled* selection
> chances. That was corrected in 4.6.1.

## Developer donation — the player's choice, capped

The donation is not a protocol fee and not a node-controlled parameter. The
player selects it in the client:

```text
developer_donation = 0.00% | 1.00% | 2.00% | 5.00% | custom
```

The reference client MAY default to 2%. The player may change it, including
to zero; a round with `donation_bps = 0` is fully valid.

> Nodes, round creators, lobbies and settlement participants may not
> overwrite, increase or substitute the player's choice. A node may accept
> the signed Entry Contract or reject it as invalid — never rewrite the
> donation field.

**Cap (new in v4.6).** `donation_bps ≤ donation_bps_max` (protocol maximum
10000 = 100% of stake), and the client MUST require an explicit second
confirmation above 500 bps. A compromised web host can otherwise set an
absurd donation to a recipient key it controls, and the player's only
defence is reading the wallet dialog carefully.

## Collection: on top of the stake

```text
game stake                        100 sat
node infrastructure fee             2 sat   (2%)
player-selected donation            2 sat   (0% or chosen)
------------------------------------------
wallet commitment                 104 sat
```

The pool stays mathematically clean: 100 sat is game risk; the rest is
service and voluntary donation, outside the winner/loser pool and outside
the ranking.

## Example: 61-player round

```text
gross_round_volume = 6,100 sat
node fee (2%)      =   122 sat
  GAME/VERIFY pool =    61 sat -> 8.714 sat per eligible slot (7)
  SETTLEMENT pool  =    61 sat -> 8.714 sat per eligible slot (7)
donation (2%)      =   122 sat -> donation recipient(s)
game pool          = 6,100 sat -> loser-pool distribution only
```

## Transparency

Before wallet approval the client MUST display: game stake, node fee,
developer donation, total wallet commitment, the selected node identities
(or "pending" per §5A.5), any committee overlap, whether any selected
operator is playing, and the donation recipient. The Entry Contract commits
to the fee schedule hash; nothing can change afterwards.

---

# 23. Stake custody and settlement *(new chapter in v4.6)*

v4.4 described entry, results and payout but never said where a stake lives
during a round or which key moves it. This chapter supplies that mechanism.
Its guiding property:

> **Doing nothing refunds the player. Taking a player's stake requires a
> final result, an elapsed objection window, and a threshold quorum.**

## 23.1 Stake commitment

**Precondition (4.6.1):** the round's committees must already be published
and verified by the client (§5A.5, §9). Step 2 encrypts shares *to the
settlement committee*, so no part of this sequence can run earlier. Any
statement that a stake may be committed before the committee is known has
been removed from this document.

1. The player generates a random preimage `P` and puts
   `payment_hash = H(P)` in the Entry Contract.
2. The player splits `P` with verifiable secret sharing (Shamir, threshold
   **5-of-7**) and encrypts one share to each settlement-committee member;
   `vss_shares_ref` points at the published shares. Verifiability means each
   node can confirm its share is consistent without reconstructing `P`.
3. The settlement committee's Lightning endpoint (§23.6) issues a **hold
   invoice** for `payment_hash`.
4. The player's wallet pays it. The HTLC is now **in flight** — accepted but
   not settled. It is in nobody's balance.
5. `STAKE_COMMITTED` is recorded once ≥5 settlement nodes have seen the held
   HTLC. Play begins only after this.

CLTV is sized in **days**, comfortably beyond round + objection window +
result window + claim window, so that delay is never loss.

## 23.2 What each outcome does

| Outcome | Action | Requires |
|---|---|---|
| `DELIVERED` (qualifying) | Cancel the HTLC → stake returns to the player | 5-of-7 settlement signatures; cancelling can only return money to its owner |
| `FAILED` / `FORFEIT` | Settle the HTLC → stake enters the pool wallet | `FINAL` result + elapsed `W` + no valid objection + ≥5 preimage shares released + 5-of-7 settlement signature |
| `VOID` / `ENTRY_VOID` | Do nothing | The HTLC expires and the wallet is refunded automatically |
| Payout to a qualifier | Lightning payment from the pool wallet | Final payout table (5-of-7) + 5-of-7 settlement signature |

The default path — nobody acting — is always the refund. That is what makes
infrastructure failure safe.

## 23.3 Why a loser cannot escape

The money left the player's wallet at entry and sits in a held HTLC. Every
step afterwards — attestation, objection window, share release, settlement
— runs without the player's cooperation. Closing the browser, refusing to
answer, or deleting the client changes nothing.

## 23.4 Why a committee cannot quietly take it

Settling a loser's HTLC requires reconstructing `P`, which requires 5 of the
7 shares, which the mechanical rule releases only against a `FINAL` result —
and finality requires 5-of-7 game/verify signatures plus an objection window
that anyone in the world may use to disprove the result by replay (§13A).
The two committees are separately selected and overlap-minimized (§5A.9),
every participant is bonded, and every one of these steps leaves a signed
artifact.

## 23.5 The pool wallet

Settled loser stakes accumulate in a wallet whose every operation requires a
**5-of-7 threshold signature** of the settlement committee. No node and no
minority can move a satoshi, at any moment, including during payout. Fees
and donations are paid from separate entry-time commitments, not from the
pool wallet, so a fee dispute can never touch player stakes.

## 23.6 Construction and maturity — stated honestly

Two constructions satisfy the property "no single party can move funds":

- **Threshold-signed Lightning node** (FROST-style Schnorr over channel
  operations, VLS-style remote signing generalized): the cleanest fit, and
  **emerging technology** rather than a solved product.
- **Fedimint-class federation with a Lightning gateway**: production-ready
  today, with an identical trust statement — a quorum of guardians, no
  single custodian.

The Round Contract names which construction it uses. V1 deployments should
use the mature one and migrate when threshold-LN hardens. Either way, the
residual is the same and is stated in §22: five colluding bonded operators
control in-transit funds. This is the minimum achievable under a
browser-only client constraint today, not a comfortable claim.

---

# 24. Wallet integration

Nostr Wallet Connect, BOLT11 QR, deep link, or WebLN where available.

Rules: the wallet seed never enters the game; the wallet stays external; the
stake amount must be visible; permissions minimal; and **no assumption that
generic NWC permissions cryptographically encode the Round Contract** — NWC
budgets are wallet-side policy, and the reliable boundary is the budget
ceiling plus the wallet's own confirmation screen. The protocol binds the
stake to the Entry Contract via `payment_hash`, not via wallet permissions.

---

# 25. Lobby and discovery

Discovery is not authoritative: project website, community sites, Nostr, a
direct round link, a QR code, or a copied `round_id`. A lobby may hide a
round from its UI; it cannot make a valid round invalid, and a player with
the Round Contract can always connect directly.

---

# 26. Reference client experience

```text
Open game -> Choose round -> Choose vehicle/loadout -> Connect wallet
-> Stake sats -> Drive -> See ghost players -> Deliver / fail
-> See result -> See final rank -> Receive payout
```

The distributed protocol should mostly be invisible. The two places it is
deliberately visible: the pre-commitment disclosure panel (§22A) and the
"committee pending" state before `start_time` (§5A.5).

---

# 27. Example round

```text
Round #92831
game stake:            100 sat
node fee:                2 sat (2%)
developer donation:      0 or 2 sat (player's choice)
census_height:         H (Bitcoin), roots in the contract
published_at:          11:50   committee unknowable, no entry possible
committee_time:        11:55   beacon -> both committees fixed, entry opens
start_time:            12:00
entry closes:          12:07
T_run:                 3 minutes
objection window W:    10 minutes
GAME/VERIFY:           7 slots, 5-of-7   (known from 11:55)
SETTLEMENT:            7 slots, 5-of-7   (known from 11:55)
```

At 11:50 the contract is published and timestamped by five census nodes; the
lobby shows it with **committee: pending** and no entry button. At 11:55 the
beacon value appears, both committees are selected, and every client
recomputes and verifies them against the census roots. The entry window
opens. Between 11:55 and 12:00, 37 players enter. At 12:00 the round starts.

Alice joins at 12:01. Because the committees have been known since 11:55,
she can build a valid entry: she generates `P`, VSS-shares it to the seven
settlement nodes, signs her Entry Contract, and her wallet pays the 104 sat
hold invoice. Five settlement nodes confirm the held HTLC; five game/verify
nodes issue EntryReceipts. She rolls out, publishes inputs and checkpoints,
and delivers.

Her client uploads the full transcript to two committee nodes and a mirror
before showing the victory screen. Five game/verify nodes replay and sign
`DELIVERED, score 18,321`. The result is provisionally final at 12:05; the
objection window closes at 12:15; nobody objects; it is `FINAL`.

At 12:07 entry closes: 61 players. Final results: 24 delivered, 31 failed,
6 forfeit → loser pool 3,700 sat. The deterministic payout table is signed
5-of-7. The settlement committee cancels the qualifiers' HTLCs, releases
preimage shares for the losers, settles those HTLCs into the pool wallet,
and pays the rank-weighted shares — every action a 5-of-7 threshold
ceremony.

Alice receives her 100 sat stake back plus her rank share. No central game
server decided she won, and at no instant did any single party hold her
money.

---

# 28. Failure matrix

| Failure | Effect |
|---|---|
| Official website down | Use a mirror |
| Lobby down | Direct round access |
| 1–2 game/verify nodes down | No problem (5-of-7 holds) |
| 3+ game/verify nodes down before finality | Protocol pauses; unstarted entries may `ENTRY_VOID` (refund) |
| A node lies | Ignored unless 5 collude; the lie is slashable evidence |
| Committee cannot reach 5-of-7 | §13C: player equivocation ⇒ forfeit, otherwise `VOID` + refund |
| Valid objection filed | Finality suspended, committee re-replays, wrong signers slashed |
| Player publishes conflicting checkpoints | §13B: automatic `FORFEIT` |
| Player closes browser / loses internet | Deterministic disconnect path (§15) |
| Result already `FINAL`, then nodes fail | Result stays `FINAL`; settlement delayed |
| 1–2 settlement nodes down | Settlement continues (5-of-7) |
| 3+ settlement nodes down | Settlement delayed; unsettled HTLCs expire → refund |
| Beacon unavailable at `committee_time` | Fallback beacon; if that fails, the entry window never opens — no stake was committed, so nothing needs refunding |
| Census roots in a contract do not match the chain | Contract invalid; no node issues receipts; no entry possible |
| Client's chain view is wrong (bad header source) | Wrong committee expectation; entry fails for lack of matching receipts. Funds are never at risk — settlement still needs 5-of-7 and still refunds by expiry |
| Arbitration set inactive | No slashing; deterrence lost. Rounds settle and refund normally; bonds recoverable by the node after `bond_maturity` |
| Arbitration set slashes without a valid proof | Bond stolen from that node. Publicly provable from the committed proof hash; player funds untouched (arbitration cannot reach stakes) |
| Lightning payout route fails | Retry within the claim window |
| Website compromised | Wallet approval still required; hashes/mirrors; donation cap limits the damage |
| 5 game/verify nodes collude **and** the victim's transcript is unavailable | Residual result-integrity failure; five bonds slashable afterwards |
| 5 settlement nodes collude | Residual settlement failure on in-transit funds; five bonds slashable |

No cell leaves funds in an undefined state, and no cell erases a `FINAL`
result.

---

# 29. What was intentionally removed from earlier versions

From v4.3: separate sequencer network, time-witness network, DA network,
verifier network, backup sequencer committees, multiple settlement profiles,
complex finality certificates, mandatory rolling entropy, multi-layer quorum
failover.

From v4.5 (removed in v4.6): the **stateful rotation cursor**, because it
required a canonical assignment log — i.e. consensus — which the
simplification was trying to avoid. Bond-weighted stateless sortition
(§5A.6) achieves the same fairness goal without shared state.

---

# 30. What must NOT be simplified away

1. Deterministic Rust/WASM simulation.
2. Ghosts cannot affect money-relevant state.
3. Open protocol and client.
4. Permissionless round creation.
5. No single node is authoritative.
6. Results require 5-of-7 matching signatures.
7. Settlement is a separate committee with a separate quorum.
8. No single settlement node controls funds.
9. No central internal player balance.
10. `FINAL` losses cannot later become refunds due to an infrastructure attack.
11. One public `blwp-node` package for all roles.
12. 2% node fee distributed deterministically to eligible selected slots.
13. Developer donation optional at protocol level and possibly 0%.
14. No privileged developer admin key.
15. **Committee seed from randomness published after the round_id** (§5A.5).
16. **Mandatory bonds with objective slashing** (§5A.3).
17. **No node may sign for a round its operator plays in** (§5A.13).
18. **Refund-by-default custody: doing nothing returns the stake** (§23).
19. **An objection window in which anyone can overturn a result by replay** (§13A).
20. **Explicit equivocation and no-quorum rules** (§13B, §13C).
21. **The census is chain state, and eligibility uses objective criteria only** (§5A.2–5A.4).
22. **Selection weight is linear in the bond** (§5A.6) — square-root or any
    concave weighting rewards splitting a bond and must never be used.
23. **Committees are fixed before any stake is committed** (§5A.5, §9, §23.1).

Items 15–20 are the v4.6 additions; 21–23 are the 4.6.1 release blockers.
Removing any of them reopens a hole through which a colluding or Sybil
operator takes the pool.

---

# 31. Organizational independence

Running seven servers is not enough if one company owns them. Selected
instances should be run by genuinely separate operators; independence
concerns operators and bonded threshold ownership, not binaries. The
reference developer should not control either quorum, and `operator_id`
declarations (§5A.1) make ownership overlap visible before entry.

---

# 32. Developer disappearance test

```text
Developer disappears tomorrow.

Can someone download/build the client?   YES
Can someone host the client?             YES
Can users create rounds?                 YES
Can anyone download/run blwp-node?       YES
Can nodes enable either/both roles?      YES
Can existing rounds finish?              YES
Can stakes be refunded if nothing runs?  YES (HTLC expiry, §23)
Is developer approval needed?            NO
Is a developer admin key needed?         NO
Is the developer donation mandatory?     NO
```

---

# 33. Bot model

Assume hostile clients: bots, automation, modified Unity, local replay,
strategy search, computer vision, forward simulation. The protocol's job is
not to prove human play; it is to ensure the submitted transcript
deterministically produces the claimed result. Bot mitigation belongs to
skill pools, rating, bot-designated rounds, matchmaking and product rules.
Because there is no house, superhuman play redistributes value between
players; it cannot create unbounded liability.

---

# 34. Scalability and the replay budget *(quantified in v4.6)*

Player financial worlds are independent, so nodes replay players
individually and networking scales per player, not full-mesh.

Every committee member replays **every** run of its round — that is the
service the 2% pays for, and sampling would weaken exactly the property that
makes a quorum meaningful. The consequence is a hard capacity relation
rather than an assumption:

```text
max_players_per_round
=
(measured_replay_speed x result_window) / T_run
```

Example with `T_run` = 3 min and a 10-minute result window: at a measured
30× realtime the ceiling is 100 players per committee node; at 60× it is
200. Rounds larger than that require either a longer result window, a faster
core, or per-node partitioning of the replay set — a design decision to be
made **after** measurement.

Do not hard-code unsupported assumptions such as `20x realtime` until the
simulation core is benchmarked. Storage: transcripts must be retained
through the objection and claim windows by all seven nodes.

---

# 35. Security model

A player trusts:

- Bitcoin and Lightning assumptions;
- cryptography (ed25519, SHA-256, Shamir/VSS, threshold Schnorr, BLS for the
  beacon);
- their own wallet;
- the exact Round Contract they signed;
- the exact `sim_wasm_hash`, checked against the client's known-good list;
- the drand beacon (or its declared fallback) for committee selection and
  round randomness;
- their client's view of the Bitcoin chain for the census (§5A.4) — bounded:
  a wrong view costs a failed entry, never funds;
- for slashing *deterrence only*, the arbitration set (§5A.3B) — it can
  never touch a player stake, and the protocol settles and refunds correctly
  without it;
- fewer than 5-of-7 selected game/verify slots being malicious **or** at
  least one honest party holding their receipted transcript;
- fewer than 5-of-7 selected settlement slots being malicious.

A player does **not** need to trust: one official website; one lobby; one
authoritative game server; one result server; one payout operator; another
player; a house bankroll; the round creator (who influences neither
committee nor outcome).

---

# 35A. Threat model — the cases that changed

| Threat | Capability | v4.4 | v4.6 |
|---|---|---|---|
| Committee grinding via chosen `round_id` | Offline hashing | **Total theft**, undetectable | Impossible without predicting the beacon (§5A.5) |
| Free Sybil into the census | Register many nodes | 24–30% of rounds controllable at zero cost | Bond per identity; √-weighted selection makes splitting pointless (§5A.3, §5A.6) |
| Player runs the nodes of their own round | Operate nodes | Self-signed wins | Conflicted nodes cannot sign and are slashable (§5A.13) |
| Colluding quorum signs a false loss | 5 bonded operators | Unappealable | Anyone can overturn it by replay within `W`; signers slashed (§13A) |
| Colluding quorum **inflates a score** rather than faking a win | 5 bonded operators | Not considered | Same objection path: the canonical transcript replays to one score only; a table that does not equal `F(...)` is slashable (§13A, §20) |
| Player runs multiple forks and submits the winner | Modified client | Undefined handling | Automatic forfeit on proven equivocation; receipt gossip surfaces it (§13B, §10) |
| Committee disagreement | Node faults | Funds stuck, undefined | `VOID` + refund, or forfeit if caused by equivocation (§13C) |
| Who holds the stake during the round | — | **Unspecified** | Held HTLC; refund is the default; movement needs quorum + preimage shares (§23) |
| Compromised web host sets a huge donation | Serve a lying client | Uncapped | Capped at 100%, second confirmation above 5% (§22A) |
| Round with a backdoored simulation core | Publish a round | Player trusts the hash blindly | Client refuses unknown `sim_wasm_hash` for real money (§5) |
| **Census divergence** — participants disagree on who is eligible | Selective gossip, withheld advertisements | Committee disputes, ungrounded rounds | Census is chain state at `census_height`; subjective criteria removed; outpoint ordering is unmineable (§5A.2–5A.4) |
| **Bond splitting to buy selection** | Split capital across identities | v4.6's √ weighting **doubled** an attacker's weight when splitting | Linear weighting: same capital, same total weight; control cost is capital share (§5A.6) |
| **Identity mining for a low ticket** | Grind `node_pubkey` | Favourable sort/ticket position | Tickets and ordering derive from the bond **outpoint**, which cannot be chosen after funding (§5A.4, §5A.6) |
| **Entry before the committee exists** | — | Shares encrypted to an unknown set; stake at risk under a committee the player never saw | Structurally impossible: entry opens at `committee_time`, and the Entry Contract cannot be built earlier (§9, §23.1) |
| **Arbitration slashes without cause** | k-of-m arbitration keys | Bond theft from an honest node | Slash must commit to a retrievable proof; unilateral recovery at `bond_maturity`; arbitration is disjoint from committees and cannot reach stakes (§5A.3B) |
| **Undeclared operator playing his own round** | Anonymous operator | Self-signed win | `operator_id` does **not** stop this; the 5-of-7 capital requirement (§5A.6) and the replay objection (§13A) do (§5A.13) |
| DDoS after a loss is final | Network attack | Already handled | Unchanged: `FINAL` results survive (§14) |

---

# 36. Architecture summary

```text
                  GITHUB / MIRRORS
                        |
          ONE OPEN-SOURCE blwp-node PACKAGE
                  (bonded operators)
                        |
          +-------------+-------------+
          |                           |
 GAME/VERIFY ROLE              SETTLEMENT ROLE
 7 selected slots              7 selected slots
      5-of-7                       5-of-7
   result + payout            preimage shares +
     signatures               threshold wallet
          |                           |
          +--- objection window W ----+
                        |
                 FINAL PAYOUT TABLE
                        |
                     LIGHTNING
                        |
                 PLAYER WALLETS

UNITY WEBGL CLIENT -> deterministic WASM -> committee
```

```text
100% game stake  -> P2P game pool
2% node fee      -> eligible selected slots (1% per role pool)
0% or chosen     -> optional developer donation
```

---

# 37. Final principle

> There is one open-source `blwp-node` package that anyone can download and,
> with a bond on Bitcoin, register — and that bond output *is* the census
> entry, so everyone derives the same eligible set from chain state.
> Committees are selected deterministically, with weight linear in the bond,
> from randomness that does not exist when the round is created — so nobody
> can choose their own judges, and splitting capital across identities buys
> nothing. The committees are fixed before any stake is committed. Seven selected instances verify results and five
> matching signatures make a result provisionally final; anyone in the world
> may overturn it within the objection window by replaying the transcript.
> Seven separately selected instances hold shares of each stake's preimage
> and a threshold wallet, so no single party ever holds player funds, and
> doing nothing refunds everyone. A fixed 2% infrastructure fee goes to the
> slots that served; the developer donation is the player's choice and may be
> zero. Anyone can create a round, and no company is required to decide who
> won or to move funds.

That is BLWP v4.6.

---

**End of BLWP v4.6**
