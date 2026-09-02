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
tree. The body itself travels in the witness of the same transaction
(§25.1), so it is retrievable by anyone with the chain and there is nothing
to serve and nothing to keep running. A body that is absent excludes that
node, and excludes it for everyone identically.

**Findability.** Every bond funding transaction MUST also pay a dust output
to `BOND_MARKER`, one address fixed by this protocol and shared by all
bonds. Without it the census is unfindable in practice: a P2TR output is a
32-byte key indistinguishable from any other, and BIP158 compact filters
exclude `OP_RETURN`, so nothing in the transaction would be searchable. One
marked output makes every bond discoverable by any light client, at the
cost of one dust output and the privacy of being recognisable as a bond -
which the published advertisement gives up regardless.

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

`bond_min(role)` is **named in the Round Contract**, not global. A round
declares the bracket it plays at and the floor that goes with it, and a
node is eligible for *that round* or not.

> A bond that no longer reaches the floor for the large rounds is still
> eligible for the small ones. The network stratifies; it does not evict.

The alternative reading - one global floor that rises as the network grows
- would eject nodes that did nothing wrong, and eject them at the worst
moment: their capital is timelocked until `bond_maturity`, so they cannot
raise it in response. Stratification costs nothing and keeps them serving.

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

### Why Taproot and not a plain multisig

Three reasons, in the order they matter.

**A cooperative release and a cooperative slash are the same transaction.**
The key path is MuSig2 over both keys, so either one is a single Schnorr
signature that looks like any other taproot spend. An observer cannot tell
that a bond was here, that there was a dispute, or how it ended. With a
classic P2SH multisig the whole script is published on the spend, and the
arrangement is legible to anyone forever.

**The paths nobody uses are never revealed.** The k-of-m arbitration keys
and the timelock exist only as hashes in the script tree. Using one reveals
that branch and nothing else - the other two remain private. A plain
multisig has no such thing: its structure is its address.

**The common case is the cheap case.** One signature, no script, no k
signatures. The path that should almost always be taken is the one that
costs least, which is the right way round.

The privacy has a cost, and it is paid in §25.1: an output nobody can
recognise is also an output nobody can *find*. That is what `BOND_MARKER`
is for.

### Rejected alternatives, so they are not proposed again

**Pre-signed transactions, or Lightning-style channel constructions, for
the census.** They do not apply. Those solve *two parties agreeing on a
transfer without publishing it*, enforced by the threat of publishing.
The census asks something else: which outputs exist, confirmed and
**unspent**, at a height, computed identically by every observer. That is
an observation problem about global state, and Lightning is built so that
state is precisely not public. Opposite requirements. A pre-signed
transaction also proves only that someone *could* spend an output, never
that it is still unspent - and unspentness is the whole question.

**Proving unspentness positively.** Bitcoin has no UTXO set commitment, so
a light client cannot be handed a proof that an output is still unspent.
It can, however, be handed the opposite: a spend of that output is itself a
complete, portable proof, exactly like the equivocation proof of §13B. The
census can therefore be built from inclusion proofs and **corrected by
objection** - anyone may knock an entry out by presenting the spending
transaction. No client needs the UTXO set; it needs headers and an
objection window. A node that spends its own bond and still expects to
serve hands its accusers the evidence itself.

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

Mainnet:

```text
GAME/VERIFY:  7 slots, threshold 5
SETTLEMENT:   7 slots, threshold 5
```

These are **network parameters**, not constants: they come from
`genesis_parameters` (§27A.6), which is committed in `network_id`. Test
networks run smaller committees, and because the sizes are part of the
network's identity a small-committee network can never be mistaken for
this one.

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

### What the threshold buys, in numbers

Selection is bond-weighted, so an attacker holding fraction `p` of the
bonded capital wins each slot with probability `p`, and needs 5 of 7:

| Share of bonded capital | Chance of controlling 5 of 7 |
|---|---|
| 20% | 0.5% |
| 30% | 2.9% |
| 40% | 9.6% |
| **46%** | **16.6%** |
| 50% | 22.7% |
| 60% | 42.0% |
| 70% | 64.7% |

The 5-of-7 threshold is doing most of the work here. Even holding **forty
per cent of all bonded capital in the role**, an attacker is in position
roughly one round in ten.

### The individual bond, derived

§5A.10 fixes the aggregate. The per-node floor follows from it by dividing
through, and lands in the same place from every row:

```text
10 nodes x bond_min >=  20 x pool   ->  bond_min >= 2.0 x pool
15 nodes x bond_min >=  50 x pool   ->  bond_min >= 3.3 x pool
25 nodes x bond_min >= 100 x pool   ->  bond_min >= 4.0 x pool
50 nodes x bond_min >= 200 x pool   ->  bond_min >= 4.0 x pool
```

**`bond_min` is two to four times the largest round pool.**

### Worked scenarios

At 10 sat/vB, with a funding transaction of about 300 vB (it carries the
advertisement in the witness), a later recovery spend of about 110 vB, and
the 330 sat `BOND_MARKER` dust:

| Round | Pool | Nodes | `bond_min` | One-off fees | Fees as share |
|---|---|---|---|---|---|
| 20 x 100 sat | 2,000 | 10 | 4,000 sat | 4,430 sat | **111%** |
| 61 x 1,000 sat | 61,000 | 25 | 244,000 sat | 4,430 sat | 1.8% |
| 200 x 1,000 sat | 200,000 | 50 | 800,000 sat | 4,430 sat | 0.6% |

The capital comes back; the fees do not.

And what an attacker at the 16.6% control probability faces:

| Round | Capital to bond | Loot if he lands it | Lost if caught |
|---|---|---|---|
| small | 18,400 sat | 2,000 | 20,000 (**10x**) |
| medium | 2,806,000 sat | 61,000 | 1,220,000 (**20x**) |
| large | 18,400,000 sat | 200,000 | 4,000,000 (**20x**) |

The middle row in plain terms: bond 0.028 BTC to be able to steal 61,000
sat in one round out of six, and forfeit 1.22 million sat when caught. He
must get away with it twenty times to pay for one slash, and the proof is
self-verifying and can be submitted by anybody - so the probability of
getting away with it is not close to the 95% he would need.

### The fee floor, which is not in the table above

At small stakes the arithmetic above is not what sets the bond. In the
first row the derived `bond_min` is **4,000 sat - less than the fees to
post it**. The 5A.10 requirement is satisfied trivially and is useless as
guidance.

In practice the floor is set by transaction cost, not by security: below
roughly **50,000 sat** posting a bond is not worth doing, and that is ten
to fifty times what security demands at small pools.

This is a comfortable failure. Small rounds are **over-collateralised for
free**: any bond worth posting at all is a large multiple of what the
threat model needs. The security arithmetic only starts to bind at a pool
of about 12,500 sat - twelve players at 1,000 sat, or a hundred and
twenty-five at 100.

> An implementation SHOULD therefore set `bond_min` to
> `max(4 x max_round_pool, fee_floor)`, and state the fee floor it assumed,
> since it moves with the fee market.

## 5A.10B A node that is falling behind should say so *(new)*

A hard floor with no warning is a bad experience: an operator watches fee
income decline over weeks and has no way to tell whether the network grew,
whether their node is unhealthy, or whether nothing is wrong at all.

Everything needed to answer that is public. A node can compute its own
standing from the chain, with no service to ask:

```text
own_weight      its bond, against total bonded capital in its role
brackets_served rounds it was eligible for, of the rounds that ran
headroom        own bond / bond_min of the largest bracket now common
```

Nodes SHOULD watch these and tell their operator **before** the floor is
crossed rather than after. Two thresholds are worth distinguishing:

- **falling share** - the network is growing and this node's selection rate
  is dropping proportionally. Not a fault, and not urgent; the node is
  still eligible for everything it was.
- **losing brackets** - `bond_min` for the brackets now commonly played has
  passed this node's bond. It has stopped being eligible for those rounds,
  and its fee income has a floor under it that will not lift on its own.

### Lead time is the point

The warning has to arrive early enough to be actionable, and "actionable"
is constrained by the bond itself: **a bond cannot be topped up.** It is one
timelocked output, so raising a stake means funding a *second* bond and
waiting for confirmations while the first stays locked until
`bond_maturity`. An operator warned on the day they drop out is an operator
who cannot respond for thirty days.

Nodes SHOULD therefore warn while `headroom` is still above 1 - at a
configured margin, reference 1.5x - and state plainly what would restore
it: how much more capital, and by when.

### How it is delivered

Operator configuration, not protocol. Email, a Nostr direct message, a
webhook, a log line, or nothing at all. A node with no notification
configured MUST behave identically in every other respect: this is an
operator convenience and nothing in the protocol may come to depend on a
message having been delivered.

### Multiple bond outputs

Since a bond cannot be topped up, a node MAY hold **several** bond outputs
in the same role, and its weight is their sum. Each must independently
satisfy §5A.3 - template, marker, retrievable advertisement committing to
the same `node_pubkey` and `operator_id`.

This is what makes the warning above worth sending. Without it, responding
to a lost bracket means abandoning a working bond and starting again; with
it, an operator adds a second output and keeps the first until it matures
naturally.

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
       // echoed for readability; MUST equal genesis_parameters (§27A.6),
       // which network_id commits to. A contract disagreeing with the
       // network it names is invalid, not a smaller committee.

  node_fee_bps = 200               // basis points of the round amount, so 2%
  config_hash                      // the game_config this round runs (§27A.7.5)
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

**Integrate over ground made good, not over time.** Playtesting broke the
time integral twice, and the second break was not fixable by tuning:

```text
progress(t) = max(0, x(t) − high_water_mark)     high_water_mark := max x so far
E_raw       = Σ proximity · (1 + heat) · progress
E_raw      += 0   within spawn_free_radius of the start
```

As a time integral, exposure paid for *presence*. Parked on the seam, a
loaded truck scored for standing still — and the frontline moves with chain
state, so it can drift within a few dozen metres of the spawn point and pay a
player who has not yet moved. Worse, once through the fighting a player could
simply circle: dawdling roughly tripled `E` while `T` at a 0.5 floor only
halved, so stalling was **net positive**. Tightening `T` alone cannot fix
that; it is a race between two clamps.

Against a high-water mark a lap covers no new ground and earns exactly
nothing, while the round clock runs on regardless. The time floor drops to
0.25 as well, so stalling is unambiguously negative rather than merely less
good. `E_reference` becomes a distance — the length of the run — and
`spawn_free_radius` joins the Round Contract constants.

The general lesson for anyone writing a scoring function here: **any term
integrated over time can be farmed by taking longer.** Integrate over
progress the player cannot repeat.

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

## The donation set

A donation goes to a **set** of recipients with declared shares, not to one
address:

```json
[
  { "lnurl": "LNURL1...", "share_bps": 5000 },
  { "lnurl": "LNURL2...", "share_bps": 5000 }
]
```

`share_bps` are basis points and MUST sum to exactly 10000. A client with
donations enabled pays each recipient its share of the player's chosen
donation - fifty-fifty above - as separate Lightning payments.

**Why a set and not an address.** One address is one party's decision about
who deserves the money, made once and never revisited. A set with shares is
a parameter the network can hold an opinion about, splits between a
developer fund and whatever else a round's participants agree is worth
funding, and does not have to be renegotiated as a whole to change one
entry.

**Rules.**

- The set is named in the **Round Contract** and its hash is part of the
  contract hash, so it cannot change after entry.
- The client MUST show every recipient before wallet approval (§22A). A
  donation to an undisclosed address is not a donation.
- A player who has donations switched off pays none of them, and the set is
  irrelevant to that entry.
- Payment failure to one recipient does not void the entry or the round.
  A donation is voluntary and outside the pool; an unreachable LNURL is a
  failed payment and nothing more. Clients SHOULD report it and MUST NOT
  redirect the share to the remaining recipients, which would let one
  unreachable endpoint quietly redistribute other people's money.
- Rounding: compute in millisatoshis, floor each share, and give the
  remainder to the first recipient in the set as published. Deterministic,
  and the amounts are too small for anything cleverer to be worth its
  complexity.

## System parameters — three kinds, three mechanisms

"Set a parameter across the network" is three different problems wearing
one name, and each needs a different answer. Collapsing them is how a
providerless system acquires an owner.

### 1. Consensus-critical: the Round Contract

Anything two participants must agree on exactly or the round cannot settle:
committee size and threshold, `census_height`, `randomness_rule`, the
score parameters of §18A.7, the fee schedule, the donation set.

These are **not network parameters at all**. They are per-round, fixed in
the contract, hashed into it, and accepted by the player at entry. A round
whose parameters someone dislikes is a round they do not enter - and
clients SHOULD warn about the ones §18A.7 lists rather than leaving the
player to read a hash.

There is nothing to vote on and no state to keep. This is where the great
majority of parameters belong.

### 2. Slowly varying network values: bond-weighted median

A few values are properties of the network rather than of a round -
`bond_min` per bracket, the bracket table of §5A.10, the split of the node
fee between roles. Nobody should own them, and they should not be frozen
at whatever seemed right when the document was written.

Each node declares its preferred value in its NodeAdvertisement. The
effective value for a round is the **bond-weighted median** over the census
at `census_height`:

```text
value = median over census, each node weighted by its bond
```

Median rather than mean: an outlier declaring an absurd figure moves a mean
and cannot move a median past the weight it actually holds. Bond-weighted
for the same reason sortition is - influence costs capital, so buying it is
Sybil-proof by construction, and the cost is the same cost an attacker
faces in §5A.10.

It is computable by anyone from the chain, so it needs no vote, no tally,
no quorum and no round of messages. A node changes its declaration the same
way it changes anything else in its advertisement: by publishing a new one
with a new bond (§5A.10B), which is deliberately not free.

### 3. Client preferences: not network parameters

The donation percentage, whether donations are on at all, notification
channels, UI. These belong to the player or the operator and the protocol
has no opinion. §22A already forbids anyone else from overwriting the
player's donation choice; the same principle covers the rest.

> The test for which kind a parameter is: **what breaks if two participants
> disagree about it?** If the round cannot settle, it is kind 1. If the
> network merely drifts, kind 2. If nothing breaks, kind 3 and it does not
> belong in this document.

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

## Collection: inclusive in the stake *(changed)*

```text
wallet commitment                 100 sat   <- what the player chose
  node infrastructure fee           2 sat   (2%, identical for everyone)
  player-selected donation          2 sat   (0% or chosen)
------------------------------------------
net game stake                     96 sat   -> the pool
```

Earlier versions collected the fee and the donation **on top**: a 100 sat
round took 104 sat from the wallet. That kept the pool arithmetically tidy
at the cost of the one number the player actually chose. "Play for 100"
now means 100 leaves the wallet, and the wallet dialog agrees with the
button that was pressed.

### What this costs, and it is not nothing

With an inclusive donation, **players no longer contribute equally**. A
player donating nothing puts 98 sat into the pool; one donating 5% puts 93.
They compete for the same ranks.

Left there, donating would be rewarded twice - once as the donation, and
again as a smaller contribution for the same entitlement - which is
backwards and is an exploit, not a generosity.

> **A player's entitlement is therefore weighted by their net stake.**
> §18A's rank weights distribute the pool as before; each rank's share is
> then scaled by that player's net stake against the mean net stake of the
> qualifiers.

It stays a deterministic function of published inputs, so §20 is unchanged
in kind: `PayoutTable = F(RoundContract, Membership, FinalResults)`, with
net stake among the inputs it already has. Millisatoshi arithmetic and the
ascending-`H(round_id ‖ pubkey)` remainder rule of §18A.6 apply unchanged.

The node fee raises no such question: it is the same percentage for
everyone, so it scales every contribution identically and cancels out of
the ranking entirely.

## Example: 61-player round, all donating 2%

```text
gross_round_volume = 6,100 sat   (61 x 100, the wallet commitments)
node fee (2%)      =   122 sat
  GAME/VERIFY pool =    61 sat -> 8.714 sat per eligible slot (7)
  SETTLEMENT pool  =    61 sat -> 8.714 sat per eligible slot (7)
donation (2%)      =   122 sat -> split per the donation set
game pool          = 5,856 sat -> loser-pool distribution only
```

Where donations differ per player the game pool is
`Σ (stake - node_fee_share - own_donation)`, and each player's entitlement
is weighted by their own net stake as above.

## Transparency

Before wallet approval the client MUST display: total wallet commitment,
the node fee and donation coming OUT of it, the resulting net game stake,
the selected node identities
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

Finding a ROUND is not authoritative: project website, community sites, a
direct link, a QR code, or a copied `round_id`. A lobby may hide a round
from its UI; it cannot make a valid round invalid, and a player with the
Round Contract can always connect directly.

Finding the NODES is a different matter and is not left open: it is chain
state, and §25.1 says exactly how.

## 25.1 Discovery is chain state *(new)*

A client finds nodes by reading Bitcoin. There is no directory, no relay
network and no seed list belonging to this protocol.

| # | Step | Answered by |
|---|---|---|
| 1 | Find a round | link, QR, copied `round_id`, a lobby - carries nothing |
| 2 | Which nodes count? | Bitcoin: bond outputs confirmed and unspent at `census_height` |
| 3 | Which are on the committee? | arithmetic: census roots + `round_id` + the beacon value at `committee_time` |
| 4 | Where do I reach them? | the NodeAdvertisement, carried by the bond funding transaction |

Then connect `wss://` to the `endpoint` from the verified advertisement.

Steps 2 and 3 are computed, not fetched: there is nothing for anyone to
withhold or forge. Step 4 is read from the same transaction that answered
step 2.

### Finding the bonds at all

A P2TR output is a 32-byte key and looks like every other one, so a bond
cannot be recognised from its output - the privacy property of §5A.3B is a
discovery problem. `OP_RETURN` does not help either: BIP158 compact filters
exclude it.

> **Every bond funding transaction MUST pay a dust output to
> `BOND_MARKER`, a single address fixed by this protocol.**

One address for every bond, so it appears in the compact filters and any
light client can find every bond that has ever existed without asking
anyone. It costs one dust output, once. It gives up the privacy of *being*
a bond, which the advertisement gives up anyway.

### The advertisement travels with the bond

The body of §5A.1 is carried in the witness of the funding transaction, and
the bond output commits to `H(NodeAdvertisement)` as before. Step 4
therefore needs nothing external: the transaction that proves the bond also
carries the address.

**What this costs.** The endpoint is fixed for the life of the bond. A
server move, a new host or a changed IP means a new funding transaction and
new confirmations, during which the node is unreachable although its bond
still stands. That is the price of having no external dependency, and the
two cannot both be had: anything that makes an address cheap to change is
something outside the chain that must be running.

Nodes are therefore expected to have stable addresses. An operator who
cannot promise one should not run a node.

### What a browser actually does

Downloading compact filters for years of blocks is hundreds of megabytes,
which a browser will not do. A browser is given a list - by whoever it
likes - and **verifies** it:

```text
block headers          from several independent sources, most work wins
                       80 bytes a block; under 4 MB for all of history,
                       far less from a checkpoint
bond transaction       plus a merkle proof, from any chain API
verify                 proof against header, H(advertisement) against the
                       bond output's commitment
```

A list provider can then **omit** but not **forge**, and omission is
answered by asking a second one. This is the difference between using a
provider and trusting one, and it is a few hundred lines: built in from the
start it stays; retrofitted it never happens, because by then it works and
nobody touches it.

> **A client MUST verify every census entry against block headers it
> obtained independently. It MUST NOT take a census, a committee or an
> endpoint on the word of any API, including one operated by the same party
> that ships the client.**

This is normative rather than advisory because the failure is invisible
from outside. A client that silently trusts a chain API behaves exactly
like one that verifies - same screens, same rounds, same results - right up
until the API returns a census that suits whoever runs it, and then the
player has been playing against a committee that was never selected. There
is no symptom to notice and nothing for the player to check.

Whoever controls an unverified chain source controls which census a client
sees, and therefore which committee it believes legitimate. That is the
whole security of the round, delegated by omission.

Running one's own chain servers does not change this. It buys availability,
and for a stranger an API operated by the party that wrote the client is
worth what that party's word is worth. Redundancy is not an argument about
trust.

## 25.2 Which channel carries what *(new)*

```text
node advertisements                          Bitcoin (§25.1)
round announcements                          any channel; carries nothing
player -> node: inputs, checkpoints          direct WebSocket
node <-> node: FROST, VSS, result assembly   direct, between endpoints
equivocation proofs, objections, receipt     direct, AND any public
  gossip                                       broadcast channel
```

The split is by **delivery guarantee**, not by convenience. Relays have
none, no ordering, and drop events at their own discretion. A missed FROST
round is a failed settlement, not a delay.

**Why accusations go two ways.** An equivocation proof is two conflicting
signed checkpoints - self-verifying, portable, no replay needed (§13B) - so
it needs no trusted channel, only *some* channel. But it has a deadline
(the objection window) and it accuses somebody. Sent only peer to peer, it
may travel through the party it accuses, or through that party's siblings
under a shared `operator_id` (§5A.13). It MUST therefore also go somewhere
public that the accused does not control. This protocol does not specify
which channel: the proof carries its own verification, so any will do, and
naming one would make it infrastructure.

> Direct is fast and bounded; public is censorship-resistant. A proof that
> is both accusing and time-limited needs both.

## 25.3 Transport, stated plainly *(new)*

There is no NAT traversal anywhere in this protocol and no peer discovery
in the networking sense. Nodes are reachable servers with a declared
`endpoint`; players are browsers, which can open connections and never
accept them. The "P2P" in this document means **no central provider**, not
peers behind routers finding each other. A browser can never be a node,
which is why `blwp-node` is separate software.

Two consequences that are cheaper to know now than in month four:

**`wss://` is mandatory, and it is a real dependency.** A browser on an
HTTPS page may not open `ws://` - mixed content is blocked - so every node
serving players needs a valid certificate. In practice that means a
certificate authority, in a protocol that otherwise removes central
dependencies deliberately. Worse, if it is troublesome enough, operators
end up behind two hosting providers or one proxy, and the decentralisation
the whole census apparatus exists to produce is lost at the transport
layer instead. Node software SHOULD make certificate provisioning a
first-class setup step rather than an exercise for the operator.

**A committed `endpoint` cannot change cheaply.** The bond output commits
to `H(NodeAdvertisement)` (§5A.2) and the advertisement contains
`endpoint`, so changing an address changes the hash and breaks the census
entry until a new commitment confirms. A server move, a hosting change or
a new IP therefore costs confirmation time and possibly a round.

There is no way around this that does not reintroduce a dependency.
Committing to something that merely *carries* the address - a name, a
record, a relay - means that thing must be running for the node to be
reachable, and it is exactly the external service §25.1 exists to avoid.
The address is therefore committed directly, and running a node is a
commitment to a stable address.

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

# 27A. Governance — changing the parameters *(new)*

A providerless network still has numbers that must change over time: the
node fee, the minimum bond, how hard the game is to win. Changing them
needs consensus without a company and without a governance coin, and it
needs to not become a lever somebody can pull.

The primitive is already here. **The bond is the stake.** Weight is bonded
capital, which is exactly the weight sortition uses, so influence costs the
same as an attack costs and is Sybil-proof for the same reason (§5A.10).
No token, no treasury, no voting contract.

## 27A.1 What can change, and by whom

| Parameter | Mechanism | Who |
|---|---|---|
| `proposal_deposit_sats` | bond-weighted median (§27A.2) | the census |
| `bond_min` per bracket | bond-weighted median **with notice** (§27A.3) | the census |
| **`node_fee_bps`**, the bracket set, `donation_bps`, `role_split` | set at genesis; changed by config proposal, MONEY class (§27A.7) | a ballot of active bonds |
| game difficulty, damage, army, round timings | config proposal, DESIGN class (§27A.7); a round MAY override within its contract | a ballot, then the round |
| the donation set | signed by the donation authority | one key, nothing else (§27A.4) |
| `genesis_parameters`: committee shape, thresholds, beacon | **nothing.** Changing them is creating another network (§27A.6) | — |
| protocol rules, message formats, the core | software version; adoption is running it (§27A.5) | nobody in particular |

The split between the first rows and the third and fourth is the subject of
§27A.7: **prices are discovered by median, design is decided by ballot.**

## 27A.2 Self-binding scalars: a median, not a ballot

A median is a mechanism for parameters the census may set **for itself**,
and the test for whether a parameter qualifies is narrow:

> **Declaring it must bind the declarer.**

`bond_min` is capital the declaring node must itself post; a node voting the
floor up prices itself out along with everyone else. `proposal_deposit_sats`
is a price the declarer must also pay to propose. Both are self-binding, and
a median over them is a genuine discovery of what the operators who must
live under a number think it should be.

**`node_fee_bps` fails this test and is not here** *(moved to §27A.7 in
v4.6.2)*. The fee is paid by the **player** and declared exclusively by its
**recipients**, so the loop only closes in one direction: an operator who
finds the fee too low stops bonding and pushes the median up, while nothing
whatever pushes it down, because players have no declaration and no rival
network to move to. That is not a discovered price, it is a cartel setting
its own take rate — and the fact that it drifts up quietly, with no proposal
and no vote to point at, makes it worse rather than better. Anything paid by
one group and set by another is a ballot (§27A.7), starting from a value
fixed at genesis.

Every node declares its preferred value for each qualifying scalar in its
NodeAdvertisement. The value in force for a round is the **bond-weighted
median** over the census at `census_height`.

```text
value = median over the census, each node weighted by its bond amount
```

There is no proposal, no voting period, no quorum, no tally and no round of
messages. The value is a pure function of chain state, so every participant
computes the same one and disagreement about it reduces to disagreement
about Bitcoin.

**Median rather than mean.** A mean is moved by an outlier in proportion to
how absurd it is; a median is moved only as far as the weight behind it
reaches. A node declaring a node fee of 90% moves nothing.

**Changing a declaration is deliberately not free.** It means publishing a
new advertisement, which means a new bond output and its confirmations
(§5A.10B). Governance therefore moves at the speed of capital, and a
campaign to swing a parameter is visible on chain while it is being
assembled.

**Why this is better than a DAO vote here.** A vote needs a proposal, a
window, a quorum rule and a tie-break, and every one of those is an attack
surface - proposal spam, deadline sniping, quorum failure, whale timing. A
median has none of them: there is nothing to schedule and nothing to win by
being last. What a vote buys is the ability to make a *discrete* choice,
and discrete choices are handled in 27A.5 instead.

## 27A.3 `bond_min` changes with notice, and with escalation

Raising `bond_min` makes some nodes ineligible for the brackets they were
serving. That is legitimate - the network grew and the floor should follow
- but it must never be a surprise, because **a bond cannot be topped up**:
it is one timelocked output, so responding means funding a second bond and
waiting for confirmations (§5A.10B).

> A rise in `bond_min` takes effect **`notice_period` after the median
> first crosses it** - reference 30 days, and never less than
> `bond_maturity` minus the confirmation depth.

A fall takes effect immediately: nobody is harmed by a floor dropping.

During the notice period, an affected node SHOULD escalate to its operator
rather than warn once:

```text
T-30d   informational   "the floor for the 1,000 sat bracket will rise to
                         X on <date>; this node is at Y and will keep the
                         100 sat bracket"
T-14d   actionable      restated with the shortfall and what a second bond
                         would cost at current fees
T-3d    urgent          last point at which a new bond can confirm in time
T+0     status change   brackets lost, income effect, and that the node
                         continues to serve everything below
```

Delivery is operator configuration (§5A.10B) and nothing in the protocol
depends on a message arriving. A node that dropped a bracket keeps serving
the ones below it: **the floor moving is not an eviction.**

## 27A.4 Network identity and the donation authority

The donation set cannot be a median: it is not a scalar, and the capital
holders are not the people whose work is being funded. It also cannot be
fixed forever, because addresses change.

It is signed by one key, and that key - with its recovery key - is part of
what defines the network:

```text
network_id = H( genesis_parameters
             || donation_authority_pubkey
             || donation_recovery_pubkey )
```

**A fork that replaces the key produces a different `network_id`.** Round
Contracts carry it, nodes and clients reject contracts that do not match
the one they were built for, and censuses are per-network. Someone who
forks the code and writes their own donation address in has not captured
the donations - they have left, and are running a different network with
their own census to bootstrap.

The identity commits to the **key**, not to the set. Rotating recipients is
therefore an ordinary operation that does not fork anything:

```text
DonationSet {
  network_id
  serial          monotonic; the highest validly signed one wins
  entries[]       lnurl + share_bps, summing to 10000
  valid_from      block height
  signature       by donation_authority_pubkey
}
```

Published like an advertisement - a marked output committing to
`H(DonationSet)` - so it is discoverable, timestamped, and cannot be rolled
back to an older serial.

### Two keys, and why there are two

**`donation_authority`** is the working key. It signs donation sets and
nothing else. It is used whenever recipients change, so it lives somewhere
usable.

**`donation_recovery`** is cold, and can do exactly one thing: name a new
`donation_authority`. It never signs a donation set. It is used once in
years, if ever, and belongs in a safe.

Both are committed in `network_id`, so replacing either is a fork - but
*rotating the authority under an unchanged recovery key is not*, and that
is the whole point.

The first draft of this section had only the authority key and said that a
theft would be answered by forking to a new one. That was wrong, and
badly: `network_id` commits to the key, so changing it invalidates the
entire census. Every node would have to post a new bond while its old
capital stayed timelocked, and every live contract would die - as the price
of a leaked donation address. A key with no revocation path is not a
bounded risk just because what it controls is small.

### Recovery, concretely

```text
AuthorityRotation {
  network_id
  serial              monotonic, separate from the donation set's
  new_authority       pubkey
  valid_from          block height
  signature           by donation_recovery_pubkey
}
```

Published like the donation set. From `valid_from`, sets signed by the old
authority are rejected and only the new one is accepted, whatever serial
the old key publishes.

### What each key can do, exhaustively

```text
authority   CAN     replace the donation recipients and their shares
recovery    CAN     name a new authority key
```

```text
CANNOT  pause anything
CANNOT  change any fee, floor, threshold or difficulty parameter
CANNOT  admit, exclude, slash or favour a node
CANNOT  see, alter, delay or void a round or a result
CANNOT  move, hold or touch any player's money
CANNOT  make a player donate: the percentage is the player's, and zero
        is valid (§22A)
```

### What happens in each case

| | Effect |
|---|---|
| **authority stolen** | The thief signs a set with a higher serial pointing at their own LNURLs, and players with donations on pay them until it is noticed. Answered by a rotation from the recovery key: **no fork, the census survives.** Nothing else is touched - no round, no stake, no payout, no committee. |
| **authority lost** | Same remedy. Rotate and carry on. |
| **both lost** | The set freezes at its last published serial and every donation keeps going where it was already going. Everything else works. There is no further recovery and there should not be. |
| **recovery stolen** | The thief can seize the authority. It is therefore **exactly as sensitive as the authority key** and must be stored accordingly - the fact that it is used once in years makes cold storage realistic, not optional. |
| **both stolen** | The network's donations are lost to the thief, and this is the case a fork is for. It costs a census. |

The damage is bounded in every row: donations are voluntary, capped by
`donation_bps_max`, and every recipient is displayed before wallet approval
(§22A). A player who has donations switched off is unaffected by all of it.

## 27A.5 Discrete changes: rough consensus

New message types, changed rules, a different core - none of these is a
number and none can be a median. There is no mechanism and deliberately so.
A change ships as a software version; it takes effect when enough nodes run
it that rounds using it can find a committee. Nodes advertise
`supported_protocol_versions` (§5A.1) and a Round Contract names the one it
needs, so a round that nobody supports simply finds no committee and never
starts.

This is slower and less tidy than a vote. It is also the only version that
does not require someone to be in charge.

## 27A.6 Genesis parameters, and the test networks

Everything above that a network cannot change about itself lives in one
block, fixed when the network is created and committed in `network_id`:

```text
genesis_parameters {
  chain                  mainnet | testnet | regtest
  committee_slots        per role
  committee_threshold    per role
  census_min_nodes       per role
  census_confirmations   depth for a bond output
  bond_maturity          absolute locktime offset
  notice_period          for a rise in bond_min (§27A.3)
  bracket_table          the §5A.10 stake ceiling table
  bond_marker            the §25.1 discovery address
  randomness_source      the beacon (see below)
  genesis_config_hash    the game_config the network starts on
}
```

**The genesis config.** `genesis_config_hash` is the `config_hash` of the
first `game_config` (§27A.7.1) - the one with no `parent` - and it carries
the network's opening `node_fee_bps`, brackets, damage table and timings.

Being inside `genesis_parameters` it is committed in `network_id`, which
settles what a launch *is*: you cannot start "the same network" with a 30%
node fee, because a different opening config is a different `network_id` and
therefore a different network with its own census and its own bonds.

The config itself is **not** frozen - a MONEY-class ballot changes it
(§27A.7). What is frozen is where the network started, so the whole chain of
configs from genesis to now is a public record with a fixed root rather than
a state whose origin nobody can check.

### Three networks

| | mainnet | testnet | regtest |
|---|---|---|---|
| committee slots | 7 | 3 | **2** |
| threshold | 5 | 2 | **2** |
| minimum census | 10 | 3 | **2** |
| confirmations | 6 | 2 | **1** |
| `bond_maturity` | ~30 days | ~1 day | **100 blocks** |
| `notice_period` | ~30 days | ~1 day | **10 blocks** |
| stake ceiling | §5A.10 table | testnet sats | play money only |
| beacon | drand | drand | **mock, seeded** |
| governance | 1008 / 2016 / 2016 | 144 / 144 / 0 | **1 / 6 / 1** |

Two nodes and 2-of-2 on regtest is the point of it: the whole settlement
path - hold invoices, VSS, a 2-of-2 FROST signature, the objection window,
the payout table - runs on one laptop.

### Where blocks come from on regtest

There is a chain - regtest is a full Bitcoin node, just one whose blocks you
mine yourself with `generatetoaddress`, instantly and for free. So nothing in
the protocol changes shape: `census_height` is a real height, bonds are real
UTXOs at a real depth, `bond_maturity` is a real `nLockTime`. Where mainnet
waits thirty days for a bond to mature, you mine 100 blocks in a second.

The beacon is the part that does **not** come from the chain. Committee
selection uses the drand round at `committee_time` (§5A.5) precisely because
it is published *after* `round_id` and nobody can grind against it. That
property is worthless in a test and the dependency is harmful: an external
service every regtest run must reach, and a seed you cannot fix, so no test
can select a known committee twice.

Regtest therefore declares `randomness_source = mock:<seed>` and the beacon
becomes `H(seed ‖ committee_time)`. A test can then assert *which* nodes get
selected instead of only that selection terminated. It is a genesis
parameter like the rest, so `mock` is committed in `network_id` and cannot
be pointed at mainnet.

### Why this cannot weaken mainnet

`genesis_parameters` is committed in `network_id`, and every Round Contract
carries `network_id`. A client or node built for mainnet therefore rejects
a 2-of-2 contract **because it is a different network**, not because it
checks a flag and hopes.

There is no configuration switch that lowers a threshold, no environment
variable, nothing to set wrongly in production. Lowering a threshold means
being on another network with another census and another set of bonds -
which is exactly what a test network is.

### What a small committee does NOT test

Regtest proves the code works. It does not exercise the threat model, and
the difference is worth stating so nobody reads a green regtest run as
evidence about mainnet:

- **No fault tolerance.** At 2-of-2 one node offline is no quorum, and
  every affected entry takes the void-and-refund path. On mainnet 5-of-7
  survives two failures. Regtest will therefore fail in ways mainnet would
  not, and passing it says nothing about liveness.
- **The overlap argument is vacuous.** §13B rests on any two 5-subsets of 7
  sharing at least three nodes, which is what makes a divergence sent to
  disjoint subsets surface. With one possible subset there are no disjoint
  subsets and nothing to detect. The equivocation machinery can be tested
  for correctness, not for effectiveness.
- **Player-node separation bites immediately - for the honest.** §5A.13
  voids entries when declared conflicts drop a committee below threshold,
  and with two slots one playing operator does it. Note what this is: a
  check on a **self-declaration** (§5A.13), not detection. Nobody can tell
  that an operator is playing if they simply declare nothing, on any
  network. What regtest will show constantly is the honest case firing,
  which is correct behaviour and not a bug to configure away.
- **The chain is yours.** Whoever runs regtest mines every block, so the
  census, the confirmation depths and the maturity locks are whatever that
  person decides. Everything resting on chain state is trivially forgeable
  there. That is what makes regtest useful - and it means a passing run is
  evidence about the code's mechanics, never about the chain-based
  security.

## 27A.7 Config proposals: the ballot, and where it belongs

§27A.2 rejects voting for scalars and that stands. It does not cover
everything, because **not every parameter is a scalar a node can hold an
independent opinion about.**

A damage table is thirty numbers that only make sense together. Take a
bond-weighted median of each field separately and you get a table nobody
proposed and nobody checked: armour medianed up by operators who wanted
tougher trucks, shell damage medianed up by operators who wanted a harder
game, and the result is a truck that cannot be killed by a hit that was
balanced against the old armour. Componentwise medians of a coupled vector
produce a configuration that is the average of several coherent designs and
is itself incoherent.

So the line is not "median good, ballot bad". It is:

> **What binds only the census, the census may median. Everything else is
> decided, and decided visibly.**
>
> A self-binding scalar - `bond_min`, `proposal_deposit_sats` - stays a
> median (§27A.2): no proposal, no schedule, and the declarer carries the
> consequence of their own declaration.
>
> Everything else is a ballot. That covers two kinds of thing: coupled
> designs that must be adopted whole - the damage table, the score function,
> the army, round timings - and **anything one group pays and another sets**,
> of which `node_fee_bps` is the important case (§27A.2). You vote on a
> **complete named configuration**, never on a field.

### 27A.7.1 What is votable, with examples

```text
game_config {
  timing {
    round_duration_s        180      // how long a run lasts
    entry_window_s          120      // lobby open before committee_time
    loading_time_s          8        // held at the bay
    claim_window_s          3600     // to take a payout
  }

  brackets {
    stake_sats            [ 100, 1000, 10000, 100000 ]
    max_players_per_round   64
    min_players_per_round   2
  }

  score {                            // §11
    E_reference             1.0
    corridor_width          12.0
    T_min, T_max            clamps
    min_score               the floor below which a run does not place
    K, r                    payout curve shape
  }

  damage {
    rifle_hit_per_mil       550      // core: army.js
    shell_damage            0.34     // fraction of condition per tank hit
    gunship_burst           0.11
    ram_lethal_speed        14.0     // m/s at which ramming armour kills
    condition_power_floor   0.55     // how weak a wrecked truck drives
  }

  army {
    squads                  12
    armour_walk             6.8      // m/s
    rifle_walk              2.6
    spawn_count             96
  }

  economy {
    node_fee_bps            200      // 2% of the round amount, INCLUSIVE.
                                     // A ballot, never a median: paid by the
                                     // player, so it cannot be set by the
                                     // operators alone (§27A.2)
    donation_bps            inclusive share of the round amount (§27A)
    role_split              game/verify vs settlement
  }
}
```

`config_hash = H(canonical(game_config))`, and it is **not** a scalar, a
diff, or a set of independently addressable fields. It is one object.

**Out of scope, permanently.** A proposal cannot touch `genesis_parameters`
(§27A.6) - committee shape, thresholds, network identity - because changing
those *is* creating a different network, and no vote can move you to another
network. It cannot touch the donation set, which is the admin key's one job
and nothing else's (§27A.4). And it cannot change protocol rules or message
formats, which ship as software and are adopted by being run (§27A.5).

### 27A.7.2 The proposal

```text
config_proposal {
  network_id
  parent          config_hash this replaces
  config          the FULL object, never a diff
  class           DESIGN | MONEY
  activation_height
  proposer        node pubkey with an active bond
  deposit_txid    proposal deposit, paid to the donation set
  signature
}
proposal_id = H(canonical(config_proposal))
```

**Full object, not a diff.** Two diffs passing in the same window would
merge into a configuration nobody voted on. A full object cannot.

**`parent` serialises competing proposals.** Both may pass; the first to
activate becomes the config, and the second is void at its activation height
because its parent is no longer current. Nothing needs to limit concurrency
and nothing needs to break a tie - the same rule Bitcoin uses for two blocks
at one height.

**The deposit is spent, not staked.** It goes to the donation set outright:
a fixed price for occupying the whole network's attention for a month.
`proposal_deposit_sats` is itself a median scalar (§27A.2) - the network
prices proposing through the mechanism that needs no proposal.

### 27A.7.3 Votes are Bitcoin transactions

This is the part that decides whether the whole scheme is sound, and the
answer has to match the rest of the spec: there is no Nostr, no DNS seed and
no server whose tally anyone has to trust.

A vote is an `OP_RETURN` output on Bitcoin:

```text
OP_RETURN  "BLW"                  3 bytes
           proposal_id[0:8]       8
           choice                 1     YES | NO | ABSTAIN
           schnorr_sig            64    by the BOND key over
                                        H(proposal_id ‖ choice)
                                  = 76 bytes, inside the 80-byte limit
```

The signature is the entire link to the bond. A verifier walks the census,
and for each bonded node checks whether the signature verifies under that
node's key. **The vote never spends the bond and cannot** - the bond is a
timelocked output with a MuSig2 key path, and voting touches none of it.

What this buys is the property §27A.2 was built for and that a gossiped
tally would have destroyed:

> The tally is a pure function of chain state. Every participant computes
> the same result, and disagreement about the outcome reduces to
> disagreement about Bitcoin.

The cost is one small transaction per vote - about 150 vB, so a few hundred
sats. Against a bond of hundreds of thousands of sats, voting a few times a
year is noise, and it is a natural rate limit on anyone who would rather
vote ten thousand times.

**Eligibility** is an active bond at `vote_census_height = H_propose`: the
census is snapshotted when the proposal is published, so no one can fund
bonds in reaction to how a vote is going. One vote per bond outpoint, and
the **last vote by block height wins**, so an operator can change their mind
(ties inside a block: lower txid). Weight is the bond amount - the same
weight sortition uses, so influence costs what an attack costs.

**ABSTAIN counts for turnout but not for approval.** Without it a turnout
floor is hostage to indifference: operators with nothing to say cannot
distinguish themselves from operators who are gone, and a good proposal
dies of quiet. ABSTAIN lets someone say *I am here and I do not care.*

### 27A.7.4 Timings

In block heights, because that is the only clock the network agrees on -
the same clock the census already uses.

| Phase | Blocks | ≈ | What happens |
|---|---|---|---|
| Review | 1008 | 7 d | Published, votes not yet counted. Time to find that it is broken *before* anybody has committed to it. |
| Voting | 2016 | 14 d | `OP_RETURN` votes confirm. |
| Cooldown | 2016 | 14 d | Outcome known, change **not** live. Operators upgrade; anyone who dislikes it exits or lets a bond lapse. |
| Activation | at `activation_height` | | |
| **Total** | **5040** | **~35 d** | |

`activation_height` MUST be at or after the end of cooldown; a proposal that
names an earlier one is invalid on its face.

**Thresholds by class**, of the bonded capital in the snapshot:

| | turnout | approval of non-abstaining weight |
|---|---|---|
| DESIGN - damage, army, score, timings | ≥ 30% | > 50% |
| MONEY - `node_fee_bps`, brackets, `donation_bps`, `role_split` | ≥ 40% | ≥ 66% |

Failing either is failing. A proposal that reaches quorum and misses
approval is dead, not retried.

The schedule and thresholds are themselves in `genesis_parameters`, so
regtest runs 1 / 6 / 1 blocks and two operators can drive a whole governance
cycle through to activation in under a minute.

### 27A.7.5 Going live

At `activation_height` the new config is the config. Two rules keep that
from disturbing anything in flight:

- **A round is bound to the config it was created under.** The Round
  Contract carries `config_hash` alongside `network_id`. A round created
  before activation and still running after it keeps its own rules to the
  end. Nothing changes mid-flight, and no scoring is ever done under
  parameters that differ from the ones the player entered under.
- **A node that has not upgraded simply stops being selectable** for rounds
  naming the new hash, exactly as with protocol versions (§27A.5). It is not
  ejected and it is not slashed; it serves nothing and its bond is
  recoverable as always.

### 27A.7.6 When a passed config turns out to be broken

There is no pause button, by construction. The admin key cannot do this and
must not be able to (§27A.4). So the answer is the honest one:

**Nodes refuse.** A config that makes rounds unplayable or unprofitable is a
config nodes do not serve, so those rounds find no committee and never
start. The network degrades to no rounds rather than to bad rounds, which is
the correct direction.

And a **repeal** runs on a short schedule - review 0, voting 1008, cooldown
0 - but *only* if its `config` is byte-identical to an ancestor that was
live before. It can go back, never forward. That cannot be abused into a
fast path for new changes, because the only configurations it can reach are
ones the network already ran.

### 27A.7.7 The operator UI, and why it never holds a key

Voting means signing with the **bond key**, which is the most valuable
secret an operator has. The obvious product - a website where you log in and
click YES - would mean handing that key to a website. It must not exist.

Instead the UI is a client of the operator's **own node**:

```text
UI  --(operator token, over TLS to the node's own endpoint)-->  node
                                                                 |
                            builds, signs and broadcasts the vote tx
```

Pairing is a `blwp-operator:` URI - endpoint plus a 32-byte token the node
prints on first start - pasted or scanned. The UI asks for an action; the
node performs it. **No key ever leaves the node**, and there is no service
in the middle to compromise, subpoena or shut down.

Tokens are scoped, and the scoping gives a property worth stating plainly:

| Scope | Can | Worst case if stolen |
|---|---|---|
| `read` | dashboards, income, bracket status | information disclosure |
| `vote` | cast and change votes | **a wrong vote** |
| `config` | edit declarations (§27A.2 medians), delivery addresses | wrong declared preferences |

None of them can move money. The bond is spendable only by its recovery path
after `bond_maturity` or by a valid slash, and no operator token touches
either. **A fully compromised operator API costs a vote, never a bond** -
which is why it is safe for this to be a convenient web UI at all.

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
| A passed config makes rounds unplayable | Nodes decline to serve it; those rounds find no committee and never start. Repeal runs on the short schedule (§27A.7.6). No pause exists and none is needed |
| Config activates mid-round | Cannot happen: a round is bound to the `config_hash` it was created under (§27A.7.5) |
| Operator API token stolen | At worst a wrong vote. No token can spend a bond or reach player funds (§27A.7.7) |
| Governance turnout below the floor | Proposal fails. The config in force is unchanged, which is the safe direction |

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
Is a developer admin key needed?         NO (the donation authority of
                                         §27A.4 signs the donation set and
                                         nothing else; if it is gone the
                                         set freezes and every line above
                                         still answers YES)
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
