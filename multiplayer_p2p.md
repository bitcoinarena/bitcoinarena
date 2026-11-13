# Bitcoin Arena — protocol v1 (formerly BTC Logistics War / BLWP)
## Providerless P2P protocol for games and other contests with a stake

> **Bitcoin Arena and nextblock (RULED 2026-10-06).** The engine and
> the game are separated. **Bitcoin Arena** is the engine: custody,
> settlement and verify, for any number of games and, later, other contests
> such as prediction markets. **Tick Tock, Next Block** ("nextblock",
> `nextblock` in code) is the first game: the truck game this document
> describes. Games are plugins any developer may register; each node
> chooses which games it hosts. The money split is **10% of the gross
> stake**: 5% mandatory to the nodes (three equal pools), and a default
> donation of 2.5% to the protocol devs and 2.5% to the game dev, which the
> player may lower as today. Every wire tag is renamed, so every id changes;
> BLWP never ran on a public network, so Bitcoin Arena starts as protocol
> version **1** (§0A.9, 2026-10-06). Where this document still says BLWP it
> means the ancestor network (§0A.9) whose bonds carried over; where it describes the truck, it describes
> nextblock.

**Status:** architecture concept, security-hardened
**Version:** Bitcoin Arena protocol v1, draft. Earlier drafts (BLWP) remain in git history.
**Date:** 2026-10-06

> **A slash pays the real loss, the rest goes to the reserves (2026-11-02,
> kanban #976).** Each harmed player gets what they lost, once, and nothing
> more. The rest of a slashed bond goes to the protocol reserves. **Nothing goes
> to the nodes, nothing to the developers**, nothing back to the slashed node,
> nothing is burned. §5A.3, §23A.5, §27A.9.2.

> **A slash pays who was harmed (2026-11-02, kanban #975).** A false result
> that raised the player it names no longer pays that player: the other paying
> entries are paid, so a committee's friend cannot collect the slash for the lie
> told in their favour. One that lowered them still pays them. §5A.3.

> **A false slash does not pay (2026-11-02, kanban #971, #974). Bond template
> 3: every round draws two panels of 7 by formula, a bond moves only to a hold
> output its node signed for that round, and leaving it takes both panels, after
> 6 blocks. Nothing goes on chain per round. Existing bonds do not move. §5A.2,
> §5A.3, §5A.3B, §23A.5, §27A.6.

> **Late join and background stake (2026-10-02 / 2026-10-03, written
> 2026-10-03; the run's end and the door RULED again 2026-10-04 14:30).**
> A series may name an entry close 45 s after a round's start; the signer
> nodes take a new entry only before start + 37 s (45 s or less of the run
> left is too late), and a late joiner's run ends with everybody's at
> start + 82 s - a later join does not extend the round. The round's end -
> the anchor of the 10-minute window - is entry close + 2 x start deadline
> + the run, as the code computes it. Play starts at once and the stake is verified in the background;
> no play frame of an entry is taken until its stake is seen held, and an entry whose first mark arrives only after its
> start deadline is `ENTRY_VOID` (§16).
> §5A.5 Timing, §13A, §23.1 step 5.

> **WINDOW-10-SPEC (2026-10-01 09:40), anchored the same day.** The
> objection window is **exactly 600 seconds of wall time**, then `FINAL` if
> no valid objection landed. It opens at the **round's end as its contract
> fixes it** - the same UTC instant on every node, chosen by nobody - and a
> seat signs `FINAL` only after **round end + 600 s + a 5 s tolerance** on
> its own clock; `FINAL` takes 5 of 7 such signatures (§13A). It is not
> a contract parameter, not counted in blocks and not a range. Winnings show
> as **pending** in the balances the moment the result is signed, not when
> the window closes, and disappear if the payment becomes invalid. Changed:
> §6 (`objection_window_W`), §12, §13A, §13C, §14, §24, §24B.1, the worked
> example, §34's capacity line and the overview diagram.

> **The federation has a life (2026-09-21).** A
> federation now holds standing balances across many rounds, so
> §23A says what the spec never said: how a federation is founded and by
> whom (bonded, guardian-capable census nodes drawn by sortition; **at least
> ten guardians, 7 of 10, for the first mainnet federation**; the testnet
> federation is **5 of 7**, seven nodes and one guardian per node, 2026-09-27); how many outages it absorbs
> and when it is declared draining; several federations at once and how a
> player's client picks one by load, not per round; how a guardian leaves,
> what abandonment is, and what its bond then pays; succession back to
> nominal size with automatic migration of every player's notes; how
> guardians, seats and clients talk; how a player finds his federation on
> any device; and the **BIP39 seed of 12 or 24 words** every player writes
> down, from which the wallet, the round keys and the identity key derive.
> **Bonds (2026-09-28):** a confirmed, unspent bond stays the bond for
> every later round, restart and advertisement; a new advertisement is an
> update transaction, not a new bond; maturity is not expiry (§5A.2,
> §5A.3B).
> Later the same day: **guardians earn from the 2%** (§22A, three pools);
> a slashed guardian bond goes **to whoever it owes, then to the protocol
> reserves** (2026-11-02, §23A.5), never to the witnesses; and a guardian can
> **leave a federation with notice and keep his bond** as a census node
> (§23A.5); every role is opt-in (§5A.1). And: **FEDERATION is the only
> custody** - THRESHOLD_LN does not exist, past rounds included, no decode-only
> value (2026-09-22 22:59) - and **guardians
> are not parked**: §23A is to be built now, on a testnet federation of
> seven guardians, 5 of 7 (§23.6, §23A.1). **Players cannot lose** (the owner, last): the exposure cap is
> what the smallest halting set's bonds cover, slashed guardian bonds wait
> in escrow until the federation is CLOSED or liquidated, and a halted
> federation is **liquidated** - every unspent note paid at face from the
> bonds of those who left - before the rest goes to the protocol reserves
> (§23A.3, §23A.5, 2026-11-02), on a halt too, after every note is paid;
> **nothing is ever burned**, in §5A.3 either.
> Timings are fast: 36 h for the
> liquidation claim window, 48 h abandonment, 72 h notice and founding,
> four weeks of drain (§23A.1). The client: the balance always in the lobby
> and never in the game, a settings screen (name, donation 0-5%, the seed
> phrase with a full-phrase **Backup**) behind an icon top right, and a
> no-backup notice on every load until backed up, gating nothing (§24B). Changed: §5A.1, §22A, §23.6,
> §23A (new), §24, §24B (new), §25.2, §27A.4, §27A.6, `FEDERATION.md`,
> `IMPLEMENTATION.md` §9.

> **The player wallet (2026-09-21).** The round
> wallet of §24 becomes the **player wallet**: one e-cash wallet per player
> seed and federation, kept in the browser, that the player deposits into
> over Lightning, plays stakes from, receives winnings and refunds into
> **automatically, the moment they are available** (shown as *pending*
> until then), and withdraws from over a Lightning invoice whenever he
> likes, in any amount. A stake is now spent from the wallet into the
> round's stake lock; no Lightning payment and no gateway sits in the
> per-round path. Nothing about the lock, the committees, the settlement
> transaction or the expiry refund changes. What the wallet holds is
> e-cash: bearer notes under the player's own seed that no node, seat,
> committee or gateway holds or can move, blind-signed so the guardians
> cannot tell whose they are. The trust statement is §22's, not a new one:
> a standing balance is the same claim on the federation a stake lock is,
> held for as long as the player chooses instead of for one round. §24A.3's
> rejection of session balances stands for what it rejected — a balance
> held in a committee's Lightning node — and is shown not to apply to notes
> the player holds himself. Changed: §0.16, §0.18, §9, §22, §23.1, §23.5,
> §24, §24A, the worked example, `FEDERATION.md` (flow, residuals,
> rehearsal, rulings).

> **The custody construction is fixed (2026-09-11).**
> A stake no longer waits as a held HTLC in a Lightning node. It waits as a
> **stake lock**: a contract inside a Fedimint-class federation, enforced by
> the guardians' consensus, that only the round's settlement committee can
> claim, only the player can take back, and that returns to the player on
> expiry. Lightning is used only to deposit into and withdraw from the
> federation, through any of several gateways, each payment atomic. No single
> node is needed and no single node can take money. There is no pool wallet:
> each round settles in one atomic transaction from losers' locks to
> qualifiers' payout contracts. Changed: §6 fields, §9, §13C, §16, §22, §23,
> §24A, the worked example, §27A, §28, §32, §35A. Details and the rehearsal
> that must pass: `FEDERATION.md`.
>
> The security pass on it (FEDERATION.md F1–F9) closed one hole the hold
> invoice never could: the stake commitment is now a **point** `P·G`, so
> Feldman VSS is checked against the lock's own secret at dealing time and a
> loser cannot escape by dealing shares of something else (§7, §23.1). It
> also added the committee's attested claim key, mandatory lock-field
> verification, a separate fee preimage, seed-derived refund keys (§24) and
> a slashing offence for withheld settlement signatures (§5A.3; removed
> 2026-11-02, kanban #1043: silence is not signed bytes).
>
> The pass over the whole protocol (P1–P8, §35A) found two holes that were
> free to exploit and two false claims. Free: **round grinding by mass
> publication** (timestamp receipts cost nothing; now `publication_txid`
> on chain before the beacon block, §5A.5) and **a self-dealing quorum that
> never publishes its transcript** (now `FINAL` requires the settlement
> seats to retrieve and post it, §13A). False: "a wrong chain view never
> costs funds" (it costs the stake, §5A.4) and "replay catches
> self-dealing" (a player-run quorum's fork selection is genuine and
> replays; it is a capital residual, §22). Also: the creator can no longer
> name his own federation (§23.6), bonds are sized against gross volume
> (§5A.3), one ticket per node (§5A.6), and `publication_relays[]` give the
> objection window somewhere to look (§25.2).

> **Four release blockers closed.** The architecture is
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
> identity proof, and a player declares no operator at all (§5A.13). Economic Sybil resistance
> comes from bonds and sortition, and self-dealing is caught by the threshold
> and the objection window (§5A.13).

This protocol keeps the simplified architecture of the earlier drafts — one open-source node
package, deterministic local simulation, quorum verification, P2P pool
economics — and closes the security holes that made the earlier draft unsafe for real
money.

---

# 0B. Why the design is what it is

Six changes are load-bearing. Four of them close holes through which an
attacker could take the whole pool.

| # | Change | Closes | Cost |
|---|---|---|---|
| 1 | **Committee seed comes from randomness published *after* the round_id** (the first Bitcoin block after `committee_time`, §5A.5; drand in an earlier draft, Bitcoin now). | **Grinding attack.** In an earlier draft the creator chose `round_id`, and `committee_seed = H(public_randomness ‖ census_epoch ‖ round_id)` with randomness already known. An attacker could brute-force round_ids offline until the deterministic selection returned his own nodes for *both* committees, publish that round, and sign himself the win and the payout. §5A.11 did not help — he overwrote nothing, he computed legally. | Committee is unknown until `committee_time`; the lobby shows "committee pending" until then, and entry opens only afterwards. |
| 2 | **Bonds are mandatory and slashable; thresholds raised to 5-of-7 for both roles; selection is linear bond-weighted stateless sortition.** | **Free Sybil + thin quorums.** An earlier draft made bonds optional ("if the protocol adopts bonding"), defined no slashing, and used 2-of-3 settlement. Two colluding operators drained a round. With a free identity and 12 eligible settlement nodes of which an attacker ran 4, P(≥2 of 3 selected are his) = **23.6%**; for game/verify (20 eligible, 8 his, 5 chosen, 3 needed) = **29.6%**. Roughly every third to fourth round was fully controllable at zero cost. | Node operation now requires capital. Small networks must run at capped stakes (§5A.10). |
| 3 | **A node may not sign for a round in which its operator plays.** | **Self-signing.** An earlier draft separated game/verify from settlement but never separated *player* from *node*. | Nodes declare an operator identity; overlapping entries forfeit the fee and the signature right. |
| 4 | **The custody chapter exists** (§23): hold invoice, preimage VSS-shared to the settlement committee, threshold-signed movement, expiry-as-default refund. | **The missing mechanism.** An earlier draft said "stake commitment" and "2-of-3 Lightning settlement" but never stated where a stake lives during a round or which key moves it. Without it, "non-custodial" was unsupported and outages had no refund path. | The most complex part of the protocol; the interim construction is named honestly (§23.6). |
| 5 | **Objection window with a replay veto** (§13A) before finality. | **Unappealable lies.** In an earlier draft, a colluding quorum's signature was the end of the story. The veto existed in the first drafts and was dropped in the simplification; it is the cheapest defence in the whole design. | Finality is delayed by the window `W`: exactly 600 s of wall time (WINDOW-10-SPEC, 2026-10-01). |
| 6 | **Explicit equivocation and no-quorum rules** (§13B, §13C). | **Undefined states.** An earlier draft never said what happens if a player publishes two conflicting checkpoint chains, or if the committee cannot agree on a result — the latter left funds stuck with no defined path. | Two short rules; one of them (equivocation ⇒ forfeit) must be in the Entry Contract. |

Smaller corrections, all listed here so nothing is silently changed:

- **Stateful rotation removed.** An earlier draft's shuffled round-robin needed a global
  cursor, and §5A.8 admitted the canonical assignment log was unsolved —
  i.e. it needed consensus, which the simplification was trying to avoid.
  Bond-weighted **stateless sortition** gives fair long-run selection with
  no shared cursor and no path dependence (§5A.6).
- **"No Sybil reward" corrected** (§22A). It was false as written: extra
  nodes do not collect extra fees directly, but they *do* buy extra
  selection chances. Bonds are what make identity expensive; the document
  now says that instead.
- **Replay cost stated instead of assumed** (§34). Every committee member
  replays every run — that is what the node fee (5%, §0A.8) pays for — so round size is
  *derived* from measured replay throughput rather than hoping for 20×.
- **Donation capped** at 100% of stake with a mandatory client confirmation
  above 5% (§22A).
- **`sim_wasm_hash` must be on the client's known-good list** for
  real-money entry (§5, §6).
- **Score inflation** added to the threat model (§35A): colluding nodes
  need not fabricate a win, it is enough to inflate a rank.

Everything else from the earlier drafts — the game, ghosts, private worlds, permissionless
rounds, one node binary, player-level finality, the disconnect rule, the
fee-on-top model, the P2P pool — is unchanged.

---

# 0A. Bitcoin Arena: the engine, its games, and nextblock *(RULED 2026-10-06)*

Everything in this chapter is RULED by the owner on 2026-10-06 unless a line
says RULED HERE. It is GAP until built; the board tasks carry the
work.

## 0A.1 Names

| What | Name | In code |
|---|---|---|
| the engine and its protocol | **Bitcoin Arena**, protocol v1 | `arena` (packages `arena-protocol`, `arena-node`, `arena-client`, `arena-donor`) |
| the first game | **Tick Tock, Next Block** - short "nextblock" (2026-10-06) | `nextblock` (its core, its Unity project and its page assets in one package) |
| the site | `bitcoinarena.io` (not registered yet; the current pages stay until it is) | |
| the repository | `github.com/bitcoinarena/bitcoinarena`, with the whole history of this one kept | |

RULED HERE, so nothing of a player's is lost in the rename:

- environment variables move from `BLWP_*` to `ARENA_*`, units from
  `blwp-*` to `arena-*`;
- browser storage keys move from `blwp.*` to `arena.*` by **migration**: the
  client reads the old key, writes the new one, and deletes the old one only
  once the new one reads back - a player's seed (`arena.player.seed`) and
  wallet survive the rename;
- player-visible text never says BLWP or BTC Logistics again.

## 0A.2 The engine and the game are separate

**The engine** holds everything that is not one game's: the census and
bonds (§5A), committees and sortition, entries and receipts, checkpoints,
replay and signing, the objection window (§13A), the no-quorum rule
(§13C), custody in the federation (§23), settlement, the player wallet
(§24A), fees and donations (§22A). **A game** brings its rules and nothing
else: its deterministic core, its configs, its result and score, its
client.

The dependency runs one way: **the engine never imports a game's code.**
What it needs from a game - which core, which config, how long a run is,
what a result is worth - it reads from the game's manifest (§0A.3) and
from the game's core through one fixed interface (step a world, read its
result), inside the replay sandbox (§0A.6).

## 0A.3 A game is a manifest anyone may register

**Every developer can register a game on the network and name its donation
set (RULED 2026-10-06).** Nobody approves it. A game exists once its
manifest is published:

```text
GameManifest {
  game_name                       // "nextblock"
  game_dev_pubkey                 // the developer's key; it signs this body
  version, parent_manifest_id     // 0 for the first; an update names the one it replaces
  result_type                     // REPLAY (a replayed run), or ATTESTED (an outcome its attestors sign, §0A.7a)
  cores[]                         // sim core hashes this game runs (the sim_wasm_hash of §5)
  configs[]                       // config hashes per core (§27A.7.5)
  run_ticks_max, round_period     // what a round of it may ask
  payout_rule, payout_params      // one of the engine's payout rules, with its numbers (§0A.5)
  min_score
  clients[]                       // client build hashes (for nextblock the WebGL build)
  game_donation_set               // recipients and shares, as §22A's donation set
  outcomes[], attestors[],        // ATTESTED only (§0A.7a): the outcomes a round may end in, the
    attest_threshold              //   attestor keys, and how many of them must sign (k of n)
  template                        // ATTESTED, optional (§0A.7c): category, max_outcomes, resolve_within -
                                  //   each round then asks its own question
  game_source                     // ATTESTED, optional (§0A.7d): source_game_id, source_kind, mapping[] -
                                  //   each round names its source round, whose signed result decides it
  scalar                          // ATTESTED, optional (§0A.7e): low, high, unit - the attestors sign a value,
                                  //   paid linearly between the bounds to the sides LONG and SHORT
  signature                       // by game_dev_pubkey over all of the above
}
game_id = H(GameManifest)
```

**Published by being served, anchored by the seats that host it** *(RULED,
2026-10-10replaces the earlier `OP_RETURN "ARN" GAME game_id`
publication)*: every seat that hosts a game serves its manifest body (`GET
/games`), and a reader checks it alone - `H(body) = game_id` and the
developer's signature - so serving needs no trust. On chain, a game is named
by the advertisements of the seats that host it (`hosted_games`, §5A.3), which
the census already reads; a manifest no seat serves is a game no seat hosts.
No transaction per manifest: an update (a new client hash is a new manifest)
costs nothing on chain, and nothing about a round changes. A manifest whose signature
does not verify, or whose `parent_manifest_id` names a manifest of another
`game_dev_pubkey`, is not a game. **An update is a new manifest** signed by
the same key with the old id as its parent; rounds name the exact manifest
they play, so an update never changes a round already written. The game's
donation set changes the same way, and only that way.

## 0A.4 Each node chooses which games it hosts

A node's advertisement names the games it hosts (`hosted_games[]`, §5A.1),
the same opt-in as its roles: nothing is implied, and changing the list is
an advertisement update, never a new bond (§5A.2). RULED HERE:

- **the game/verify committee of a round is drawn only from census nodes
  that host the round's game**: the sortition filters the census by the
  committed advertisements before it draws (§5A.6), so the census root
  stays one root over the whole census and every observer applies the same
  filter;
- the census minimum (§5A.10) for the game/verify role counts only hosting
  nodes; a game too few nodes host has no paying rounds and says why;
- **settlement and guardian roles are game-agnostic**: they sign payout
  tables and hold custody, never replay, so they are drawn from the whole
  census as today;
- a node refuses to open, list or take an entry for a round of a game it
  does not host, by name;
- the reference node hosts nextblock by default; the operator may remove it.

## 0A.5 Payouts without game code

Settlement seats must compute the payout table (§20) without running a
game. So **a payout rule is the engine's, not the game's** (RULED HERE): the
engine defines the rules - in Arena v1 one, §18A's rank curve - and a manifest
picks one and gives its numbers (`payout_params`: the curve's numerator and
denominator, the minimum score). A game asking for a rule the engine does
not have is not a valid game.

## 0A.6 A game's core runs only where its node chose it, and only in the sandbox

RULED HERE. A node never fetches or runs a core because a manifest names
it. It runs a game's core only if its operator installed that core and
lists the game, and it runs it only in the replay worker (§10): no network,
no file system, no clock, no randomness but the round's seed, the same
integers on every machine (§3). A manifest is evidence of what a core's
hash is; it is never a reason to execute code.

The client applies the same caution as for federations and cores (§5,
§23.6): a game on the client's known-good list is offered; any other game is
shown with its developer key and manifest id and needs an explicit
confirmation before a stake.

## 0A.7 Beyond games

The engine is not only a game engine: contests whose result is an attested
outcome - a price, an event - use the same custody and settlement, for
example **prediction markets**. The `result_type` of a manifest says which
kind a game is: `REPLAY` (a replayed run, §10) or `ATTESTED` (§0A.7a).
Nothing in the engine may assume that a result is a replayed run outside the
code that handles `REPLAY`.

## 0A.7a Non-replay plugins: attested results *(RULED 2026-10-07, board)*

**RULED 2026-11-07 (spec review, kanban #1292).** A manifest's `attest_threshold` must be more than half of its attestor keys (`k > n/2`), so two standing outcomes always share a key and the contradiction names it; a manifest under that is invalid. An attested round's gross is capped at a quarter of the attestors' posted bonds (`gross ≤ Σ attestor_bond / 4`, as §5A.10 caps a game round against its committee; for drawn attestors the bonds are the drawn seats' census bonds; for key-named attestors with no posted bond, as on testnet today, only §5A.10's committee cap binds, which every market carries anyway (kanban #1293), and on mainnet a manifest naming an attestor key with no bond is invalid - RULED 2026-11-08, kanban #1365), and a manifest may name a backup attestor set the seats consult after `resolve_at + deadline/2` when the first set is silent. Before this, one attestor who signed Up could sign Down for the price of a bond unrelated to the pool, a k-minority could VOID at no cost, and silence was a VOID button; VOID is a transfer from the in-the-money side to the out-of-the-money side.

**Result source.** A round of an `ATTESTED` game has no core, no config and
no run: its manifest lists no cores, `run_ticks_max` 0, no rank curve and no
`min_score`, and a round of it names 32 zero bytes as its `sim_wasm_hash`
and `config_hash`. Its result is an **outcome**, one of the manifest's
`outcomes[]` (2 to 16 labels), signed by its **attestors**: a set of 1 to 16
keys named in the manifest, of which `attest_threshold` (k of n) must sign.
**The game dev chooses the attestors** (RULED): they are in the manifest the
game dev signs, so a player sees who decides the outcome before staking.
They are not the round's signer nodes reading a feed.

```text
OutcomeAttestation {
  round_id
  outcome                         // index into the manifest's outcomes[]
  observed_at_ms                  // when the attestors saw it
  signatures[]                    // { attestor key, signature over H(the three fields above) }
}
```

**The entry carries a pick, not a run.** An entry into an attested round
backs one outcome by its index (`pick`, after the entry's other fields; an
entry without one keeps its bytes and its id). It still locks its stake, its
fee and its donation exactly as any paying entry (§0A.8, §23.1). It plays no
run, sends no batch and no mark, and no worker replays it. A seat refuses an
entry with no pick, a pick out of range, a pick into a replayed round, and
**any pick once it holds a standing attestation for that round** - a pick made
after the outcome is known is a copy.

**What verify means without a replay.** A seat takes an attestation at
`POST /outcome?round=<id>` and holds it only if it stands:
- it is for that round;
- its outcome is one the manifest names;
- at least `attest_threshold` distinct keys **the manifest names** signed it;
- every signature on it verifies.

Each refusal is by name. Nothing else of the world is checked: the seats do
not know the price; they know who the game dev said may say it. `GET
/outcome?round=` answers the round's state: `OPEN` (none held), `ATTESTED`
(one outcome) with its table, or `DISPUTED`.

**What an objection is.** Two attestations for one round, each standing on
its own, naming **different** outcomes. The seat holds both: the pair is the
proof that the attestors contradicted themselves, the round is `DISPUTED`,
**and it settles on neither outcome** - no table is built from it.
*(RULED, 2026-10-10)* **A disputed round is VOID at once:** every
stake lock and fee lock comes back whole by the return door (the seats' forfeit
to each player's own key), no fee is taken, and nobody waits for a lock's
expiry. **Attestors post a bond the contradiction proof slashes - before
mainnet** (with the node bonds' enforcement); on testnet there is no
attestor bond, and the proof is published so the market's developer can drop
the attestor from the next manifest.

**The payout rule: pari-mutuel** (RULED: no counterparty - the losers pay the
winners). Out of each entry's stake come the market's fees: its manifest's,
0.5 % nodes + 0.5 % donation by default (§0A.7b.3), **due once the entry is
in the round at its entry close, paid out at resolution** (2026-10-09): a market entry's fee lock holds both, it makes no donation
outputs at entry, and before entry close it can be cancelled at no cost. The rest is its net stake in the pool. With outcome `o`:
- every entry that picked `o` gets its own net stake back plus
  `floor(losing_pool x its_net / winning_net)`, where `losing_pool` is the sum
  of the other entries' net stakes and `winning_net` the sum of the winners';
- the msats the floors leave go one each to the winners in entry-id order;
- if nobody picked `o`, every entry's net stake goes back to it;
- fees + donations + payouts = the gross, to the msat.

The settlement seats build this table from the stored entries' picks and the
held outcome **without running any game code**. A manifest of an attested
game must pick `PARI_MUTUEL`; a replayed game must pick `RANK_CURVE`.

**Slices.** Slice 1 (board): the manifest type, the pick, the
attestation and its refusals, the dispute, and the table - all read at
`GET /outcome` and `/api/rounds`; an attested round's settlement is **held**,
nothing of it moves. Slice 2: the settlement transaction paying that table
(the winners' payouts, the fee locks to the seats, as §22A), the page's pick
UI, and a regtest round.

### Sketch: a prediction market on the same custody and settlement

"Where does BTC close on Friday?" A game dev publishes manifest `btc-close`:
- outcomes `above 100k`, `between`, `below 90k`;
- three attestor keys (say three independent price-feed operators), threshold 2;
- `PARI_MUTUEL`;
- its own donation set.

Nodes that choose to host it list it (§0A.4) and need install nothing: there
is no core.

1. A series of rounds opens as for any game (§5A.5). Each round's entry
   window closes before Friday's close, its `end` after it.
2. A player picks `below 90k` and stakes 10,000 sat (market default fees,
   §0A.7b.3):
   - a 100 sat fee lock: 50 sat for the nodes and 50 sat donation, half to
     the protocol devs and half to `btc-close`'s dev, due at entry close and
     paid out at resolution;
   - a 9,900 sat stake lock to the round's claim key.
3. After the close, two of the three operators sign `{round_id, 2, t}` and
   anyone posts it to the seats. Each seat checks the two signatures against
   the manifest and holds it.
4. The seats build the pari-mutuel table, and the round's settlement pays it
   (slice 2): the losing stake locks are claimed into the winners' payouts,
   and the fee locks to the seats.
5. With three keys and k = 2, two standing attestations of different
   outcomes need at least one key to have signed both. That key's two
   signatures are the proof: the round is `DISPUTED`, and nothing is paid out
   of it.

## 0A.7b The market we build first: "Bitcoin Up or Down - 15 minutes" *(2026-10-09: "match this polymarket market", board /#278)*

**Book or pool, decided the same at every seat (RULED 2026-11-10, kanban #1417).** A
two-outcome round can hold backed orders and backed plain picks, and "backed" is a fact each
seat learns at its own time, so no seat may decide the round's kind from the stakes it has
seen. The kind is read from the one fact every seat shares: **a round is a book iff a
threshold-certified batch holds an order**; a batch takes only orders whose stake the batching
seats saw, and a round with no certified batch by its close is a pool. A plain pick in a book
round, and an order in a pool round, is not an entry of that round: the seats forfeit its lock
at once, as a refused round's stake is returned (§23.2, REFUSED-RETURN), and the page says
which kind the round became. For the 2.0 line the Round Contract names its kind
(`market_kind`: book or pool) and the door refuses the other type outright; the certified-batch
rule is the 1.9 answer and stays the fallback where a contract names none.

**RULED 2026-11-07 (spec review, kanban #1293).** A market round's **gross** is under §5A.10's ceiling: a seat refuses an order once the round's filled volume plus the order would exceed `max_round_pool` of its census, and a market on a game (§0A.7d) is capped at the source round's `max_round_pool` and its gross counts into the source committee's exposure. Before this a book round could hold a thousand 100,000-sat orders under a committee bonded for a 1,000-sat bracket.

The model is Polymarket's series **BTC Up or Down 15m**
(polymarket.com/event/btc-updown-15m-1791598500, read 2026-10-09 from its
public API). One market per quarter hour, on the clock (UTC), each with two
outcomes. Its rule, verbatim:

> This market will resolve to "Up" if the time-weighted average price (TWAP)
> of Bitcoin ... of the time range specified in the title is greater than or
> equal to the price at the beginning of that range. Otherwise, it will
> resolve to "Down". (Source: the Chainlink BTC/USD TWAP 60 s data stream.)

| | Polymarket | Bitcoin Arena |
|---|---|---|
| market | one per 15 min window, a recurring series, open ~24 h before its window | one **market round** per 15 min window of a market series (off the games' 90 s grid, §0A.7b.4) |
| outcomes | Up, Down | `outcomes[] = [Up, Down]`, indexes 0 and 1 |
| price to beat | the price at the window's start: the stream's 60 s TWAP at that moment | the same: the 60 s time-weighted average of the feed's readings before the window's start |
| rule | Up if the end price (the stream's 60 s TWAP at the window's end) >= the price to beat, else Down | the same, **a tie is Up**; `up-down.js` `upDownOutcome` is the rule as a pure function |
| who resolves | UMA / Polymarket from Chainlink | the market's **attestors** (§0A.7a), k of n, each applying `upDownOutcome` to the feed samples it read, signing `{round, outcome, observed_at}` |
| trading | a central limit order book matched continuously: tick 0.01, minimum 5 shares, a share pays $1 | **signed standing limit orders cleared every second at one uniform price** (§0A.7b.2): tick 0.01, minimum 5 shares, **a share pays 1 sat** |
| fees | taker only, 0.07 x p(1-p) per share, maker rebate | **the owner's rulings instead** (§0A.7b.3): the market's own rate, 1 % by default (0.5 % nodes + 0.5 % donation), due when an order fills, paid out at resolution |
| custody | USDC on Polygon | the federation's locks (§23.1); no house, no counterparty but the other side's orders |

**0A.7b.1 Resolution.** At the window's end each attestor reads its feed
samples ([{at_ms, price}], integer prices) and computes the price to beat
(the time-weighted average of its readings over the 60 s before the window's
start) and the end price (the same 60 s average before the window's end),
each reading weighted by how long it stood. Up if `end price >= price to
beat`, else Down. **Read, not averaged over the window (corrected 2026-10-10,
comment 1154):** the "TWAP" in Polymarket's rule is Chainlink's
TWAP 60 s *stream*, read at the two ends. Averaging the whole window instead
disagreed with Polymarket in 2 of 4 live windows; end against start agreed
in 4 of 4. The comparison is exact
(integers, no float), so two honest attestors reading the same samples sign
the same outcome. Seats refuse an attestation observed before the window's
end (`resolveAfterCloseMs`, §0A.7a terms). With no standing outcome by the
deadline (`deadlineAfterResolveMs`) the market is VOID and everything comes
back. The source rule is in the manifest's terms as text (`sourceRule`), and
the market dev names the attestors: they are not Chainlink, and a player sees
who they are before trading.

**0A.7b.2 The book.** Complete sets: 1 sat of collateral pays 1 sat to
whichever side wins, so an Up buyer at price p and a Down buyer at 1 - p
together fund a set. An order is `{round, player key, outcome, limit price,
stake (fees included), nonce, expiry}`, signed by the player over its id. A price is
a whole cent (tick 0.01 on a scale of 100,000), and an order buys at least 5
shares at its limit. The seats agree only on **which** orders are in a batch.
`order-book.js` `clearBatch` is a pure function of that set, so every seat
clears it the same way: no arrival order, nothing to front-run.
- **The price** is the Up price that matches the most payout; then the
  smaller imbalance; then the lower price.
- **The short side** fills whole. **The long side** fills better limits
  first, and the marginal limit is shared pro rata, the leftover msat one
  each in order-id order.
- **What does not fill** is not charged: its stake and its fee come back.
  What fills pays its fee (§0A.7b.3).

**Standing orders, every second** (2026-10-09: "Order batches alle 1s,
wenn möglich alle 0.5s"). A player places a limit order at any time, and it
is matched in the next batch. **Batches run every 0.5 s** (`BATCH_MS`;
measured, §0A.7b.5: seven seats agreed every batch's set in at most 275 ms
with real round trips, inside the half second; 1 s was the fallback). What has
not filled **stands** in the book for the batches after, until it fills, its
player cancels it (at no cost), or its expiry passes. An order names
`expiry_ms` in its signed bytes: 0 stands until filled or cancelled
(Polymarket's GTC), a time stands until then (GTD). An order that fills over
several batches is one position. Polymarket matches each order the moment it
arrives because one operator orders them all. Here seven seats would have to
agree on the order of every single order, and whoever orders them can
front-run. A batch only needs the seats to agree on **which** orders are in
it, and everyone in it gets the same price. Measured: `clearBatch` clears
5,000 orders in 27 ms (at most 99 candidate prices at a 0.01 tick).

Selling a position before resolution (Polymarket's sell button) is a later
slice: a sell of Up at p is an order matched against a buy of Up at >= p in
the same batch.

**0A.7b.3 Fees (2026-10-09).** A market's fees are its manifest's:
0.5 % to the nodes and 0.5 % donation by default, at most 5 % each and 10 %
together.
- **The fee falls due when an order fills** ("when an order is filled, the
  fee is of course due too"), on the filled part only. In a pari-mutuel
  market round an entry fills at the round's entry close.
- **What has not filled can be cancelled at no cost**: the player signs a
  cancel with the entry's session key (`POST /cancel`), every seat drops the
  entry from the round, and both its locks come back at once by the return
  door (`GET /forfeit`, and `GET /forfeit?lock=fee` for the fee lock). After
  entry close a cancel is refused: the order is in, and its fee is due.
- The fees sit in the order's fee lock until the market resolves. Then the
  nodes take their part and the donation is paid to the protocol devs' and
  the market dev's keys, from winners and losers alike.
- A VOID market, or a pari-mutuel round nobody picked right, gives everything
  back (rulings "refund at the deadline", "refund the fees too").
- Example: 1 sat on Up pays 0.01 sat in fees once it fills, and 0.99 sat buys
  the odds. At an Up price of 0.73 that is 0.99 / 0.73 = 1.356 sat of payout
  if Up wins.

**0A.7b.4 Still to build.** ~~Market rounds on their own 15 min period
instead of the 90 s grid~~ (AS BUILT 2026-10-10,: a market's series runs on
its manifest's `round_period` - 96 rounds a day for 15 min - and every other game's series stays on the 90 s grid with
its id unchanged; `series.js` reads the period off the template, `series-writer.js` stamps it from the manifest), with lock expiry per round (window end + deadline
+ objection window). The batch record signed by the seats. Cancel at the
seats and the immediate return of a cancelled order's stake and fee locks.
Positions as locks and the payout per share. The reference attestor daemon
(three price sources, `upDownOutcome`). Selling before resolution. The
market page: Up/Down prices, the price to beat, the order entry, positions.

**0A.7b.4a Each order brings its own amount; market and limit orders** (AS BUILT 2026-10-102026-10-10:
"Make the larger protocol change as needed to support both market and limit orders"). In a paid market round an order's
stake is the player's own, 1 sat to 100,000 sat (`order-book.js` MIN_ORDER_MSAT, MAX_ORDER_MSAT); the round's
`stake_msat` is what a plain pick stakes. The seat checks the order's 1 % fee on its own amount. A **limit order** names a
price, a size and an expiry (none: it stands until the round's entry close). A **market order** is an order at most 10c
over the price now with a 60 s expiry: it fills at its batch's one clearing price, and what does not fill expires and comes
back at settlement. Both go through the same entry, deposit and locks; the page hands their locks to every seat until
entry close, since a batch needs 5 seats holding an order's locks.

**0A.7b.5 How the seats agree a batch**. A page posts
a signed order to every seat (`POST /order`), and each seat keeps it with the
time it arrived. Batch k takes what reached any seat before its cutoff,
(k + 1) x the interval in ms since the epoch, so every seat names the same k
from its clock. Its **leader** is the round's seat k mod n, so leadership
rotates: a seat that is down only moves its batches' orders into the next
leader's batch, which takes everything before its own cutoff.
1. A little after the cutoff (100 ms grace, so an order posted just before it
   has landed), the leader asks every seat for its unbatched orders
   (`GET /batch-proposal`) and takes their union, checking each order again. Each seat signs its answer, and refuses a batch that leaves out an order it reported before the cutoff; a leader that then cannot reach the threshold voids and the next leader takes the union (RULED 2026-11-07, kanban #1313: omission by the leader was silence, and a free look at the uniform price).
2. It hands the set and its signature over `batchId` (round, k, the order ids)
   to every seat (`POST /batch`).
3. Each seat checks the leader is the round's seat k mod n, every order, that
   none of them is in another batch there, and that it signed no other set
   for (round, k). It keeps the orders it lacked, marks the set as batch k,
   and answers its own signature over the same id.

Every seat that signed holds the same set, and `bookBatch` clears it the same
way (`GET /book`). Measured with seven seats on one host, every seat-to-seat
request delayed by a round trip measured to a live seat through its tunnel
(p50 56 ms, max 106 ms):

| interval | batches | agreed p50 | p95 | max |
|---|---|---|---|---|
| 0.5 s | 20 | 225 ms | 275 ms | 275 ms |
| 1 s | 20 | 221 ms | 267 ms | 267 ms |

Every batch was held and signed by all seven seats, and all seven cleared
the 40 batches identically. Orders backed by locks, the certificate and the
void are §0A.7b.6.

**0A.7b.6 Positions backed by locks** (comment 1127; 2026-10-09: "Pick (a)").

**Orders and locks:**
- **An order is an entry** with a limit price and an expiry after its pick
  (marker `0xa9`). The player locks first: its stake lock is its budget less
  1 %, its fee lock is the 1 %.
- An order is tradable at a seat once that seat verified both locks with the
  federation. A leader batches only orders tradable at at least the threshold
  of seats.
- No seat holds the money. A lock moves whole: claimed whole, or returned
  whole.
- Only **certified** batches (at least the threshold of seats' signatures)
  are in the book (`book-ledger.js`, a pure function of them).
- A batch that can no longer reach the threshold is **void** (enough seats
  declined it, each signing that it never will). Until then the book waits
  for it.
- Cancels and sells travel inside a batch. In a batch, new orders join first,
  then cancels take their orders' rest out, then expiries, then sells, then
  the clear.

**What each event does to an order's locks:**

| event | in the federation | in every seat's book | return door |
|---|---|---|---|
| match certified | nothing moves | fill recorded | closed (a whole return would hand back filled money) |
| match not certified | nothing moves | no fill; the orders wait (a void batch's go into the next) | unchanged; while pending: "in a batch not decided yet" |
| cancel, unfilled | stake and fee lock back at once, whole | out of the book | open once the batch carrying the cancel is certified |
| cancel, partly filled | nothing until settlement | the rest leaves the book | closed; the rest is paid at settlement (a) |
| sell | nothing | Up and Down shares close into sets; the buyer gets the shares | closed; the proceeds are paid at settlement (a) |
| resolution | every lock with a fill claimed whole in one settlement | | locks with no fill come back whole |

**A sell** of s shares of an outcome at ≥ p is a buy of s of the other
outcome at ≤ 1 − p, paid for by the shares already held. Its cost is owed out
of the complete sets it closes, and its fee is the market's rate of the
proceeds.

**At settlement** each claimed order is paid:
- its winnings (every winning share paid out of the pool of all collateral);
- less its sells' debt and fee;
- plus the unspent rest of its budget;
- plus the part of its fee lock its fills did not use (the fee due is
  `fee lock × filled cost ÷ budget`).

The nodes get their part of the fees due (`nodeBps` of the whole rate,
evenly over the round's seats), and the donation the rest. A filled order's
stake secret is released for this settlement whoever won; an unfilled one's
stays sealed.

Measured (`order-locks.test.js`, 7 seats, measured round trips): every case
above. 8 filled orders settled with 16 locks claimed, 80,000 msat paid out of
80,000 claimed, and a partly filled cancel paid exactly its 1,819 msat rest.
`order-batch.test.js` on locked orders: certified at all seven p50 297 ms,
max 344 ms, so 0.5 s holds (with the 100 ms grace). A batch that must first
void or certify an earlier one took up to 532 ms; the book is then one batch
late.

## 0A.7c Event-market templates *(AS BUILT 2026-10-14, feature 5; docs/PLATFORM-RESEARCH.md)*

**Why.** A market's question lived in its signed manifest, so every new
question ("Will X happen by Y?") needed a newly signed manifest that nodes
choose to host. With a template the manifest says who decides and on what
terms, and **anyone opens a new question by publishing one round of it**.

**The template, in the manifest.** An `ATTESTED` manifest may name, after its
own marker byte `0x04` (behind the market terms, before the required version;
`0x03` is a top split's payout shares, feature 3). The manifest's
trailing fields, each after its own marker and in this order: an attested
game's market terms `0x01` and template `0x04`, a head-to-head game's table, a
top split's shares `0x03` (never two result types' fields in one manifest),
then the required version `0x02`, last:

```text
template {
  category                        // 1 to 32 characters: what kind of question its rounds ask
  max_outcomes                    // 2 to 16: the most outcome labels a round may name
  resolve_within_ms               // the latest a round may resolve after its entry close (at most 30 days)
}
```

Everything a market's trust and money are made of stays the manifest's: its
attestor keys and threshold, its fees, its attestors' deadline and its source
rule - its market terms (§0A.7b.3), **which a template must name**. Its terms'
`resolve_after_close_ms` is then the **earliest** a round may resolve after its
entry close. A template **requires protocol version 2026.0.4 or later**,
as a top split does: its rounds carry their question in a contract tail the
builds of that version read, the census seats a round's nodes only among those
whose advert lists its version - so a seat without the code is never seated
for a template's round - and a node too old to read the field cannot read the
manifest at all, so it cannot host the template. A template runs on no grid (`round_period` 0). Its own
`outcomes[]` label the template itself (its shape, e.g. YES / NO); a round
names its own. The field is optional: **every manifest without it keeps its
bytes and its game id** (asserted against every signed manifest in the repo:
Up/Down 672415c8 / f5f3f187, RPS 1e9ab4b7 / a75f54fd, nextblock 495516ae /
c693585b, hello-world 32ee1aa4).

**The question, in the round.** A Round Contract may carry, **last of all**,
its own question:

```text
event {                           // marker 0xc3, its fields, then its own size (u16) and 0xc3 again
  question                        // 1 to 280 bytes of UTF-8
  outcomes[]                      // 2 to 16 labels, each 1 to 64 bytes of UTF-8, each named once
  resolve_at_ms                   // when its outcome is decided
}
```

It is in the hashed bytes, so the question, the labels **and their order** -
the index the attestors sign - are the round's id. It is read from the end by
its closing marker and size; a contract without it keeps its bytes and its
round id (asserted for all 24 layouts of versions 1-3 with and without
deadline, series, rules and creator). It is read from version 2026.0.4 on and
never on a round of a series (a series round's id `H(series_id || i)` would not
hash its question).

**Which rounds carry it** (`roundFitsManifest`, at `POST /round`): a round of a
template **must**, and a round of any other game **must not** - each refused
by name (409). A template's round names no more outcomes than its
`max_outcomes`, and resolves from `entry_close + resolve_after_close_ms` to
`entry_close + resolve_within_ms`.

**The outcome is the round's.** The attestors sign an index into **this
round's** `outcomes[]` (an attestation is already per round): a seat checks the
range against the round's labels, the signatures against the template's
attestor set and threshold, the observation against the round's
`resolve_at_ms`; the round is VOID at its own `resolve_at_ms +
deadline_after_resolve_ms`, and its locks are sized to last to that
(lock-expiry.js). A pick is in the round's range. `GET /rounds` lists the
round with its `event`, `GET /round` names the question beside the contract's
bytes (`x-question`, `x-outcomes`, `x-resolve-at-ms`), `GET /outcome` answers
the round's question and labels; the page's lobby shows the question from the
contract it checked, not a node's word.

## 0A.7d Markets on games *(AS BUILT 2026-10-15, feature 6, protocol 2026.0.6; docs/PLATFORM-RESEARCH.md item 6)*

**Why.** Every game round already ends in a result its own committee signs.
A market whose outcome **is** that signed result needs no oracle and no
attestor: spectators back BULLS or BEARS of a Tick Tock round, and the
round's 5-of-7 RoundResult (§13) settles them.

**The source, in the manifest.** An `ATTESTED` manifest may name, after its
own marker byte `0x05` (behind the market terms, never beside a template,
before the required version `0x02`):

```text
game_source {
  source_game_id                  // 32 bytes: the manifest id of the game whose rounds it is a market on
  source_kind                     // 1 = ROUND_RESULT: a price round's §13 RoundResult (the only kind)
  mapping[]                       // one byte per value of that result, in order BULLS, BEARS, FLAT:
                                  //   an index into the manifest's outcomes[], or 0xff = refund
}
```

Such a manifest names **no attestors and a threshold of 0** (the fields are
written empty): no attestation decides it, and `POST /outcome` refuses one
for it by name (an empty attestation would otherwise meet a threshold of 0).
It must name market terms (fees, question, `resolve_after_close_ms`,
`deadline_after_resolve_ms`), runs on no grid (`round_period` 0), and
**requires protocol version 2026.0.6 or later**. Every outcome must be
some value's (no pick that can never win). Tick Tock's natural market:
`outcomes [BULLS, BEARS]`, `mapping [0, 1, 0xff]` - FLAT refunds; a three-way
market maps FLAT to a third outcome instead.

**The source round, in the round.** A Round Contract of version 6 or later
may carry, after the creator's key and before a question:

```text
source_round {                    // marker 0xc4, then the id, then 0xc4 again: 34 bytes
  source_round_id                 // the id of the one round of the source game this round is a market on
}
```

It is in the hashed bytes, so the source is the market round's id. With it a
contract's tail is one of the 16 lengths a contract may end with plus 34, and
no tail of those 16 lengths is another plus 34, so the decoder tells them
apart by length - and looks for it **only on a version-6 contract**: a
contract below 6 is read exactly as before (all 48 layouts of versions 4 and
5 with deadline, series, rules, creator and question keep their bytes and
round ids; versions 1-3 as pinned in §0A.7c). Never on a round of a series,
never beside a question. A round of a market on a game **must** name its
source, a round of any other game **must not** (`roundFitsManifest`, 409 by
name at `POST /round`).

**Timing.** The market's entries close **no later than its source round
starts** - before the source's first price sample exists - and its source
round **ends no later than** the market's resolution time (entry close +
`resolve_after_close_ms`). A market round whose entries close after its source
starts, whose source is a round of another game, or whose source ends late is
refused by name (`gameMarketFitsSource`) and can never come to fit: it is
VOID. A source round of a series (Tick Tock's are) has the id
`H(series_id || i)`, which does not hash its times, so its contract is taken
only as its series derives it (`seriesRoundCheck`, or a seat's own stored copy,
which it keeps only after that check).

**What "signed result" means.** For `ROUND_RESULT`: the RoundResult
`{ round_id, open_cents, close_cents, front }` of the source round (§13), its
id (`ARENA/v1/RoundResult`) signed with BIP-340 node keys by at least the
source round's own threshold - `receiptsNeeded(settlement_slots)`, 5 of 7 - of
distinct keys of the source round's **settlement committee as the verifier
draws it** from the census and the beacon (a seat: its roster; a page: the
committee it derived), never the source contract's `nodes`, which a round id
does not hash from version 2. It is exactly the check a page makes to show THE
BULLS WIN for the source round itself. A key outside the committee, a second
signature by one key, or a signature over another result counts nothing.

**Resolution.** `gameMarketResolution` answers the market's outcome (the
mapping of the result's front), a **refund** (a value mapped to `0xff`), VOID
(the source does not fit), or no standing result yet. The market is **VOID -
every stake back, its fee too, as §0A.7b's refund at the deadline** - on a
refund, on a source that does not fit, and when no signed result of its source
stands by entry close + `resolve_after_close_ms` + `deadline_after_resolve_ms`
(a source round that was itself VOID, or never ran, signs no result).

**Not a source kind: head-to-head (RPS).** A head-to-head round signs no
round-level result: each entry's PlayerResult (§13) names one player key and
WIN/DRAW/LOSS as DELIVERED/FAILED and a score, and the round's players are
known only when its entries close - after a market on it must have closed. A
market could name no seat whose result it pays before it is too late to pick.
That kind needs a signed per-table winner first.

**At a seat (as built).** The source round's signed result is **held where
an attestation is held** and settles the market exactly as §0A.7a settles an
attested one (arena-node `game-market.js`):

- **Checked.** Against the source round the seat holds, or - a market's seats
  being another draw than its source's - the source contract fetched from the
  market round's census seats (`GET /round?id=`, through the routed fetch) and
  taken only if it hashes to the `source_round_id` the market names; a series
  round only as a series the seat holds derives it (its id does not hash its
  times, so a seat answering the right id with other times is refused). A
  fetched contract is never written into the seat's rounds. The committee is
  drawn by the seat's own roster on that contract (census root checked against
  the chain, the beacon's seed) - never by the answering seat's word.
- **Held** (`game_outcomes`, beside `outcome_attestations`), once per
  (market round, result), only once the source round has **ended** on the
  seat's clock: the RoundResult's encoded bytes, the signatures of the drawn
  committee that verify over its id (one per key; nothing else of a handed-in
  list is kept), and the source contract - the evidence any seat re-verifies
  the settlement from. `GET /outcome` serves them as `gameOutcome` where an
  attested round serves `attestation`.
- **Settled as an attested market.** Every reader of an attested round's
  outcome (settlement, the return door, the stake-share handout, `GET
  /outcome`) reads the held result as a standing attestation of the outcome it
  maps to: final after the market round's objection window (600 s) from when
  it was held, then the pari-mutuel table (§0A.7a) and its lock settlement by
  the seats' attested sweep. Two standing results of different outcomes - the
  committee contradicting itself - would make it DISPUTED, settled on neither.
- **VOID at once.** A result mapped to `0xff` (Tick Tock FLAT), and a source
  that can never fit the market (another game, entries closing after it
  starts, ending after the resolution time), are held as a VOID (outcome 255;
  a misfit with no result, its source contract as evidence): from then on the
  round is VOID - nothing claimed, every stake back by the return door - not
  only at the deadline. No result by the deadline is VOID as before.
- **On its own.** A seat hosting a market on a game sweeps every 10 s
  (`ARENA_APP_MARKET_SWEEP_MS`): each round of its store is looked at **once**,
  behind a rowid cursor; a market round on a game with nothing held is
  remembered as pending and tried only when due - from its entry close (the
  source contract), from its source round's end (the committee's results), then
  every 30 s, at most 4 a pass - and leaves for good once an outcome or VOID is
  held, or at its deadline. It asks each seat of the source's committee for
  `GET /round-result` (and its own where it sits on it), groups the answers by
  the result signed, and holds the first group that stands: a seat answering
  another open or close signs another result and counts only towards that.
- **`POST /game-outcome?round=<market round id>`** stays the way for anybody
  to hand a seat the result sooner: `{ openCents, closeCents, front?, sigs:
  [{ key, signature }] }` - what each source seat answers at `GET
  /round-result`. Checked as above (fetching the source if the seat does not
  hold it) and held: 201 when new, 200 when held already, with the round's
  outcome as `GET /outcome` answers it; 409 by name when it does not stand,
  before the source ended, or the seat cannot draw the source's committee.

Left: the page's market lines. **Dormant until seats advertise 6**: a
version-6 round draws a committee only from nodes whose advert lists 6.

## 0A.7e Scalar markets *(AS BUILT 2026-10-15, feature 8, protocol 2026.0.7; docs/PLATFORM-RESEARCH.md item 8)*

**Why.** "A numeric outcome (a price, a count) paid linearly between bounds.
Richer questions than buckets; one market instead of many." One market asks
"BTC/USD at 18:00 UTC, in cents?" where buckets needed one outcome per range.

**The scalar, in the manifest.** An `ATTESTED` manifest may name, after its
own marker byte `0x06` (behind the market terms, never beside a template or a
game source, before the required version `0x02`):

```text
scalar {
  low                             // i64: the lower bound, a whole number in `unit` (may be negative)
  high                            // i64: the upper bound; low < high, refused by name otherwise
  unit                            // 1 to 16 characters: "cents", "blocks", "tenths °C"
}
```

Its `outcomes` are exactly the two **sides**, `[LONG, SHORT]` (LONG = pick 0,
SHORT = pick 1); its attestors are k of n as for any attested market; it must
name market terms (fees, question, `resolve_after_close_ms` - when the value
is read - and `deadline_after_resolve_ms`), and it **requires protocol version
2026.0.7 or later**. **No round byte changes**: a round of a scalar
market is an attested round whose entries pick a side; `roundFitsManifest`
refuses a round of it below version 7 by name. A node too old to know the
field cannot read the manifest (trailing bytes); every manifest without it
keeps its bytes and its game id.

**The value, in its own message.** The attestors sign the observed value V:

```text
ValueAttestation {                // type 0x2a, written at protocol version 7
  round_id                        // 32 bytes
  value                           // i64, in the manifest's unit
  observed_at_ms                  // u64
  signatures[]                    // { attestor key, Ed25519 signature over the body's id }
}
id = H_tag("ARENA/v1/ValueAttestation", body)
```

Its type byte (`0x2a`) is not an outcome attestation's (`0x1d`), its body
names version 7 (a decoder refuses one below 7), and its id is taken under its
own tag - so **an outcome index can never be replayed as a value, nor a value
as an index**: neither the bytes nor a signature cross. And each door asks the
kind its market reads: `attestationStands` refuses an outcome attestation for
a scalar market, `valueAttestationStands` a value attestation for any other.
It stands by the manifest's threshold of distinct attestor keys and must be
observed at or after the market's resolution time, as an outcome is.

**The payout** (`scalar.js scalarPayoutTable`, integer msat only). Each
entry's fee and donation come out of its stake first (§0A.8, as pari-mutuel);
T is the net pool of both sides. V is clamped to `[low, high]`;

```text
LONG share  = floor(T * (V - low) / (high - low))
SHORT share = floor(T * (high - V) / (high - low))
the 0 or 1 msat the two floors leave -> the side of the entry first in ascending entry id
each side: floor(share * net / side_net) per entry, the leftover msats one each in ascending entry id
```

Nothing is invented or kept: fees + donations + payouts = stakes, payouts = T.
The LONG total never falls as V rises (it is floor or ceil of its exact share)
and SHORT's never rises; one entry may step 1 msat against V where the named
remainders move. Swapping every pick and mirroring V to `low + high - V` pays
every entry the same.

**Edge cases, decided.** V at or beyond a bound pays as that bound (LONG takes
the whole pool at or above `high`, SHORT at or below `low`). **One side only**
- nobody on a side, or a side that staked nothing against one that did - has
no counterparty: it is **refunded**, every stake back, its fee too, exactly as
a pari-mutuel round "nobody picked" (`scalarOneSided`). No entry: refunded. A
free round of both sides: each gets its 0. No value by entry close +
`resolve_after_close_ms` + `deadline_after_resolve_ms`, or two different
values standing (DISPUTED: the pair is the proof): **VOID**, every stake back.

**At a seat (as built).** `POST /outcome?round=` takes a value attestation's
bytes beside an outcome attestation's (told apart by the type byte); a
standing, timely one is held in `outcome_attestations` (its outcome column
-1, the value in its bytes) and every reader of an attested round's outcome
reads it back as the value (`game-market.js heldOutcomes`;
`attested.js outcomeStanding` answers `{ ATTESTED, value }`, two values
DISPUTED). Final after the round's objection window (600 s), the settlement
makes the scalar table (`attestedTable`) and pays it by the lock rule
(`attestedLockSettlement`): a lock moves whole, so a row paid **less** than its
net stake has its lock claimed and its rest paid back to its own key, and a
row paid **at least** its stake keeps its lock (the return door hands it back)
and is paid the excess from the claimed locks. The stake-share handout
releases exactly the claimed rows' secrets; the return door hands every stake
and fee back at once for a one-sided round. `GET /outcome` adds `scalar
{ low, high, unit }`, `value`, `clamped`, the scalar `table`, and
`valuesNamed` when DISPUTED.

Since built: the page's market lines (the value checked against the
manifest's attestors, its unit, where it pays and what a side got back) and
the value-signing attestor (`arena-attestor --mode value`), and an order book
for scalar sides (2026-10-15): a round is a book or a pool, as any two-outcome
market; at resolution a LONG share is worth (V - low) / (high - low) of a sat
at the clamped value V and a SHORT share the rest, so the book's pool is split
between the sides by where V lies (LONG's part floored, SHORT the rest) and
within a side pro rata by shares - every msat paid out or due as a fee
(book-ledger.js `bookSettlement` `scalar`). **Dormant until seats advertise
7**: a version-7 round draws a committee only from nodes whose advert lists 7.

**Scalar templates** *(AS BUILT 2026-10-15, protocol 2026.0.8)*. From version 8
a scalar manifest may also be a template (§0A.7c): anyone opens a numeric
question by publishing one round of it. Its `max_outcomes` is 2, and its
`scalar` bounds are then the **range** a round's bounds must lie in, in its
unit. A round names its own bounds inside its question's tail, after its
resolution time:

```text
event {                           // as §0A.7c, and on a round of a scalar template:
  ...                             //   question, outcomes[] (its two sides, long then short), resolve_at_ms
  low, high                       // i64 each, low < high, inside the template's bounds - version 8 only
}
```

They are in the hashed bytes, so they are the round's id; a round below 8
naming them is refused by its decoder, and every question without them keeps
its bytes. `roundFitsManifest` holds a scalar template's round to naming
bounds inside the template's, and every other template's round to naming
none. The round is paid between **its** bounds: `marketOfRound` gives the
round's view, which the value check (clamping), the table every settlement,
stake handout and `GET /outcome` reads (`attestedTable`), and the page read.
A version-8 manifest; dormant until seats advertise 8.

## 0A.8 The money: 10% of the gross stake

*(2026-10-16: with the protocol reserves the split becomes nodes 4 %, developers 4 %, reserves 2 %, and items 40 / 40 / 20 - §27A.9, not yet built; the table below is the split in force.)*

RULED (2026-10-06):

```text
stake (gross, what leaves the wallet)              100%
  nodes, mandatory                                  5%   -> three equal pools, 5/3 % each:
                                                            game/verify, settlement, guardian (§22A)
  protocol devs, donation, default                 2.5%  -> the network's donation set (§27A.4)
  game dev, donation, default                      2.5%  -> the round's game's donation set (§0A.3)
  net stake                                      >= 90%  -> the pool
```

- **Gross**: all of it comes out of the stake the player chose, as today
  (§22A, "inclusive").
- **The nodes' 5% is mandatory**, as the 2% was.
- **The 5% to developers stays a donation**: the default is 2.5% to the
  protocol devs and 2.5% to the game dev, and the player may lower it, down
  to zero, in settings. RULED HERE: one choice, `0 1 2 3 4 5 %`, default
  **5%**, always split half to the protocol devs and half to the game dev;
  a client may not offer more than 5% without §22A's second confirmation.
- **When the protocol devs and the game dev are the same recipient** - as
  for nextblock - the client pays that recipient once, the sum of both
  halves; the shares are still computed separately, so the split is the
  same whoever the recipients are.
- Free rounds carry no fee and no donation.

**The round's auditors** *(protocol 22, §13A.1)*: after the website's line, **10% of the nodes' part** goes to the
auditors whose `AUDIT` arrived in time, equally; none, and it stays with the pools. The player pays nothing more.

**The website that brought the entry** *(RULED 2026-10-15, 
roadmap item 7, path (a); AS BUILT, protocol 2026.0.9)*: an entry may name the
33-byte payout key of the page that brought it (`frontend_pk`, marker `0xac`,
last of the entry, in its signed bytes - so no seat can swap it). At
settlement that key is paid **10% of the nodes' fee on the stakes it
brought** (20% until 2026-10-25, kanban #675: "reduce fee to 10%"; no
website had been paid by then) - `fee x 10% x stakes_brought / gross`,
floored, of the nodes' fee
table's own fee and gross - **out of the nodes' 5%**, as one line off the top
of the nodes' part of the fee locks; the nodes share the rest. **The player
pays nothing more**: the stake, the fee lock (5%) and the donation are what
they would be without it. Only on a round of version 9 or later (a seat
refuses the entry otherwise, by name), so its seats are only nodes that pay it;
every entry without it keeps its bytes. **An order book** (comment
2295) pays the same 10% of the nodes' part of the fees each claimed order paid
(its buy and sell fees x `node_bps / (node_bps + donation_bps)`), floored per
order, as a line before the seats' in its settlement (`bookLockSettlement`,
fee.js `frontendBookShares`); the donation's part and every order's own out
are unchanged.

## 0A.9 Protocol version 1, and the move from BLWP

**Every wire tag is renamed (RULED 2026-10-06), so every id changes.
BLWP never ran on a public network, so this is Bitcoin Arena protocol
version 1, not a version 2 of anything (2026-10-06).** RULED HERE:

- tagged hashes move from `BLWP/v1/...` to `ARENA/v1/...` and the
  publication magic from `"BLW"` to `"ARN"`; `protocol_version` stays **1**;
- mainnet has nothing to move: it starts as Bitcoin Arena with its own
  genesis and `network_id`, and no successor-network rule (§27A.8) applies;
- testnet4 and regtest are test networks: the new tags give each a new
  `network_id`, and what runs there now is test operation, not a public
  history. In practice on testnet4:
  - **bonds are kept by re-affirmation** (§27A.8.3's transaction): one small
    transaction per operator, no bond spent, no new maturity - a confirmed
    bond stays the bond (§5A.2) - then an advertisement update naming
    `hosted_games[]`;
  - **the federation does not change** (its id is its guardians' names and
    addresses, not a BLWP tag), so the player wallets' e-cash carries over;
  - the series already posted under the BLWP tags run out and settle as they
    are; no new one is posted once Bitcoin Arena rounds open; a seat may run
    both until the last BLWP round is settled;
- nextblock's first manifest is published before the first Bitcoin Arena
  series, with the protocol devs and the game dev the same donation set.

---

# 0. Original game concept — the foundation BLWP preserves

Arena is the P2P/network/settlement redesign of the existing **BTC Logistics
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

Arena simplifies the financial model to **fixed-stake round brackets** but
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

Because Arena replaces house odds with player-versus-player pooled
competition, truck balance belongs to the Round Contract and the game rules
rather than to a recalibrated house multiplier.

## 0.5 Terrain, armies and combat

The financially relevant world includes deterministic logic for terrain,
armies, fire, truck movement, hits, damage, cargo effects, the delivery
gate and mission timeout. Existing logic (e.g. `Army.cs`) is extracted into
the deterministic Rust core. Unity may keep richer visual physics and
suspension, but settled state comes from the core.

## 0.5A The front is the price — a dynamic candle front *(new, 2026-09-16, the owner)*

The battlefield's front line is the live Bitcoin price laid across the map as a
chart. This is the game's premise (README: "the live Bitcoin price chart is the
battlefield") and it is now stated as a rule the core, the transcript and the
result screen all carry. WAR_TACTICS.md §4.13-§4.14 and §0.2 are the normative
text; this section is what the protocol commits to.

- **The front is a price history.** The core holds a tape of 64 price samples
  in USD cents. Laid from the post office (oldest) to the miner (newest), its
  21-sample moving average is the seam the two armies fight over: a rising
  price moves the bull line forward, a falling one the bear line. It is seeded
  per round and **moves during the round** as samples arrive - one per 5 s -
  so the front scrolls and redraws while the player drives, and the armies
  follow it at their own speed.
- **The front is candlesticks, and the candles are terrain.** Ten seconds -
  two samples - make a candle, 32 on the ground (the last 5 min 20 s; the
  HUD chart shows the whole round since `start_time`, 250 candles at 41 min): a 1 m plateau as wide as its slot, bodies touching into a
  raised ribbon the truck drives along, a 4 m ramp at 25% on every free
  edge, no wall and no corridor, the wick a 0.5 m ridge of the same ground, no glow, nothing above 1 m - green up, red down, readable from
  above and from the cab. The plateaus and wicks are in the core's ground
  (`surfaceAt`), so they are settled state like the relief and the craters:
  a hull-down tank sits behind a candle's edge, a rifleman hides under its
  lip, a heavy truck may not make the climb, and every node replays the same
  chart at the same metre. The chart spans the field between the two buildings and scrolls
  continuously toward the post office at 0.58 m/s as samples arrive; its
  HIGH, LOW and the crossing of the round's OPEN are the war's objectives
  (WAR_TACTICS.md §4.11, §4.15).
- **The price is shown to the cent**: `$75,000.02`, always, with the lead
  against the round's open beside it (`BULLS +0.42%`).
- **The price decides who wins the war - not points.** There is no simulated
  winner: it is bulls against bears, and the price at the end of the round
  against the price at its start decides. Higher: **THE BULLS WIN**. Lower:
  **THE BEARS WIN**. Objectives, kills and ground are how the war looks; none
  of it counts. The chart fights the war: when the price rises the bulls
  attack, press along the whole front, hit harder and are resupplied faster,
  and the bears are pushed back and die faster; when it falls, the reverse;
  sideways, both fight over the chart's HIGH, LOW and OPEN (WAR_TACTICS
  §4.14). During the round the HUD shows the lead
  (`BULLS +0.42%`); a run's end screen shows the lead at that moment beside the
  truck's own result - DELIVERED / WRECKED / MISSED, the score, the sats; the
  round's end and the settlement carry the verdict. The war's winner is the
  market's; the truck's result is the player's; the score (§0.15) reads only
  the truck.
- **The price is world input, not player input** (§11): every node replays the
  same front, or the transcript does not replay. A player cannot move the
  market, and the armies do not read the truck.

## 0.6 Route choice and battlefield exposure

```text
front / combat corridor   = greater exposure and danger
normal route              = intermediate exposure
edge / boundary route     = lower exposure and danger
```

The original house-banked design turned exposure into payout multipliers.
Arena does **not** keep the house multiplier, because the economics are now a
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
settled Arena competition.

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
Contracts, session data and protocol messages. No email or password. Wallet
identity and game identity need not be the same key.

**Display name (2026-09-08, M3; key ruled 2026-09-12).** Default is
derived from the player's **identity key** - the tab's stable key, never a
round key - so every client shows the same string for one player in the lobby,
on the board and in every round:
`taggedHash('BLWP/v1/DISPLAY_NAME', identityPubkey)` → `adjective-animal-NNNN`
(64 adjectives, 64 animals, four-digit number). Locked in
`packages/arena-protocol/src/display-name.js`, the only wordlist that names a
player. The name is **changeable**: a custom
name lives next to the secret in the browser, may be published to the round's
seats as a player-signed display record (the other players' pages verify it
before they draw it; a seat can omit it, never invent it), and is never on the
signed final. Other players' rows - seated view, lobby, board - show the name
from their verified display record: the custom name if they chose one, else
the default from the identity key the record carries. The
LNURL-pay `comment` on donations (rounds published with an LNURL set only;
a key set pays inside the federation, §22A) is the player **public key as
hex**, not the display name (2026-09-08). It is omitted if
`commentAllowed` is under 64 characters.

**Browser key (M3).** The secret is stored in the browser (`arena.player.v1`)
with a backup download/import the player triggers. It is never uploaded to a
node.

## 0.13 Original money model vs Arena money model

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

## 0.14 Arena P2P success pool

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
49 players, all starting together, mission time 82 seconds. She
picks a truck and cargo, commits 100 sat from her player wallet (topped up
from her external Lightning wallet when it runs low, §24A.1),
and rolls out. She steers, brakes, chooses her route, meets deterministic
armies and fire, takes damage, sees competitors as ghosts, reaches the gate.
Independent Arena nodes replay her authenticated input history and confirm
`DELIVERED, score 18,321, THE BULLS WIN (+0.42%)` - the price rose over the
round, the bull line pressed while she drove, and the end screen says so
beside her score and her sats. After membership and results are finalized, her
rank determines her share of the loser pool, collected into her player
wallet the moment it is available and withdrawn to her external wallet
whenever she likes.

## 0.17 What changes technically

```text
BEFORE:  Unity WebGL -> authoritative shard -> central ledger
         -> wallet daemon -> Lightning

AFTER:   Unity WebGL -> deterministic Rust/WASM
         -> independent Arena node quorum
         -> independent settlement quorum -> Lightning
         -> external player wallets
```

The gameplay fantasy stays the same. The trust architecture changes.

## 0.18 Deliberately removed from the original central concept

Central authoritative game server; central player ledger; persistent
custodial balances; operator hot-wallet float as bankroll; house-backed
multipliers; 90% RTP target; global operator calibration; mandatory 10%
house fee; central withdrawal endpoint; one operator deciding results.

A balance the player holds himself, as e-cash under his own seed (§24A.1)
is not a custodial balance: no operator holds it or can move it.

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

One downloadable server package, `arena-node`, plus the browser client.

```text
OPEN SOURCE CLIENT
      |
      v
arena-node software
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

**Thresholds changed.** An earlier draft used 3-of-5 and 2-of-3. Two colluding
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
/arena-node
/replayer
/test-vectors
```

`/arena-node` contains all server-side capabilities: entry and checkpoint
handling, transcript storage, replay and signing, and optional Lightning
settlement support. No proprietary daemon is required.

GitHub may be primary, but no domain or account is authoritative. Anyone may
build and host the client, run the node, enable either role, create rounds,
build a competing frontend or a compatible client. No API key and no
developer approval is required.

---

# 5. Unity vs deterministic core

**The truck game is one use of this network** (2026-09-15). The seats
and the federation are a generic consensus and custody layer. They replay
and settle a named core (`sim_wasm_hash`) and the round's rule set
(`config_hash` / `game_config`); they do not embed truck, cargo or map. A
second game is a new core + client on the same nodes and federation. **Several
games and several rule sets run at once** (2026-09-15 08:07): each
round names its core and its rules; two titles and two configs can be live
on the same seats in the same window. Not a rewrite of the seats. M3 keeps
that split as far as it will go.

Unity is not trusted for money. Unity handles rendering, audio, UI, input
capture, animation, ghosts and lobby. A deterministic core compiled to
WASM handles the settled world: in this title, vehicle state, movement,
world collision, damage, cargo, enemies, delivery, failure, timeout and
score.

Requirements: fixed-point arithmetic; deterministic simulation; fixed
protocol tick; no Unity PhysX for settled state; canonical serialization;
versioned `sim_wasm_hash`.

**Build trust.** The `sim_wasm_hash` is chosen by the round creator,
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
  operator_id                  // SELF-DECLARED, not proof of identity; siblings for seating (§5A.13)
  supported_protocol_versions
  roles_supported              // game_verify | settlement | both | none - opt-in (below)
  endpoint, region, capacity_class
  software_hash
  settlement_capabilities
  lightning_capabilities
  bond_outpoint                // MANDATORY; the census entry itself (§5A.2)
  bond_script_template_version
  bond_maturity_height         // templates 2 and 3: the height in the recovery leaf (§5A.3B)
  census_key                   // template 3: the key path B names (§5A.3B)
  slash_presig                 // template 3, in an update only: the bond's own, 65 bytes (§5A.3B)
  payout_pubkey                // where fee shares are paid
  guardian_of[]                // (federation_id, guardian peer key) this operator runs (§23.6)
  guardian_capable             // the third role, opt-in: willing to hold custody as a guardian (§23A.2)
  guardian_endpoint            // the fedimintd API endpoint the client and the seats use (§23A.4)
  hosted_games[]               // Arena v1: the game_ids this node hosts, opt-in (§0A.4); game/verify is drawn only from hosts
  timestamp
  signature                    // by node_pubkey over all of the above
}
```

The advertisement is **not** what makes a node eligible. The bond output is
(§5A.2). The advertisement is the body that the bond output commits to, so
that chain data alone identifies both the node and its terms.

**Every role is opt-in (RULED 2026-09-21).** A node says in its
advertisement what it takes part in, and is drawn for nothing else. The
three roles are independent: `game_verify` (replay and sign results),
`settlement` (hold a share of the preimages and sign the settlement
transaction - signing, not holding money), and `guardian_capable` (hold
custody as a guardian of a federation, §23A). Any combination is valid,
including none, and an operator who wants no part of custody simply leaves
`guardian_capable` off and is never in a guardian sortition. No role is
implied by another, no role is implied by the bond, and no fee share is
paid for a role a node did not take (§22A). A node changes its roles with an
**advertisement update** (§5A.2) - never a new bond - effective at the next
`census_height`;
turning a role off while serving it is a departure and follows the notice
of that role (§23A.5 for a guardian; a seat serves out the rounds it sits
in). Nothing is slashed for a role a node never advertised.

## 5A.2 Census anchoring — the census is Bitcoin chain state

An earlier draft said advertisements are "canonicalized" without saying how independent
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
census objective. It is paid **once**.

**A bond, once confirmed, stays the bond (RULED 2026-09-28 07:39).**

- **It does not expire.** A bond output that has confirmed and is unspent
  is the node's bond at every later `census_height` - for every later
  round, across every restart of the node, and across every new
  advertisement of the same `node_pubkey`. Nothing in this protocol ages a
  bond out, replaces it or asks for it again. `bond_maturity` (§5A.3B) is
  the earliest height at which the node may take its money back, not a
  height at which the bond stops counting: an unspent bond past maturity
  is still the bond. A bond stops being the bond in exactly two ways: it is
  **spent** (by the node, by a cooperative close, or by a slash), or it is
  knocked out by a proof that it was spent (§5A.3B). A spend through path B
  of a template-3 bond is neither: its hold output stays the bond (§5A.3B).
- **The funding spend is the bond's birth.** The transaction that spends a
  funding output into the bond output **creates** the bond. That the funding
  output is spent is not an objection, not a spend of the bond, and never
  evidence against the census entry; only a spend **of the bond output
  itself** is (§5A.3B).
- **A node never posts a bond it already has.** On start, on restart, for a
  new round, and for a new advertisement, the node first looks on chain for
  a confirmed, unspent bond output committing to its `node_pubkey`
  (template, `BOND_MARKER`, §5A.3). If one exists, **that is the bond** and
  the node's bond-posting path (`postBond` in the reference node) is not
  taken. The posting path runs only when no such output exists, or when
  the operator asks for an **additional** bond to raise the node's weight
  (§5A.10B: several bonds, weight is their sum) - an addition, never a
  replacement.
- **A new advertisement is an update, not a new bond.** The bond commits,
  at its creation, to the node's first advertisement. Every later one is an
  **advertisement update**: one small transaction that pays the
  `BOND_MARKER` dust (so it is findable, as a bond is), carries
  `OP_RETURN "BLW" ADV bond_outpoint H(NodeAdvertisement)`, carries the body
  in its witness (§25.1), and is signed by `node_pubkey`. It spends no bond
  and starts no maturity clock. The census reads, for each unspent bond, the
  **newest valid update confirmed at or below `census_height`**, else the
  advertisement the bond committed to at creation. An update whose
  `node_pubkey` is not the bond's is not an update of that bond.

## 5A.3 Eligibility — objective criteria only

**RULED 2026-11-07 (spec review, kanban #1291).** Two limits on the absence machinery. (1) **A weight cap on the absence claim:** the census a duty node posts may leave out at most 20 % of the chain census's bonded weight per day, oldest-missed first; the rest stays in whatever the certificates say, and a client refuses a committed census whose weight is under 75 % of the chain census it can see itself. Before this, three heartbeat certificates (5 of 9 drawn, ~10 % per slot at 30 % of capital) could evict the whole honest census for a day and run every round, panel and auditor of the day on the attacker's seats. (2) **The duty order is not grindable:** rank by `H(duty tag || network_id || d || bond outpoint)` drawn bond-weighted as every committee is, never by the node key (§5A.4 already says a key hash is grindable). On a day with no confirmed primary of an item, the emergency grids of the day's rank-1 node count for no proofs (its rounds are still played; ranks 2 and 3's grids still count). This is read from blocks alone, so seats and clients read it the same; a conflicted primary is never mined and cannot be seen on chain, so the earlier wording "conflicted by its own coins" is withdrawn (RULED 2026-11-08, kanban #1348).

Every eligibility criterion must be decidable from chain state plus the
committed advertisement body. Nothing else may enter, or the census stops
being canonical.

**Eligible iff all of:**

```text
bond output exists at census_height, unspent, >= census_confirmations deep
                                               (its hold output stands for it, §5A.3B)
bond output uses the protocol's bond script template (5A.3B)
template 3: its slash_presig at bonding >= census_confirmations deep (5A.3B)
bond_amount >= bond_min(role)
committed advertisement body retrievable and hash-matching
advertisement signature valid under node_pubkey
advertisement declares the role and a supported protocol version
advertisement declares serving = true          (2026-09-28, below)
node is not absent from its seatings           (protocol 22, kanban #727, below)
node is not stalled in its rounds              (protocol 26, kanban #1052, below)
```

**Stepping out without unbonding** *(RULED 2026-09-28)*. A node that
will be offline - maintenance, a move, retirement - publishes an
advertisement update (§5A.2) with `serving = false`. From the first series
whose `census_height` is at or above that update's block, the node is not in
the census and is never drawn; its bond stays confirmed, unspent and valid
(§5A.2), and it keeps the rounds of series already created (at most 72 h
ahead, §5A.5 - those draws are fixed). An update with `serving = true` brings
it back from the next census in the same way. The fee is the node's own; no
bond moves and no maturity clock starts. A node that stops answering without
stepping out is not punished for the absence itself - it earns no fee share
(§22A) and yields its seat to the reserve (§5A.7) - but it wastes the reserve,
so the reference node warns its operator when it has missed three seatings in
a row and offers the `serving = false` update.
From protocol 22 a node that stops answering for a whole day is also taken
out of the census by the rule below, without its operator; the warning stays,
because a node stepped out by its own update costs no reserve at all.

**Absent from its seatings - only nodes seen in the last 24 h are drawn
(protocol 22; RULED 2026-10-27, kanban #727).** Measured on testnet4
2026-10-27: every Up/Down v23 round drew 9 nodes, 7-9 of them stopped test
nodes whose bonds were still locked, so no round was seated all day. the owner:
"Können die adverts nur gezogen werden von nodes die in den letzten 24h auch
online waren?" - yes, from 2.0. "Online" from pings is not a fact two seats
share, so the rule reads only threshold-signed certificates: of seatings
(§5A.7) and, so that one day is enough, of heartbeat slots (below):

```text
window      (T - 24 h, T], T = the median time past of the census_height block
seating     one (round, role) whose seating_close falls in the window and whose
            protocol-22 seating certificate stands: every seated node signed
            the SEATING and a SEEN naming who was present (§5A.7)
slot        the heartbeat slot (round, 0) of a 22 round that seats itself
            (one per round, the owner 2026-10-27), closing with its seating,
            whose heartbeat certificate stands: 5 or more of the slot's 9 committee members
            signed a HEARD naming who they heard (below)
present     named in the SEEN of any seated node of the certificate, or seated;
            for a slot, named in any signer's HEARD, or a signer
missed      drawn for the seating by the round's own draw - or left out of the
            round's census as absent, as every seated node's SEEN says - and
            not present; for a slot, in the round's census (or left out by
            it) and not present
absent      in the census by every other criterion, present at no seating or
            slot the claim names, and missed at ABSENCE_PROOF_SEATINGS = 3 or
            more seatings or slots whose closes lie at least
            ABSENCE_PROOF_SPACING_MS = 1 h apart
census      from protocol 22: every output of an absent node is left out (a node is
            its key); census_root (§5A.4) is taken over what is left
```

This extends the reserve-seat rule above rather than adding a new one: a
node "that stops answering without stepping out" was already counted as
missing seatings (the three-in-a-row warning); now a day of nothing but
misses also leaves the census. It is still no punishment - the bond is
untouched, nothing is slashed, and the node comes back by itself.

- **Absence only with proof** *(RULED 2026-10-27; the owner: "can it be
  manipulated which nodes are offline so others are chosen?")*. As first
  built, the posting node chose the absent from the PRESENTs it had
  collected, and a seat could refuse that only with a signature it happened
  to hold. A posting node could ignore PRESENTs and declare honest nodes
  absent - "drawn in the window" limited nothing, since nearly every node is
  drawn every day - and shrink the census to raise its own and its
  colluders' share of every draw. So now a node may be left out only on
  threshold-signed seating certificates that show it missed: the claim
  names, for each absent node, 3 seatings, and attaches their certificates.
  Every seat **and the client** checks each one deterministically, on its
  own draw of that seating: the certificate stands against the round's own
  draw (every seated node signed it, at least the threshold, in score
  order), the node was drawn there (or the round's census had left it out
  already), no seated node named it present, and the closes are three
  different times in the window. An absence without valid proof makes the
  census invalid at every seat and at the client. That is a plain validity
  check of what the census root committed, like any other census check -
  not the "a refutation spreads from seat to seat" path the owner rejected.
  To hide an honest node's PRESENT, every seated node of a seating must
  lie, at three seatings, each of a different random draw.
- **Not for a few missed seatings** *(RULED 2026-10-27, against an attacker
  flooding a node while it is drawn)*. One or two missed seatings - a
  restart, a network blip, a denial of service timed to its seatings - keep
  a node in. So does one listed presence anywhere in the 24 h. A node drawn
  for fewer than 3 seatings, or for none - a new bond, a small weight, a
  quiet day - had too little to be seen at, and is kept. The two roles of
  one round, or two grids' rounds at one moment, share a seating_close and
  count once, so one blackout is one miss. The 3 is
  `ABSENCE_PROOF_SEATINGS`, a protocol constant.
- **Three misses an hour apart** *(kanban #727, the owner 2026-10-27: not out
  for a short outage)*. With a heartbeat slot every 15 minutes (and more
  than one grid's rounds), a 30-minute restart misses three slots in a row.
  So the closes a proof counts must lie at least 1 h apart
  (`ABSENCE_PROOF_SPACING_MS`), seatings and slots alike: one outage shorter
  than 2 h - a restart, an upgrade, a blackout - is never proof, and an
  attacker who floods a node must do it at three moments an hour apart,
  each time while the honest posting node would still find the node
  present at the rest of the day (below).
- **Seatings alone were too slow.** A round with fewer than 5 present has
  no seating certificate, so it proves no one absent, and a seating proves
  only its 9 drawn missed. On the 10-27 shape (28 bonded, 20 stopped;
  arena-protocol `presence.test.js`, both roles of a 15-min grid, every
  certificate signed for real) seatings alone seat 1 round of 96 on the
  first day and prove 1 node absent; the next day 7 and 12; the day after
  47 and all 20. Three days of rounds drawn mostly from stopped nodes.
- **The heartbeat** *(RULED 2026-10-27, kanban #727; the owner chose a
  heartbeat so a stopped node is proven out within a day, and one slot per
  round)*. Every 22 round that seats itself (not a table's later rounds,
  which share its first round's draw) has `HEARTBEAT_SLOTS_PER_ROUND` = 1
  heartbeat slot, closing with its seating: a 15-min grid gives a slot
  every 15 min, 96 a day. The slot has a **committee** of
  `HEARTBEAT_DRAWN` = 9 node keys of the round's census, drawn as its
  committees are (one key one seat, weighed by bond, §5A.6) on its own
  seed `H("ARENA/v1/HeartbeatDraw" || committee_seed || j)`, j = 0 - not
  the round's seats, and the same 9 at every seat and at the client, from
  the census and beacon they already check for the round. Every node of
  the round's census, and every node its census left out (that is how it
  comes back), signs `HEARTBEAT(round_id, j, node_pubkey)` in the minute
  before the slot closes and hands it to the 9 (`POST /heartbeats`). A
  member keeps the HEARTBEATs of census nodes until the close and none
  after; then each live member signs `HEARD(round_id, j, heard, left_out)` -
  every node it held a HEARTBEAT of, and the nodes the round's census left
  out - and hands it to the other 8 (`POST /heard`). The **heartbeat
  certificate** is the HEARDs of at least `HEARTBEAT_THRESHOLD` = 5
  distinct members, grouped by identical lists. Every node a signer lists,
  and every signer, was present at the slot; every other node of the
  round's census, or left out by it, missed it - not only the drawn. A
  proof names a slot as role `heartbeat-0`; it counts with seatings toward
  the 3 misses an hour apart, and a listing in either keeps the node in. A
  seat that held a node's HEARTBEAT in the window refuses a census that
  leaves it out, as it does with a PRESENT.
- **Why the heartbeat is faster.** A certificate needs 5 live members of
  one random 9, as a seating needs 5 live of its drawn 9; but each
  certificate proves every stopped node missed at once, where a seating
  proves only the stopped nodes it drew, and the slot's 9 are a second,
  independent draw beside the round's seats. On the 10-27 shape with the
  heartbeat (arena-protocol `heartbeat.test.js`, one slot per round, every
  certificate signed for real) the first day has 4 seated rounds and 10
  heartbeat certificates of 96, and its census leaves out all 20 stopped
  nodes; from the next day every round is seated (96 of 96) and every slot
  certified (96 of 96), and no live node is ever proven absent. Over 100
  simulated days of that shape a stopped node is proven out within one day
  on 83 % of them (seatings alone: 1 %).
- **Why it is safe.** The certificate threshold stays 5 of 9 even when most
  nodes are down: a slot with fewer than 5 live members simply has no
  certificate, and proves nothing. So **no group of fewer than 5 nodes can
  make a heartbeat certificate at all**, ever, and one honest member's
  HEARD keeps every node it heard in. `2 x 5 > 9`: two certificates of one
  slot share a signer, and a member that signed two different HEARDs for
  one slot has equivocated. To leave out an honest node a group must hold 5
  of the 9 seats of the beacon's random draw at three slots an hour apart in
  one day, **and** post the census (the day's duty node), **and** the
  honest seats - which hold the honest node's HEARTBEATs, handed to 9
  members every 15 min - refuse that census. How often a group holds 5 of a
  slot's 9 seats on a 28-node census (`heartbeat.test.js`, 20 days of 96
  slots): 4 and 5 nodes never; 6 nodes 0.35 slots a day, never 3 an hour
  apart; 7 nodes 1.5 a day, 3 an hour apart on 2 of the 20 days.
- **The trade-off, as ruled** *(the owner 2026-10-27: one slot per round)*.
  Any rule that lets a few live nodes prove many stopped ones out in a day
  lets as many colluding nodes produce the same proofs against honest
  ones: from the certificates alone, "8 nodes are up and 20 are stopped"
  and "8 nodes pretend the other 20 are stopped" look the same. What
  decides is how many proof chances a day holds. Share of 100 simulated
  days on 28 nodes (8 live for the stopped case; a colluding group of c for
  the honest victim) on which 3 misses an hour apart can be proven:

  | slots per round | a stopped node out in 1 day (8 of 28 live) | c = 5 | c = 6 | c = 7 | c = 8 |
  |---|---|---|---|---|---|
  | seatings only (before) | 1 % | 0 % | 0 % | 0 % | 1 % |
  | **1 (a slot per 15-min round, ruled)** | **83 %** | **0 %** | **2 %** | **36 %** | 86 % |
  | 3 (a slot every 5 min) | 100 % | 0 % | 23 % | 90 % | 100 % |

  the owner chose 1 slot per round: on a 10-27 day a stopped node is out
  within one day on 83 % of days; a colluding group of 7 of 28 has the
  proofs on 36 % of days, of 6 on 2 %, of 5 never. The number is one
  constant, `HEARTBEAT_SLOTS_PER_ROUND`.
- **What it costs.** Per node per day (`heartbeat.test.js`): out 96 x 9
  HEARTBEATs of 132 bytes and a HEARD to 8 members per membership - about
  350 KB at 28 nodes and 220 KB at 500 (a node is a member of 96 x 9 / n
  slots: 31 at 28, 2 at 500); as much in; about 55 KB of certificates kept
  at 28 nodes and 15 KB at 500. A HEARD lists keys of 32 bytes; at
  hundreds of nodes a bitmap over the census would cut it to n/8 bytes.
- **Absent stays absent until seen.** An absent node is drawn for nothing
  in the next census, so by "not drawn is not absent" alone it would be back
  in the census after that, drawn again, missed again. So each seated
  node's SEEN names the nodes the round's census left out (`left_out`), and
  a seating that left a node out and did not see it is a missed seating
  too: the next claim proves it absent again with that day's certificates,
  and no earlier census has to be checked again.
- **Coming back.** A node left out signs, as the seatings of the rounds whose
  census names it absent come, a PRESENT for each - it is drawn for none of
  them, and the seats take it for this purpose (only from a node the round's
  census left out) - and hands it **before the seating close** to the
  round's drawn (`POST /presents`) and to every seat (`POST /presence`). A
  seated node names it in its SEEN, so it is present at that seating and the
  next census keeps it. The reference node does this by itself; the
  operator does nothing.
- **Present but late.** PRESENTs go into a certificate only up to the
  seating close: a seat takes none after it, and signs its SEEN over what it
  held then. A node whose PRESENT arrived late is not present at that
  seating - for the proof that seating is missed, as it was for the seating
  itself (it was not seated). One PRESENT in time in 24 h keeps it in. A
  seat that still holds a late PRESENT of it refuses a census that leaves it
  out (below), and the posting node asks the seats for such PRESENTs before
  it claims anyone, so it leaves out no node a seat would refuse it for.
- **Only the duty postings' rounds prove an absence** *(kanban #727,
  2026-10-28; the hole the heartbeat left open: "rounds anyone posts add
  extra draws")*. Anyone may post a series, and a seat and the client draw
  any round whose contract they can check - so a group that posted many
  rounds of its own would get many more random draws to find three with 5
  of its nodes in, at one publication fee per 96 rounds. So a seating or
  heartbeat certificate is a proof only for a round of a **duty posting of
  its day** (§5A.5 "One posting per app per day"): the day's primary grid,
  its backup grid, or an emergency grid - a round of any other series (a
  table someone posted themselves, a test grid) proves nothing, though its
  certificate still keeps every node it lists in. Which postings count,
  decided the same way at every seat and at the client from the chain and
  the publication:

  ```text
  marker      the round's publication (its series' publication for a series
              round) carries a day marker "ARN" 'D' or 'B' || day d || tag
              whose tag is a duty item's: <app>-day or <app>-day-emergency
              for the apps the duty posts (DUTY_PROOF_ITEMS: updown, rps,
              nextblock; a 'B' on an emergency item is no marker)
  day         the round starts in the day that d posts (d + 1, targetDay)
  creator     the round names its creator, the creator signed the series id
              (a plain round: the round id), and the creator is within the
              first DUTY_PROOF_RANKS = 3 of day d's duty order - ranks 1-3
              post the primary, 2-3 the backup, the emergency from rank 1 on
              - taken over the node keys of the round's own census as its
              root commits it (every seat checks that root against its
              chain, the client against the root: one list everywhere)
  first       per day, item and kind the first confirmed publication is the
              posting (as the duty rule reads "posted"); an emergency item
              the first DUTY_EMERGENCY_CAP = 3. A later duplicate of the
              same day and item adds no proof round
  ```

  Why this holds: an attacker can post a series and can write any marker
  into an OP_RETURN, but it cannot stand in the day's duty order on demand -
  that order is the chain census's rank, `H(duty tag || network_id || d ||
  node key)` over the census, the same list on every node. A group of 7 of
  28 has a member in a day's first 3 on about 59 % of days; the cap on
  postings is what keeps that member from multiplying the day's rounds - at
  most one primary, one backup and three emergency grids per app, each what
  the duty would have posted anyway. The rank is read over the round's
  committed census, not the census at the day's anchor the duty node reads
  its own rank from (`duty-day.js` orderOf): the two differ by at most the
  bonds confirmed between the anchor and the series' census block, and a
  posting at a rank the proof rule does not take is played as before - its
  rounds prove nothing, which is all. An item named otherwise (arena.conf
  `ARENA_DUTY_ITEM_<APP>`) posts rounds that are played but prove nothing.
  Measured (`heartbeat.test.js`, 20 days of 96 slots on 28 nodes): a group
  of 7 has 3 slots an hour apart on 2 of 20 days from the duty grid, and on
  13 of 20 with one self-posted grid of its own beside it - which the rule
  takes away; a self-posted grid of 96 beside the duty grid would have had
  20 of its slots (11 of its seatings, `presence.test.js`) named as proofs
  without the rule, 0 with it, and the claim is the same either way.
- **What the posting node does.** The absent set is chosen once, by the
  node that posts the census (the day's duty node, §5A.5), and committed in
  the census root it writes into the series - fixed on chain before the
  beacon, so it cannot be aimed at a committee. Before it writes the root it
  reads the window's certificates it holds; for every node of the census it
  saw nowhere it asks every seat and the node's own address
  (`GET /presence`) for that node's PRESENTs and for the certificates that
  name it, and takes each that stands against its own draw. A node is left
  out only if the certificates of duty rounds prove it absent. It sends the
  **absent claim** - each absent node with its 3 seatings, and their
  certificates - to every seat (`POST /absent`) before the grid; every seat
  serves it again (`GET /absent?root=`, with the contracts of the named
  rounds, each round's publication with its merkle branch and its creator's
  signature, so a client can draw each and read whose duty posting it is).
- **What every seat checks.** A seat whose chain census does not hash to a
  22 round's `census_root` takes the claim held for that root, checks that
  the chain census less the claimed nodes hashes to it (so the claim names
  exactly the nodes left out), and checks every proof as above, drawing each
  named seating itself and reading, from its own chain view, whether the
  named round is a duty posting's (the marker on its publication, the day's
  first confirmed posting of that item and kind, the creator's rank over
  the round's committed census). The named round's census is read as its own root
  commits - its absent claim is not checked again here, its seated checked
  it before they signed - so a proof never sends a seat back through every
  earlier day. A wrong proof makes the census invalid, exactly as a wrong
  root is today: the seat serves none of its rounds and names the node and
  the proof. A named seating the seat cannot draw yet (it does not hold that
  round's contract) is "not yet", like a claim not yet received: asked
  again, never kept as a refusal. On top, as the owner ruled, a seat that holds
  a window PRESENT or a window certificate naming a left-out node present
  refuses that census itself; that refusal stays the seat's own.
- **The client** checks the census as before (§5A.6) and, for a 22 round
  whose seats hold a claim, every proof of it the same way: each named
  round's contract by its id, its census from evidence hashing to its root,
  its beacon off the same headers, its draw, its certificate - and that the
  round is a duty posting's: its publication proven into the client's
  agreed headers and publishing it, the duty marker and its day read off
  it, the creator's signature over the series id (a plain round: the round
  id) under the key the contract names, and the creator's rank in that
  day's duty order over the census the client just checked. A wrong proof
  refuses the round. What the client cannot see is a node a census left out
  that the claim does not name, and whether an earlier posting of the same
  day and item exists (the first confirmed one counts) - completeness was
  always the seats' check, against their full chains, and such a root
  hashes to nothing an honest seat serves.
- **A fresh seat** - restarted without its store, or new - draws a named
  seating from the round's contract once it holds the series (they are
  announced to every seat), so it checks the proofs as any seat does; until
  then the census is "not yet". As a posting node it leaves out only nodes
  that the certificates it holds or is handed prove absent.
- **What this closes.** A posting node can no longer leave out an honest
  node: every absence is a proof everyone checks, and the census root
  commits to the set. Nobody can keep an honest node out for a day by
  flooding it at one or two of its seatings. A colluding posting node and a
  few seats gain nothing either: one seated node's honest SEEN keeps a node
  in. And nobody buys draws (2026-10-28): a round of a series anyone posted
  themselves proves nothing, so the day's proof chances are the duty
  postings' rounds and no more - a group's chances are the table above, on
  the duty grid, whatever it posts beside it.
- **What remains.** (1) All seated nodes of a seating (5 to 7 of its 9
  drawn), or 5 members of a heartbeat slot's 9, colluding can sign without
  an honest node's word; it takes three such certificates an hour apart,
  each a different random draw. The draws are random, but the claim
  chooses which certificates of the day it names - three of the duty
  postings' rounds and slots - so the bar is "a group holds 5 of 9 seats
  three times in a day", not "a majority of the drawn" (the table above,
  per grid of 96). The duty itself posts more than one grid a day - one
  table per app per federation, a primary and a backup - and each is its
  own 96 draws; the table's numbers are per grid, and a network's chances
  per day scale with how many duty grids it plays. (2) Miners
  grinding the beacon, unchanged (§5A.5): a miner can withhold blocks to
  move which nodes are drawn, here as for every draw. (3) An attacker who
  floods a node at **every** seating and slot of a whole day (3 or more an
  hour apart, and at every presence) keeps it out the next day; it beats
  once in time and is back the census after. (4) A PRESENT carries no time and a series is known
  ahead, so a node could pre-sign PRESENTs to stay in while away; it gains
  only the rule before 22 (it stays in and misses its seats). (5) A client
  checks a named round's contract by its id; for a series round that id
  binds the series and index, not every field, so the client trusts the
  seat for the rest of that contract as it already does for its own round;
  the seats check it from the series they hold. (6) The "first confirmed
  posting" of a day and item is the seats' reading of their chains; the
  client, holding headers, takes a duplicate posting by a first-3 node for
  the day's (it still needs the marker, the day, the creator's signature
  and rank). (7) A marker is an OP_RETURN anyone can write: a bogus 'D'
  marker for a day makes the duty nodes see the day as posted (§5A.5
  "posted") - the Health page names who posted; for proofs it counts for
  nothing (its series' creator is not in the first 3, or signs nothing).

**Version.** Folded into protocol 22 with the auditors (§13A.1), not a
number of its own: 2.0 is unreleased and no series of 22 is posted on any
network, so a 22 census and a 22 certificate have only ever been these. A
census below 22 is the chain census, whatever claim a seat holds, and a
certificate below 22 carries no SEEN - byte for byte as before. Had a 22
series been posted before this rule, it would have needed 23.
The heartbeat is part of the same 22: its HEARTBEAT (0x39) and HEARD (0x3a)
are new types, and a seat below 22 has no slots to draw.
The duty-only rule is in the same 22 too: no claim of 22 was ever posted,
so no claim ever named a round that is not a duty posting's.
(arena-protocol `presence.js` absentFrom, checkAbsenceProof, provenProof,
`ABSENCE_PROOF_SEATINGS`, `ABSENCE_PROOF_SPACING_MS`, `PRESENCE_VERSION`;
`heartbeat.js`, `HEARTBEAT_SLOTS_PER_ROUND`, `HEARTBEAT_DRAWN`,
`HEARTBEAT_THRESHOLD`; `seating.js` SEEN; `duty.js` dutyMarkerOf,
dutyRoundStands, dutyPostingsOf, `DUTY_PROOF_RANKS`, `DUTY_PROOF_ITEMS`,
`DUTY_EMERGENCY_CAP`;
`census.js` deriveCensus `absent`; `client-committee.js` absenceFromChain;
arena-node `presence-book.js` dutyOf, `roster.js` absentCensus and
heartbeatCommitteeFor, `seating-agent.js`, `heartbeat-agent.js`,
`duty-poster.js`; arena-client `committee.js`.)

**Stalled in its rounds - a node named by the seats of 3 failed rounds leaves
the draw (protocol 26; RULED 2026-11-02, kanban #1044 option 2, #1052).** 3 of
a round's 7 seats can stop an entry at its result or the whole round at its
settlement. That is silence: it leaves no signed bytes, so no bond answers for
it (§5A.3B, #1043). A set of nodes could enter only the rounds where it holds 3
seats, lose, stay silent and get the stake back, all day. This rule does not
stop the one free bet, and it does not stop a round with 4 or more colluders. It
stops doing it all day, on the path absence already walks: signed proofs in the
census claim, checked by every seat and by the client. It runs at the RESULT and
FINAL stages. The SETTLEMENT stage is built and off, behind its own height
(RULED 2026-11-03, #1069, below), so until that height is named a stall at the
settlement stays a repeatable free bet.

```text
StallNote   { round_id, stage, silent[] }, signed by a seat's node key, after a
            failed round only. Nothing is noted in a round that worked, and
            nothing in a round that had nothing to decide (RULED 2026-11-11,
            kanban #1339): a round whose every entry is VOID by its own rules
            for want of players - a head-to-head table with one stood reveal
            or none (§0A.7, "nobody was played against"), a round with no
            entry past its start deadline (§16) - is not a failed round at
            any stage. No money depended on its result, so silence there is
            no free bet; the 8-day replay showed it benching honest seats
            under load for a lone player at an RPS table.
stage       RESULT      an entry of the round went VOID by no quorum (§13C),
                        read once the round's re-run windows are over
            FINAL       an entry stands at a result's threshold and is short of
                        its 5 FINAL signatures when entries are due: own
                        final_after + 60 s, round_end + 1865 s, the last moment
                        any entry of the round is due. A round waiting on a
                        no-quorum entry has its FINAL due at the end of its wait
                        + 60 s, the bound of §13A (#1060): the same moment
                        (RULED 2026-11-03, #1069)
            SETTLEMENT  the round's settlement has not landed 2 h after
                        final_after. Counted only from STALL_SETTLEMENT_HEIGHT:
                        below it no seat signs such a note, no seat takes one,
                        and no check counts one (#1069)
silent[]    RESULT      the round's seats that gave this seat no signed result for
                        that entry by the time the note is written, after the
                        round's re-run windows (round_end + 1865 s), not by the
                        quorum deadline (RULED 2026-11-11, kanban #1339): a
                        result that came after end + 600 s is late, and late is
                        signed bytes that show the seat worked; the entry still
                        voids for no quorum in time, the money rule is untouched,
                        but a loaded seat is not silent for being slow
            FINAL       the round's seats that did not sign FINAL for that run
            SETTLEMENT  the round's seats silent at the step where this seat's
                        last settlement pass stopped: no signed word there, or a
                        refusal after signing FINAL (RULED 2026-11-03, #1066) -
                        except a refusal whose stated reason the noting seat can
                        check against the federation and finds true (RULED
                        2026-11-11, kanban #1448): "no loser's lock is claimed",
                        "the lock the plan claims is not held" and the like are
                        dissent about the plan, not silence, when the federation
                        indeed holds no such lock; a refusal whose reason does
                        not check is silence as before. The replay showed loaded
                        honest seats refusing plans they could not claim
            never the seat itself
named       at least STALL_NOTE_QUORUM = 4 of the round's seats signed notes
            listing the node, none of them itself. The lists need not be equal
stalled     named by STALL_PROOF_ROUNDS = 3 rounds whose final_afters lie at least
            ABSENCE_PROOF_SPACING_MS = 1 h apart inside STALL_WINDOW = 72 h before
            the median time past of the census_height block, each a fresh draw
            and each a duty posting's round (below)
census      from protocol 26, past the absent: every output of a stalled node is
            left out; census_root (§5A.4) is taken over what is left
cap         nodes out by this rule hold at most 10 % of the census's weight past
            absence. Past that those named longest ago are out and the rest stay
            in. The first always goes, so on a small census the cap is 1 node
```

- **What a seat lists.** For RESULT, the seats whose signed result it did not
  hold at the end of the re-run window, so a slow seat's late result still clears
  it. A seat that was not running at that moment signs nothing: seats stopped
  through a round came back holding nobody's result and listed everyone (measured,
  7 real seats, 3 stopped). A round's several VOID entries make one note, the union
  of their lists. For FINAL, the seats whose FINAL signature on the run most
  seats signed it did not hold at that moment, read once. A seat that did not sign
  that FINAL itself lists nobody. An entry a held objection suspends has failed
  nothing: it is not at the threshold's state, and the stage does not read it.
  For SETTLEMENT, the seats silent at the step where this seat's own last
  settlement pass stopped. The step is the signed plan, the ack, the commit
  (`SettlementCommit`, §5A.3 table row) or the share: a pass short of acks asks
  nobody to commit, so a list of commits alone would name the honest seats beside
  the silent ones. Only a seat that asked knows, and each seat asks in its turn,
  one every 2 blocks, so all 7 have had theirs inside the 2 h. A seat that gave no
  result itself signs no note for that entry, and a seat that never asked has
  nothing to list.
- **What is silent at a settlement (RULED 2026-11-03, #1066).** A seat is silent
  if it gave no signed word at the step where the pass stopped, or refused after
  signing FINAL for that round. A reason cannot clear a seat, because reasons are
  free. What a seat signed before it refused can: a seat that signed FINAL held the
  round's data and agreed on the outcome, so it has no honest reason to refuse, and
  "no such series" after a signed FINAL is a contradiction by its own signature. A
  seat that refused by name and whose FINAL the asker does not hold is not listed
  at the settlement. That seat is not off the hook, because the FINAL stage lists
  it: a colluder is named at the first step it skipped, result, FINAL, ack, commit
  or share. A 5xx is nobody's word, a tunnel's as likely as the seat's, and reads
  as no answer (RULED 2026-11-03, #1069): this is written for failed rounds only,
  and a seat behind a broken tunnel did not answer. The asker holds a refuser's
  FINAL at the moment the pass stops.
- **The share is a step (#1066).** A seat that committed and sent no share is
  silent there, and so is one whose share does not verify against its public share
  of the round's key. Shares go to the asker only, so the asker lists what it
  received, as for commits, and from protocol 26 it asks every seat that committed,
  so the list names all of them and not the first. Each seat asks in its turn, so
  all have seen it. A seat that did not commit was not asked for a share: it is
  listed as at the commit.
- **One silent seat does not stop a settlement (#1070).** The signature needs 5 of
  the 7, and it needs every seat on its list. So a seat that commits and gives no
  share, or a share that does not verify against its public share, goes off the
  list, and the asker asks again at once while 5 remain. A nonce pair signs one
  list once and a seat that signed a list that did not complete draws a new pair at
  the next commit, so a failed list binds nobody to it. Measured before this: one
  withheld share left every seat that had signed that list refusing any other until
  it restarted.
- **Only the round's seats ask for a commit or a share (RULED 2026-11-03, #1075).**
  A share request spends the asked seat's nonce pair for that pass. With the doors
  open to anyone, a stranger who saw the list on its way could reach a seat first
  with a made-up list (the seat's own commitment and four invented ones), the seat
  signed it, and the real list was refused: every pass, as often as it liked, a
  stall cheaper than the 3 seats this section is about. From
  `SETTLEMENT_ASK_HEIGHT` a commit or share request carries a `SettlementAsk`
  signed by the asking seat's node key:

  ```text
  SettlementAsk { step, round_id, scope, settlement_txid, payload_hash },
              signed by the asking seat's node key; travels as x-settlement-ask
  step        1 commit, 2 share
  scope       the round's own settlement, a late entry's or one federation's,
              by a kind byte and that id (zeros for the round's own)
  payload     the body sent: the acks for a commit, the commitment list for a share
  answered    only if signed by a seat of the round's seating, over the settlement
              the asked seat rebuilt and the very body it was sent; else 403
  ```

  The ack door stays open: acks are public evidence (§5A.3 table row) and are
  published with the settlement, and holding them gets a stranger no commitment
  once a commit needs a seat's signature. A seat of the round can still spoil its
  own round's passes; that is a seat at fault, not a stranger. Measured on seven
  real seats with a real 5-of-7 key and real acks: below the height a stranger
  racing the asker spoiled 3 passes of 3 (18 made-up lists signed, the real list
  refused "keeps no second pair" 18 times); at the height its 6 lists were refused
  with 403 and the pass went through the first time. An honest round below the
  height sends the same requests as before and no ask; at the height it sends the
  same requests with an ask on each commit and share, and signs the same bytes.
- **4 silent seats leave 3 honest, so no note stands. Accepted, and priced as rate × payoff (RULED 2026-11-07, kanban #1305):** a player-operator with 20 % of capital holds 4 of 7 in about 32 of a grid's 960 rounds a day (121 at 30 %), each a free option worth about pot/4 against a two-player opponent, up to ~0.4× his capital a day with the capital returned; for named-claim rounds the fallback claim (§23.2) needs the same four quiet seats, so this is the one stall left there. A round with 4
  or more colluders goes unrecorded: 3.3 % of rounds at 20 % of capital, 12.6 %
  at 30 %.
- **A frame is bounded, not stopped.** 4 colluders can name 3 honest seats. A
  signed result cannot clear them at the draw, because a refutation spreading
  from seat to seat was refused (§5A.3 above): a claim stands on what it
  carries. Slashing a false note is refused too: an honest seat cut off from a
  peer would sign one in good faith and lose its bond. What bounds it: a note
  needs a real VOID, a failed FINAL or a stalled settlement, so a frame costs its
  authors that round's fee, in the open. It takes 3 rounds an hour apart, each a fresh draw and
  a duty posting's, so they cannot make their own rounds. The cap holds. The
  victim loses fees for the window and nothing else. At 30 % of capital with 10 %
  of honest weight out the attacker's share is 33.3 %: 3 of 7 goes from 35.3 % to
  about 43 %, 5 of 7 from 2.9 % to about 4.5 %. It needs 4 of 7, repeatedly.
- **How the draw agrees: exactly as absence.** The census claim (`GET /absent`,
  `POST /absent`) carries, beside the absent, `stalled`: each node with its 3
  rounds, for each round at least 4 notes and the seating that seats it. The
  certificate of that seating says who the round's seats were; a table's round
  names its table's seating. Every seat and the client check each proof on
  their own draw: the note signed by a seat of that seating, listing the node and
  not itself, the node seated there, the round under this rule and a duty
  posting's (the check above), its final_after in the window, the 3 an hour apart
  and of 3 different seatings, and the cap, in the order above, on the weight the
  root commits. A claim without valid notes makes the census invalid, as for
  absence. No new transaction, nobody new pays. The client reads a stalled node's
  weight from the census of its seating. A duty node gathers the window's notes
  from every seat first (`GET /stall-notes`); seats hand their notes on as they
  sign them (`POST /stall-notes`).
- **Out for a season from the third note (RULED 2026-11-07, kanban #1304; it was "as long as 3 proofs lie in the window", at most 70 h, which §5A.10's income term had assumed to be a season).** A node named by three proofs leaves the draw for `season` (12,960 blocks) from the third; an honest node framed by four colluders over three failed rounds loses 90 days of fees, bounded by the 10 % cap, the re-priced residual. **Carried forward by census (RULED 2026-11-08, kanban #1350):** the census whose claim proved the stall commits it in its root (third proof at height H3); a later census leaves the node out until H3 + `season` by naming that earlier census, its root posted by a duty grid and the node's entry in its stalled list, in place of the proofs. A checker verifies the earlier census's publication and root in its own headers, as it checks any duty posting, and the height arithmetic. The proofs are checked once, while fresh; notes stay 7 days as now. Nothing else is kept longer, and a client's join does not slow. The old text follows for the record:
- ~~**Out for as long as 3 proofs lie in the window.**~~ There is no timer and no
  sentence to serve: a node is back by itself once fewer than 3 proofs lie in the
  last 72 h, and nobody decides anything, so nobody can be asked. It is drawn for
  nothing while it is out, so nothing new names it.
- **RESULT and FINAL ship; SETTLEMENT stays off until a replay of new logs
  (RULED 2026-11-03, #1069).** The replay at the values above, 2026-10-20 to
  11-03, all 15 seats: RESULT and FINAL bench nobody. The SETTLEMENT stage benches
  one honest seat, by the seat holding different entries, a bug (#1068). The values
  do not move for that: tuned around one seat's bug they would let every real
  colluder run 5 free bets instead of 3, and stop being right the moment the bug
  is fixed. So the stage has its own height, `STALL_SETTLEMENT_HEIGHT`, not named on
  mainnet or testnet4. It is named once #1068 is fixed and live and a replay of at
  least 8 days of logs from seats running the fix benches nobody at these values.
  The old logs cannot show that: they contain the bug. A benching with a cause is
  fixed at the cause. Only one with no bug behind it is a question about values.
  Honest failures read as noise to any stall rule: each refusal an honest seat gives
  is a bug to fix first, and each one fixed makes this rule safer.
- **What that leaves open, plainly.** Until that height is named, a stall at the
  settlement is a repeatable free bet (§22, P6). RESULT and FINAL make an attacker
  move later in the round. They do not stop it.
- **FINAL is unstressed, not proven.** No failed round in the replay had a seat
  that signed FINAL holding an entry short at that moment, so the stage read zero
  rounds. That is acceptable because a false note there needs a failed round to
  exist at all.
- **Slow honest seats.** Nothing is noted unless the round failed, so 1-2 slow
  seats never count. A restart shorter than the spacing is one proof at most. A
  load spike is the real risk: 3 seats on one overloaded host failing rounds again
  and again. The cap limits that to 1 node on today's network.
- **The draw only.** The census of rounds, so seats, reserves, panels and
  attestors alike. Not pay: a stalled round pays nobody already. Not absence: a
  stalled node is in no `left_out` list. Not the bond. Not the census key, which is
  chain-only and keeps its shares (§5A.3B).

**Version.** Protocol 26, `STALL_VERSION`, on one height per network
(`STALL_HEIGHT`, named after every seat of the network runs it; mainnet from
genesis, testnet4 not named yet). 2.0 only. A census below it never leaves a
stalled node out, and its claim and its commit are the bytes they were. The
SETTLEMENT stage has its own height on top of that, `STALL_SETTLEMENT_HEIGHT`, read
at the round's census height: not named on mainnet or testnet4, 0 on a regtest and
a devnet, so the code stays run. A claim that needs a note below it falls short of
its 4 seats and makes the census invalid, at every seat and at the client.
StallNote is type 0x41, `SettlementCommit` 0x40.
The signed ask has its own height too, `SETTLEMENT_ASK_HEIGHT` (#1075), read at the
round's census height for a round with acks (protocol 22 on): mainnet from
genesis, testnet4 not named yet, 0 on a regtest and a devnet. It is named after
every seat of the network runs it, since a seat of an older release would refuse
signed asks or send unsigned ones. Below it the commit and share doors answer as
before. 2.0 only: the 1.9 line keeps the open doors, where a made-up list costs a
seat only the pass it lands in (#1070). `SettlementAsk` is type 0x45.
(arena-protocol `stall.js` stallsOut, settlementNotesCount, stallNoteCounts, stalledFrom, checkStallProof, stallCapKept,
`STALL_NOTE_QUORUM`, `STALL_PROOF_ROUNDS`, `STALL_WINDOW_MS`, `STALL_CAP_BPS`,
`STALL_SETTLEMENT_WAIT_MS`, `STALL_SETTLEMENT_HEIGHT`; `settlement-ack.js` signSettlementCommit,
signSettlementAsk, checkSettlementAsk, asksBySeat; `constants.js` `SETTLEMENT_ASK_HEIGHT`;
`client-committee.js` absenceFromChain; arena-node `stall-book.js`, `settlement.js`
`#stoppedAt`, `#gatherShares`, `#listed`, `#leaveOut`, `#askHeaders` and `#askRefusal`, `roster.js` absentCensus; `tools/stall-replay.mjs`, the replay.)

`bond_min(role)` is **named in the Round Contract**, not global. A round
declares the bracket it plays at and the floor that goes with it, and a
node is eligible for *that round* or not.

> A bond that no longer reaches the floor for the large rounds is still
> eligible for the small ones. The network stratifies; it does not evict.

The alternative reading - one global floor that rises as the network grows
- would eject nodes that did nothing wrong, and eject them at the worst
moment: their capital is timelocked until `bond_maturity`, so they cannot
raise it in response. Stratification costs nothing and keeps them serving.

**Deliberately NOT eligibility criteria**: uptime,
heartbeat history, reputation, latency, geographic spread, or "no unslashed
misbehaviour" as a live judgement. None of these is objectively observable
by every participant at a common instant; each would hand different
observers a different census. An earlier draft listed uptime and heartbeats here, which
alone would have broken canonicalization. The absent rule above (protocol 22) is
not uptime: it reads threshold-signed seating certificates, not pings, is
chosen once by the posting node and committed in the census root, and every
exclusion carries its own proof that every seat and every client checks the
same way - so every observer still reads one census.

Liveness is handled *after* selection instead, where it costs nothing to
disagree about: an absent node earns no fee share (§22A), and a committee
that cannot reach its threshold triggers the void-and-refund path (§13C).
Proven misbehaviour removes a node the only objective way — by its bond
being spent by a slashing transaction, which makes the output no longer
unspent at the next `census_height`.

```text
bond_min(settlement)  >= max_round_volume of the rounds it may serve
bond_min(game_verify) >= max_round_volume of the rounds it may serve
```

`max_round_volume` is the **gross** volume — every stake locked, winners'
included — not the loser pool: five colluding settlement
seats hold five shares of every `P` and the claim key, so what they can
take is every lock of the round, roughly twice the pool. §5A.10's tables
read `max_round_pool` as this gross figure.

The bond is what makes identity expensive. Without it, a Sybil attacker
creates arbitrarily many nodes for free and buys arbitrarily many selection
chances — the flaw that made an earlier draft unsafe.

**Slashing offences.** A bond is forfeit on *objectively provable*
misbehaviour, each a portable artifact anyone can check. How a proof becomes
a transaction is §5A.3B.

| Offence | Proof |
|---|---|
| Signing two different results for the same (round, player, transcript_hash) | The two signed results |
| Signing a result contradicted by replay of the canonical transcript | Transcript + receipts + replay |
| Acknowledging a payout table that does not equal `F(contract, membership, results)`, or a `settlement_txid` that does not rebuild from the acknowledged table, the contract and the round's locks | The seat's `SettlementAck` + the threshold of acks + the table + those inputs; for an entry the table is false on, its result with the threshold of `FINAL` signatures, or its Entry Contract. A pair that does not rebuild needs no `FINAL` signature: what the seat signed is false by itself |
| Signing a release with no valid proof (template 3, §5A.3B, kanban #971) | The release, whose witness names the signers + the bytes that hash to its `OP_RETURN` and do not check |
| Signing a release or an escrow payout that pays other than its `payout_table` (template 3, §5A.3B) | The release or the payout + the table |
| Signing an `AUDIT` (§13A.1) over a result a valid objection contradicts (kanban #724, #725) | The `AUDIT` + its signature + the rows it vouched for + transcript + receipts + replay of the objection that held |
| Signing two `LockSet`s for one `round_id` with different entries (§17A.6, RULED 2026-11-13 on #2587) | The two signed LockSets, the accused's node key on both — the whole bond goes to the reserves (no player lost money) |

**Only bytes the accused signed (RULED 2026-11-02, kanban #1035).** A row of
this table stands only on bytes the accused signed with its node key. A FROST
signature names nobody, so it is never the proof.

- *Two results.* A `PlayerResult` names no entry and every PLAY is an entry, so
  two honest entries of one player are two results for one (round, player).
  The offence is two results for one transcript. A node that doubles under a
  second transcript has signed at least one result that replay contradicts,
  which is the next row.
- *`SettlementAck`.* Before a seat joins the FROST signing of a settlement it
  signs, with its node key:

  ```text
  SettlementAck { round_id, payout_table_id, settlement_txid }
  ```

  `payout_table_id` is the id of the table the seat computed. A seat joins the
  signing only with acks from at least the threshold over the same three
  fields, and each seat keeps them with the table and publishes them with the
  settlement (`GET /settlement-acks`). A round of protocol 22 and later settles
  this way. The cost is one signature per seat per settlement, off chain.
  From protocol 26 a seat answers a settlement's commit with a signed word too,
  `SettlementCommit { round_id, settlement_txid, H(nonce points) }`, one signature
  per seat per settlement (`x-settlement-commit`, kanban #1052). It slashes
  nobody: it is what makes a seat's list of who stayed silent read
  (§5A.3, "Stalled in its rounds").
- *The table.* A settlement table's rows name their entry: `entry_id`,
  `player_pubkey`, `amount_msat`, with the outcome and score the seat held for
  it, and the table names the late entry a second settlement is for. So what a
  seat said about each entry is its own word, and nobody filing a proof can
  choose which of a player's entries a row meant. It also lists what the
  transaction is made of (RULED 2026-11-02, kanban #1043): the locks claimed,
  each with the entry that names it, the payouts in order, and the nonce. The
  txid hashes these and the `P` of each stake lock, and the fee lock's `F` from
  its Entry Contract.
- *The rebuild.* Seats already rebuild the transaction and agree its txid, so a
  pair either rebuilds or is false by itself. A filer shows each stake lock's
  `P`, which must open the stake point its Entry Contract names, so nobody can
  feed in a `P` that makes an honest pair look false. The hash is the stock
  client's. Where no `P` can be shown, the txid is not read and the rest of the
  row still is. A table that moves no money
  rebuilds to no transaction, so the txid gives it away. A table marked late may
  claim only its own entry's locks, as the Entry Contract names them, and is
  false if the accused also acked a round's own table that claimed that lock.
- *What the table row reads.* A table no threshold of seats acked moved nothing
  and proves nothing. `F` is read only on entries with a threshold of `FINAL`
  signatures: a §13C outcome is decided on one seat's clock, so an entry
  decided that way is left out of the proof and the table is not false on it.
  With every row proved, `F` is recomputed and compared. With a row out, what
  `F` pays the others moves with it, so only what holds whatever that row was
  is read: a proved non-qualifier is owed nothing, a proved qualifier at least
  its net stake. An entry with a signed `FINAL` and no row is not read, since
  it can be a late entry left to a second settlement. A late loser's table and
  a market's are not made by `F`: their amounts stay unread, and the rebuild, the
  claims and the ceiling below still bind them.
- *What else the row reads, with no `FINAL`.* Every claim against the Entry
  Contract it names, and that the payouts and the guardians' fees fit in what is
  claimed. In a played round's own table, every row names an entry and an
  outcome, its amounts are `F` of those outcomes, and its stake claims and each
  qualifier's payout are exactly what those rows make under the federation's fee
  rule. A fee lock's split among the nodes is not read: it turns on seatings and
  `AUDIT`s a seat holds, it is no player's money, and its ceiling is the fee
  locks. Nobody qualifying leaves the remainder split unread, since it needs the
  signed donation set and its sends. A reading that cannot be made is left out and
  never counts against a seat.
- *Filing.* A seat asked to ack or commit to a pair other than the one it rebuilt
  reads the round's acks from the other seats for 6 hours, and files a proof
  against each seat that acked a false pair (`GET /table-slash-proofs`, `tableSlashes`
  at `GET /slashes`). The arbitration set judges the record with its own client of
  the federation, and a proof it has no client to read waits.
- *What is gone.* "Settlement action without the required signatures" merged
  into the table row: the FROST key needs its threshold anyway, and paying an
  entry with no signed `FINAL` is a table that differs from `F`. "Claiming a fee
  share" went: no node claims anything, fee shares come from the settlement
  plan, so a wrong one is a wrong table, and availability stays a condition of
  being paid (§22A), not an offence.
- *What is left unslashable.* An entry settled wrongly on a §13C decision. A
  `VOID` or `FORFEIT` is one seat's clock and cannot be proved false from signed
  bytes; §13C's own rule, that only proven equivocation forfeits, is the guard.
- *What went (RULED 2026-11-02, kanban #1043).* "Withholding a settlement
  signature" is not an offence. Every stall is silence, and a row stands only on
  bytes the accused signed: an ack says a seat agreed, not that it then refused.
  Making a seat show a commit or a share to clear itself would be proof by
  non-response, and with three seats silent the others never reach a share.

**Where a slashed bond goes (RULED 2026-11-02, kanban #976).** Each affected
player gets their **real loss**, once, and nothing more. **The rest of the bond
goes to the protocol reserves** (§27A.9). **Nothing goes to the nodes, nothing
goes to the developers**, nothing goes back to the slashed node, and nothing is
burned. That holds for every offence and every bond, a guardian's too (§23A.5).

- **The real loss** is what the player should have received less what they did
  receive, floored at zero: `F(contract, membership, true results)` against the
  settlement that happened. It is an amount, never a share of the bond. A player
  a false result raised has no loss. After an objection in time nobody has one:
  the result was corrected before any money moved, so no player is paid and the
  whole bond goes to the reserves. A doubled result with no replay shows no
  loss; a player it harmed is paid through the replay's proof.
- **Once.** Several bonds slashed for one round pay one loss. The proofs of a
  round are taken in ascending proof id; the first pays each loss, and each
  later one pays only what is still owed. If a bond cannot cover what it owes,
  it pays pro rata by loss and the next proof pays the rest. A proof is stored
  per (round, entry, node), and each bond's slash is its own transaction.
- **Why the reserves.** Whatever pays a recipient is what a colluder aims for:
  a friend's entry, a share of the census, a developer's share. Nobody collects
  from the reserves by being in the round, by being a node or by being a
  developer. They pay only a proposal that passed §27A.9.5's vote: bonds 3 months
  old, 60 % of votes and 20 % of everyone, at most 10 % of the reserves, after 2
  weeks.
- **Why nothing goes back to the node.** Repaying the damage is not a penalty.
  A node that pays back only what it took risks nothing by cheating, and keeps
  it whenever nobody looks.
- **No reward for the objector.** The auditors of §13A.1 are paid from the
  nodes' fee to look. Any share of a slash is money a colluder can collect.

**The rule's text and hash.** This is `ARENA rule slashing v2`, with a new
`slashing_rules_hash`, and the only slashing rule mainnet knows. The v1 split is
withdrawn. A testnet round published under v1's hash keeps that hash until it
has settled.

Two words in that rule are defined here:

- **The slashing height** is a height the arbitration set **names**, not one the
  chain hands back: any height at or below the chain tip when the slash is
  signed, and at or above the round's `census_height`. It is written into the
  slash's `OP_RETURN` (§5A.3B: `H(fraud_proof) ‖ slash_height ‖ hint`). It
  records when the proof was ruled on, and no payment depends on it.
- **The affected players** are the entries the offence can have harmed, and each
  proof names them mechanically, so a recorder needs no judgement. Each is paid
  its real loss; an entry with none gets nothing.

  | Offence (table above) | `affected[]` |
  |---|---|
  | Two results for one (round, player, transcript_hash) | every other financially activated entry |
  | A result contradicted by replay | that `playerPubkey` if the signed result lowered them; otherwise every other financially activated entry |
  | A payout table that is not `F(contract, membership, results)` | every financially activated entry |
  | A contradicted `AUDIT` (§13A.1) | as a result contradicted by replay, for the entry whose contradicted run the proof names |
  | A release with no valid proof | the node it was taken from, in place of players |
  | A release or escrow payout against its table | the entries of that table |

  **The player a false result favoured is never paid for it (RULED 2026-11-02,
  kanban #975).** The named player is not always the one harmed. Comparing the
  signed result with the replay's, as a payout reads them - a delivery over a
  stake handed back over a lost one, then the score - a result that **lowered**
  them harmed them. One that **raised** them harmed everybody else; so do one
  that moved neither, and a doubled result, which says nothing about which way
  it went.

  §13A's "the affected player, another player in the round" is the same word:
  the one the offence names first, and the others after. A player is paid the
  only way a player can be paid: the slash's one output goes to an escrow, which
  is pegged into the round's federation, and each loss becomes one **payout
  contract** to that entry's `player_pubkey` (the refund key of its lock, §23.1
  step 4; public in the lock). The client collects it like any payout (§24):
  pending, then in the wallet, no press. Sixty players' losses are federation
  amounts in msat, not dust on the chain.

**Nothing is ever burned (RULED 2026-09-21), here or anywhere in this protocol**:
a slash that destroys value pays nobody for the harm, so every remainder in this
document has a recipient: the protocol reserves. The Round Contract's
`slashRemainder` has one valid value, this rule; `BURN` is withdrawn.

## 5A.3B Bond construction and how a fraud proof becomes a slash

**RULED 2026-11-07 (spec review, kanban #1303).** A holder judges a proof whether or not it hosts the game: it fetches the core by the proof's `sim_wasm_hash` and replays in its sandbox, and builds a read-only federation client from the public `FederationRecord` for the table row. "Does not host the game" is no longer a reason to sign nothing. **Residual, at its price:** a third of the shares that stays silent voids every slash start and every fallback, unprovably; the only answer is the reshare rule (shares follow bonds) and the census health line.

**RULED 2026-11-07 (spec review, kanban #1287).** The fallback leaf opens before the return leaf: `slash_fallback_blocks` 288 < `slash_return_blocks` 432 (testnet4 72 / 108, regtest 24 / 36). Before this the return opened at 144 and the fallback at 288, so for any bond past `bond_maturity` a slash landed only if both panels signed within a day, three quiet panel members cost nothing, and the bonding presig (no panel leaf) made a mature guardian, auditor or panel member unslashable. Now the census key always gets its turn; an honest mature node falsely started waits three days instead of one, bearing the false-fallback exposure every immature bond already bears. #1021's "a mature node can leave first" is withdrawn.

An earlier draft said "slashable" without saying where the bond sits or who can move it.
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
              -> the arbitration quorum, at any time (no timelock)
```

`bond_maturity` is an absolute locktime, reference 30 days after the bond
confirms. It is **not an expiry** (RULED 2026-09-28): it is only the
earliest height at which path A lets the node take its money back, and its
purpose is that **arbitration can never freeze a bond forever**: if
arbitration disappears, path A returns the money to its owner. A bond past
maturity that the node has not spent is still the bond (§5A.2) and still
counts, round after round. The one thing maturity changes is a race: past
it, a node that sees a slash coming can spend through path A first and
leave. That spend takes it out of the census for good and is itself public,
so the residual is deterrence lost for an offence caught late, never a
player's money (§5A.3B, "Why player funds do not depend on any of this").

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
It can, however, be handed the opposite: a spend of that output - the bond
output itself, never the funding output it was made from (§5A.2) - is itself a
complete, portable proof, exactly like the equivocation proof of §13B. The
census can therefore be built from inclusion proofs and **corrected by
objection** - anyone may knock an entry out by presenting the spending
transaction. No client needs the UTXO set; it needs headers and an
objection window. A node that spends its own bond and still expects to
serve hands its accusers the evidence itself.

### From proof to transaction

```text
1. Anyone publishes a fraud proof: the two contradicting signatures, or the
   transcript + receipts + replay, or the SettlementAck + the threshold of acks
   + the table + what it rebuilds from, and the FINAL signatures of the entries
   it is false on. A seat that does not hold the round relays it freely.
2. The proof is mechanically checkable — every offence in the table above is
   either a signature comparison or a deterministic replay. No judgement.
3. k-of-m arbitration keys sign a slashing transaction spending path B,
   naming slash_height (§5A.3): <= the tip when they sign, >= the round's
   census_height; nLockTime = slash_height.
4. That transaction MUST carry OP_RETURN = H(fraud_proof) ‖ slash_height ‖
   retrieval hint.
5. One output, an escrow, pays §5A.3: each player's real loss, then the rest
   to the protocol reserves, both through the federation. Nothing to the nodes
   or the developers.
```

Because the slashing transaction commits to the proof, **every slash is
permanently auditable**: anyone can fetch the proof later and re-verify it.
A slash whose committed proof does not retrieve, or does not check, is
itself public evidence against the arbitration set.

**`H(fraud_proof)` is the hash of the complete proof (RULED 2026-11-03, kanban #1065).**
Everything a checker needs is in it, signatures included. The bytes under that hash
**are** the proof, and bytes that do not hash to it are not a copy of anything.

```text
FraudProof {
  evidence    the published record: the proof body and every signature
  contract    the round's contract
  entry       the entry's contract, for a replay or an AUDIT
  bundle      the objection that held, transcript, receipts and inputs, for a replay or an AUDIT
}
H(fraud_proof) = tagged_hash("ARENA/v1/SlashProof", its bytes)
```

A checker fetches by hash from anyone. If it holds bytes that hash, there is one thing
to judge, and if they do not check, the start really was false and the return is right.
Its own chain, census, core and federation client are the rest of what it reads. Two
seats may build two valid proofs of one offence, under two sets of signatures or two
objections, so one output can have two hashes. A bond has one start, the filer's turn
picks one, and the holders who signed it hold its bytes. A seat that does not hold the
round relays bytes freely under the hash they have (`PUT /slash/<hash>`), and refuses
them under any other. An abandonment's proof needs no round and carries its record
(§23A.5).

### A false slash does not pay: template 3 *(RULED 2026-11-02, kanban #971, #974; for new bonds and mainnet)*

Under templates 1 and 2 path B is k-of-m with no timelock, and no script says
where the money goes. k colluding members can take any bond, and only public
evidence stands against it. Template 3 names no standing group of people:
**each round has its own two panels, drawn by a formula anyone can run, and no
one can move a bond without them or without most of the bonded capital.**

There is no covenant here. A signature the node made in advance does the same
job for the one step that needs it. **None of this adds a transaction to a
round.** It adds one signature per seat per round, kept off chain. Only a slash
that really happens goes on chain.

**Who is responsible for a round.** Two panels, of up to 7 each, for every
round, fixed when its committees are:

```text
panel_seed(r)  = tagged_hash("ARENA/v1/SlashPanel", committee_seed(r))
order          the §5A.6 selection over the round's census, on panel_seed(r),
               less every node drawn for any role of the round (all 9 per role,
               §5A.7)
E              the nodes left in that order
n              min(7, floor(|E| / 2))
t              floor(2n / 3) + 1        n 3..7 -> t 3, 3, 4, 5, 5
panel A        the first n of that order
panel B        the next n
```

A panel is a function of the chain and the round (RULED 2026-11-02, kanban #1053).
Which rounds have attestors depends on a manifest a seat may not hold, and panels are
fixed before any player enters, so neither is left out: an attestor or a player's own
node can sit on a panel of that round. A panel only checks a proof, and the census key
has already started it.

**A small census gets smaller panels (RULED 2026-11-02, kanban #1021).** The
census minimum stays, and no round is refused for this. A panel is a check on a
slash the census key has already started, not the theft barrier: nothing starts
without 2/3 of the shares. With n under 3 there are no panels: the hold output
has no release leaf, only the return and the fallback, so a slash pays at
`slash_fallback_blocks`.

The lobby and the explorer list both panels beside the committee. Anyone can
recompute them, nobody applies for them, and no node can move itself in or out.
Being drawn takes no work unless a slash comes, and pays nothing.

**The census key: who gates the first step.** A key in a bond is fixed when it
is bonded, and a round is drawn later, so the first step needs a key that exists
already. `census_key(e)` is a FROST key (RFC 9591, BIP-340) of the census at the
start of epoch `e`. No one is chosen: every bonded node holds shares by its
bond. An epoch is `bond_maturity` long: `epoch(h) = floor(h / bond_maturity)`, from
height 0. The census height of epoch `e` is `e x bond_maturity -
census_confirmations`; before that is a positive height, the network's first key
applies. A bond names the newest standing key when it is made. A holder signs a
slash start only after replaying the proof itself, and does not sign one for a
proof it cannot fetch.

**Who holds how many shares (RULED 2026-11-02, kanban #1021, #1034).**

```text
B             census_key_bond_min, a per-network constant (§27A.6)
T             total bonded sats in the census
S             census_key_shares_max = 1024, a genesis parameter
exact         sum of floor(bond / B) over the census <= S:
              shares(node) = floor(sum of the node's bonds / B),
              x = 1.. in ascending node key
drawn         otherwise, S shares, one at a time, i = 0 .. S-1:
              x_i = tagged_hash("ARENA/v1/CensusKeyShare", h || i) mod T
              i is 4 bytes, big-endian
              share i, at x = i + 1, goes to the node whose stretch of T holds x_i
              nodes in ascending lowest outpoint, each stretch its summed bond
h             the hash of the block at the epoch's first height, e x bond_maturity,
              in the bytes `getblockhash` prints
threshold     floor(2 x total shares / 3) + 1, 683 of 1024
```

`T` and the shares read the census of §5A.4 before any role filter: every node in
it, by its sum. A key belongs to the network, not to a role. That census is the
chain's, read at `CENSUS_KEY_VERSION`, the protocol version that runs the key's
daemon (it is at or above 19, so bonds sum). A node whose advertisement does not list
that version cannot deal or sign, so it is out of the key's census, in `T` and the
shares alike. `serving = false` is on the chain, so such a node is out too. Absence
is not on the chain: a node left out of a round's census by an absence claim keeps
its share, and an absent holder is simply a share that does not sign (RULED
2026-11-02, kanban #1048). `B` is a network
number, never a round's, and no caller passes it: testnet4 uses its live floor,
50,000 sat, and mainnet takes the lowest bracket's value from genesis.
`bond_min(role)` per round stays what it is for rounds; the key does not read it.

`h` comes after the census cut, so nobody can bond into a known draw. A drawn key has
no floor and is linear in sats: splitting a bond changes nothing, and a node can
draw several shares, or none. A small network stays exact.

The 2/3 line depends on which kind a key is. On a drawn key, capital held together
before `h` needs about 60 % to reach the threshold. A buyer who picks holders after
`h` needs about a third on a skewed census (measured: Zipf bonds, 33.5 % median,
30.5 % lowest of 2000 draws). That buys one key: bonds that name it, as far as the
fallback reaches. An exact key is 2/3 in both cases (RULED 2026-11-02, kanban #1041).

The bound stands by what it reaches. One key reaches only the bonds that name it,
which are bonds made while it was newest, and among those the immature ones after
`slash_fallback_blocks`, plus mature ones whose node stays offline past
`slash_return_blocks`. It reaches no stake, no other key's bonds and no round. So the
most a buyer can win is one epoch's new bonds, and a new key at each epoch's start
keeps it there. A hidden holder set, a higher threshold and a draw with less variance
were each refused. A DKG failing epoch after epoch is the thing to watch, because a
key then gathers more live immature bonds: from 2 failed epochs in a row (an epoch that asked nothing ends the count), the owner
page and the health page say so. Every node reads that from its chain, so all say the
same: a closed epoch failed if the plan at its first block asked a new key or a reshare
and no record of that epoch stands; an epoch that asked nothing ends the count, since a
key no bond named gathers nothing. `GET /census-key` answers it as `failing`, and
`GET /owner/standing` carries the warning (kanban #972).

The chance that capital share `p`, fixed before `h`, draws the threshold of one key,
exact binomial:

| Share of bonded capital | Chance of 683 of 1024 |
|---:|---:|
| 20 % | 1e-229 |
| 50 % | 3e-27 |
| 55 % | 2e-14 |
| 60 % | 6e-6 |
| 62 % | 0.1 % |
| 65 % | 13 % |

**Which keys stand (RULED 2026-11-02, kanban #1021).** A bond stays valid and
nobody re-bonds (§5A.2), so a key cannot retire while something names it.

- **Retired:** a key with no unspent bond or hold output naming it. Nothing is
  done for it again. This is read before the census' floor, version and `serving`
  filters: a node left out of a census takes no bond off a key (kanban #1050).
- **Reshared only when needed:** when nodes of the current census hold under 80 %
  of its shares, at most one key at a time, oldest first. The reshare keeps the
  public key. A stable census costs nothing. A keygen tolerates absence, a reshare
  does not: it fixes its dealers at its start, and they must hold the old
  threshold. If one drops out, the run fails and the next starts at the next
  `founding_window`. Nothing is lost meanwhile, since the old shares still work.
  The chain decides all of it: see "A reshare" below.
- **New key:** at an epoch's start, and only if the newest key has been named by a
  bond. The DKG starts at the epoch's first height, when `h` is known, and the key
  is new once anchored. A DKG that fails leaves the newest key standing, and the
  next epoch tries again.
- **The window is `founding_window`,** the time a set has to finish its DKG. First
  half: deals. Second half: holders sign the transcript hash in the
  `CensusKeyRecord`. The deal set is every valid deal a node holds at the midpoint.
  Nodes that differ sign different hashes. Without the threshold on one hash the
  key fails and the newest stands, which is already the failure path. Nothing needs
  to converge by force.
- **Never one key for all time:** old shares still combine among their old
  holders, whatever a reshare does, and nobody can prove a deletion. A single key
  would leave the genesis founders able to reach every bond forever.
- **A key under its threshold is dead:** its bonds stay valid, cannot be started,
  and path A still works. Deterrence is lost for those bonds, nothing else. The
  owner page says so. Dead means unreachable by the current census, the only
  thing anyone can measure, for the reshare and the owner page alike. Old holders
  may still sign, and the chain would take it: see the residual below.

**The first key is made before the first bond (RULED 2026-11-02, kanban #1021).**

```text
CensusKeyRecord { network_id, epoch, public_key, census_height,
                  total_shares, threshold, transcript_hash }
signed by node keys holding the threshold of its shares
anchored by OP_RETURN "ARN" 'K' H(record)
```

The census reads the first valid record per epoch. A bond may name the key that
was newest at any height in `[confirmation height - census_confirmations,
confirmation height]`, and no other, or it does not count. That key was alive a
few blocks ago, so nobody reaches a dead one this way, and no bond fails for a race
with an anchor.

- **Mainnet, epoch 0:** the genesis founders, at least the census minimum of 10,
  run the DKG before any bond exists, one share each, threshold 2/3, each on its own
  machine with `tools/founders-dkg.mjs`: there is no chain yet to run it on, so the deals
  and statements go by files in a folder they share, and nothing in it is secret. They
  bond naming it, and epoch 1 is the first key by weight. `genesis_parameters` names the key and
  who holds it (RULED 2026-11-02, kanban #1050):

  ```text
  census_key_0 { public_key, holders[], threshold }
  holders[]    the founders' node keys, one share each, in share order
  ```

  This stands in for key 0's `CensusKeyRecord`. It needs no signatures or anchor,
  because genesis commits it in `network_id`, and it leaves out `network_id` itself,
  which would be circular. From there key 0 is a key like any other: the 80 % trigger
  reads those holders, a reshare runs when it trips, and a `K` record names the new
  holders. It is not retired at epoch 1: a key cannot retire while a bond names it,
  and nobody re-bonds, so the first bonds would become unslashable or stay with the
  founders for good. A reshare moves them on. As for any key, old shares still combine
  among the founders and nobody can prove a deletion, so the founders keep their reach
  over the bonds naming key 0. Until the first key by weight they are the capital
  anyway.
- **Testnet4 and a network with a census already:** the census at an announced
  height makes the first key by the rule above, on its existing template 1 and 2
  bonds, and anchors the record. No genesis change, no re-bond. That height is
  `CENSUS_KEY_FIRST_HEIGHT`, a constant beside genesis, and the first key is the
  epoch that starts at or after it, by the epoch's own census height and draw. A
  height is named only after the network runs `CENSUS_KEY_VERSION`. **Named in 2.0 (the owner's
  decision on #1083, 2026-11-03):** regtest and a devnet `0`; testnet4 `160,128`
  (= 1112 x 144, an epoch's first block), confirmed by the owner on 2026-11-03;
  mainnet none here, it scans from `genesis_height`.
- A network with no key yet cannot take a template-3 bond. That is the only
  refusal.

**The anchor and its scan (RULED 2026-11-02, kanban #1041).**

- **Who funds it:** any holder, in duty order, from its own wallet: the holders
  ordered by `H(duty tag || network_id || epoch || node key)`. Rank `k` posts from
  `(k - 1) x 6` blocks after the record is complete at that node, by the same
  `duty_post` settings and fee rates as a day's posting. A node that cannot pay says
  so and falls to the next. Anyone else may post it too: the record proves itself,
  and the first valid one per epoch counts. Nobody is paid and nobody is punished.
- **Where the record travels:** the record and its signatures go in the script-path
  leaf the anchor transaction spends: `<key> CHECKSIG OP_0 OP_IF <pushes of at most 520
  bytes> OP_ENDIF`. `OP_RETURN "ARN" 'K' H(record)` is its only output. So it is
  retrievable by anyone with the chain, there is nothing to serve, and a census stays
  a pure function of the chain. A door may show a record as a convenience, and nothing
  rests on it. The signers are the fewest that reach the threshold, largest first: 204
  signers are 19.5 KB, about 5,000 vB, once per key.
- **The hash covers the record, not its signatures,** but the spent output commits to
  the leaf, so no relay can strip them. An anchor without a standing body counts for
  nothing and the same record can be posted again. A reshare's list travels the same
  way.
- **Where the scan starts:** at `CENSUS_KEY_FIRST_HEIGHT`, forward, with what it found
  kept across restarts. It never uses a lookback window: a key is named by bonds for
  years. A network that names no height has no key and no template-3 bond. Mainnet
  scans from `genesis_height` in `genesis_parameters`, key 0 being there too.
- **A record stands** when its epoch starts at or after that height, its census
  height is its epoch's, it is anchored no earlier than the epoch's first block, and
  nodes holding the threshold of that census' shares signed it. Records are judged in
  chain order, so the keys a census reads were judged before it.
- **A cached census** names the standing keys at or below its height, or a census kept
  before an anchor was read would hold that key's bonds out.
- **A deal on the wire** is signed by its dealer's node key, outside the deal, so the
  transcript does not change. The first signed deal per dealer stands. **The midpoint**
  freezes the deal set and runs the check; a node signs its record one block later, so
  a complaint heard in that block drops the deal everywhere first.
- **The census a key reads** is the chain's, at `census_key_bond_min` and
  `CENSUS_KEY_VERSION`.

**A reshare (RULED 2026-11-02, kanban #1048).** Anything nodes must agree on byte for
byte goes on the chain, not a gossip view.

```text
ReshareReady  { key, run }    signed by an old holder's node key
list          { network_id, key, run, signatures }
anchored by   OP_RETURN "ARN" 'R' H(list)
run           the epoch whose founding_window it runs in
```

- **Trigger:** read from the chain, so every node has one answer. For epoch `e`: the
  keys standing at its first block, each with the holders its newest record names,
  or `census_key_0`'s before it has one, against that epoch's census. The oldest key that a bond names, held at or over its
  threshold and under 80 % of its shares, is reshared. The window is the epoch's
  `founding_window`, beside that epoch's keygen, and the new holders are that
  epoch's census, the same shares and draw as its keygen.
- **Present:** old holders sign `ReshareReady` in the first quarter of the window.
  From the quarter's end, the first holder in duty order with signatures covering the
  old threshold anchors them, rank `k` from `k - 1` blocks after it, by the same
  `duty_post` settings as any anchor. The list counts from the window's first block
  until the midpoint below. Its signers are the fewest that reach the threshold,
  largest first. The first valid anchor of a run **is** `present`, and
  `reshare_dealers` fixes the dealers from it.
- **Then** the deals run for the rest of the window, as a keygen: the rest's first half
  deals, its second half signatures, the midpoint freezing the set. Each dealer deals
  its part of the key to the new census.
- **A drop-out:** each part is a term over exactly the dealers' set, so a dealer that
  does not deal fails the run. The next starts at the next `founding_window`.
- **No anchor, no reshare.** A list short of the threshold, for a key the epoch's plan
  does not name, or after the midpoint counts for nothing.
- **The record** is a `CensusKeyRecord` as a keygen's: `epoch` the run, the same public
  key, the new census' height and counts, signed by holders of the new threshold,
  anchored by `"ARN" 'K'` by the new holders in duty order. A record naming a key that
  stands is a reshare's, and it stands only after its run's list. It adds no key and
  makes no key newer: it says who holds that key from then on. A node keeps its new
  shares beside the old until that anchor stands, since only the chain says the run
  held. Then it deletes the old: a duty nobody can check.
- **A new holder has not the old polynomial,** and nothing on the chain proves one a
  peer could hand it. It needs only that the parts add up to the key, so that is what
  it checks. That is enough for safety: if the parts add up, and each share checks
  against its dealer's commitments, the key is safe, and two dealers offsetting each
  other change nothing.
- **Naming a bad dealer (RULED 2026-11-02, kanban #1050).** An old holder compares each
  dealer's constant term with that dealer's own part, read off the old polynomial,
  names a dealer whose term differs, drops its deal and signs no record of that set.
  The run then fails like a drop-out, since each part is a term over exactly the set.
  The poster of the next list leaves out a dealer it named, as long as the others still
  cover the old threshold, so one old holder cannot block every epoch. The transcript
  holds no verifying shares of the old key, so a new holder cannot check a name: for it
  a bad sum fails the run and names nobody. Adding them is a format change, which was
  left out, so repeated failed reshares are the warning already ruled for keys: from 2
  failed epochs in a row, the owner page and the health page say so.

**What a client reads (RULED 2026-11-02, kanban #1048).** A client that cannot count a
bond cannot check a draw, so a census holding a template-3 bond is read with the
standing keys. They are read like any census input: from a few seats, `GET
/census-key/records` for each anchor with its merkle branch, `GET /census-key/census`
for the census its record names. Each anchor is proved into the headers the client
agreed, the body read from the leaf it spends, the record held to its epoch's rule,
every entry of that census rebuilt as a round's is, and the signatures counted against
the shares of that census. They are judged in chain order, so a census that names an
earlier key reads it. A seat can withhold a key and cannot make one up, and a withheld
key shows as a root that does not match. A census with no template-3 bond asks nothing.
This must stand before `CENSUS_KEY_FIRST_HEIGHT` is named for a network with a page.

**The bond (`bond_script_template_version` 3).** The key path and path A stay.
Path B needs both the node's advance signature and the census key:

```text
script path B (slash start)
              <node_key> CHECKSIGVERIFY
              <census_key(e)> CHECKSIG
```

**The advance signature, per round (`slash_presig`).** With its SEATING
signature (§5A.7), each seated node signs one **slash start** for that round,
hash type `SIGHASH_SINGLE|ANYONECANPAY` (0x83):

```text
version 2, nLockTime 0
input 0       the bond, sequence 0xfffffffd
output 0      the whole bond amount, to hold(bond, round)
```

It is 65 bytes, travels in the certificate and is checked with the seating; it is
not secret and a client need not read it. A
seat refuses a seating whose member's `slash_presig` does not verify. The signed
transaction is normally never published. The hash type leaves everything else
open: whoever files the slash adds a fee input and the proof's `OP_RETURN`, and
the release pays their fee back. A slash uses the `slash_presig` of the round
the offence is in; an offence with no round uses the node's newest, or the one at
bonding (below) if the node was never seated.

A seated node signs one per template-3 bond it holds, none for a bond of another
template or one already started. The seating certificate carries them after its
justifications, so whoever holds the certificate holds what a slash needs, and a
seat checks them with it; a seating with no template-3 bond is byte for byte as
before. A seat counts a member's seating signature only with its presigs, so it
builds no certificate without them, and refuses one that lacks a presig or carries
one that does not verify. `GET /slash-presig` serves one with the panels its hold
output names. A hold output depends on the round only through its panels, so the two
roles of a round share one presig, and so do all rounds of a table, which share one
draw: the seating of its first round and of each check-in carries it for the rounds
it seats. A slash on a table's later round uses that presig (kanban #972).

**The advance signature at bonding (RULED 2026-11-02, kanban #1053).** A node also
posts one in an advertisement update when it bonds (the bond's txid does not exist
before), as `slash_presig` in that body. It moves the bond to a hold output with no
release leaf, only the return and the fallback, the shape a round with no panels already
has. Its script is built from the bond, its advertisement and its census key alone.
A template-3 bond counts only with it `census_confirmations` deep.

A reader, the page included, checks it with one signature check over those fields: no
panels, no draw, no census, and nothing recursive. The earliest update carrying one
that verifies counts, later updates need not repeat it, and a seat hands that update
with the bond's evidence.

A node posts the bond and that update together. On a network with a census key a new bond
is template 3 and names the newest standing key; on any other it stays template 2. One
funding transaction pays both carriers, since a carrier is fixed by the body's length and
a presig is 65 bytes whatever it signs (kanban #972).

A slash on this presig pays at `slash_fallback_blocks`, by the census key, and a mature
node can leave first. It is the slowest path, for a rare case. It covers an offence
with no round, and a node with no round presig because it was never seated: a
guardian, an auditor with a contradicted `AUDIT`, a panel member with a false release. A
seat's round presig stays the normal path.

**The hold output.** A P2TR output with an unspendable internal key, rebuilt by
anyone from the bond and the round:

```text
release       <slash_hold_blocks> CHECKSEQUENCEVERIFY DROP
              <t-of-n panel A>  <t-of-n panel B>
              -> §5A.3: each real loss, then the rest to the reserves;
                 no such leaf when the round has no panels, or for the
                 presig at bonding

return        <slash_return_blocks> CHECKSEQUENCEVERIFY DROP
              <bond_maturity> CHECKLOCKTIMEVERIFY DROP
              <node_key> CHECKSIG
              -> the node alone

fallback      <slash_fallback_blocks> CHECKSEQUENCEVERIFY DROP
              <census_key(e)> CHECKSIG
              -> the census key, if the panels do not sign, or there are none
```

**The flow, replacing steps 3-5 above for a template-3 bond:**

```text
3. The census key signs the slash start after replaying the proof, with
   OP_RETURN = H(fraud_proof) ‖ slash_height ‖ hint. slash_height keeps its
   meaning but is not the nLockTime: slash_presig fixes that at 0.
4. slash_hold_blocks later, t of n of both panels, each having replayed the
   proof, sign the release, with
   OP_RETURN = H(fraud_proof) ‖ slash_height ‖ H(payout_table) as its first
   output. The table names every affected entry and its share.
5. The release pays §5A.3: each real loss, then the rest to the reserves. Panel A's members bring the
   players' share into the federation and pay the table, in score order, none
   holding more than its own bond.
```

**A seat files it (kanban #972).** A seat holding a proof against a template-3 bond takes
the round's presig, or the bond's own if it holds none, a fee coin from its own wallet that
holds the whole fee, and the proof's `OP_RETURN`. It then asks the key's holders, in two
rounds of FROST. A holder commits a nonce only after it has replayed the proof itself and
held the transaction to its own census: that bond, unstarted, the whole amount to a hold
output it rebuilt, a presig that verifies, the proof named. A nonce is used once. The
filer checks the signature before it sends anything, and whatever it claims, Bitcoin takes
the result or refuses it. Seats holding one proof wait their turn by a hash of the proof
and the node key. A seat judges a proof from its own bytes, its own census and chain: two
signed results by their signatures, a result, a re-run or an `AUDIT` contradicted by replay by
replaying the objection in the proof under the round's core and beacon, and for an `AUDIT` the
draw on its own census, less the round's players where it holds the round, and a false table
by rebuilding it with its own client of each federation it names, on that federation's fee
rule, and a release by the panels it redraws and, for a release with no valid proof, its own
word on the bytes under the release's `OP_RETURN`. An abandonment is read as §23A.5 says, on
its chain as it stands, and a node reading a start on its own bond reads its output at the block
before that start. Three answers: it holds, it does
not, or this seat cannot say yet, having no census there, no core, no beacon or no client. A holder signs
nothing it cannot judge, and a node with a start on such a proof waits. A seat that holds no
share or does not host the game is one of those. A proof handed to a seat at `PUT /slash/<hash>` is
judged on its next pass, one at a time, and a seat keeps a verdict by the hash. A seat files
what it can see from what it holds. A release is on the chain and anyone's to file: a record of
the release, the outputs it spent, and the bytes or the table it committed to, at `PUT /slash/<hash>`.
A seat lists what the rows it holds left, and files an output on template 3 as any proof it holds.
An escrow payout is not judged by this path yet.

**A network that reads template 3 only (RULED 2026-11-03, kanban #1065).** A node there never
falls back to template 2: that is real money locked in a bond that does not count. With no
key read it posts nothing and refuses by name, "no census key read yet", and tries again.
Every other network keeps template 2 where no key stands. Mainnet is such a network.

**The payout table (RULED 2026-11-02, kanban #1021).**

```text
PayoutTable {
  version 1, network_id, round_id, proof_id, bond outpoint
  entries[]    ascending entry_id: entry_id, player_pubkey, loss_msat
  reserves[]   ascending federation_id: federation_id, msat
  carrier_margin_msat (u64), margin_off (u8: 0 reserves, 1 players)   (kanban #1086)
  outputs[]    the release's outputs after its OP_RETURN, in order:
               value_sats, script, pays
}
payout_table_id = tagged_hash("ARENA/v1/SlashPayoutTable", its bytes)
pays in order: filer, player_carrier, reserves, escrow
```

The release's `OP_RETURN` comes first and is left out of the table, because it
carries the table's hash. `filer` repays the start's fee input. `player_carrier`
outputs are the peg-ins of panel A's members in score order, none above that
member's own bond. `reserves` are the parts of §27A.9.2, and `reserves[]` lists what
the release pays in. `escrow` is what does not fit, under the hold's release leaf
without its wait and its fallback leaf (RULED 2026-11-03, kanban #1085, below). The part kept in escrow is that output, so
`reserves[]` needs no extra field: the escrow's value past the players is placed by
load when spent.

In sats the players' parts round up and the reserves take the rest. A carrier's
part under dust is raised to dust out of the reserves; if they cannot cover the
raise, that carrier merges into the one before it. Players are never short. The
transaction fee comes off the reserves, never the players. Outputs + fee = the
bond, exactly. A panel member signs only if its own recomputed table is
byte-equal. Any seat serves the table by its id. A fallback carries the same
`OP_RETURN` fields and a table of this format, and census key holders sign one only
after replaying the proof.

**How a signer builds a release or a fallback (kanban #972, decision #1083, 2026-11-03).** A signer reads
everything itself except a release's carriers, which the proposal names (RULED 2026-11-04, kanban #1130, below);
two signers that read the same build the same bytes, and two that do not sign different bytes and nothing adds
up: the fallback is the way out. *These are readings of the text above, for review; the owner did not rule them
one by one, except where a ruling is named.*

- **The fee** is the start's own rate: what the start's inputs hold past its outputs (the fee input's value, read
  off the chain), over the start's vsize, rounded up, never under 1 sat/vB, times the release's or fallback's
  exact vsize with its witness (t signatures of each panel, or one). The table is built again with each fee asked
  until the one it was built with is enough; the fee only goes up, so every signer ends on the same bytes. The
  filer chose that rate, so a mainnet filer's estimate carries into both and no signer guesses at a mempool.
- **`filer`** repays the start's fee input, its value to its own script. A seat derives that coin's key from its
  node key and the proof's hash, so the repaid output is its own to spend.
- **The escrow** is a P2TR output with the hold's unspendable internal key and the leaves ruled for it (#1085,
  "The escrow spend" below): the panels' leaf with no wait and the fallback leaf, or the fallback leaf alone where
  there are no panels and on every fallback.
- **The losses** are read from every seat of the round that answers `GET /audit-run`, the union of what they hand,
  each entry checked against its id and each FINAL against the committee, then §5A.3's real loss: a seat can hold
  back and cannot add. A later slash of the same round, in chain order and then proof id, pays only what the
  earlier ones' tables leave owed; a start whose hold was returned paid nothing.
- **The players' federation** is the round's (`federation_id`).
- **A carrier's peg-in** is per start, federation and use, made once by its own client and signed by its node key
  (`carrier_peg_in`), `GET /slash-pegin`: the players' part and a reserves' part are two outputs of one release, so
  two addresses, each deposit claimed on its own. The signature names all three (RULED 2026-11-04, kanban #1130):
  `tagged_hash("ARENA/v1/CarrierPegIn", network_id ‖ start outpoint ‖ federation_id ‖ use ‖ script)`, the start
  outpoint the hold output (txid, vout u32 big-endian), `use` one byte, 0 players and 1 reserves. A peg-in handed on
  by another seat therefore cannot be passed off for another start, federation or use. Template 3 is in no release,
  so no height gates the change.
- **A reserves' part** of a federation goes to the first carrier, in carrying order, with a reserves peg-in of that
  federation. The text caps `player_carrier` outputs by the carrier's bond and says nothing of reserves; this
  build does not cap a reserves' part.
- **The load** is each federation's newest signed record this seat holds and the reserve key its guardian seats
  name, read when the table is built. A federation whose guardian seats stand has a key: a seat that has not read
  it yet waits and builds no table (kanban #1129), until the cap.
- **The reserve key's cap (RULED 2026-11-04, kanban #1130; formula rebased 2026-11-07, kanban #1340).** From the start's
  confirmation + `slash_fallback_blocks / 4` on (72 blocks mainnet, 18 testnet4, 6 regtest, the same numbers as before:
  the fallback is now the next spend after the release, so the cap is read against it, not against the return leaf,
  which opens after the fallback since #1287), every signer builds the
  release or fallback with the **whole** reserves' part in the escrow, whatever keys it has read; the filer and the
  players' outputs do not change. The escrow's next spend places it by load (#1085), and a federation whose key is
  still unread is paid nothing by that spend. An escrow spend and a liquidation escrow spend still wait for an
  unread standing key: the escrow has no return leaf, so the wait loses nothing.
- **The carriers are what the proposal names (RULED 2026-11-04, kanban #1130).** Each panel member serves at
  `GET /slash-release?start=` its proposal: its table and every checked peg-in it holds. A signer checks each peg-in a
  proposal names (signed by a panel A member, for this start, that federation and that use), rebuilds everything
  else itself with exactly those (losses, fee, load, order by score, the bond caps, the reserves to the first carrier
  with a reserves peg-in of that federation, the rest to the escrow), and signs when the bytes are equal. A member
  left out does not stop a signature: its share only moves to the next carrier or the escrow, which the panels and
  the fallback hold. Each seat serves the peg-ins it has read and checked and takes the others', so the next
  proposal names more. A signer may sign every proposal that checks; all spend the one hold, so one confirms.
- **The release goes out** from any panel member holding t signatures of each panel over one proposal's bytes. Each
  serves the proposals it signed, with the signatures it has checked over each, at `GET /slash-release?start=`, and the
  others read them there. A (t + 1)th signature of one panel would fail the leaf, so exactly t of each go in.
- **The fallback is filed** by one holder at a time, in a turn by a hash of the proof and its key. Every holder
  builds the fallback and keeps it, so a holder the table names as a carrier knows to carry, and signs a share
  only when its own table's id is the one asked for. `excluded` is the accused and every node drawn for the round.
- **A carrier pays** each slice of a loss it carries to `refund_key(player)`, in the table's entry order across the
  carriers in their order, and the rest of what it claimed, less the carrier margin for its own payout's fee
  (#1086 and #1121 below), to that federation's reserve key, kept as a reserve row of kind `slash` that every seat checks
  against its own port. It pays on the table that confirmed, whichever that is (RULED 2026-11-03, kanban #1085, below).

**The carrier's payout margin (RULED 2026-11-03, kanban #1086).** A carrier keeps a margin back of each claim for
its own payout's fee in the federation. It never comes out of a loss (decision #1083: each real loss paid to the
player's key; "players are never short").

- **The output.** A player-carrying output (`player_carrier`) is the unpaid loss it carries plus the carrier's
  payout margin, taken from the reserves' share of that spend. This holds for every table with such outputs: the
  release, the fallback and each escrow spend. `slashHoldsOnEscrowSpend` accepts a player output up to the unpaid
  loss plus the margin, and no more.
- **The margin is a constant the table names,** per network, in two parts (#1121 below): 2,010 sat on testnet4
  and regtest (a devnet runs regtest's), 20,010 sat on mainnet. A signer can't choose it, so every signer builds the same bytes. The PayoutTable names it
  as `carrier_margin_msat`, and each escrow spend's `outputs[]` repeats it; a spend naming another margin than its
  table's answers to row 8.
- **Unused margin is not the carrier's.** Whatever the payout fee didn't take goes on to the reserve key with the
  carrier's reserves part, or with the next one if this carrier has none. A carrier keeps nothing.

**The margin covers the peg-in fee too (RULED 2026-11-04, kanban #1093, recorded by #1121).** A federation takes a
peg-in fee off each deposit before it credits it (walletv2: its consensus feerate, never under 1 sat/vB, times its
receive weight). A real Fedimint run measured 416 sat. A 10 sat margin then left the carrier short, so a slash
paid its players below face and a liquidation's claims waited for ever. The feerate moves with the chain and the
federation's own queue, so no seat reads one value every signer agrees on, and the margin stays a constant:

| part | constant (genesis) | testnet4, regtest | mainnet |
| --- | --- | --- | --- |
| the carrier's payout fee (#1086) | `CARRIER_PAYOUT_FEE_MSAT` | 10 sat | 10 sat |
| the receiving federation's peg-in fee | `CARRIER_PEGIN_FEE_MSAT` | 2,000 sat | 20,000 sat |
| the margin the table names | `CARRIER_PAYOUT_MARGIN_MSAT`, their sum | 2,010 sat | 20,010 sat |

- **The carrier keeps back only the payout part.** What the peg-in fee leaves of the peg-in part goes to the
  federation's reserve key in the same payout, as unused margin does. With no reserve key yet it is owed on like
  unused margin. Players are paid at face whenever the peg-in fee is within the allowance. A dearer one pays pro
  rata (slash) or waits for the next spend (liquidation), as before.
- **Each carrier claims its own deposit by outpoint.** A federation may give a client one peg-in address for all
  its deposits (walletv2 does), so two escrows carried by one carrier land on one address, and "the balance grew"
  would let one escrow read the other's money. A carrier claims the outpoint of the output paid to it
  (`txid:vout`, with its value), and reads what that one deposit credited: its value less the peg-in fee, less
  the client's own fees on the claim. An answer that does not name that deposit is refused, never read off the
  balance. A wallet that gives each deposit its own address (the legacy wallet) may still be read by its balance.
- **This holds for every carrier**: the release, the fallback, each escrow spend of a slash, and the escrow
  spends of a liquidation (#1111).
- **With no reserves' part in the spend** (no reserve key yet, #1085), the margin comes off the players' parts pro
  rata to their loss, as the fee does there, and the table says so (`margin_off = players`). That is the one case
  where a player gets slightly less, and it is written down.

*Readings of #1086 as built (kanban #972), for review:*

- **Every table.** The ruling's "a player-carrying output" names no table, and the carrier who pays is the same in
  all three, so the release and the fallback name the margin as the escrow spend does. A carrier then pays the same
  way whichever table confirmed: the player its slices exactly, out of loss + margin.
- **"The reserves' share"** is what the spend holds past the players: its reserves parts and whatever goes back to
  the escrow alike (the escrow's value past the players is placed by load when spent). So a spend with no room for
  reserves still pays the margin out of that money. `margin_off = players` is named when that share cannot take
  every players' output's margin whole: the escrow holds only players' money, or less than one margin past it.
- **In sats** each players' output holds its part plus the margin rounded up to whole sats (2,010 sat on testnet4
  and regtest, 20,010 sat on mainnet, #1121), none above its
  carrier's bond with it; a carrier's slices fill each output up to its value less the margin. The checker allows
  the players' part rounded up once, plus one margin per players' output of a spend that names `reserves`, plus up
  to dust for an output raised to dust; the reserves at most the escrow less the players' part and those margins.
- **What the fee didn't take** is measured on the carrier's client: its balance before the payout, less after,
  less what went out. The carrier owes that to the federation's reserve key and adds it to its next payout there
  (the reserves' part of the same spend when it carries one, else its next slash). The margin of a reserves output
  is that output's own fee and goes on the same way. Where the balance cannot be read the margin counts as spent.

**The carriers of a fallback (RULED 2026-11-02, kanban #1031).** With no panels, and
on every fallback, because a fallback means the panels did not sign and panel A
cannot be trusted to carry, the carriers are the census key's holders in descending
shares, less the accused, the proof's other slashed nodes and the round's seats,
none above its own bond. The holders' table names them, and each publishes a peg-in
address signed by its node key.

**When no holder has a signed peg-in (RULED 2026-11-02, kanban #1034).** All of it
goes to escrow, and the players wait. The table has no `player_carrier` output, and
the money leaves by an escrow spend when a carrier publishes a signed peg-in.
Entries stay pending. This is not a refusal.

**An escrow spend answers to the table (RULED 2026-11-02, kanban #1031, #1034).** A
peg-in address is per wallet, so no record can list them, and all money goes through a
carrier, including the reserves' part.

```text
escrow spend  OP_RETURN = payout_table_id ‖ id of its own outputs[] as first output
outputs[]     version 1, payout_table_id, load_height (u32), carrier_margin_msat (u64),
              margin_off (u8), then the table's format: value_sats, script, pays
              tagged_hash("ARENA/v1/SlashEscrowOutputs", those bytes)
payable       a script a carrier's node key signed as its peg-in for this table and
              the escrow outpoint the spend spends (a CarrierPegIn, #1085):
              tagged_hash("ARENA/v1/CarrierEscrowPegIn", payout_table_id ‖ escrow txid
              ‖ escrow vout (u32) ‖ federation_id ‖ script)
```

What does not go out comes back to the same escrow as a `pays = escrow` output. The
check is amounts by `pays` against what the table left unpaid, plus those signatures:
`player_carrier` up to the players' part the release did not carry plus the carrier margin
of each players' output (#1086), `reserves` up to the rest of the escrow, counted with every
earlier spend. Row 8 of the offences covers that too.

**The escrow spend (RULED 2026-11-03, kanban #1085).** A table can leave money in its
escrow: players owed with no carrier yet, a reserves' part no federation had room for, or a
network with no reserve key (§27A.9.2). Nobody may hold that money without a rule, so each
answer reuses what the release already does.

The escrow output gets the hold output's two spending leaves, without the return:

```text
release    t-of-n panel A + t-of-n panel B          no wait
fallback   <slash_fallback_blocks> CSV, census key   if the panels don't sign
```

With no panels, only the fallback leaf. There is no return leaf: this money is owed to players
and the reserves, never the node's again.

- **Who signs and files, and when.** The same signers as the release that made it: panels A and B,
  t of n each, or on the fallback leaf the census key. The filer's turn is the start's rule, a
  hash of the proof and the key. A spend is **due** when a carrier has published a signed peg-in
  for it (§5A.3B "When no holder has a signed peg-in", the players' part), or a federation has room
  for the reserves' part. Every seat checks its escrows every 6 blocks, and there is no other wait.
  If the panels haven't signed by `slash_fallback_blocks` after the escrow confirmed, the census
  key may.
- **What "has room" means.** As for the release: §27A.9.2's spread, on the federation records in
  force at a height the spend **names** in its `outputs[]` (`load_height`). That height is at or
  below the tip when it is signed and at or above the escrow's confirmation, the same idea as
  `slash_height`. Signers check the spend against their own records at that height, so every
  signer builds the same bytes.
- **Who carries it.** The release's rule, read again at the spend: on the panels' leaf panel A's
  members in score order, none above its own bond; on the fallback leaf the census key's holders
  in descending shares, less the accused, the proof's other slashed nodes and the round's seats.
  Only members that have published a signed peg-in for this escrow count. A member that has left
  the census is skipped.
- **Where a carrier publishes.**

  ```text
  CarrierPegIn { payout_table_id, escrow outpoint, federation_id, peg-in script }
               signed by the carrier's node key
  ```

  Seats take it and hand it on, at `POST` / `GET /slash/<payout_table_id>/carriers`, checked
  against the carrier rule before they keep it. It is the same thing the release reads as "a
  payable script is one a carrier signed".
- **The fee.** The node's estimate with a floor on mainnet; the fixed amount stays on testnet, as
  #1065 said for the return. It comes off the reserves' part, never the players', as for the
  release. If the escrow holds only players' money (no reserve key yet), the fee comes off each
  player's part pro rata to its loss. That is unavoidable and small.
- **A carrier pays on for the table that confirmed.** Once a release is mined its table is a fact:
  the hash is on chain, and the money on a carrier's peg-in belongs to the players and the
  reserves that table names. `carry()` runs on the table whose hash the confirmed release
  carries, after the carrier checks that the bytes hash to it, that its own slice is named, and
  that its own peg-in received that slice. It does not re-judge the table: the panels' threshold
  did that. A carrier that doesn't pay on is the residual already named, "none above its own
  bond", so its own bond answers for it at most.

**As built (kanban #972, on the 2.0 line).** `slash-release.js` (arena-protocol) builds the escrow
output (`slashEscrowOutput`, `escrowReleaseLeaf` in `bond-script.js`), the spend (`slashEscrowSpend`)
and what each carrier carries along the escrow's spends (`escrowSlices`); `slash-escrow-run.js`
(arena-node) runs it. A seat reads the release or fallback the chain holds (`confirmedOf`): its own,
or a peer's whose transaction, rebuilt from the table, has the txid whose outputs the chain holds
confirmed. It follows the escrow along its spends, publishes its CarrierPegIns where it may carry,
reads the others' at their doors, and once per 6-block window builds at the window's first height (or
the escrow's confirmation, if later). A panel member serves its proposal and signature at `GET
/slash-release?start=` (`escrow`), signs every other member's proposal it rebuilds byte for byte at
the height it names, and sends one at t of each panel. A holder files the fallback leaf in its turn
through `POST /census-sign/commit` with kind `escrow`, and each holder signs only its own `outputs[]`
at the height asked. A carrier pays on each spend once it is mined, as for a release.

*My readings of #1085 where it leaves a detail open, for review (not ruled one by one):*

- **The escrow of a fallback** has the fallback leaf alone, as a round with no panels: a fallback
  means the panels did not sign, and its table already names the holders as carriers. So its census
  key waits `slash_fallback_blocks` from the escrow's confirmation like any other.
- **The fee rate** is the start's own (`startFeeRate`), as for the release: every signer must build the
  same bytes and none can read another's estimate. On mainnet that is the filer's estimate with the
  1 sat/vB floor; on testnet the start's fixed fee sets it.
- **The named height** is the first height of the 6-block window a signer builds in, or the escrow's
  confirmation if that is later. A signer takes any height from the escrow's confirmation to its tip.
- **One output per peg-in.** A CarrierPegIn is one per carrier, escrow outpoint and federation, and
  carries one output. The players' part goes first, to carriers with a peg-in of the round's
  federation in their order, none above its bond. Then each federation's reserves' part goes to the
  first carrier in order with an unused peg-in of that federation. A part with no such carrier, and
  whatever finds no room, goes back to the escrow, for the next spend's fresh peg-ins.
- **Pro rata** applies whenever a spend holds less than the players are still owed once its fee is
  off: each entry's part is scaled to what there is, the odd msat one each in entry order, then cut
  across the carriers as a table is. Under dust, what would go back to the escrow joins the largest
  reserves output, or the fee.
- **A carrier's bond** is its bond at the tip, summed over its outputs, as the release reads it.
- **"The proof's other slashed nodes"** are not excluded yet, by the fallback's carriers or the
  escrow's: the release's build leaves them out today, and the escrow follows it.
- **A CarrierPegIn is kept** only for a table a seat reads confirmed, an escrow outpoint of that
  table, a node of panel A or the holders less the accused and the round's seats, and a good
  signature. A new one is handed on to the escrow's signers once.

**A proof that cannot be fetched (RULED 2026-11-02, kanban #1031).** A holder that
cannot fetch the proof does not sign a start or a fallback, a panel member does not
sign a release, and the reference node takes the return leaf at its clock. A seat
tries the hint, the relays and the seats until then. Not being able to fetch is not
an offence: the offence needs bytes that do not check.

**The clocks are hours, not days.** The money a player is waiting for here is
the slash share. Their own stake and winnings never wait for it: a false result
is corrected inside the 30 minutes of §13A.

| | mainnet | testnet4 | regtest |
|---|---|---|---|
| `slash_hold_blocks` | 6 (~1 h) | 1 | 1 |
| `slash_return_blocks` | 432 (~3 days) | 108 | 36 |
| `slash_fallback_blocks` | 288 (~2 days) | 72 | 24 |

`slash_hold_blocks` is the depth a chain event needs anyway, and long enough to
replay a proof. A player's line shows as pending, with its amount, from the
moment the release confirms (§24). The players' share then still has to enter
the federation, which takes the federation's own peg-in depth (on testnet4 100
blocks, its setting). A panel member holding enough e-cash may pay at the
release and refill itself from the peg-in; nothing depends on it.

**What each attack gets.**

| Attempt | Result |
|---|---|
| the census key sends a bond anywhere but a hold output its node signed | refused by Bitcoin: `slash_presig` no longer verifies |
| the census key starts a slash with no valid proof | no money moves: the panels do not sign, and the hold output stays the bond (below) |
| a round's panels, both captured | they cannot start without the census key, and a panel reaches only that round's seats, not every bond |
| one panel blocks a true slash (3 of 7 refuse) | the census key releases at `slash_fallback_blocks`, which opens before the return leaf (RULED 2026-11-07, kanban #1287) |
| a node buys a slash start to get out before maturity | nothing: the return leaf waits for `bond_maturity` too |
| 2/3 of the bonded capital on an exact key; on a drawn one about 60 % held together before `h`, about a third for a buyer who picks holders after it | can still take a bond that has not matured, and only among the bonds naming that one key. At 2/3 it holds the committees anyway |

**The fallback is meant (RULED 2026-11-02, kanban #1021; REWRITTEN 2026-11-07,
kanban #1287, #1340).** A started bond, mature or not, cannot leave before the
census key has had its turn: the fallback opens at `slash_fallback_blocks` (288)
and the return leaf only at `slash_return_blocks` (432). The return is what a
falsely started bond gets when neither the panels released nor the census key
fell back by then. #1021's "a mature node can leave at `slash_return_blocks`,
before the fallback opens" is withdrawn: it made every bond past maturity
unslashable whenever three panel members stayed quiet. Script still cannot say
"only before maturity", and a mature node that does nothing is now no safer than
one that reacts, because neither can act before the key.

The reference node takes the return leaf itself, as soon as it opens, when a start
names a proof that does not check on its own replay. An owner does not have to
watch; the wait is three days instead of one.

A start does not show a hold output's leaves, and only the panels rebuild them, so a node
keeps the panels of every hold it signs a presig to, past the round's prune. Without them
it could not spend the return leaf. Path A is gone with the bond output, so the owner page
leaves a started bond by the return, and says when that opens (kanban #972).

The residual: an offline mature node can lose its bond to 2/3 of a key's shares.
Threshold signers cannot be named, so a false fallback has no offence row; it is
public through the committed proof hash. And a stale key: shares of a key the
current census can no longer reach still combine among their old holders, and the
chain would take their signature on anything still naming that key.

**The hold output is still the bond (§5A.2).** A spend through path B is the one
spend of a bond that does not end it: the census reads its output 0 as the same
bond with the same weight, until it is spent by a release, a return or the
fallback. It is not an abandonment by a guardian (§23A.5). So a start with no
valid proof takes nothing from the node: it stays drawn and earns as before.
Only a release takes a node out.

The census reads a spend as a start when input 0 is the bond, its leaf is
`<node_key> CHECKSIGVERIFY <census_key> CHECKSIG` with the bond's own node key, and
output 0 is a taproot output of the whole bond amount. Any other spend ends the bond.
The bond keeps its outpoint, its depth and its advertisement in the census, so no
leaf and no root changes. The census cannot rebuild the hold output itself: its leaves
name the round's panels, and the panels are drawn from this census. What stands behind
output 0 is the node's own `slash_presig`, which is why it needs nothing else
(kanban #1050).

**Panel members** take nothing from a slash. Signing a release with no valid proof slashes the
signer: the release's witness names them.

**Existing bonds.** Templates 1 and 2 are read as before on the networks that
read them, and nothing moves: a bond stays valid, and no bond is asked to
re-bond. Mainnet reads template 3 only.

**AS MEASURED (2026-11-02, private regtest, Bitcoin Core 31.1, mainnet clocks).**
A throwaway script against bitcoind, 23 of 23 as expected. One plain key stood
in for the census key: Bitcoin sees one BIP-340 signature either way.

| Attempt | Bitcoin's answer |
|---|---|
| census key + presig, money to another address | refused: invalid Schnorr signature |
| presig without the census key; census key without a presig | refused |
| round 1's presig on round 2's hold output | refused: invalid Schnorr signature |
| round 1's and round 2's presig, each to its own hold output | each **accepted**, 332 vB |
| round 2's presig after round 1's start | refused: the bond is gone |
| release at 1 and at 5 confirmations | refused: non-BIP68-final |
| release at 6 by round 2's panels on round 1's hold | refused: invalid Schnorr signature |
| release at 6: panel A alone, panel B alone, 5 + 4 | refused |
| release at 6: 5 + 5 | **accepted** and mined, 501 vB |
| census key before 288, another key on its leaf | refused |
| return at 143, by another key, or before maturity | refused |
| return at 144, mature node | **accepted**, 147 vB |
| fallback at 288, census key, immature bond | **accepted**, 138 vB |

**On chain:** nothing per round. A slash costs 332 + 501 = 833 vB, once.

**The census key, as measured (2026-11-02, kanban #972).** One thread, one process
playing every node, a real key, BIP-340 signature and reshare keeping the public
key, with one node absent. The 1000-node figures are sampled: 25 nodes dealt, and
the census-wide sums are scaled from them. Keygen is what one node does; a node
checks one random combination of all its deals, and a failure splits by halves until
the bad deal is named.

| Nodes / shares / threshold | Keygen, one node | Received, broadcast | Signing list | Reshare deal |
|---|---|---|---|---|
| 15 / 32 / 22 | 0.4 s | 39 KB | 5 nodes, 0.5 KB | 70 ms |
| 200 / 357 / 239 | 19 s | 5.0 MB | 82 nodes, 7.8 KB | 1.3 s |
| 1000 / 1382 / 922 | 7-10 min | 95 MB | 540 nodes, 52 KB | 6.9 s |
| 1000 / 1024 drawn / 683 | 2.2-2.4 min | 37.5 MB | 204 nodes, 19.5 KB | 2.7 s |

Not measured: the batch at 1000 nodes over all its deals, and a run across real
machines.

**Through the node's own code (2026-11-02, kanban #972),** `tools/census-key-regtest.mjs`:
five real seats on one machine and a private regtest, 11 shares, threshold 8. Deals
crossed the seats' doors in 3 s, the record was complete 2 to 3 s after the statement
block, and the anchor from a seat's wallet was 236 vB with 3 signers. All five read the key
from their own chain, a template-3 bond naming it counted, one naming another key did
not, and the next epoch's key had the new node among its holders. The largest body a
key can need, 683 signers, was 822 stack items and 16,965 vB, and bitcoind took it as
standard.

**A reshare through the node's own code (2026-11-02, kanban #972, #1048),** the same
harness, 31 of 31 as expected. A bonded node that does not list `CENSUS_KEY_VERSION`
added nothing to 11 shares, threshold 8. A node of 3 shares left, 8 of 11 held, and all
four old holders said ready. The list was 224 vB with 3 signers. With the largest
holder stopped after its list went out, the run ended with 2 of 3 deals, no record
and the old shares standing. The next epoch's window ran with it back: 3 dealers, the
same public key, a second holder set on every chain, no key added, and all 11 new
shares open that key. The node that left keeps none, and the next epoch asks for no
reshare. A page read both keys from the seats in about 0.1 s in the page's code, against
headers read straight from bitcoind, and refused an anchor outside its chain, a census
with an entry left out, and a second key whose census names a withheld first. The
largest body, 683 signers, in its leaf is 16,650 vB against 16,965 on the stack, and
bitcoind takes it as standard. Not measured: a real round with a template-3 bond
joined through a page, a Chrome, and a reshare at size or across machines.

**A drawn key against the skew that broke the unit (2026-11-02, kanban #1039).** 1000
nodes, Zipf bonds, 2000 draws of 1024 shares, threshold 683, `tools/census-draw-measure.mjs`.
Under the old unit 9 nodes with about 20 % of the capital reached the threshold.

| Who reaches 683 | Capital needed, median | Least of 2000 |
|---|---:|---:|
| the largest nodes, fixed before `h` | 66.7 % | 61.5 % |
| the fewest nodes, picked after `h` (203 median, 178 least) | 40.8 % | 38.4 % |
| the most shares per sat, picked after `h` | 33.5 % | 30.5 % |

The about 60 % is capital that holds together before `h`. The shares are public from `h`
on, so holders picked after it are a bribe, not a stake, and for them it is about a
third on this skew. A flatter census costs more. The Zipf skew is an assumption. See
"The 2/3 line" above for why the bound stands.

### The residual, named

> **Bitcoin cannot verify a WASM replay.** No script, no covenant proposal
> and no soft fork changes this. A fraud proof about "this transcript
> replays to DELIVERED, not FAILED" is not expressible on chain. Therefore
> any slashing mechanism needs an off-chain party to attest that the proof
> checks — and that party can, in principle, slash without cause.

Arena therefore does not claim trustless slashing. It bounds the trust:

- **Arbitration is disjoint from the round committees** and from settlement.
  It touches bonds only; it can never move a player stake, delay a round, or
  influence a result.
- **Slashing without a valid committed proof is provable misconduct**, which
  destroys the arbitration set's standing and, where the arbitration members
  are themselves bonded, their bonds.
- **Path A caps the damage in time**: an inactive arbitration set cannot hold
  a bond past `bond_maturity`. Under templates 1 and 2 it does not stop a
  hostile one, because path B has no timelock. Template 3 does (above).
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

Given `census_height`, every participant runs the same five steps:

```text
1. SCAN     all outputs created at or before census_height whose script
            matches the bond template (5A.3B) and that are unspent at
            census_height with >= census_confirmations depth.

2. RESOLVE  for each, read the committed H(advertisement) and retrieve the
            body from the node, a mirror, or any peer. Hash must match.
            Unretrievable body -> excluded (identically for everyone: the
            hash is public, the content is missing for all).

3. FILTER   apply 5A.3. Objective criteria only. From protocol 22 also
            the absent nodes of the posting node's claim (5A.3), each with
            3 seating certificates proving it absent, checked by every
            seat and by the client.
            From protocol 26 also the stalled nodes of that claim (5A.3,
            "Stalled in its rounds"), each with the notes of 3 failed
            rounds, checked the same way.

4. SORT     ascending by (funding_txid, vout) as raw bytes.
            Outpoints are unique, so the order is total and tie-free.
            NOTE: sorting by H(node_pubkey), as an earlier draft said, is grindable —
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
the same assumption every browser Bitcoin application makes — and it is
**not** bounded the way an earlier revision claimed *(P4)*. That revision
said a wrong census costs a failed entry, never funds. That was false under
every construction: a client that accepts a forged census accepts the
forger's committee, deals it the preimage shares, locks to its attested
claim key (§23.1), and that committee signs itself a `FAILED` and claims
the stake. A forged chain view is the whole round handed to the forger.
This is why §25.1's verification rule is normative and why, for a paying
round, a client MUST obtain headers from at least two independent sources
and MUST refuse a census any one source alone vouches for. The reference
client ships with multiple providers and a hard-coded checkpoint for that
reason, not for convenience.

## 5A.5 Committee seed — from randomness published *after* the round *(closes the grinding attack)*

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
beacon_block     = the first Bitcoin block whose median-time-past is after
                   committee_time, at the round's confirmation depth
round_randomness = hash(beacon_block)
                   the 32 bytes of the double SHA-256 of its 80-byte header,
                   in the order the hash produces them (internal order, not
                   the reversed hex a block explorer prints)
```

**RULED 2026-09-24: the block hash itself, as the code has it.** The
earlier text read `H(hash(beacon_block) || height(beacon_block))`; the code
seeds the committee and the world with the block hash, and every seed in
every test, fixture and live round is built on that. The height adds
nothing: the block's hash already commits to its height (BIP34 puts it in
the coinbase), and both uses pass the value through a tagged hash again -
`committee_seed` here, `player_seed` in §12 - so no domain is shared with
anything else. Changing the code to the old formula would move every seed
and buy no security. The spec follows the code.

**Bitcoin is the mainnet source** *(ruled, 2026-09-11; drand
removed)*. The beacon is a value that **does not exist yet** when the
contract is published — and "published" is objective: the
contract's hash confirms in a block strictly below the beacon block
(`publication_txid`). The Round Contract commits to *which* block will be
used (`randomness_rule`, derived — never a height an author could name),
not to its value. The height is derived because a named height would be a
choice, and a choice is a grinding surface.

What Bitcoin buys and costs against drand: no external federation to reach
and no second trust assumption — the client already verifies headers for the
census (§5A.4). What it costs is miner influence: a miner can discard a
block whose hash he dislikes, at the price of that block's reward. Against
pools of thousands of sats that is no attack; the stake ceiling (§5A.10)
keeps it that way, and §27A.6 lists the source as a genesis parameter so a
network that ever needed another could only be a successor (§27A.8).

> **Why:** in an earlier draft the creator chose `round_id` while `public_randomness` was
> already known, so committee selection was a pure function of a value the
> attacker controlled. Grinding round_ids offline until both committees
> consisted of his own nodes was trivial and undetectable — §5A.11's
> "committee cannot be overwritten" check passed, because nothing was
> overwritten. Sourcing the seed from a *future* beacon makes the committee
> unknowable at creation time. Grinding now requires predicting a Bitcoin
> block hash, which is the chain's own security assumption.

### The `committee_time` window

An earlier draft placed committee selection at `start_time` and then permitted stake
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

A series' publication is not held to this lead: its own rule is below.

**Anti-grinding is anchored on chain, not on receipts**. An earlier revision
had the creator collect timestamp receipts from five census nodes predating
the beacon. That was two holes. Any five bonded nodes — not selected ones,
any five — could backdate a receipt, which put the grinding attack back at
the price of five cheap census entries. And receipts were free, so a creator
could publish a thousand candidate contracts, let honest nodes timestamp
them all, wait for the beacon, and promote only the one whose committee was
his: each candidate is a fresh draw, and with 20% of the bonded capital
(≈0.5% per draw, §5A.10) two hundred free draws make a captured committee
near certain. Nothing in the client can see the difference, because
`operator_id` is self-declared.

Both close the same way: **a Round Contract exists only once its hash is in
a Bitcoin block before the beacon block.**

```text
publication_txid      a transaction carrying
                      OP_RETURN "BLW" ROUND H(RoundContract)     (36 bytes)
                      confirmed at a height strictly below the beacon block
```

The ordering is then objective — the beacon block's hash did not exist when
the publication confirmed — and every candidate costs a transaction. The
arithmetic that makes this enough: with per-draw probability `p` and a
publication costing `c`, a captured committee costs the attacker `c / p` in
expectation — at 200 sat and 20% capital about 40,000 sat per capture, more
than any 100-sat-bracket round holds — and a capture spent on settlement
theft is a public federation transaction that slashes five bonds at two to
four times the round's gross volume each (§5A.3, §5A.10). The publication
cost prices small rounds; slashing prices large ones. A round with no
publication, or one confirmed at or after the beacon block, is invalid and
gets no entry receipts.

- Between `published_at` and `committee_time` the lobby shows
  **"committee: pending"**. No stake may be committed in this state, and the
  client offers no entry button.
- There is no fallback beacon: the beacon is a Bitcoin block, and
  a client that cannot see Bitcoin cannot verify the census either. If no
  block confirms within the grace period, the round never opens for entry;
  since no stake was committed, nothing needs refunding.

### Round series — a new round every 90 seconds *(RULED 2026-09-28)*

**The nodes open a new round every 90 seconds, continuously.** A publication
and a beacon per round cannot carry that: each costs a transaction and waits
on Bitcoin for its block and its depth - an hour at best on mainnet, many
hours on testnet4 (measured 2026-09-27/28: a round published at 01:58 had no
block to carry its publication before its beacon arrived at 03:58, and died
there). So the unit anchored on chain is a **series**, and the rounds of a
series need nothing more from Bitcoin.

```text
SeriesContract        every field of a Round Contract except the round's own
                      times, plus:
  series_start        wall-clock instant of round 0's entry opening
  round_period        90 s (the network's reference; a genesis parameter)
  round_count         how many rounds the series holds (cap below)
  round_run           82 s, every run of the round starting at its start_time (below)

series_id             = H(SeriesContract)
publication           OP_RETURN "BLW" SERIES series_id, confirmed before
                      series_start (CENSUS3D-1401; a series has nothing to
                      grind, below)
committee_time        = series_start - series_lead_min
series_lead_min       a genesis parameter (§27A.6): mainnet 72 h (2026-09-28 11:31, HORIZON72-1131; census, committee
                      time and lead one 72 h since 14:02, CENSUS3D-1401);
                      testnet4 24 h (14:05, TN24-1405), with its census
                      cut 36 h ahead (14:09, TN24-POST-1409)
beacon, depth         as above, once per series; reached inside the 72 h
```

**Timing - every network, every round *(RULED 2026-09-28; replaces
0a4c25c4's 15 s entry window and 90 s run)*.** A new round starts every
**90 seconds**, and **every run of a round starts together** at its
`start_time` and lasts at most **82 seconds** (`round_duration_s` = 82,
`blockTicks` = 4920 at 60 ticks/s). A player plays every round without
missing one: the run ends at least 8 s before the next round starts, the
result card stands for those **8 seconds**, and then the page says
**"joining next round in N seconds"** beside an **"exit game"** button until
the next start. This holds on mainnet, testnet4 and regtest, and for free
rounds as for paying ones - there is no longer "test" timing.

```text
start_time(i)      = series_start + i * 90 s
entry_open(i)      = committee_time(i)          (the committee exists; 5A.5)
entry_close(i)     = start_time(i) + late_join  late_join = 0 or 45 s, fixed by the series
                                                (in its template, so in its series id)
last_entry(i)      = start_time(i) + 37 s       a late-join round: a NEW entry at or after it
                                                is refused - 45 s or less of the run is left
; the same entry posted again is taken
join_tick          = the round's ticks already gone at the join (0 before the start); the
                     run is blockTicks - join_tick and ends on the round's last tick
run ends           <= start_time(i) + 82 s      every run, late joiners included
result card        >= 8 s, then "joining next round in N s" + "exit game"
```

**Late join (RULED 2026-10-02 and 2026-10-03: "Joining an existing
round is possible with 45 seconds in").** A series may let players join a
round that is already running, up to **45 seconds** after its start. The 45
seconds are part of the series template (`entry_close - start_time`), so
they are in the series id and every round of the series derives them; a
series names either 0 or 45 s and nothing else.

**The run ends with the round; the door closes when 45 s remain *(RULED 2026-10-04 14:30,: "They always end at the 82/90 boundary ... A
later join does not extend the round. The late joiner has less time. Join
closes when 45 s remain")*.** The signer nodes are stricter than the bytes:
a new entry of a late-join round is refused from `start_time + 37 s` on (at
that instant 45 s of the run remain), and a late entry names the round's
ticks already gone as its `join_tick` (a node refuses one more than 10 s
behind its own clock). Its run is `blockTicks - join_tick` and ends on the
round's last tick with everybody's, so every run of a round ends by
`start_time + 82 s` and the 8 s before the next start hold for late joiners
too; the page offers a late-join round until `start_time + 32 s` (the join's
own 5 s). No new series was needed: the 45 s in the bytes stand. The
**round's end** of §13A is `entry_close + 2 x start_deadline + T_run` (code:
`roundEndMs`) - after every run's end, as before. Before the late-join
ruling every series round closed its entry at its start and all players
started together; a series with late join 0 keeps exactly that.

**Continuing is the default.** While a player's run of round `i` is on the
road, the page enters round `i+1` for them (its entry window is open: the
committee of `i+1` exists long before, §5A.5), so the next run starts with
everybody else at `start_time(i+1)`. In a paying round that entry locks the
next stake from the player's wallet as any entry does; the player stops it
with **exit game**, on the countdown or at any time before `start_time(i+1)`,
and a stake locked for a round the player then leaves refunds by the lock's
own expiry path (§23.1). A player who is not continuing enters from the
lobby any time before a round's start. At most one round's runs are on the
road at once; each round settles on its own.

**Round `i` of a series is derived, never authored:**

```text
round_contract(i)     = SeriesContract with
                          committee_time  = series committee_time
                          start_time      = series_start + i * round_period
                          entry_open      = its seating certificate (below)
                          entry_close     = start_time + late_join   (0 or 45 s, in the
                                            template; the door is start + 37 s, §5A.5 Timing)
                          round_index     = i
round_id(i)           = H(series_id || i)
committee_seed(i)     = H(series committee_seed || i)
committee(i)          = §5A.6 sortition with committee_seed(i) over the
                        series' census - a fresh draw for every round
round_seed(i)         = H(committee_seed(i) || "world") - the world, the
                        per-round draws; never a value anyone picks
```

Every round of a series is fixed the moment the series is published: nothing
per round is chosen after the beacon, so a series grinds no better than a
single round did, and the anti-grinding arithmetic above holds per series. A
node **must refuse** an entry, a lock or a settlement for a `round_id` that is
not `H(series_id || i)` of a published series whose beacon it holds, or whose
`i` is outside `0 .. round_count - 1`, or whose entry window is not the one
derived above.

**72 hours, about 3 days *(RULED 2026-09-28 14:02, CENSUS3D-1401;
replaces CENSUS90-1400 and the 84 h / 120 h schedule of HORIZON72-1131)*.**
A series' census is cut and its `committee_time` falls **72 h** before its
first entry opens, both at the same instant. Inside those 72 h, and before
`series_start`, the census block reaches its depth, the series is
published, its beacon comes and reaches its depth, and its committee is
drawn. There is **no window in front of the 72 h**: no publication window
(the 36 h and CENSUS90's 6 h are withdrawn) and no beacon slack (the 12 h is
withdrawn, and so is the rule that the beacon be deep before
`series_start - 72 h`). A node **must refuse** a series whose `series_start`
is not 72 h after its `committee_time`, and must not list, open or take
entries for a round whose committee it has not drawn. Bitcoin's delays
(testnet4's gaps of hours, a reorg that drops the publication and forces it
again) are absorbed inside those 72 h, never in front of a player. The lead is not `abandon_blocks` (48 h),
`departure_notice` or `founding_window` (72 h): those are the federation's
clocks (§23A.1) and do not move with it.

**The series is a function of the clock, so anyone can publish it.** Series
`k` has fixed times, derived from the network's genesis
(`genesis_series_start`, §27A.6), and so a fixed contract:

```text
series_start(k)      = genesis_series_start + k * series_max       (24 h)
round_count          = series_max / round_period                    (960)
census_height(k)     = the highest block whose MTP <= series_start(k) - census_lead
                       (mainnet 72 h; testnet4 36 h - TN24-POST-1409)
committee_time(k)    = series_start(k) - series_lead_min
                       (mainnet 72 h, testnet4 24 h - TN24-1405)
publish_from(k)      = census_height(k) at census_confirmations depth
beacon(k)            = first block with MTP > committee_time(k); drawn from
                       once at depth, before series_start(k)
SeriesContract(k)    = the genesis template with these values; nothing else
```

The census cutoff, `committee_time` and the lead are one number, 72 h
(CENSUS3D-1401). The 120 h census of HORIZON72-1131, the 90 h of
CENSUS90-1400 and the 84 h `committee_time` are withdrawn.

**Testnet4 runs a 24 h lead *(RULED 2026-09-28 14:05, TN24-1405)*,
so a round can be tested the next day, with its census cut 36 h ahead
*(RULED 14:09, TN24-POST-1409)*.** On testnet4 `committee_time` and
`series_lead_min` are **24 h**: `committee_time` falls at
`series_start - 24 h`. The census is cut **12 h earlier**, at
`series_start - 36 h`, and those 12 h are testnet4's **publication window**:
from `publish_from(k)` (the census block at depth) the series is published,
and the publication must confirm **strictly below the beacon block**, the
rule a round published by its creator follows. Inside the 24 h, before
`series_start`, the beacon comes and reaches depth and the committee is
drawn; there is no beacon slack in front of the 24 h. A testnet4 node
refuses a series whose `series_start` is not 24 h after its
`committee_time`, or whose census is not cut 36 h before its start.
**Mainnet does not change**: 72 h, CENSUS3D-1401.

**The writer's horizon is 72 h on every network (TN24-1405).** The node
generates the schedule - every series slot `k` and every round's
`round_id` position, `start_time` and entry window, all functions of the
clock - **72 h ahead on every network, testnet4 included**. That horizon
does not shrink to 24 h. What the lead governs is when a written slot is
**filled**: its census, publication, beacon and committee, which on testnet4
come in its last 24 h and on mainnet in its last 72 h. A round whose slot is
written but not yet filled is listed as scheduled and takes no entry.

**A series already broadcast stays.** The series already published for
**3 October** - and any other series whose publication confirmed before
this ruling - keeps the contract it was published with: its census height,
its `committee_time`, its start. It is neither re-derived nor moved. The
72 h schedule applies to every series not yet published.

**Why publication may now come after the beacon block.** A round published
by its creator must confirm below its beacon block, because a creator who
saw the beacon could grind `round_id` (§5A.5 above). A series has nothing
to grind: every field of `SeriesContract(k)` is a function of the genesis
parameters, the clock and the chain at `census_height(k)` (next paragraph),
so there is exactly one candidate whoever publishes it and whenever.
With the census cut at the same instant as `committee_time`, the census
block cannot be at depth before the beacon block exists, so the "below the
beacon" rule would make every series impossible. For a series it is
therefore replaced by **confirmed before `series_start`** on mainnet; for a
round a creator publishes, it stands unchanged, and on testnet4, whose census
is cut 12 h before `committee_time` (TN24-POST-1409), the series follows it
too.

Every field is fixed by the genesis parameters and the chain, so every node
computes the same `SeriesContract(k)` and the same `series_id`. **Any bonded
node may publish it** - `OP_RETURN "BLW" SERIES series_id` - from
`publish_from(k)` on. On mainnet that is inside the 72 h and it must confirm
before `series_start(k)`; on testnet4 it is the 12 h window and it must
confirm strictly below the beacon block (TN24-POST-1409). The reference behaviour is that every node publishes once
`publish_from(k)` has passed and it sees no confirmed publication yet; the
series counts from the **first confirmed publication** (lowest height, then
lowest txid). A second publication of the same `series_id` is legal and only
wasted fee; a publication of any other hash for slot `k` is not a series and is
ignored. Nothing is chosen, so there is nothing to grind: the old argument
("each candidate costs a transaction") is replaced by "there is exactly one
candidate". If no publication confirms in time - before `series_start(k)` on
mainnet, below the beacon block on testnet4 - series `k` does not exist and its 24 h of rounds are a gap - no stake was taken in it.

**One node on duty posts the next 24 h, and a missed slot falls to the next (RULED 2026-10-13 ~18:35Z).**
"Wir müssen jeden Tag verlässlich follow up rounds für alle Spiele und Networks posten, jeden Tag für die nächsten 24h. Das macht
immer eine bestimmte deterministische node die gerade Dienst hat ... diese node postet die Runden die in 24h starten. Wichtig ist dass
keine gap entsteht. Wenn die Node ihren Slot verpasst, macht die nächste Node, verantwortlich für die nächste Runde das, und die Runde
danach wenn die zweite Node wieder ihren Slot verpasst hat. Bis es gepostet ist. Nur eine node postet die runde." This replaces "every
node publishes" for the rounds of every game and every network (each federation):

```text
slot            one UTC hour; slot i posts the rounds of hour i + 24, [(i+24) h, (i+25) h), one grid per game and network
                (an "item"); consecutive slots cover consecutive hours - no gap, no overlap
on duty         the census at the slot's anchor - the first block whose median time past is beyond the slot's start less 3 h,
                the same for everybody once it exists - ranked by H('BLWP/v1/DUTY' || network_id || slot || node_pubkey);
                the first is on duty. Anyone computes it.
posted          a slot of an item is posted when a transaction carries OP_RETURN "ARN" 'D' slot item_tag (12 bytes) beside the
                grid's series publications, seen in the chain or the mempool
missed          the CURRENT slot's duty node posts its own slot and, from 5 min into its slot, every slot of the last 20 not posted
                yet, oldest first. So a missed slot falls to the next slot's node, and to the one after if that one misses too,
                until it is posted - and at any moment only one node (the current slot's) posts. A missed slot keeps > 4 h of lead.
committee time  each grid's first start less 6 h: its publication confirms long before, and its beacon is 6 deep before it
                starts (measured 2026-10-13: testnet4 made one block per ~20 min while a miner's timestamps ran 1 h 44 min ahead;
                a grid whose committee came 45 min after its publication waited ~2 h for a 6-deep beacon)
```

**One posting per app per day, a primary and a backup, posted by the nodes themselves (RULED 2026-10-14 ~11:22Z, 2026-10-26; kanban #689,
#702).** "Each game may only have one round posting per day and the fees must be as low as possible" (10-14) made the slot a UTC day;
"The round runners must be an integrated part of the node" (10-26) made every node run the duty itself; "Yes make it part of the design,
in the spec" (10-26) added the backup grid. This is the rule every node follows today (arena-protocol `duty.js`, arena-node
`duty-day.js` / `duty-poster.js`):

```text
day             day d (a UTC day) posts the rounds of day d + 1, every app in every OPEN federation: one transaction per app, one
                table per federation (Rock Paper Scissors two), the whole day on the app's period
on duty         the census at day d's anchor (the first block whose median time past is beyond d's start less 3 h) in duty order,
                H(duty tag || network_id || d || node key) - the same list on every node; GET /duty on any node shows its top 3
primary         rank 1 posts from 00:00 UTC of day d; rank 2 from 01:00 and rank 3 from 02:00 if the day's marker is still not seen
                (no later rank: nodes that post nothing cannot push it towards the evening). Marker OP_RETURN "ARN" 'D' d item_tag.
                Census 6 below the tip, committee time 12 h before day d + 1, the newest app version that census can draw. A
                day's rounds are posted by 12:00 UTC of day d, its committee time (kanban #775) - and never later: from 12:00 UTC no node posts a
                primary or a backup for it, only an emergency grid (kanban #742, DUTY_POST_BY_MS)
backup          the node after rank 1 in the same order posts a second grid of the same day: rank 2 from 02:00 UTC, rank 3 from
                03:00 if rank 2 has not, never the node that posted the primary. Its own coins and publication, a census 12 below
                the tip (taken two hours later, so another block), committee time 9 h before day d + 1. Marker "ARN" 'B' d item_tag
played          one grid per window: a round of a backup series (its publication carries the 'B' marker) is offered, and takes
                entries, only while no round of the same app, federation and start from another series is drawn on that seat - the
                primary while its committee is drawable, otherwise the backup. A seat that holds an entry in a window's backup round
                takes none in its other rounds of that window. Seats say it per row (GET /rounds `backup`, `played`); pages offer
                a row most seats play (lobbyRowOffered); a backup under a drawn primary is no live round (GET /games). This is a rule
                of the door: "on that seat" is the seat's own read of its own chain, and seats may differ on it. It decides only whether
                this seat takes a new entry now, never who is in a round (§17, RULED 2026-11-03, kanban #1071)
posted by       every grid names the posting node's key as its creator and signs each series id with it: who posted a day is the
                creator of the series its marked transaction publishes - checkable by anyone, shown on GET /duty and the Health page
proofs          only these postings' rounds - the primary, the backup, the emergency grids, by a creator within the day's first 3 -
                are absence proofs (§5A.3 "Only the duty postings' rounds prove an absence"); a table anyone posted proves nothing
missed          a primary nobody posts falls to rank 2 and 3 as above; a backup nobody posts leaves the day to its primary
dead            a posting whose census block the chain left, whose census the seats' chains (GET /headers) do not hold, whose
                publication a reorg returned to the mempool and its beacon then passed, or whose coins a mined transaction spends
                (conflicted) is dead at once. A day whose postings are all dead, that has no confirmed rounds by 16:00 UTC of day d
                (no posting of its own in a block and not dead, no primary posting of it by any node in a block, and no rounds of it
                listed by the seats; kanban #775 - a day posted by another node is accepted from its block and nothing new is posted
                for it, 2026-10-29), or that is not
                drawable on the seats for the newest version 4 h before it starts (or while it runs), gets an emergency grid of what is
                left of it ("ARN" 'D' with the
                item "<app>-day-emergency"), at most 3, from the day's duty node first and the next ranks 20 min apart. An
                unconfirmed posting has its fee raised once, 3 h before its committee time
paying          the node pays from its own Bitcoin Core wallet, confirmed coins first, at 0.1 sat/vB (raised to at most 1). A node
                that cannot pay - no wallet, no confirmed coins, a chain read through Electrum - says so on GET /duty and posts
                nothing; its day falls to the next rank. arena.conf duty_post = auto (default: on while the wallet holds confirmed
                coins) | on | off; duty_wallet, duty_fee_rate, duty_max_fee_rate
```

**Who pays the fee.** The publisher pays it from its own wallet and is
reimbursed from the node fee (§22A, 5% in Bitcoin Arena) of the series' round 0 - or, if round
0 has no entries, the first round of the series that settles with any. The
reimbursement is one line in that round's settlement: `publisher_payout =
min(publication fee, fee_cap)` to the publisher's bond key, where the fee is
the confirmed publication's own fee, read from the chain (reference `fee_cap`:
10,000 sat). Only the first confirmed publication is reimbursed; duplicates
are the duplicating node's loss, which is what keeps nodes from all
publishing at once.

**Continuity.** Because the times are fixed, **72 h of rounds are fixed
ahead**: series `k`'s census and `committee_time` fall at
`series_start(k) - 72 h`, while series `k-3` runs, and it is published and
drawn inside those 72 h. The lobby always
shows one round open for entries and the rounds that follow it, every one
already fixed; a player never waits on Bitcoin. If series `k` fails, rounds
stop at the end of series `k-1` and resume at `series_start(k+1)` - nothing is
paid or refunded for a gap, because no stake was taken in it.

**What the lead costs.** Every round's committee is known up to 72 h
before the round runs, from the hour its beacon is deep - time to approach its members. That is the same exposure as any
known committee: a member that signs a false settlement loses its bond
(§5A.3), and the per-round stake ceiling (§5A.10) keeps what one round can
win below what five slashed bonds cost (named-claim rounds, from `NAMED_CLAIM_HEIGHT`, kanban #1131; a stock-lock round's settlement signature names nobody, so there only the bracket and §5A.10's income term bound it - kanban #1338). The lead changes when a briber can
start, not what a capture pays.

**Who runs the rounds.** Every round draws its own committees: §5A.6 run
with `committee_seed(i)` over the series' census, per role (§5A.9): 9 drawn,
at most 7 seated from those present, threshold 5 (§5A.7). The census is the one named in the series: every node
whose bond is confirmed and unspent at the series' `census_height` and commits
to its advertisement (§5A.2-5A.3) - including a bond confirmed long ago
(§5A.2). A node bonded after that height takes part from the next series whose
census includes it. Over a series each node sits in about
`960 x 7 x w_node / W_total` committees per role, in proportion to its bond;
nobody chooses who serves, and nobody can move a node in or out of a round.
A drawn node that is offline yields its seat to the next drawn node in score
order (reserve seats, §5A.7); a round with fewer than 5 of its 9 drawn present
never opens for entries. A node that will be away steps out of the census
beforehand (§5A.3, `serving = false`).

**Cap.** One captured beacon draw no longer holds a series: each round's
committee is its own draw, so a capture is per round and the arithmetic of
§5A.6 and §5A.10 holds per round unchanged. `round_count` is still capped so a
series lasts at most `series_max` (reference: 24 h, 960 rounds at 90 s),
which bounds how long one census stands before newly bonded nodes join.

**Per round, unchanged:** each round has its own entries, stake locks, claim
key (§23.1; the committee may deal keys for upcoming rounds ahead), transcript,
objection window and settlement - rounds overlap (round `i+1` takes entries
while round `i`'s runs finish) and settle independently. What moved off chain
is only the round's *existence*: it follows from its series, so it needs no
transaction and no block of its own.

## 5A.6 Selection — bond-weighted stateless sortition
*(replaces an earlier draft's stateful rotation)*

For each role independently:

```text
for each eligible node:
    ticket(node) = H(committee_seed || outpoint || role)      // 256-bit int
    weight(node) = floor( bond_amount / bond_min )            // >= 1, LINEAR
    score(node)  = ticket(node) / weight(node)                // 512-bit fixed point

select the `slots` nodes with the lowest score
```

**Linear, not square-root**. An earlier draft used
`sqrt(bond / bond_min)` and claimed it made splitting neutral. It did the
opposite: four nodes at 1× have weight 1 each, total 4, while one node at 4×
has weight 2 — under square-root weighting **splitting a bond doubles the
attacker's total selection weight**. Linear weighting makes the same capital
produce the same total weight however it is divided:

```text
capital C, one identity   : weight C/bond_min
capital C, j identities   : weight C/(j*bond_min) each, total C/bond_min
```

- **Stateless.** No cursor, no shared counter, no assignment history. An earlier draft's
  round-robin needed a global rotation cursor, and §5A.8 conceded that the
  canonical assignment log was unsolved — i.e. it required exactly the
  consensus the simplification was trying to avoid. Sortition removes the
  problem instead of deferring it.
- **Fair in the long run.** Expected selection frequency is proportional to
  bonded capital, verifiable by anyone over any window of rounds.
- **Deterministic tie-breaking.** Tickets are drawn over the *outpoint*, not
  the pubkey, so a node cannot mine a favourable identity: it would have to
  choose a txid.
- **One ticket per node**. A node holding several bond
  outputs (§5A.10B) draws one ticket, over its lowest outpoint, with the
  summed weight. One ticket per outpoint would hand a node one draw per
  output — the splitting advantage back through the front door.

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

### The client computes the committee itself *(RULED 2026-09-28)*

**A client never takes a node's word for who serves a round.** Before it
seals a stake-secret share, signs an entry or lists a round as joinable, the
client computes the round's committees itself - the same sortition the nodes
run - and compares. Asking several nodes and accepting when they agree is
not a check: nodes that are all wrong together, or all the nodes a player
happens to know, would pass it.

```text
inputs the client verifies itself
  headers        Bitcoin headers up to the tip, checked for proof of work
                 and linkage (§5A.5); from any node or public source
  census         the round's census list per role at census_height: every
                 entry's bond output proven by a Merkle branch against those
                 headers, its advertisement signature valid (§5A.3), and the
                 list hashing to the census_root the published contract names
  beacon         the beacon block by the §5A.5 rule on those headers, at depth,
                 and the series publication strictly below it
  round index    i, from the round's start and the series start

computation
  committee_seed(i) = H(series committee_seed || i)          (§5A.5)
  drawn[role]       = §5A.6 sortition over census[role]      (9 per role, §5A.7)
  seated[role]      = the seating certificate's list, checked against
                      drawn[role] in score order (§5A.7)

refusal
  a node's committee answer, a contract's node list or a seating
  certificate that differs from the client's own computation -> the round
  is refused, the lobby says which node answered what, and no share is
  sealed, no stake locked, no entry signed
```

What the nodes deliver is **transport**: headers, the census entries with
their proofs, the beacon height, the seating certificate. Every one of them
is checked; none is believed. A census entry missing from what a node sent
shows as a root that does not match the contract's `census_root`, and the
client asks another source. The census root itself is fixed on chain by the
series publication (§5A.5), so a node cannot change which census a round was
drawn from after the fact.

The computation is cheap enough for a phone: a census of a few thousand
entries is one hash per entry per role and a sort; the proofs are a Merkle
branch per bond. A client that cannot complete it - no headers, a missing
proof - does not join; it says why, the way a refused entry does.

## 5A.7 Committee size and thresholds

**RULED 2026-11-11 (kanban #1449): a page reads a table's seating once, not once per round.** A table's rounds are seated by its anchor round, so the page keeps each seat's seating answer per (seat, table, role) and reuses it for the table's later rounds while two things hold: the committee the page builds itself for the new round (§5A.6, from the census and the beacon) is the same seats as the kept answer, and the answer is not older than `seating_keep_ms` (60 s). A built committee that differs, a re-seating announced with `&at=`, or the age passing, asks again. The page warms the seating of the table on screen; another table is read when it is opened. The check stays what it was: every round's committee is still built by the page and compared with a signed seating; only the asking is shared. Before this one idle page sent a seat 616 seating asks in 45 s, 5.5× more than the distinct (seat, table, role) triples. A seat answering a table's seating once with its round range is the 2.0 form of the same rule and needs a release.

**RULED 2026-11-07 (spec review, kanban #1314).** A drawn node that answers PRESENT and then signs no SEATING does not hold the round: a seating that drops a member of S with no signature by `seating_close + Δ` (Δ = 20 s) counts as coming after S for the ordered rule, with the missing signature, attested by the signers' own SEEN record, as the justification, so the honest signers may move to it. A slow honest node loses its seat to a reserve, which the text already accepts.

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

### Reserve seats *(RULED 2026-09-28)*

A node drawn up to 72 h ahead (§5A.5, round series) may be offline when its
round comes. So each role draws **more nodes than it seats**:

```text
drawn      = 9 per role     the 9 lowest scores of §5A.6, in score order
seats      = 7              at most; the threshold stays 5
present    = drawn nodes that signed PRESENT(round_id, role, node_pubkey)
             before seating_close = start_time - 120 s  (so round i+1 is
             seated before round i starts and a continuing player can enter it)
seated     = the first min(7, |present|) present nodes in score order
round opens for entries iff |seated| >= 5
```

**A present node answers (RULED 2026-11-02, kanban #979).** A PRESENT says a node
means to serve; it does not show that anybody can reach it, because a node can
push it out from behind an address nobody reaches. So a node leaves out of its
first seating a drawn node it failed to reach twice in a row at its advertised
endpoint, with no answer since, and the next drawn node takes the place. It never
goes below the threshold this way: with fewer than 5 left, the PRESENTs it holds
stand as written above. It keeps the PRESENT, so seats that disagree on who
answers meet by the ordered rule below (kanban #738): the seating of more
PRESENTs comes after, and one seat's bad line costs a reserve, never a round.

Which nodes a seat counts as not answering is public at its `GET /node-facts`, with the address, the failed tries and since when, so any node can compare and ask that address itself. That a node did not answer cannot be proven, only observed, so it costs a seat in a round and never a bond.

**What a node runs on (kanban #984).** Each node measures its cores, its origin (country and nearest Cloudflare data centre, found by the node itself, never its address) and its bandwidth once, reads its operating system, version, RAM and load every hour, signs one small record and hands it to every seat. A seat keeps the newest record of each bonded node, so it stays readable with its age after that node went offline. It is the node's own word: it decides no draw and no seat, and it names no address, path or key.

**A table checks in (RULED 2026-11-02, kanban #1020).** A table is seated by its first
round and plays all day, so the rule above would seat it only once. The first round of a
table in each quarter of an hour of UTC time is its **check-in**: the 9 drawn nodes
exchange PRESENT for it, closing at `start_time - 120 s` as for any round. A seated node
leaves only if a seat holds no PRESENT of it for the check-in *and* failed to reach it
(the rule above), so a node that lives keeps its seat even on a build that sends no
PRESENT for a later round. The rest keep their seats, and the next drawn node that checked
in and answers takes the place; with no such reserve the table stays as it is. The new
seats sign `SEATING(check-in round_id, role, seated list)` under every rule below, with
the signature of every node it seats. That certificate seats the check-in and the rounds
after it, and the seven make their own claim key. A round that already holds entries keeps
the seats it took them under. If the seats do not meet, nothing changes and the next
check-in tries again. A client asks `GET /seating?round=<table's first round>&role=<role>&at=<its round>`,
which answers `{ cert, index }`; it checks the certificate against the draw and that the
check-in is a round of the table at or before its own, and of those a seat hands, the
newest stands. A seating on any other later round of a table is refused.

**The seating certificate.** The seated nodes sign
`SEATING(round_id, role, seated list)`; a round's seating is valid only with
the signature of **every** node it seats. Each node signs at most one seating
per round and role that can still stand, and seats itself only in score order
among the PRESENT messages it holds: it seats a node ranked below one it knows
to be present only if that one is also seated. Two valid seatings for the same
round and role always share a signer - each has at least 5 of the same 9, and
5 + 5 > 9 - so two certificates are proof of **equivocation** by that signer
and slash its bond (§5A.3B). The general constraint, for any parameters:
`2 x threshold > drawn`.

**A second signature only after a member of the first signed another**
*(kanban #738)*. Measured 2026-10-27 23:30Z (Up/Down round d77b3d03): one
overloaded seat signed the seating of the 5 PRESENTs it held at the close, six
signed the seating of 7, and no certificate formed. Seatings are ordered: S
comes before T when T seats at least as many and its i-th seated ranks no
lower in the draw than S's i-th, for every i of S (the seating of more
PRESENTs comes after the seating of fewer). A node that signed S and holds no
certificate for the round and role signs a second seating S' only when

```text
1. a member of S other than itself signed a seating that does not come before S
2. S' is the seating of the PRESENTs it holds now, and S' comes after S
3. it is in S'
4. another node's signature over S' is in hand
```

and only before the round starts. A seat in that state takes the PRESENTs the
others held at the close from them, late. An honest node's signatures then
come one after another in that order: the first node to leave S saw a member
that never signed S and, from a seating not before S, can only go on to
seatings after it - never to S. So S never completes, at most one certificate
stands, and two certificates still prove equivocation only against a node that
broke the rule.

**No rule may ever slash an honest seat** *(protocol 22, kanban #738, RULED
2026-10-28)*. A Byzantine member B of S can sign T, let an honest H move on to
S', and then sign S as well: if S and S' both complete, the two certificates
share H. So from 22 a second seating signature carries its **justification**:
the departing member's signed conflicting seating T, which shows S can never
stand.

**The signature binds the justification** *(protocol 22, kanban #746, RULED
2026-10-28, option B)*. From 22 a SEATING signature is over the seating and
the hash of the justification it carries, under its own domain tag:

```text
justification_hash = H_tag("ARENA/v1/SeatingJustification", justification bytes)
                     (the empty string's hash for a first signature)
signed             = H_tag("ARENA/v1/SeatingSigned", seating_id || justification_hash)
```

`seating_id` is the SEATING id as before (its body, its id and SEEN over it are
untouched). Below 22 the signature is over `seating_id` alone, byte for byte as
before, and shipped rounds are unchanged.

```text
justification = vec(S)            the seating left, node keys in score order
                vec(T)            the member's seating, node keys in score order
                member            32 bytes, M
                signature         64 bytes, M's SEATING signature over T
                bound             32 bytes, the justification_hash M's
                                  signature over T binds
                u8 flags          bit 0: the signer's step before follows
                [signature        bit 0: the signer's own SEATING signature over
                 justification]   S and the justification it binds, when its
                                  signature over S was itself a second one
```

Round and role are the signature's own. A step carries M's signature and the
hash it binds, not M's own justification: M's reasons are M's to present, so
nothing is nested (the #738 nested form, flag bit 0 then, is gone; any flag
beyond bit 0 is refused). A justification stands when S and T are seatings of
the draw (drawn nodes in score order, at most the seats), the signer is in S
and in the seating it signs now, which comes after S, M is in S and in T and
is not the signer, T does not come before S, M's signature over T verifies
binding `bound`, and a step before is the signer's signature over S, binding
the justification with it, which stands for it. The signature the
justification comes with must bind it: a justification attached afterwards,
or one whose hash the signature does not bind, is no step. A justification
carries **at most 8 steps in all** (itself and its steps before, counted
together, not nesting depth); one with more is not encoded, not read and not
counted, and an honest seat whose next signature would need more signs
nothing (so no honest seat ever needs a longer chain to be excused). GET
/seating-sig and the batch door hand it as `justification` (hex) beside the
signature, and an older seat reads past it; the certificate carries, after its
SEEN groups, one `(node key, justification)` per seated node whose signature
on it is a second one, sorted by node key, and nothing when there is none -
and each seated node's signature in a 22 certificate is checked binding the
justification the certificate carries for it (none: the empty string's hash).
A seat counts another node's signature over a seating other than one it
already holds of that node only with a justification whose chain leaves one
held (or one held whose chain leaves this one), and refuses a signature whose
justification does not stand or that does not bind it; a certificate carrying
one that does not stand does not stand either.

**One seating, signed once** *(kanban #746)*. A member signs each seating of a
draw once. Two signatures by one member over the same seating binding
different justification hashes are a fault on their own: the member is named,
with no excuse. An honest seat writes its signature, with its justification,
before any door hands it out; after a restart it hands out the one written and
never makes a new one.

**A chain of departures excuses** *(protocol 22, kanban #744, RULED
2026-10-28)*. A seating equivocation proof over two seatings X and Y of one
draw, X before Y, is valid against a member M only if M signed both and M
**cannot** present a valid chain X = S0 -> S1 -> ... -> Sk = Y: seatings of
that draw in strictly increasing order, M's signature over every Si, and each
step Si -> Si+1 a justification that Si can never stand, bound in M's own
signature over Si+1 (#746). Honest M that signs S, then S2, then T is excused
for S and T even when H cited M's T to leave S and M's reason for T is about
S2: M left S for S2 with a reason too. The excuse never depends on which
seating a citer cited. Two seatings neither of which comes before the other
are joined by no chain.

A chain reaches the judge on the signatures themselves: M's justification for
its last signature carries its steps before (bit 0), each bound in M's
signature over the seating it left, so the certificate of Y holds M's whole
chain; and a seat judging a proof also counts every signature it holds with
the justification it binds (its own included). A presented justification is
checked like any other and counts only beside the signature that binds it; a
forged step - one whose member is not in the seating it leaves, or whose
signature does not verify - breaks the chain.

**Why binding closes it** *(kanban #746)*. A lone Byzantine B could otherwise
sign T first, let H leave X citing B's T, sign X too, and then hang on its own
T a justification citing H's T: a chain that clears B. Bound, B's T carries the
empty string's hash, so B has no step; if B signs T again bound to H's T, its
first signature over T sits inside H's justification and the two name B
outright. A signature can bind only a signature that exists already, so
justifications never cite each other in a circle: the earliest signature by
any member of a completed X over a seating that conflicts with X has no
justification that stands, and its signer signed X too. So a proof by two
completed seatings always names at least one signer.

The attacker is still caught: every step names a member that killed the
seating it left. When that seating is one of the two certificates, the member
signed it (it is seated in it) and its own seating, not before it: the two are
an equivocation of their own (`seatingSignedTwice`; the proof by two
certificates names it too) unless that member presents a chain between them in
turn. Two completed seatings still void the round. If every signer of both is
excused, the proof names nobody: it is kept as an unnamed fault record
(`unnamed`) that never feeds a slash, an exclusion or a reputation count.
Slashing on seating equivocation stays as built (none in 2.0); when it comes it
applies only to the members a proof is valid against under this rule. GET
/seating-equivocation names who is proved against (`signers`), who is excused
(`excused`), the step proofs (`signedTwice`, each with the hash its signature
binds), the members that signed one seating twice (`doubleSigned`) and whether
it names nobody (`unnamed`).

**Who was present** *(protocol 22, kanban #727, RULED 2026-10-27)*. From
22 the certificate also says who was present, because it is the only proof
that leaves a node out of a census (§5A.3, "Absent from its seatings"). With
its SEATING signature each seated node signs
`SEEN(round_id, role, seating_id, present, left_out)`: `present` every node
it held a valid PRESENT of at the seating close - seated, a present reserve,
and a node the round's census left out coming back - and `left_out` the
nodes the round's census left out as absent. The certificate carries these
after its signatures, grouped by identical lists, and stands for a 22 round
only with one SEEN from **every** seated node and from no one else. A node
is present at the seating if any seated node names it, so hiding an honest
node's PRESENT needs every seated node to lie. A PRESENT is taken only until
the close (but at a seat whose seating can never stand, above, which lists
those it took late in the SEEN of its second seating); one that arrives later
is in no SEEN, and for the proof that
seating is missed. The SEATING body, its id and the equivocation rule are
unchanged, and a certificate below 22 carries no SEEN, byte for byte as
before (a below-22 certificate that carries one is refused).

**Heartbeat committees** *(protocol 22, kanban #727, RULED 2026-10-27)*.
Besides its seats, every 22 round that seats itself draws one heartbeat
committee of 9 for its heartbeat slot (§5A.3, "The heartbeat"; one slot per
round, the owner 2026-10-27), on the round's census and committee seed with its
own tag. They serve nothing
and sign no result: they only sign who they heard. The threshold is the
seating's, 5 of 9, and the same `2 x threshold > drawn` holds, so two
certificates of one slot share a signer.

A client takes an entry only for a round whose seating certificate it holds
and has checked against the draw it computes itself (§5A.6); the lobby lists
the seated nodes of each round. A node that sees two certificates for one
round publishes both, and the round is void (§13C) - no stake was taken,
because entries need the certificate.

**What the reserve buys**, with a share `q` of the drawn weight offline
(independent draws):

| offline `q` | P(round fails), 7 drawn, need 5 | P(round fails), 9 drawn, need 5 |
|---|---|---|
| 10% | 2.6% | 0.1% |
| 20% | 14.8% | 2.0% |
| 30% | 35.3% | 9.9% |

The reserve changes nothing about capture: a seated committee is still 5 of
at most 7, drawn from the census by §5A.6, and an attacker gains no seats by
being present - only an honest node that is absent loses its seat. An
attacker that controls reserve seats and keeps the others from seating needs
their absence, which it cannot cause without breaking their node.

## 5A.8 (removed)

The stateful rotation cursor of an earlier draft is gone; see §5A.6. Nothing in this protocol
requires a canonical assignment log.

## 5A.9 One set of seats in both roles

From protocol 2 a round has **one draw and one set of seats**: the same 7 hold
both roles, game/verify and settlement (`sortition.js drawRoleOf`; the owner
2026-10-14, kanban #308, #1045). Measured with the real `selectCommittee`, 200
rounds on a 40-node census: 1.16 seats of 7 in both roles at protocol 1, 7.00 at
protocol 2, 22 and 24.

`overlap_count`, the seats that hold both roles, is published, and the client
shows it before a paying join (§22, Transparency). From protocol 2 it is the
whole set by design, so a threshold in one role is the same threshold in the
other. What that means for a stalled entry is §22's residual (P6).

*History, protocol 1 only:* it drew game/verify, removed those nodes and their
`operator_id` siblings from the settlement pool, and drew settlement from the
remainder.

Template 3's panels are not affected: they are drawn apart from this set
(§5A.3B).

## 5A.10 Minimum census size and stake ceiling

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

**The income term (RULED 2026-11-07, kanban #1280).** The table above prices
theft, which is paid for with bonds. A stall is paid for with nothing but
future fee income: a bribe to three quiet seats is cash, paid once, and the
bench (§5A.3, "Stalled in its rounds") costs them fee income over months. A
bond is a one-time number too, so it cannot price that. So a round's pot is
bounded a second time, by what one seat earns in a season:

```text
income_seat   = nodes' fee of every round that counted for the season
                (§27A.9.6's board, the rounds of kanban #1218, over the
                last `season` = 12,960 blocks) ÷ the census size at the
                round's census height
max_round_pool <= income_seat        (the lower of this and the table wins)
```

Three quiet seats then forgo at least three pots when the bench takes
them out of the draw for a season, so the losing side's whole budget, the
refund, cannot pay them. Read the same at every seat: both inputs are the
deterministic ones the leaderboard reads. A network with no season behind
it has `income_seat = 0` and plays the table's lowest bracket. The term
matters where the fallback claim (§23.2) does not reach: stock-lock rounds
before `NAMED_CLAIM_HEIGHT`, and a round with no agreed result at all.

Rationale: at 100 × max_round_pool, an attacker reaching the ~17% control
probability of §5A.6 must bond ≈ 50 × the pool he could steal, and forfeits
five bonds when caught (from `NAMED_CLAIM_HEIGHT`; before it a stock-lock settlement is a FROST signature that names nobody, so the theft costs no bond and only the bracket and the income term bound it - kanban #1338). The ceiling exists so that the arithmetic stays that
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

**Counted as one bond (protocol 19, kanban #544).** A node is its
`node_pubkey` AND its `operator_id`: outputs of two operators never merge,
even under one key. From protocol 19:

- each output is still checked on its own - template, marker, retrievable
  advertisement, `census_confirmations`, and its own maturity;
- the round's `bond_min` is applied to the node's **sum**: a 32,000 sat output
  beside a 50,000 sat one is in, the node at 82,000; an output whose node sums
  below the floor is excluded by that sum ("that node's bonds sum to N");
- the node's **newest advertisement over all its outputs** (an update, or a
  newer output's own body; the higher block, then the later position, then
  the larger txid) decides version, serving, roles, games and endpoint for
  every one of them - each output keeping its own maturity height;
- every reader of a bond reads the sum: sortition weight, a federation's
  bonded guardians, the record's guardian rows, the gateway seats, the
  capacity view's B*, a node's standing.

**The chain's own census sums from a height (RULED 2026-11-02, kanban #1063,
#1064).** The census no round names, read by a federation record's basis, the
ballot, a founding, the duty order and the arbitration set, sums a node's
bonds from `CHAIN_CENSUS_SUM_HEIGHT`, one per network. A census decides money
and seats, and a reader who differs signs different bytes, so the **height
read** decides, not the clock: a census below the point reads as before, the
floor on each output, and a census at or above it is summed. A record, a ballot
or a founding checked later against an old height gets the old answer on any
release, and nothing already decided changes. The one place this is decided is
where the chain census is derived. Mainnet is from genesis; testnet4's point is
named after every seat and installer node runs a release that has it, and until
then it never sums.

Below protocol 19 the floor stays each output's, as before. **Add to bond is
the default way to raise a bond** (2026-10-19: "e.g. increase your bond
by 32000 sats"): `arena-install --add-bond <sat>` or the owner page's "Add to
bond" shows the amount, the fees, the new total and the added output's
maturity, and posts it with the node's current advertisement; the warnings
say "increase your bond by N sat". `--rebond` stays for joining matured
outputs into one.

## 5A.11 Selection cannot be overwritten

The Round Contract contains:

```text
census_height, census_confirmations
game_verify_census_root
settlement_census_root
randomness_rule                 // WHICH future beacon round, at committee_time
selection_algorithm_version     // linear-weight sortition
publication_txid                // H(contract) in a block before the beacon block (§5A.5)
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

The node fee (5% in Bitcoin Arena, §0A.8) goes only to the committee that actually serves the round
(§22A). Because selection is bond-weighted and stateless, long-run fee
income is proportional to bonded capital and uptime, not to the number of
identities. No node holds a permanent slot, and no developer, lobby or round
creator decides who earns.

## 5A.13 Player–node separation

> **A player declares no operator.** (RULED 2026-10-14 ~20:01Z: "Remove the do you run arena nodes section and also
> remove it from the specs".) The Entry Contract carries no operator declaration, the client asks for none, and no node is
> made conflicted, unpaid or slashable by one.

Self-dealing - an operator whose nodes are seated in a round he plays - is stopped by the two mechanisms that never depended on
a declaration: an attacker must control 5 of 7 selected slots, which §5A.6 prices in bonded capital, and a fabricated result is
overturnable by anyone through deterministic replay inside the objection window (§13A). Economic Sybil resistance comes from
**bonds and sortition**.

The advertisement's `operator_id` stays: nodes sharing a declared operator are siblings for the census and seating rules
(one seat per operator, §5A.6, §23A).

---

# 6. Permissionless round creation

There is no central `CreateRound` server. Anyone may create a Round
Contract; it is valid because its fields satisfy the protocol. No developer
signature is required.

```text
RoundContract {
  round_id
  protocol_version                 // 1, Bitcoin Arena (§0A.9)
  game_id                          // Arena v1: the exact GameManifest this round plays (§0A.3)
  sim_wasm_hash                    // client checks against known-good list (§5); must be in the manifest's cores[]

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
  randomness_rule                  // the first Bitcoin block after committee_time, at depth (§5A.5)
  published_at
  committee_time                   // >= published_at + min_publication_lead
  entry_open_time                  // == committee_time (§5A.5)
  publication_txid                 // H(contract) on chain before the beacon block (§5A.5)
  publication_relays[]             // where transcripts, attestations and objections are posted (§13A, §25.2)

  game_verify_slots = 7,  game_verify_threshold = 5
  settlement_slots  = 7,  settlement_threshold  = 5
       // echoed for readability; MUST equal genesis_parameters (§27A.6),
       // which network_id commits to. A contract disagreeing with the
       // network it names is invalid, not a smaller committee.

  node_fee_bps = 500               // basis points of the gross round amount, so 5% (Bitcoin Arena, §0A.8; BLWP had 200)
  config_hash                      // the game_config this round runs (§27A.7.5)
  donation_bps_max = 10000         // protocol cap 

  bond_min_game_verify
  bond_min_settlement
  bond_script_template_version     // §5A.3B
  slashing_rules_hash
  arbitration_set                  // k-of-m keys; bonds only, never stakes
  arbitration_k, arbitration_m
  bond_maturity                    // absolute locktime for unilateral recovery

  objection_window_W               // exactly 600000 ms (WINDOW-10-SPEC, 2026-10-01); any other value is an invalid contract
  equivocation_rule_hash
  no_quorum_rule_hash
  custody_rules                    // see §23; the one value is FEDERATION (§23.6); any other byte is an invalid contract
  federation_id                    // the federation holding the stake locks;
                                   //   valid only if its guardians are bonded census nodes (§23.6)
  stake_expiry_blocks              // replaces htlc_cltv_days; 144 (§23.1)
  claim_window_days

  disconnect_rule
  finality_rule

  creator_pubkey
  creator_signature
}
```

The creator gains no administrative power after publication — and no influence over the
committee either.

---

# 7. Player Entry Contract

```text
PlayerEntryContract {
  round_id
  player_pubkey

  stake
  join_time
  vehicle, loadout, cargo

  seed_commitment                  // H(player_secret)
  stake_point                      // P·G, P = player-generated scalar (§23.1) — a point, not a hash, so VSS is checkable against it
  vss_shares_ref                   // P shared to the settlement committee (§23); Feldman A0 == stake_point
  fee_preimage                     // F, in clear: opens the fee lock (§23.1)
  stake_lock_outpoint              // the stake lock in the federation (§23.1)
  fee_lock_outpoint
  claim_key_attestation_ref        // the settlement seats' signed claim key (§23.1)

  sim_wasm_hash
  payout_hash, fee_hash
  equivocation_rule_hash           // player accepts forfeit-on-equivocation
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

# 8. One downloadable Arena node software

One open-source package, `arena-node`. Depending on enabled roles, an
installation can accept and timestamp entries, receive checkpoints and
transcripts, store enough data for replay, replay and sign results, and
participate in threshold Lightning settlement.

```text
7 GAME/VERIFY role slots  -> 5 matching signatures required
7 SETTLEMENT role slots   -> 5 matching authorizations required
```

These are roles of the same software, not different products. Selected slots
SHOULD be operated by genuinely independent parties; the same operator may
technically enable both roles. From protocol 2 one set of 7 holds both
(§5A.9), and the client displays that.

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
3b. settlement seats publish        claim_pk, signed by >=5 seats (§23.1 step 0)
4. player builds Entry Contract    P generated, Feldman shares to THIS committee, A0 = P·G
5. player wallet holds the stake   e-cash (§24A.1); if short, a Lightning deposit via any listed gateway
6. client locks the stake          spent from the player wallet into a stake lock (§23.1), not settled
7. >=5 EntryReceipts               STAKE_COMMITTED
8. play
```

A player is financially admitted if:

```text
valid Entry Contract
+ built against the round's published, verified committees
+ stake committed as a stake lock in the round's federation (§23)
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
local forward simulation was performed. Arena makes no such claim.

**Receipt gossip.** Committee members exchange digests of the
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

**Price samples are world input** *(new, 2026-09-16)*. The front (§0.5A) moves
with the live price, so the price the run was played against must replay
identically on every node:

```text
PriceSample { tick, price_cents, attestation }
```

`price_cents` is the BTC/USD price in cents as an integer. `attestation` is
the game/verify committee's signature over `(round_id, tick, price_cents)`:
the committee nodes publish one attested sample every 5 s of round time from
the contract's named feed - and, with the first, the 64 samples before
`start_time` from the feed's history, so the ground is a full chart from the
first tick - and a client includes each sample in its next
`InputBatch` at the tick it applied it. A sample without a valid attestation,
or applied at a tick other than the one signed, makes the batch invalid. A
run that received no attested feed runs on the round's seeded synthetic tape
and its result carries `front_mode = SIM` - the same fallback the client
already shows for every feed - and nodes replay it the same way. The player
never chooses the price; he can only replay it or not play.

**Protocol 5: the median of signed readings** *(RULED 2026-10-14
~21:50Z,: "Build A as protocol 5 ... each seat signs the price it
read, and the sample is the median of five signed readings. Nobody proposes a
price, so nobody chooses BULLS, BEARS, or FLAT. That signature change is
protocol 5.")*. Measured before it: rounds `6b51be20` / `a45f2ae5` were signed
FLAT by 7 seats with both ends at $81,766.45 while the run traded
$81,713-81,838 - one seat proposed each sample and the others signed it within
a tolerance of their own reading, so the proposer chose the front. For a round
whose own contract names protocol version **5 (2026.0.5)** or later:

```text
PriceReading     { round_id, tick, price_cents }          // ONE seat's own price of one moment, signed by that seat alone
PriceTapeReading { round_id, tick, price_cents[64] }      // one seat's own 64 readings before start_time, signed once
PriceSample(5)   { tick, readings[>= 5 of distinct committee keys] }   price = median(readings)
PriceTape(5)     { tick, tapes[>= 5 of distinct committee keys] }      price[i] = median(tapes[*][i])
```

- Each committee seat reads the feed itself (the exchange ticker, a price at
  most 5 s old, else no reading) and signs **only its own** reading of each
  moment, with its node key (BIP-340, tag `ARENA/v1/PriceReading`, body
  `round_id || u32 tick || i32 cents`). Nobody signs anyone else's price; no
  seat proposes one, and no leader carries price authority.
- Every seat posts its reading to the round's other seats (`POST
  /price-reading`) and keeps every reading that verifies under a key of the
  round's committee. A key that signs two different readings of one moment
  counts for neither. A sample **stands** with at least `threshold` (5 of 7)
  readings by distinct committee keys; its price is their **median**: sorted
  ascending, an odd count the middle reading, an even count the **lower
  middle** - always a price some seat actually read, never an average. A
  sample carrying more than `threshold` readings uses all of them. Anyone
  checks it by verifying every signature, the keys and the count, and
  recomputing the median; a stated price is never trusted. A forged reading,
  a second reading by one key or a key outside the committee refuses it.
- With at most two of seven seats lying, the median of five or more readings
  has two honest readings at or above it and two at or below it: no outlier
  moves it beyond the honest seats' range. *What is left:* whoever assembles a
  sample from more than five readings could leave some out; the median of any
  five of seven is still one of the middle three, all honest. Seats serve a
  sample once all seven readings are in (or 2.5 s after its moment), and a
  seat's RoundResult takes every reading of the committee it holds or can
  fetch, so the seats agree on one set.
- **The tape** before `start_time`: each seat signs its own 64 readings once
  (tag `ARENA/v1/PriceTapeReading`) - one signature a seat instead of 64, a
  batch carries 7 x 352 bytes instead of 7 x 64 x 100 - and each position's
  price is the median of that position over at least five such tapes. A seat
  that missed a moment signs no tape; it never fills a gap with an older price.
- In an `InputBatch` a protocol-5 sample is attestation kind 2 `[tick, 2,
  median, [key, cents, signature] x n]` and the tape kind 3 `[tick, 3,
  medians[64], [key, prices[64], signature] x n]`. A round of protocol 5
  refuses a proposed-and-countersigned price (kinds 0 and 1); a round below 5
  refuses readings and keeps the attested sample above **unchanged**, byte for
  byte. The scheme is chosen by the round's version, never the seat's.

---

# 12. Randomness

```text
round_randomness = hash(beacon_block)                // §5A.5 (ruled 2026-09-24); also the committee seed source
player_seed      = H(round_randomness || player_pubkey || player_secret)
```

**One world per round where the round's config says so *(RULED 2026-10-04)*.** Under a shared-world config (`2170f250`, §27A.7.8) the
world is `round_seed = H(committee_seed || "world")` (§5A.5) for every player
of the round: no `player_secret`, key or `join_tick` moves it, the entry's
`world_secret` is 32 zero bytes, and a node refuses an entry that names any
other. The beacon of a series is known a day ahead, so a world a player
could pick a secret or a fresh key for was a world he could try offline and
enter with the easiest - the per-player rule below is kept only for the
rounds published under the configs before it.

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
states. That is accepted and stated; Arena does not claim bot resistance
(§33).

---

# 13. Results

Each committee node independently replays the player's canonical transcript
(§13C) using the pinned simulation version and signs:

```text
PlayerResult {
  round_id, player_pubkey
  result, score
  front, front_open_cents, front_close_cents, front_mode   // BULLS | BEARS | FLAT; LIVE | SIM   (new)
  transcript_hash, sim_wasm_hash
  node_pubkey, signature
}
```

`front` here is the lead at the tick the run ended (`BULLS LEADING`), signed
with the run so that the tape the run was played against is part of the
result. It does not enter `score`. **Who won the round** is decided once, by
the price, at the round's end (WAR_TACTICS.md §4.14):

```text
RoundResult {
  round_id
  open_cents, close_cents          // first and last attested sample of the round
  front                            // BULLS if close > open, BEARS if lower, FLAT if equal
  node_pubkey, signature           // 5-of-7 of the settlement committee
}
```

**From protocol 5** *(RULED 2026-10-14 ~21:50Z)*
`open_cents` and `close_cents` are the **medians** of the committee's signed
readings of sample 0 and of the round's closing sample (the last at or before
its last tick), each standing with at least five readings (§11). A seat keeps
both ends' readings across a restart; at the end one that holds fewer than
the whole committee's asks the other seats for theirs and takes every reading
that verifies, then signs. The object, its bytes and its signature are as
above; only where its two prices come from changes. A round below protocol 5
keeps the first and last attested sample.

It is what every client shows as **THE BULLS WIN** / **THE BEARS WIN**, the
same for every player in the round, whenever they drove. A node that
disagrees about it disagrees about the attested tape, which is objectionable
(§13A). It moves no money and enters no score: the payout table (§20) reads
rank, and rank reads the truck.

Once **5-of-7** nodes sign the identical result, the result becomes
`PROVISIONALLY_FINAL`. The objection window is the round's own (§13A): it
opens at the round's end and closes 600 seconds later, the same instant on
every node. The result becomes `FINAL` when five seats sign it after that
close plus the tolerance, with no valid objection. The player's winnings or refund show as
**pending** from the same moment (§24), not from `FINAL`.

> An earlier draft made 3 matching signatures immediately final. This protocol inserts the
> window, because a signature quorum that lies had no counterparty there.

---

# 13A. Objection window and replay veto

After a result is `PROVISIONALLY_FINAL`, the window `W` runs: **exactly 10
minutes, 600 seconds of wall time** (RULED 2026-10-01 09:40,
WINDOW-10-SPEC).

**One exception, head-to-head rounds (RULED 2026-11-10, kanban #1398; it narrows
WINDOW-10-SPEC and the owner, whose playtest raised it, confirms it).** A
head-to-head round's result is a pure function of two signed commitments and
two signed reveals, checked in a millisecond by anyone who holds them; there is
no transcript to replay and nothing the ten minutes can find. Its window is
**60 seconds** (`objection_window_h2h`; regtest 5), long enough to object with
a receipted reveal the seats did not count, and its settlement follows at
once, so winnings are in the wallet about a minute after the round instead of
eleven. Replayed games keep the 600 seconds, and the page says "N sat arrive in
about 10 minutes" while they wait. Refused: paying at PROVISIONALLY_FINAL (an
upheld objection would then claw back spent money), and re-staking provisional
winnings (a voided round would void the rounds it funded, a cascade no player
can follow).

**The window, stated once.**

- **What it was.** Until this ruling `W` was a contract field with a
  "reference" of 10 minutes, so a round could name another; the code also
  carried it as a window in blocks at both ends, and §13A allowed any value
  up to 6 hours. None of that stands. There is one window on every network
  and in every round: 600 seconds.
- **The clock: the same start and the same length on every node (RULED 2026-10-01).** Wall time, not blocks, and not a moment any node
  observes or any signer writes down:

  ```text
  window_open   = round_end                  the round's end as its contract fixes it:
                                             entry_close + 2 x start_deadline + T_run, in
                                             UTC (code: roundEndMs) - after the latest
                                             instant any run of the round can end, late
                                             joiners included (§5A.5)
  window_close  = round_end + 600 s
  final_after   = window_close + tolerance   tolerance = 5 s (RULED HERE)
  ```

  Every node computes `window_open` from the signed contract the round id
  binds, without asking anybody, so the window starts at the same instant
  everywhere and nobody can move it: not a node, not a signer's timestamp,
  not a miner. A Bitcoin block is not the anchor: its arrival is random
  (minutes on mainnet, hours on testnet4) and its header time is the
  miner's to shift by up to two hours - a block is the right source for
  randomness, where nobody may know the value in advance, and the wrong one
  for a start everybody must know in advance.
- **Every node measures the same 600 seconds.** Each seat measures against
  its own clock, and the rules below make clock error harmless rather than
  hoping it is absent:
  1. **Nodes keep NTP time.** A seat whose clock is off by more than the
     tolerance is not a valid signer of `FINAL`; another seat may show it by
     its signed times (rule 3).
  2. **`FINAL` is 5 of 7.** A result is `FINAL` only when five settlement
     seats have each signed `FINAL` for it, and a seat signs only once its
     own clock reads `final_after` and it holds no valid objection. One seat
     with a fast clock decides nothing; the window ends, in effect, at the
     fifth honest clock, a few seconds after `window_close` at most.
  3. **Signed times are checked on arrival.** A seat counts a result or
     `FINAL` signature only if the time it carries is within the tolerance
     of the receiving seat's own clock. A back-dated or forward-dated
     signature does not count and is itself evidence against its signer.
  4. **An objection lands when it is public in time.** It is sent to the
     seats and to the round's `publication_relays[]` at once. A seat that
     sees it before its own `final_after` does not sign `FINAL`; since
     `FINAL` needs five signatures, three seats seeing it in time block it,
     whichever seat a player's network reached first.
- **Results must be in before the window closes.** A result reaches
  `PROVISIONALLY_FINAL` - five matching signatures - inside the window, as
  soon as the committee has replayed the run; one that has not by
  `window_close` falls to §13C's no-quorum rule: from protocol 22 the
  re-run window below, then `VOID`, refunded, unless proven equivocation.
  The pending line still appears the moment the result is
  `PROVISIONALLY_FINAL` (§24), and every result of a round with no no-quorum
  entry becomes `FINAL` in the same minute.
- **What a node refuses.** A Round Contract whose `objection_window_W` is
  not exactly 600000 ms is invalid: a node refuses to open it, list it or
  take an entry for it. A node refuses to sign `FINAL` before its own clock
  reads `final_after`, refuses to count a signature whose time is outside
  the tolerance of its clock, and refuses to keep a result short of `FINAL`
  once five seats have signed it with no valid objection on record.
- **A late objection.** An objection that reaches a seat after its window
  closed does not suspend anything: the result is `FINAL`, §14 lets nothing
  undo it, and the payment proceeds. But a valid objection is also a fraud
  proof against every node that signed the contradicted result (§5A.3,
  "a result contradicted by replay"), and that proof has no deadline: it is
  filed for slashing, and the slashed bonds pay the affected players (§5A.3).
  Late is too late to change the result, never too late to cost the liars
  their bonds.
- **What the player sees.** The winnings, or the stake coming back, appear
  as a pending line in the balances the moment the result is
  `PROVISIONALLY_FINAL` (§24), with the amount and the time the window
  closes in UTC - the round's end plus 600 seconds, the same for every
  player of the round. They do not wait for the window. If the payment becomes
  invalid - a valid objection inside the window, a re-run that changes the
  result, `VOID`, a forfeit - the pending line disappears, and the line the
  new result earns, if any, takes its place.

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

**AS BUILT (2026-10-04).** `POST
/objection?round=&entry=[&block=]` takes the objection as its body and
refuses an empty one: 400, "an objection carries its transcript and
receipts (13A)". The body is a bundle of four length-prefixed parts:
- the Objection (`encodeObjection`: round, player, `transcript_hash`, the
  signed result objected to, the claimed outcome and score, the objector's
  key);
- the objector's BIP-340 signature over its id;
- the canonical transcript, as `GET /canonical` hands it out (batches and
  signed marks: the object `transcript_hash` names);
- the signed receipts, as `GET /receipts` hands them out;
- and, when the transcript carries no batches, a fifth part: the run's
  inputs, as `GET /replay/transcript` hands them out. Measured live on
  the free pair (2026-10-04): the live client sends its ticks as play
  frames, so a live run's canonical transcript is its receipted marks
  over no batches. The replay must reproduce every receipted mark's
  state hash, which binds those inputs to the run. Inputs that reach
  past the last receipted mark are refused.

The seat checks it on its own evidence before anything is stored
(`objection-check.js`). The checks run in this order, and each refusal
is named:
1. the signature;
2. the round, entry and result named;
3. the transcript's hash;
4. the checkpoint chain;
5. that the transcript belongs to the entry;
6. that every checkpoint has a receipt signed by a committee member;
7. that the replay under the round's own core gives the claimed result,
   and that it differs from the signed one.

A bundle that fails is refused (422 with the reason) and nothing is
stored. A valid one is stored with its arrival time, taken before the
replay runs, and counts as the replay that disagrees, beside the seat's
own replay. The same function runs outside any seat:
`tools/check-objection.mjs` reads only a seat's public doors (`/round`,
`/entry`, `/results`, `/randomness`) and replays locally.

**Effect:** a valid objection suspends finality. The full committee re-runs
the canonical transcript; the replay outcome is authoritative. Every node
that signed the contradicted result is slashed (§5A.3). If the committee
cannot reach 5-of-7 on the re-run, §13C applies.

**How SUSPENDED ends (RULED 2026-09-24; it was parked on the result-window
field, which the owner ruled 2026-09-15 equal to the objection window).**
Suspension is bounded, by the same contract field, twice at most:

1. The valid objection opens a **re-run window** of 600 seconds of wall
   time from the original `window_close` - again the same instant on every
   node, and the same tolerance and 5-of-7 rule (WINDOW-10-SPEC).
2. A re-run result with 5-of-7 inside that window is provisionally final
   and gets **one** objection window of its own: 600 seconds from the end
   of the re-run window. If none is valid, it is
   `FINAL`. If one is valid, the signers of that result are slashed as
   well and the entry is **`VOID`** at once - refunded by forfeit or by the
   lock's expiry (§23.2) - with no third run: two contradicted quorums in
   one entry is the operator side failing, which §13C already pays by
   refund.
3. No 5-of-7 by the end of the re-run window: **§13C's no-quorum rule
   decides** as at the end of an ordinary result window - `FORFEIT` if the
   disagreement is proven player equivocation (§13B), `VOID` and refunded
   otherwise - and the slashing of the first result's signers stands,
   because the objection that proved them wrong already exists.

So an objected entry is decided at the latest three windows - 30 minutes -
after the round's end; an entry nobody objects to, 10 minutes.
That is the objection path's length, not a range of the window: the window
is always 600 seconds. The stake lock's 144 blocks (§23.1) cover it with
room to spare, and the former rule that a contract's window may not exceed
6 hours is withdrawn with the field's freedom (WINDOW-10-SPEC).
The settlement transaction does not wait on an entry that is SUSPENDED by an
objection: the round settles without it, and a suspended entry's lock is
settled on its own when it ends - forfeited to the player if `VOID` or
`DELIVERED`, claimed in a second settlement transaction if `FAILED` or
`FORFEIT`, paying the same payout table's recomputation (§18). A qualifier
left out that way gets its stake back and no share of the pool.

**The one exception: a round with a no-quorum entry waits for it (RULED
2026-11-02, kanban #1047; protocol 22).** Such a round does not settle until
that entry is decided: at most until the re-run window closes and, with a
quorum in it, until its one objection window closes. That is at most
`round_end + 1805 s`, plus at most 60 s for the `FINAL` signatures to arrive;
past that the entry is left out as above. Waiting applies only if a seat holds
a run of the entry at `final_after`: a signed result, or a receipted mark of it
(RULED 2026-11-02, kanban #1060). An entry with neither has no run, and goes to
`VOID` then. The reason is money: `F`
depends on every result, so a rescued winner left out would be paid nothing,
and a part-settled round cannot fix that. An entry suspended by an objection
still does not hold the round. While a round waits, its pending lines say the
later time (§24).

**After a re-run ends `FINAL` the re-run's result is the entry's result
(kanban #1049; protocol 22).** A seat that signed the contradicted run reads
the agreed re-run, not its own `PlayerResult`, wherever money follows: the
table, the second settlement, the forfeit, the stake secret. Before 22 each seat
read its own result. Measured: such a seat left a re-run `DELIVERED` as `FAILED`
in its table, released its stake secret, and on protocol 1 claimed its lock.

**Client duty:** on delivery, the reference client uploads its complete
transcript to at least two committee nodes and, if configured, to an
independent mirror **before** showing the victory screen. This is what makes
the veto work for a player who closes the browser immediately afterwards.

**Effect on the collusion bar:** five colluding bonded operators must now
also ensure that no honest node, no third-party mirror and no watchtower
holds the victim's receipted transcript. Their fabrication is permanently
provable afterwards, and their bonds are slashable by whoever proves it.

**Publication is a condition of finality**. As an earlier revision stood,
the objection needed a transcript, and the transcript lived only with the
nodes that received it. When the cheater is the player — an operator whose
five nodes are the quorum — he sends the honest two nothing, his five
receipt and sign whatever he likes, the canonical chain (§13C) is his by
construction, and no honest party ever holds an object to replay. The
residual of §22 ("the victim's transcript unavailable") was satisfied by
the attacker at no cost. Therefore:

- a `PROVISIONALLY_FINAL` result is not `FINAL` until the canonical
  transcript it names by `transcript_hash` has been **retrieved by ≥5
  settlement seats** from any game/verify node and **posted by them to the
  round's `publication_relays[]`** within the window. The window counts
  from the round's end (WINDOW-10-SPEC), so the seats post at once: a transcript posted late leaves objectors less of the
  600 seconds, and one not posted when they end leaves the result unable to
  become `FINAL`;
- a settlement seat that cannot retrieve the transcript within the result
  window treats the entry as `VOID` (§13C): a result nobody can replay does
  not settle;
- once posted, anyone can replay it. A transcript that replays to the signed
  result was honestly played; one that does not is an objection; and a
  second signed checkpoint chain in an honest node's hands is an equivocation
  proof (§13B).

`publication_relays[]` are data in the contract — any URL, any relay,
several — never infrastructure of this protocol: anyone may mirror, and the
objects carry their own verification.

## 13A.1 Three auditors replay every round *(RULED 2026-10-27, kanban #725; protocol 22)*

**RULED 2026-11-07 (spec review, kanban #1306).** Four changes so the auditor layer has an equilibrium. (1) The unpaid remainder of the auditors' 10 % goes to the protocol reserves, never back into the nodes' pools. (2) An AUDIT counts when it is on the round's `publication_relays[]` by the cutoff (that path is built), not only when a seat says it holds it. (3) An AUDIT carries one tick hash over every entry of the round (RULED 2026-11-09, kanban #1383): `t = beta mod T_run` from the auditor's own VRF output, with `T_run` the Round Contract's run length, skipped to the next tick if `t` is a checkpoint tick; the hash is `tagged_hash("ARENA/v1/AuditTick", t ‖ for each entry in entry-id order: entry_id ‖ H(its run's state at tick min(t, its last tick)))`, an entry with no run (VOID before any mark) contributing 32 zero bytes. One hash, every run replayed, since the AUDIT vouches for every entry; seats verify it from the replay they already did. A hash over one entry (picked by beta) would prove one replay of many, and one hash per entry would carry the same proof in more bytes. (4) The transcript is posted by `window_open + 120 s`, relay-timestamped, or the result cannot reach FINAL. Before this the seats paid the auditors out of their own fee and kept what they did not pay, an AUDIT needed no replay, and the committee controlled the clock the auditors raced.

**Head-to-head rounds: the audit before FINAL (RULED 2026-11-10, kanban #1400;
the owner: "when the objection window is just 60 seconds, some other node need
to check the result, not just the 5 of 7").** With the 60 s window (§13A,
kanban #1398) a head-to-head result is `FINAL` only when nodes outside the
committee have checked it:

- **Nothing in the round waits for it (the owner, 2026-11-10: "the reveal
  phase must stay fast; the audit runs in the background").** Commit, reveal
  window and decide run exactly as §0A.7 head-to-head rules say, 8 s rounds
  included; the auditors start when the seats' `PROVISIONALLY_FINAL` stands
  and work in parallel to the 60 s window. The audit gates only `FINAL`, the
  payout; never a reveal, never the next round, never play.
- **Who:** the same lottery as below, over the same eligible set `E` (census
  less the drawn, less the players' and operators' nodes, less nodes without
  the audit role), with `AUDITORS_H2H = 5` expected per round in place of 3,
  since the check is a hash and costs nothing. Drawn in secret, published
  with the signature; `(beta, pi)` prove the draw.
- **What they check:** every entry's commitment against its reveal (the
  hash, the move among the game's, the round and entry it is bound to), each
  reveal's receipts against the reveal window, FORFEIT for an entry with no
  stood reveal, VOID with one entry, and the decide adapter's verdict over the
  stood reveals. A check, not a replay: a few milliseconds.
- **What they sign:** one `H2H_AUDIT { round_id, results_hash, beta, pi }`
  per round over the per-entry outcomes (entry-id order, `entry_id ‖ outcome ‖
  score`), posted to the round's `publication_relays[]` and handed to the
  seats.
- **FINAL inside the 60 s** needs the committee's 5 of 7 **and** `k = 2`
  valid `H2H_AUDIT`s over the same `results_hash` from distinct drawn
  auditors, on the relays before the window closes. Five expected and two
  needed: with four of five online, fewer than two answer in about one round
  in twelve.
- **Too few by 60 s:** the window **extends to 600 s** and the round finishes
  as a replayed round does, `FINAL` without audits at the end of the long
  window. Never VOID for want of auditors: the players did nothing wrong. The
  page says "checking the result" for the minute and "arrives in about 10
  minutes" if it extends.
- **A dissenting auditor** files the ordinary §13A objection with the bytes
  that contradict (a reveal and its receipt the seats did not count, a
  commitment that does not open to the counted move); it suspends as any
  objection does. An `H2H_AUDIT` over a result such an objection then
  contradicts is the §13A.1 `AUDIT` offence and is slashed the same way.
- **Pay:** as auditors are paid below, the 10 % of the nodes' fee over the
  valid `H2H_AUDIT`s the seats hold at `final_after`.
- **Until built and live** (its own protocol height), the duty poster names
  600 s on head-to-head days and the 60 s window stays off (kanban #1399).

Every seat of a round's committees replays its runs (§34), and anyone may
object (above). But nobody outside the committee is obliged to look, so five
colluding seats are caught only if somebody happens to replay. From protocol
22 every paid round also has **auditors**: about three census nodes outside
its committees, drawn in secret, who replay every run of the round and
object to a false result.

**Rulings (2026-10-27):** drawn in secret until they publish; `FINAL` does not
wait for them; paid from the nodes' fee, 10 % of it.

**Who may audit a round.** The census at the round's `census_height`
(§5A.2), less:

- every node **drawn** for any of the round's roles (all 9 per role of
  §5A.7, seated or not);
- the nodes of the round's players and every node of their operators
  (§5A.13), so nobody audits a round he plays or profits from;
- every node that does not advertise the **audit role** (below).

**A role of its own, in the owner dashboard** *(RULED 2026-10-27: "Die Rolle
muss im owner Dashboard stehen")*. Auditing is a node role like the others
(§5A.9): the advertisement names it in its roles (`audit`), the owner area's
Roles lists it as **"Audit rounds"** with on and off, and the Rounds section
(kanban #715) shows the rounds this node audited, the objections it filed and
what it earned. The installer offers it with "Play and check rounds" (on
together). **A node that had the verify role before the update gets the audit
role automatically** (RULED 2026-10-27): the updater, or the node at its first
start on protocol 22, adds `audit` to its roles and posts the advertisement
update, with no step by the owner; a node without verify gets nothing added. Only
nodes advertising the role are eligible, so `W` counts no node that would
never replay and the expected number stays three.

Call what is left the round's eligible set `E`, with total weight
`W = sum of weight(node)` over `E` (`weight` as in §5A.6: `floor(bond / bond_min)`).

**The lottery: secret, unique, checkable by anyone.** Each eligible node
evaluates a verifiable random function over the round id with its node key:

```text
alpha          = tagged_hash("ARENA/v1/Auditor", round_id)
(beta, pi)     = ECVRF_prove(node_secret, alpha)    // RFC 9381, ECVRF-SECP256K1-SHA256-TAI
v              = int(beta[0..8]) / 2^64              // in [0, 1)
auditor       iff  v < AUDITORS x weight(node) / W  // AUDITORS = 3
```

- **Secret.** `beta` needs the node's secret key: nobody else, the committee
  included, can tell who audits a round before the auditor shows its proof.
  A committee that means to cheat does not know whom to bribe or avoid.
- **Unique.** A VRF has one output per key and input, so a node cannot try
  again for a better draw (a Schnorr signature would let it: its nonce is its
  own choice). `alpha` is fixed by the round id, before any result exists, so
  the committee cannot steer it either.
- **Checkable.** Anyone verifies `pi` against the node's census key, `alpha`
  and the census, and recomputes `v`, `weight` and `W`.
- **About three, not exactly three.** The expected number is 3; a round can
  have none (about 5 % of rounds, `e^-3`) or more. That is the price of the
  secret draw, accepted 2026-10-27; the committee's own replay and every other
  objector still stand behind it.

**What an auditor does.** As soon as the round's transcripts are on its
`publication_relays[]` (§13A, "where the run is posted"), it replays every run
of the round in the replay worker (§10) and, **at least 30 s before
`window_close`**:

- if every result it replays equals the signed one: it publishes

  ```text
  AUDIT {
    round_id
    results_hash        // H over (entry_id, run id the committee signed) of every entry, in entry_id order
    node_pubkey
    at_ms               // when it was signed: at most window_close - 30 s
    vrf_proof           // pi, and beta
    signature           // node key, over all of the above
  }
  ```

  to the round's seats (`POST /audit`) and its `publication_relays[]`. A seat
  takes it only if `at_ms` is within the tolerance of its own clock (§13A
  rule 3) and at most `window_close - 30 s`, and hands every new one to the
  round's other seats, which take a forwarded one until `window_close`: the
  30 s are for every seat to hold the same set, because the auditors' lines
  are part of the payout all seats sign byte for byte (a seat that still
  differs signs other bytes and the 5 of 7 that agree carry the payout);
- if one differs: it files the objection of §13A for that entry, exactly as
  any objector does. The objection is what stops `FINAL`, and it is a fraud
  proof against every node that signed the false result (§5A.3, §5A.3B): the
  slash follows. An auditor that objects publishes no `AUDIT` for the round.

A drawn node that cannot replay in time publishes nothing. **It never signs
an `AUDIT` it has not replayed**: an `AUDIT` over a result that a valid
objection later contradicts is a fraud proof against its signer, as for a
committee signature ("a result contradicted by replay", §5A.3), and slashes
its bond.

**`FINAL` does not wait for the auditors.** The window, the 5 of 7 and
`final_after` of §13A are unchanged. An auditor that never shows holds up
nothing; it only earns nothing.

**Pay: 10 % of the nodes' fee, to the auditors who published.** At
settlement, after the website's line (§0A.8, `frontend_pk`) and before the
pools (§23A.10 "Pay"), one line off the top of the nodes' part:

```text
auditors_share = floor(nodes_fee_after_website x 10 %)
each           = floor(auditors_share / k)     k = the valid AUDITs the settlement seats hold at final_after
remainder      -> back into the nodes' pools, as if there were no auditors
k = 0          -> the whole share stays in the pools
```

A settlement seat counts an `AUDIT` only if its proof verifies, its node was
eligible, its `results_hash` matches the results being settled, and it was
taken by the rule above. The
player pays nothing more: the stake, the fee and the donation are what they
were. Example, a round of 10,000 sat stakes and a website line: nodes' fee
400 sat, website 40, auditors 36 (three auditors: 12 each), pools 324 (one
verify seat of seven: 11.6 sat, against 12.9 without auditors).

**AS BUILT (2026-10-27, kanban #725):** protocol (`auditor.js`, `vrf.js`), the role, the payout line (`lock-settlement.js`) and the node:

- *The auditor* (`round-auditor.js`, run by `server.js` every 10 s on every node): every paid round of protocol 22 of a replayed game
  (not an attested market, not a head-to-head round) that it holds, is not seated in, and whose window is open. Drawn by its own VRF, it
  reads the round from a seat (`GET /audit-run`: every entry and every signed result), counts the agreed run itself against the
  committee, and replays each entry from what the seats hand out (canonical transcript, receipts, inputs) through the seat's own objection
  check (`checkObjection`, the round's core and beacon). All agree: the `AUDIT` to every seat. One differs: the objection of §13A
  claiming the replayed run, to every seat, and no `AUDIT`.
- *The seat's door* (`POST /audit`, `audit-seat.js`): signed by its node, VRF proof good, the node eligible and drawn, not a player of
  the round, its `results_hash` the seat's own agreed runs, within 5 s of the seat's clock and at least 30 s before `window_close`. Kept
  once per node and round. A new one goes to the round's other seats with the forwarding seat's key (`x-audit-seat`) and its signature
  under `ARENA/v1/AuditForward` over the `AUDIT`'s id (`x-audit-forward`). A forwarded one counts until `window_close`, and only from a
  seat of the round. `GET /audits` lists them.
- *Pay*: the settlement reads the `AUDIT`s held and not contradicted (`signerNodes.auditors`).
- *Contradicted*: where the first result's signers are filed against (an agreed re-run of another run, VOID or FORFEIT after an
  objection, a late objection), every `AUDIT` the seat holds for that round is marked. Its bytes and signature are kept as the evidence
  (`GET /audits`), and it is paid nothing.
- *Slashed* (kanban #724, #725): at the same place the seat files one `AUDIT_CONTRADICTED` proof per contradicted `AUDIT`
  (`verify.js fileAuditSlashProofs`, `slash.js`), with the same standing and the same verdict as the first result's signers: the
  contradicted run is the one they are filed for, and the replay is the seat's own signed result differing from it (for an agreed
  re-run, also being the re-run's run). The proof and what travels beside it:

  ```text
  AUDIT_SLASH_PROOF {                       // type 0x37, 263 bytes; its id H_tag(ARENA/v1/SlashProof, bytes) is what path B commits to
    round_id, entry_id, player_pubkey       // the entry whose run the AUDIT vouched for, and its player
    node_pubkey, audit_id                   // the auditor and the AUDIT it signed
    contradicted_run_id                     // the run the objection held against
    transcript_hash                         // the canonical transcript the objection replayed
    bond_txid, bond_vout                    // the bond the auditor's own advertisement names
  }
  || AUDIT (188) || its signature (64) || n (u16) || n x (entry_id, run_id)   // the rows its results_hash is over
  ```

  The objection that held travels as for a result contradicted by replay: the seat's `GET /objection-bundle` for (round, entry). The
  check (`slashHoldsOnAudit`), every step a comparison or a signature, the replay verdict handed in: the `AUDIT` is the one named, by
  the node and for the round named, and it **stood** (`auditStands`: its signature, its VRF proof for the round, the node eligible and
  drawn, signed at least 30 s before `window_close`); its rows hash to its `results_hash`, and the proof's entry is among them at
  `contradicted_run_id`; the entry is of the round and names the player; the held objection is against that run, on the canonical
  transcript; the bond is the advertised one; the replay differs. Stored once per (round, auditor) (`audit_slash_proofs`), listed for
  the arbitration set at `GET /slashes` under `auditSlashes` (the player-result list is unchanged), served at `GET /audit-slash-proofs`,
  and put to the round's relays (`PUT /slash/<id>`, kept only with the `AUDIT` it names and the rows it vouched for). The arbiter
  (`arbiter.js judgeAuditProof`, `tools/arbiter.mjs`) judges it as it judges the player-result kind: the objection replayed again under
  the round's core and beacon, then the same check, the eligible set from its own census (less the round's drawn nodes, and the
  players off `GET /audit-run` out of the set and still in `W`). Path B and its split are §5A.3's for every slash.

  Decided here, where the text above is silent: (1) **one proof per `AUDIT`**, naming the first entry whose contradiction this seat
  files: one `AUDIT` is one signature and pays from one bond, so a second contradicted entry of the same round files nothing more
  (as a second proof against a spent bond would slash nothing); (2) **the harmed player is that entry's**, as for a result
  contradicted by replay (§5A.3's `affected[]`), not every entry the `AUDIT` covered; (3) **an `AUDIT` that could not have stood is
  not slashable**: one by a node not drawn, or signed inside the last 30 s, vouched for nothing a seat could take, as a stranger's
  result signature owes nothing; (4) **the evidence carries the rows**, not only the `AUDIT`: its `results_hash` alone names no run,
  and the rows are what show a stranger which run of which entry it vouched for; (5) **its own type byte under the slash-proof tag**:
  a proof of one kind never reads as the other, and the commitment stays `H_tag(ARENA/v1/SlashProof, proof)`.

Not built: the `AUDIT` to the round's `publication_relays[]`; the operator exclusion (no player declares an operator since §5A.13's ruling). A contradicted `AUDIT` found while
the seat reads no census for the round is filed by a pass once it does, for 6 h; held in memory, so a restart in that time loses it (kanban #1000). Two choices the
text above does not make: the players are refused at the seat's door and are not taken out of `W`, so an auditor holding no entry
draws on the same `W` as the seats. An entry void at the door (§15) is left out of `results_hash`.

---

# 13B. Player equivocation

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

**AS BUILT (2026-10-04).**
- **What counts:** two checkpoints of one entry, each signed by its session
  key, with different ids and either the same tick or the same parent. It
  holds at any tick, the first included. The proof check is
  `provesEquivocation`, with no replay. **Same parent, RULED 2026-10-05 (b):** a pair from one later parent forfeits only when both
  marks were receipted by a seat, each in some seat's chain. A mark a seat
  refused for not following its head was never carried and does not count.
  That is a page stuck on an old head, measured on testnet4: ea63aa94 sent
  13 marks after @1620, all naming @1560; c35157df's later marks all named
  @60. Neither is forfeited. A same-tick pair and two first marks forfeit
  as before. The disjoint, one-seat and split forks still forfeit.
- **How a seat gets the pair:** a seat counts a pair it holds itself (its
  stored and refused marks), one pulled from a peer's `/equivocation`, or,
  for a fork sent one mark per seat (where no seat holds both), one it
  makes by setting each peer's receipted marks (`/checkpoints`) against
  its own. A pair proven that way is kept (`fork_pairs`) and served at
  `/equivocation` from then on.
- **The close:** before signing a run, a seat holding a proven pair signs
  FORFEIT, score 0, over the canonical transcript, and logs
  `[close] <entry> FORFEIT: two chains at tick N (§13B)`. Seats that agree
  reach FINAL FORFEIT like any result. A seat that signed the run without
  the proof makes a split, and §13C decides FORFEIT, since "proven
  equivocation" counts later-tick pairs as well as first-mark pairs. The
  first-mark path is unchanged.
- **The stake:** with a qualifier in the round, the FORFEIT lock is claimed
  in the round's settlement like a loser's and pays the winners (the loser
  pool). With nobody qualified, it is claimed like a walk-away's, into the
  remainder split: 75% to the sitting seats, 25% to the donation set. It
  is never left to expire back to the equivocator (RULED 2026-10-04 (b)).
  An honest loser's lock in a no-winner round still expires back to its
  player.
- **What no replay undoes:** the FORFEIT is signed over the canonical
  transcript, which carries the inputs, so a replay of the player's own
  run would "contradict" it. A seat holding the proof therefore refuses
  any objection against that entry at the door (422, "that entry forfeited
  by §13B: this seat holds the proof that the player signed two chains
  ..."), before any replay, and stores nothing. A re-run of such an entry
  signs FORFEIT, score 0, never the run.
- **The stake is opened:** a seat holding any proven equivocation (two
  first marks or a fork) releases its share of the equivocator's stake
  secret, even over a run it signed itself, and gathers the others'.
  Without that, a split decided FORFEIT by §13C left the stake unopened
  and the round unsettled.
- Measured on a 2-of-2 lock round, and live on the free pair, for: a fork
  by tick, a fork by parent, a fork held at one seat, a split (with and
  without a qualifier), and the equivocator's own objection (refused).

> **Why:** An earlier draft had 5 nodes and threshold 3, so two 3-subsets always overlap
> in at least one node — divergence was in principle detectable. But the
> document never said what that node must *do*, which left "run several
> forks and submit the winning one" as an open question. With 7 slots and
> threshold 5, any two 5-subsets overlap in at least three nodes; combined
> with gossip and an explicit forfeit rule, the strategy is not merely
> detectable but priced.

---

# 13C. Canonical transcript and the no-quorum rule

**Canonical transcript.** For each player, the canonical transcript is the
**longest checkpoint chain that carries receipts from at least 5 committee
nodes**, together with the input batches whose hashes it commits to. All
nodes replay that object, so "node A saw more than node B" cannot by itself
produce disagreement.

**Result window.** The result window **equals the objection window** -
600 seconds of wall time (2026-09-15; fixed at 600 s by
WINDOW-10-SPEC, 2026-10-01). A seat that cannot retrieve the transcript in
that window treats the entry as VOID.

**No-quorum rule.** If, after the result window, no result has 5-of-7
signatures:

1. If the disagreement is explained by proven player equivocation (§13B) →
   `FORFEIT`, at once.
2. From protocol 22, if a seat holds a run of the entry (a signed result or a
   receipted mark): the entry goes to §13A's re-run window, among the same 7.
   Below.
3. Otherwise the fault is on the operator side → the entry becomes `VOID`,
   the stake is refunded by forfeit or by the stake lock's expiry, and the entry is
   excluded from the pool and from the payout table.
4. Nodes whose signature contradicts a replay of the canonical transcript
   are slashed.

This is deliberately asymmetric: a player cannot manufacture a refund by
causing disagreement, because the only way a player can cause it is
equivocation, and equivocation forfeits. Everything else that goes wrong is
the infrastructure's fault and refunds.

> **Why:** An earlier draft had no rule at all. A committee that could not agree left
> funds in an undefined state with no path forward.

**The re-run window before `VOID` (RULED 2026-11-02, kanban #1037, #1045, #1047;
protocol 22).** No quorum at `final_after` does not void an entry that has a
run. It gives honestly overloaded seats (#735, #738) ten more minutes,
and a slow seat can still complete the 5. It does nothing against collusion:
there is one set of 7 (§5A.9), so 3 silent seats stay silent here too (§22, P6).

- **Who.** The same 7. No result at the threshold by `final_after`, or a
  threshold in time that is short of its postings: a late posting then cannot
  void an entry, which would be the overload again.
- **`FORFEIT` stays first.** Proven equivocation is `FORFEIT` at `final_after`,
  and is read again at the window's end.
- **Otherwise `SUSPENDED`.** Each seat carries the receipts first, then signs a
  `RerunResult` from its replay of the canonical transcript, naming no
  contradicted run (`contradicted_run_id` all zeros), counted by the same rule
  as any re-run: signed from `final_after`, held before `round_end + 1205 s`,
  5 of 7 on one run. A seat signs no re-run while a seat it cannot reach could
  lengthen the transcript, the same rule as for a first result: re-runs signed
  over different prefixes never reach 5.
- **A quorum in the window** takes the re-run path: its one objection window to
  `round_end + 1800 s`, `FINAL` on the re-run from `+ 1805 s`. A valid objection
  in that window makes the entry `VOID` at once, and the re-run's signers are
  slashed as for any re-run. Why it keeps that window: a late quorum nobody can
  object to is what §13A exists to prevent.
- **Publication stays a condition of finality**, with the same deadline. The
  re-run's transcript must be posted by the settlement threshold before
  `round_end + 1205 s`, or the entry is `VOID`.
- **No quorum by `round_end + 1205 s`:** `VOID`, or `FORFEIT` on proven
  equivocation. Written once.
- **Nobody is slashed for this.** No objection proved anyone wrong, so no slash
  proof is filed and no audit is contradicted. Silence leaves no artifact.
- **What a run is (RULED 2026-11-02, kanban #1060).** A seat holds a run of the
  entry at `final_after` if it holds a signed result or a receipted mark of it.
  Nobody signed can mean only that the seats do not have 5 receipts yet: every
  live seat holds its own, and a seat coming back with the rest can still save
  the entry. So that goes to the window too, and the round waits. An entry with
  neither has no run, and goes to `VOID` at `final_after`: `#noQuorum` at the
  first-mark door stays there. Three seats truly gone give `VOID` at about
  `round_end + 1208 s`, not `+ 686 s`. That price is accepted: 3 seats can delay
  more than that anyway (#1044).
- **A seat that cannot retrieve the transcript** (`#unretrievedPastWindow`) holds
  to the window's end, `FORFEIT` first, while it or a peer holds a run. A seat
  with neither asks the peers for what they signed first.
- **A seat out at the window's end.** It holds no re-run in time, and its own
  clock would read `VOID` while five others go `FINAL`. It asks the peers for
  their re-runs before it writes anything, counts 5 on one run by their signed
  times, and takes their `FINAL` signatures. It signs no `FINAL` of its own.
- **The round waits for it** (§13A). Rounds before protocol 22 decide at
  `final_after`, byte for byte as before.

Measured on seven real seats at protocol 22, a real federation, a paid round of
two entries, one winner and one loser (`tools/no-quorum-devnet.mjs`; a seat
stopped with SIGSTOP before the round's end). Nobody hands anybody receipts: a
seat stopped holds its receipts unread. Times are from the round's end.

| Case | Result |
|---|---|
| Honest round | `FINAL` by 7 of 7 and settled by + 607 s, no re-run on record |
| 2 slow (a control: it cannot fail) | `FINAL` by 5 by + 625 s, loser's lock claimed and the winner paid, the two back at + 705 s |
| 3 out before any receipt is pulled, one back at + 804 s | Nobody can sign: `SUSPENDED` at + 614 s, the pending line at + 1200 s, no re-run signed. The four pull the seat's receipts themselves, 5 of 5 re-runs on one transcript by + 925 s, `FINAL` at + 1811 s. The loser's lock claimed, 90 000 000 msat, and paid to the winner |
| The other two of those seats, back at + 1901 s | One pass reads `VOID`, unwritten; `FINAL` by + 1911 s, as the five |
| 3 silent, receipts never pulled | `SUSPENDED`, no re-run, `VOID` at + 1206 s at all seven, the lock left for its player |
| No mark at all, 3 seats out | `VOID` by + 693 s on the retry's own clock, no re-run, nothing waited for |

With every seat up, an entry with no mark is `FORFEIT` at the door (§15), as ever.

**AS BUILT (2026-10-04).** The result window's deadline
is `final_after`: the round's end + 600 s + 5 s, in wall-clock ms, on each
seat's own clock, by when that seat **held** each record. A PlayerResult
carries no signed time, so its held time is its deadline, as for
objections. A posting's block hash is stored data and decides nothing.
Past `final_after` (`finality.js resultFinality`):
- **A late result:** only the results held before the deadline count. If
  at least one was held in time and no run reached the threshold, §13C
  decides once and the decision is written: FORFEIT on proven
  equivocation, otherwise VOID. That covers a threshold completed late
  and a split with every seat up. The reason names the late arrival.
  A seat that held no result in time could not retrieve or sign; that is
  the "cannot retrieve the transcript" door above, decided by the
  verifier.
- **A late posting:** only the postings held before the deadline count.
  An in-time quorum not published by the settlement threshold in time is
  VOID (§13A, "publication is a condition of finality").
- A written decision stands, so FINAL signatures, a result or a posting
  that arrive later never turn it back. Each one is logged once as
  `[close] <entry> VOID|FORFEIT: <why>`.
- A VOID entry is left out of the round's settlement and payout. Its
  lock is neither claimed nor forfeited and returns to the player at
  expiry (§23.2).

Measured live on the free pair, for a late result, a split and a late
posting (two test faults, off by default: `ARENA_TEST_DISSENT_FILE` with
`<entry> first`, and `ARENA_TEST_LATE_POSTING_FILE`).

That is the rule below protocol 22. From 22 the two no-quorum cases above go to
the re-run window instead of deciding at `final_after`, and the same reasoning
holds at the window's end.

---

# 14. Finality

> Once a player's result is `FINAL`, later infrastructure failure does not
> erase it.

```text
final loser + later DDoS  !=  refund
```

A later outage may delay settlement. It cannot convert `FAILED -> REFUND` or
`FORFEIT -> REFUND` after finality. This is unchanged from the earlier drafts and remains
one of the most important properties in the design.

The one-way ladder:

```text
PROVISIONAL -> PROVISIONALLY_FINAL -> FINAL -> SETTLED
                        |       round end + 600 s + 5 s, 5 of 7 seats (WINDOW-10-SPEC)
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

At the round's close *(ruled 2026-09-12)*:

- A seated player whose stake was committed and who sent no first mark is
  `FORFEIT`, score 0, signed by the committee over the empty transcript —
  never `ENTRY_VOID`, never a refund.
- A first mark signed after the start deadline is a late start: `FORFEIT`,
  score 0, the same as no mark.
- A run whose checkpoints stop is `FAILED` at its last receipted checkpoint,
  and a re-run under §13A applies the same rule.

**Two first marks are `FORFEIT`, never a refund.** A player who signs two
first marks for one entry — on time at some seats and another one, late or
not, at others — has equivocated (§13B). This holds even when a real outage
had already made a seat record `ENTRY_VOID` (§16) for the on-time mark:

1. that seat's `ENTRY_VOID` record stays as history (§14 lets nothing undo
   it);
2. a seat that holds the proof of the two first marks refuses its signature
   on the forfeit of the stake lock to the player, and records no
   `ENTRY_VOID` from another seat's evidence;
3. after the result window the no-quorum rule (§13C) decides `FORFEIT` at
   every seat;
4. the lock follows a forfeited entry's path — held until its expiry or
   claimed as a forfeit — and is never handed back by the committee.

A disconnect is not an escape hatch for the stake.

---

# 16. Infrastructure outage before finality

**Before stake commitment:** no financial entry exists; no loss.

**After commitment, before the first financial tick:** if fewer than 5
game/verify nodes are available, the entry becomes `ENTRY_VOID` and the
stake is refunded by forfeit or by the stake lock's expiry (§23.2).

**During active play:** with 5-of-7 available, continue. Below threshold,
protocol progress pauses; a short grace period is allowed. No finalized
result is erased, and known losses never become refunds because of a later
attack.

---

# 17. Round membership

After `entry_close_time`, membership is the set of players holding ≥5 valid
EntryReceipts issued before the cutoff, minus entries voided under §13C or
§5A.13. The list is deterministic; no central database decides it.

**One seat's door does not decide it (RULED 2026-11-03, kanban #1071).** A door
is a seat's own: it says whether this seat takes a new entry now, and the
backup rule (§5A.5) reads this seat's own view of its chain. An entry the round
has accepted is in, whatever one seat's door said:

- **Accepted** means 5 seats' EntryReceipts. Until those exist (kanban #1009) it
  means 5 seats' signed results or FINALs naming the entry. A FINAL stands on
  those results, so a seat counts the results.
- **A seat short of an accepted entry takes it from a peer.** No refusal of the
  door applies, the backup rule included. Every part of it is still checked as a
  client's copy is: the bytes to the entry's id, the shares to its stake point,
  the locks with the federation, the Lightning address and each item by their
  signatures, and each result counted by its own signature from a seat of the
  round's committee.
- **A seat short of an entry never decides for it alone.** It signs no VOID for
  it and refuses no plan for it. If it cannot get the entry it signs nothing
  about it, which is ordinary silence: the round goes on with the other seats.
- **Below 5 an entry is no member: `ENTRY_VOID`.** Once more seats lack it than
  the threshold leaves room for (3 of 7, 1 of 2), it can never reach 5. Where it
  is held it is `ENTRY_VOID`, no result is signed for it, and its stake comes
  back; nobody played it, so an entry left without an opponent is `VOID`. A
  disagreement at the door costs a refund, not a stuck round. The seats answer
  `ENTRY_VOID` at `GET /settlement` and the client shows the entry as not taken.

As built on head-to-head rounds, the only games whose result depends on another
entry: before a seat signs for such a round it reads the entries its peers hold
(`GET /api/round-result`). That reading is a hint: it says where to look, and
what a seat takes rests on the signatures above. Seats that lack an entry are
counted only when they answer, so a seat that is down lacks nothing. Three seats
that lie about lacking an entry gain nothing they did not have: three seats
withholding their signatures already keep it from 5. A market carries its orders
in certified batches (`order-batch.js`).

---

# 17A. Head-to-head rounds: the certified lock set *(RULED 2026-11-12 on #2116 (b); protocol 2026.0.28; kanban #2561)*

A head-to-head round (Rock Paper Scissors) is decided over all of its entries at
once: each player commits to a hidden move at entry, reveals it after the entry
close, and the game's decide adapter judges the revealed moves
(`arena-protocol/src/head-to-head.js`). A move is public as soon as one reveal is
out. Before protocol 28 each seat decided alone, by its own clock and its peers'
word, whether a stake lock came before any reveal (#1479, #1551, #1598). A session
key is free, so a player could enter rock, paper and scissors under three keys
with no lock, read the honest move and lock only the winner; every per-seat rule
against that had another way round it (a clock ahead or behind, a partner lying
about the time, a seat holding a reveal back, the order replay as a second lock
door, an early reveal shutting honest locks out, a bogus in-flight lock).

From protocol 28 one signed decision replaces them, for every **paying**
head-to-head round whose contract names `protocol_version >= 28`. Rounds below 28
and free rounds keep the earlier rules byte for byte.

## 17A.1 The set

```text
LockSet = u8 0x50 || u16 version (28) || round_id[32] || vec<entry_id[32]>   (ascending, each once)
set_id  = H("ARENA/v1/LockSet", LockSet)
```

The entries are those whose **stake the signing seat saw locked before the entry
close** (its stake seen, by the federation, at a door time before `entry_close_ms`).
No door takes a stake or fee lock new to a seat from the entry close on.

## 17A.2 Signing

From the entry close, by its own clock, each seat of the round's committee:

1. **View.** Signs what it verified, under its own tag so it can never count as
   a certificate signature: `BIP340(node_key, H("ARENA/v1/LockSetView", set_id || u64 at_ms))`.
   The views go to every seat of the round (`POST /lock-set`) and are pulled
   (`GET /lock-set?round=`).
2. **Sign once.** When it holds every committee seat's view, or at the close +
   1200 ms holding a threshold of them, it signs **one** set: the entries of its
   own view that at least a threshold of views name.
   `sig = BIP340(node_key, H("ARENA/v1/LockSetSignature", set_id || u64 at_ms))`, with `at_ms`
   its own clock. The seat keeps that signature before it serves it and never
   signs another set for the round, after a restart too, so two different sets can
   never both gather a threshold of honest signatures. An entry only some seats
   verified leaves the round instead of splitting the committee; a seat never signs
   an entry it did not verify itself.
3. **Certify.** Any threshold of signatures over one set is the certificate:

```text
LockSetCertificate = u8 0x51 || u16 version || u16 len || LockSet || vec<key[32] || u64 at_ms || sig[64]>   (keys ascending)
```

A certificate **stands** when at least the round's threshold (5 of 7, 2 of 2) of
distinct committee keys signed the same set, each with
`entry_close_ms <= at_ms <= entry_close_ms + 3000`. A signature outside the
committee, outside that window, under the view tag, or over another set counts
nothing. The certificate's time is the latest counted signer's `at_ms`.

## 17A.3 What the certificate gates

- **No seat takes or serves a reveal before it holds a certificate that
  stands.** `POST /reveal` is refused until then, and `GET /reveals` serves no
  move. The reveal window opens at the certificate and closes at the round's end
  as before.
- **Only certified entries are seated, revealed and decided.** A reveal of an
  entry outside the set is refused; the decide plays the set's entries only and
  signs every other entry `VOID`. A lock that arrives after the close, by any
  door, is in no view and no set: it is not in the round, and goes back by
  forfeit at once (`VOID`, its lock never claimed). A seat signs that forfeit
  (`GET /forfeit`, and `?lock=fee` for the entry's fee lock) as soon as it holds
  the certificate and the lock is not in it, as a refused round's lock (§23.2):
  no result and no settlement to wait for. A certified entry's lock waits for its
  round as before.
- **No certificate by the close + 3 s: the round is `VOID`.** Every entry is
  signed `VOID` and every stake comes back. Never a partial round. A seat that
  holds no certificate when it decides first pulls one from every peer; a
  certificate is a signed object, so one that formed anywhere in time counts
  wherever it arrives. Every lock of a `VOID` round goes back by forfeit at once,
  stake and fee lock, on the same rule: past the window, none held here and none
  pulled from the peers when the forfeit is asked.
- **The page** polls `GET /lock-set?round=`, checks the certificate against the
  seats it dealt its stake to, and reveals only then (arena-client
  `revealWhenCertified`). Past the window with none it says the round is void.

## 17A.4 Why it holds

With the reveal gated on a signed set, a clock behind or ahead, a lying
partner or a slow honest seat changes only **whether** the certificate forms
(and so whether the round plays or is VOID), never **which** entries count:

- an entry needs a threshold of seats that verified its lock before their
  own close, and those seats sign only once, from the close on;
- no honest seat serves or takes a move before the certificate, so nobody holds
  an honest move while the set can still change;
- a seat with its clock behind may take a lock after the real close, but one
  seat's view is below the threshold, and the certificate may already stand
  without it.

## 17A.5 Speed

One signing round between the close and the reveal: views at the close, the
signature as soon as every view is in (at the latest close + 1.2 s), the
certificate as soon as a threshold of signatures is in. Measured on seven seats
with one seat answering 1.5 s late and one down (`h2h-lock-set-2561.test.js`):
the certificate at the close + 1.25 s, the page saw it at + 1.31 s, all six live
seats signed both results at + 1.46 s. An 8 s round stays inside its slot.

## 17A.6 A contested set *(RULED 2026-11-13 on #2587; kanban #2606)*

A committee of 2t - 1 has two thresholds that overlap in one seat, so one seat that
signs two sets can make two certificates that stand over different sets of one round.

- **The round is `VOID`.** A seat that holds two standing certificates over
  different sets decides no set (every entry is signed `VOID`), returns every lock
  by forfeit at once (stake and fee lock, in either set or in none), and builds,
  commits to and signs no settlement of either side. A seat that acked one side's
  settlement before it saw the second certificate stops there; a settlement that
  still lands is read by offence (a) (#1131): no correct table exists for a `VOID`
  round.
- **Not "earliest wins":** a certificate's time is its signers' own clocks, so two
  seats would name different firsts.
- **Seats share certificates:** `GET /lock-set?round=` serves the second
  certificate (`conflict`) beside the first, and a seat hands it to every peer at
  once, again on each forfeit ask until it landed.
- **The offence (§5A.3):** signing two `LockSet`s for one `round_id` with different
  entries. Evidence: each signed set as `u16 len || LockSet || u64 at_ms || sig[64]`
  (`encodeSignedLockSet`); the proof is the slash proof body with no player, the
  lower set id named and the higher beside it, so one offence has one commitment
  (`slashHoldsOnTwoLockSets`). A view signature never counts. No player lost money,
  so the whole bond goes to the reserves (#976).

---

# 18. P2P economics

The house does not fund winnings. Fixed brackets (10 / 100 / 1,000 sat,
capped by census health per §5A.10).

```text
loser_pool = Σ FAILED stakes + Σ FORFEIT stakes
```

Qualifiers (`DELIVERED` and score ≥ minimum) receive their own stake back
plus a rank-weighted share of `loser_pool`. Node fees and the player-selected
donation are **inclusive** in the wallet commitment (§22A, changed); the
pool is the sum of net stakes, and entitlement is weighted by net stake.
`VOID` and `ENTRY_VOID` entries neither contribute to nor draw from the pool.

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

> **Bitcoin Arena note (§0A.8):** this analysis was made with BLWP's 2% fee. With the
> 5% node fee every expected value below moves down by three points (the edge
> route is −5% instead of −2%) before any donation; the argument and its
> conclusion are unchanged.

Worked example — 100 players at 100 sat, the 2% fee out of it (98 sat
staked, §22A), 50 taking the map edge and all arriving, 50 taking the
corridor with half of them dying:

```text
loser_pool = 25 x 98 = 2,450 sat
flat-ish rank curve: bottom 50 collectively take 20% -> 9.8 sat each
                     top 25 take the other 80%       -> 78.4 sat each
```

| Route | Expected value | Variance |
|---|---|---|
| Edge | 98 back + 9.8 share − 100 paid = **+7.8%** | ~zero |
| Corridor | 0.5 × (98 + 78.4) − 100 = **−11.8%** | high |

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

E  exposure  in [0,1]       time and depth in the corridor, heat-weighted
T  time      in [0.25,1.5]  reference_ticks / elapsed_ticks, clamped
C  cargo     in [0,1]       room used / bed capacity
```

**T, the time factor** *(2026-10-04)*. `reference_ticks` (par) is
**1800 ticks**, about 30 s at 1092/65536 s a tick. T is 1.5 - the ceiling -
for any run of 1200 ticks (20 s) or less, falls from there, is 1 at par, and
reaches the floor 0.25 at 7200 ticks (120 s). In ticks the clamp is
`elapsed held to [1200, 7200]`; the tick count, not seconds, is the rule.

**C, the cargo factor** *(2026-10-04)*. C is how full the truck is:
the **room used over the bed's capacity**, 0 for an empty bed and 1 for a
full one. The room is the core's own `roomFor(vsize)` summed over the
parcels loaded, and it is declared with the load at roll-out, so a replay
sets the same C. A run declares no load until roll-out and starts at C = 0.
A load stored before the room was declared (an older transcript) carries no
room and keeps C = 0.7, so a stored run never moves.

Both are part of the round's config (§27A.7.5): a round is scored by the
par, the T bounds and the cargo rule its `config_hash` names.

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
mechanism that moves the edge route from +7.8% to −2%: it qualifies, it keeps
its stake, it simply does not place.

## 18A.5 Qualification stays generous

`score ≥ min_score` with `min_score` set low — reference value 1. The
cautious player is **not** disqualified and does **not** forfeit.

Disqualifying them is the obvious-looking fix and it is wrong. Their stakes
would fall into the pool, raising it to 7,350 sat (75 x 98), handing corridor
survivors +96% and the cautious −100%. That is not balancing, it is a levy on a legal
strategy, and it re-creates the minimum-danger rule through the back door.
The mechanism throughout is "earn nothing", never "lose everything".

## 18A.6 The same round, re-run

```text
50 edge players       E ≈ 0.05 -> score ≈ 50   -> ranks 26..75, share 0
25 corridor survivors E ≈ 0.9  -> score ≈ 900  -> ranks 1..25
25 corridor deaths                             -> loser_pool 2,450 (25 x 98)
K = ceil(0.25 · 75) = 19, all of them corridor survivors
```

Each player pays 100 sat, 2 of it the fee, 98 staked (§22A); a qualifier
gets its 98 back.

| Route | Expected value |
|---|---|
| Edge | 98 − 100 = **−2%** |
| Corridor | 0.5 × (98 + 98) − 100 = **−2%** |
| Corridor at 70% personal survival | 0.7 × 196 − 100 = **+37.2%** |

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

Deterministic. Seats sign the table's id in their `SettlementAck` (§5A.3), and
a seat joins the settlement's signing only with **5-of-7 matching acks**. A seat
acknowledging a table that does not equal `F(...)` is slashable, on the entries
with signed `FINAL` results, and so is one acknowledging a transaction that does
not rebuild from its table.

---

# 21. Settlement role of the same node software

```text
arena-node --roles game_verify
arena-node --roles settlement
arena-node --roles game_verify,settlement
```

**GAME/VERIFY role:** receives entries and checkpoints; stores transcripts;
replays the deterministic simulation; signs final results; **does not move
funds**.

**SETTLEMENT role:** verifies the Round Contract; verifies 5-of-7 final
results; acknowledges the table it computed and the transaction it rebuilt,
and joins the signing on 5-of-7 acks (§5A.3); holds one share of each entry preimage;
participates in threshold Lightning settlement; **cannot change a result or
the payout formula**.

The same software implements both, but the protocol requires the
result/payout quorum before any settlement authorization.

---

# 22. Node trust model

Arena does not pretend browser-only Lightning settlement is perfectly
trustless. The honest statement:

> Anyone can download the same node software and, with a bond, become
> eligible. No single node decides a result or moves funds. A 5-of-7
> game/verify quorum determines final results; a separate 5-of-7 settlement
> quorum authorizes Lightning settlement; and a public objection window lets
> anyone overturn a fabricated result by replay (blocked with at least 3 honest
> seats; against 5 colluders the payment goes out at FINAL and is repaid from
> their bonds through §5A.3B, whose players' share the panels can release from
> the hold at `slash_hold_blocks` - RULED 2026-11-07, kanban #1308).

Residual assumptions:

```text
5-of-7 malicious GAME/VERIFY slots
  AND the victim's receipted transcript unavailable to every honest party
    -> can corrupt result finality

5-of-7 malicious SETTLEMENT slots
    -> can corrupt or censor settlement of that round's stake locks

threshold of the round's federation guardians (§23.6)
    -> can take the federation's reserves, every round's locks included
federation halted below its threshold
    -> every lock freezes, refunds included; there is no unilateral exit

player wallet balance (§24A.1)
    -> the two federation lines above, for as long as the player leaves
       e-cash in the wallet instead of for one round; nothing is added
```

5-of-7 GAME/VERIFY slots run by a PLAYER of the round 
    -> can run many forks and submit the best: undetectable, because the
       submitted transcript is genuine and replays to its own result.
       Not caught by the objection window; caught only by capital (§5A.6)
       and by publication (§13A), which forces the chosen fork into the open

3 of the 7 seats (P6)
    -> can stop an entry at its result, or a whole round at its settlement.
       A winner goes unpaid (griefing). A losing friend gets their stake
       back, out of the winners' pool, so 3 seats give a friend a free bet.
       Silence leaves no artifact and is not slashable. Chance of holding
       3 of 7: 14.8 % at 20 % of capital, 35.3 % at 30 %. Committees are
       known hours ahead, so a player can choose those rounds. From protocol
       26 a set of nodes that does it again and again at the result or FINAL
       leaves the draw (§5A.3, "Stalled in its rounds"). At the settlement it
       does not yet: that stage is off until its height is named (#1069).

**P6 is a live exploit shape, not a corner case (RULED 2026-11-02, kanban
#1045).** Enter only rounds where you hold 3 seats. If you lose, stay silent and
get the stake back. If you win, let it settle. That is a risk-free bet,
repeatable up to the stake ceiling until the stall rule takes those nodes out of
the draw (§5A.3, the owner's choice on #1044). The rule reads the result and FINAL
stages now; at the settlement it stays repeatable until `STALL_SETTLEMENT_HEIGHT` is
named (#1069). There is one set of 7 since protocol 2 (§5A.9), so the re-run
window of §13C does nothing against it: it helps honestly overloaded seats, not
collusion.

**Closed for named-claim rounds (RULED 2026-11-07, kanban #1268, revised by
#1290).** From `NAMED_CLAIM_HEIGHT` a lock has a third path: after
`stall_blocks` four of the seven named seats pay the settlement the FINAL
results make (§23.2, "The fallback claim"), so a stalled settlement returns
nothing to the loser unless four seats stay quiet. What the exchange that
led there established: the per-round draw is no defence, since the committee
is public from the beacon and a losing player reads it after the draw;
silence cannot be priced, since it has no bytes and a liveness slash would
slash a dropped relay; and a haircut on the refund does not help. The
arithmetic (kanban #1280): four honest signers would split the haircut, so
three quiet seats forgo three quarters of it, while the losing side's budget
is the whole refund; the bribe stops paying only when the refund falls under
3/7 of the pot, a 57 % haircut on an honest player on a bad relay day, the
case the refund exists for. Only a stall that returns nothing has no buyer.
A bribe is cash once and the bench is income over months, which is why the
bench cannot price a stall and §5A.10 bounds the pot by a seat's income too.

**The re-run window's delay is not a new power.** A round with a no-quorum entry
waits for it (§13A), so 3 seats can delay a whole round's payout by 20 to 30
minutes. They could already stall a whole round until its locks expire,
so 20 to 30 minutes is less than they have now. Pay stays per round: a stalled
round pays nobody, which is the only fee price silence has (the fee table must be
byte-equal at 5 seats, so paying by signer would put a varying input into it).

The first two require five bonded operators to collude and forfeit five
bonds, in a round whose committee they could not choose (§5A.5). The federation lines - guardians, halt,
and the player wallet's standing balance - are the federation's own
trust statement, stated without cosmetics: they are why the guardians MUST
be independent bonded census operators, why a round names its federation,
and why a federation's exposure is capped alongside §5A.10's stake ceiling.
Gateways are not in this list: a gateway can refuse a deposit or a
withdrawal, never keep one.

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

## Node fee: 5% mandatory, to the round's sitting seats and its federation's guardians

**RULED (2026-10-06, §0A.8): the node fee is 5% of the gross stake**,
in the same three equal pools. It replaces the 2% ruled 2026-09-15.

```text
node_fee = 5.00% of gross_round_volume
5/3 %   -> GAME/VERIFY pool     (the round's sitting seats)
5/3 %   -> SETTLEMENT pool      (the round's sitting seats)
5/3 %   -> GUARDIAN pool        (the seated guardians of the federation
                                 the Round Contract names, §23A)
```

**RULED (2026-09-21): guardians earn from the node fee** (2% under BLWP, 5% in Bitcoin Arena). They carry the
reserve, the bond and the liability of every round the federation settles,
and until this ruling had no income at all (Fedimint base fees are 0). The
three-way equal split is RULED HERE, and confirmed by 2026-10-06 with the total at 5%. The guardian pool
is divided evenly among the guardians **seated** (§23A.1: not gone) at the
round's `FINAL`, and paid as one payout contract per guardian in the round's
settlement transaction (§23.2), to the `payout_pubkey` of the guardian's
census advertisement. A guardian earns it only if seated; a gone guardian's
share goes pro rata to the other seated ones. With no eligible guardian at
all, from protocol 22 the pool goes where §23A.9 says (the gateway seats,
else the two committees). While the federation's
predecessor is DRAINING, the pool is shared per seat with the predecessor's
seated guardians (§23A.6 step 5). Testnet: 5/3 % over seven guardians.
From protocol 2026.0.16 the node fee is split into **four pools of 1 %**: game/verify,
settlement, custody and **liquidity** (§23A.10: the federation's liquidity providers).
From protocol 2026.0.15 one third of the guardian pool goes to the
federation's two **gateway seats** and two thirds to its guardians (§23A.9:
who hosts the federation's Lightning, how the best two are chosen, what they
earn).

Each pool's share is divided among the round's **sitting seats** - the seats
the census seated for this round, its `nodes` - however many there are: two
in a 2-of-2, seven in a 5-of-7. Not seven census slots when the round is
2-of-2 (2026-09-15). In a 5-of-7 each eligible seat receives
`(5/3)% / 7 ≈ 0.238%` of gross volume for its role; in a 2-of-2, `(5/3)% / 2`.
An operator selected for both roles earns both shares, because it performs
both services. A fee lock is sized for the same seats the settlement pays.
The node fee is **5%** (2026-10-06; it was 2%, 2026-09-15). Fedimint's own base fees are **0**:
the federation runs with `disable_base_fees`. Lightning `min_htlc` / routing
is not a federation fee.

**Availability qualification.** A selected node earns its share only if it
performed the contract-defined minimum service: for game/verify, the
required receipts plus replay and signing; for settlement, participation in
the settlement protocol during the settlement window. Unearned shares are redistributed pro rata among
the other eligible nodes in the same role pool, keeping the total at 5%.

**Remainders.** Calculate in millisatoshis, floor each base share, and
distribute the remaining msat in ascending `H(round_id ‖ node_pubkey)` order.

## The donation set

A donation goes to a **set** of recipients with declared shares, not to one
address. *(RULED 2026-10-03: "We'll use the federation(s) as
donation layer"; FEDERATION.md "Donations in the federation".)* The set
names **keys**, not LNURLs - one set for the network, valid in every
federation:

```text
donation set = signed by the network's donation authority (§27A.4)
  [ { recipient_pk: 33-byte secp256k1 key, share_bps: 6667, label: "dev a" },
    { recipient_pk: ...,                    share_bps: 3333, label: "dev b" } ]
```

`share_bps` are basis points and MUST sum to exactly 10000. A client with
donations enabled pays each recipient its share of the player's chosen
donation **inside the round's federation, in the same transaction that
locks the stake and the fee**: one donation output per recipient, a payout
contract as §5 builds them - a pre-expired lock with `refund_pk =
recipient_pk`, which only the recipient redeems, with its own key, at any
time. No gateway, no route, no minimum HTLC and no Lightning fee: a stake
that is locked is a donation that is paid. (Measured 2026-10-03, the
Lightning way failed twice: LNURLs no browser could reach, and a 666 msat
share found no route over a channel whose minimum HTLC was 1 sat.)

- **The Entry Contract names the donation outpoints** beside the stake and
  fee lock outpoints - one per share above 0 msat, in the set's order, and
  only when there are any, so an entry that pays no key keeps its bytes and
  its id.
- **Enforced by the signer nodes:** an entry whose donation is above 0 is
  taken only if the federation holds those outputs, each to its recipient
  key for its share; a wrong or missing output is refused like a wrong
  stake lock.
- **Found by the recipient's own client:** each signer node keeps the
  donation outpoints of the entries it took, by recipient key and
  federation, and answers them publicly (`GET /donations?key=...`); the
  recipient's client confirms each with the federation, redeems it there
  and withdraws to its own Lightning node - one Lightning fee for many
  donations.
- **Rounds already published keep the set they name.** A round whose set
  names LNURLs (before 2026-10-04) paid them over Lightning as separate
  payments; nothing of such a round is rewritten.

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
- A donation is voluntary and outside the pool, and **not returned**: a
  walk-away or a refunded stake does not bring it back, and a join that
  locked and then failed has given its donation. A share is never
  redirected to the remaining recipients. (Under an LNURL set, an
  unreachable LNURL was a failed payment and nothing more.)
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
way it changes anything else in its advertisement: by an advertisement
update (§5A.2) - one transaction and its confirmations, never a new bond -
which is deliberately not free.

### 3. Client preferences: not network parameters

The donation percentage, whether donations are on at all, notification
channels, UI. These belong to the player or the operator and the protocol
has no opinion. §22A already forbids anyone else from overwriting the
player's donation choice; the same principle covers the rest.

> The test for which kind a parameter is: **what breaks if two participants
> disagree about it?** If the round cannot settle, it is kind 1. If the
> network merely drifts, kind 2. If nothing breaks, kind 3 and it does not
> belong in this document.

## Sybil economics — corrected statement

An earlier draft claimed "no Sybil reward". That was false as written: fees do go only
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
> An earlier draft used square-root weighting here and claimed the same property. It had
> it backwards: under `sqrt`, four nodes at 1× total weight 4 against a
> single node at 4× with weight 2, so splitting a bond *doubled* selection
> chances. That was corrected.

## Developer donation — the player's choice, capped

The donation is not a protocol fee and not a node-controlled parameter. The
player selects it in the client:

```text
developer_donation = 0% | 1% | 2% | 3% | 4% | 5%      (2026-09-21, §24B)
  half -> the protocol devs' donation set  (the network's, §27A.4)
  half -> the game dev's donation set      (the round's game manifest, §0A.3)
```

The reference client offers exactly these six, on its settings screen
(§24B); `custom` is withdrawn from the reference client, and the protocol
cap below stays for clients that are not it. **The reference client
defaults to 5%: 2.5% to the protocol devs and 2.5% to the game dev (RULED 2026-10-06, §0A.8)**; it was 2%. When both sets are the same
recipients, as for nextblock, each recipient is paid once, the sum of both
halves. The player may change it, including
to zero; a round with `donation_bps = 0` is fully valid.

> Nodes, round creators, lobbies and settlement participants may not
> overwrite, increase or substitute the player's choice. A node may accept
> the signed Entry Contract or reject it as invalid — never rewrite the
> donation field.

**Cap.** `donation_bps ≤ donation_bps_max` (protocol maximum
10000 = 100% of stake), and the client MUST require an explicit second
confirmation above 500 bps. A compromised web host can otherwise set an
absurd donation to a recipient key it controls, and the player's only
defence is reading the wallet dialog carefully.

## Collection: inclusive in the stake *(changed)*

```text
wallet commitment                 100 sat   <- what the player chose (gross)
  node infrastructure fee           5 sat   (5%, identical for everyone, §0A.8)
  donation to the protocol devs   2.5 sat   (default; 0 to 2.5 as the player chose)
  donation to the game dev        2.5 sat   (default; 0 to 2.5 as the player chose)
------------------------------------------
net game stake                     90 sat   -> the pool (95 with no donation)
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

## Example: 61-player round, all at the default donation (Bitcoin Arena, §0A.8)

```text
gross_round_volume = 6,100 sat   (61 x 100, the wallet commitments)
node fee (5%)      =   305 sat
  GAME/VERIFY pool = 101.667 sat -> per sitting seat (7)
  SETTLEMENT pool  = 101.667 sat -> per sitting seat (7)
  GUARDIAN pool    = 101.667 sat -> per seated guardian
donation (5%)      =   305 sat
  protocol devs    = 152.5 sat  -> the network's donation set
  game dev         = 152.5 sat  -> the game's donation set (nextblock: the same set, paid once: 305 sat)
game pool          = 5,490 sat -> loser-pool distribution only
```

Amounts are kept in msat and floored per share, with §22A's remainder rule.

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

# 23. Stake custody and settlement

An earlier draft described entry, results and payout but never said where a stake lives
during a round or which key moves it. This chapter supplies that mechanism.
Its guiding property:

> **Doing nothing refunds the player. Taking a player's stake requires a
> final result, an elapsed objection window, and a threshold quorum.**

## 23.1 Stake commitment

**Precondition:** the round's committees must already be published
and verified by the client (§5A.5, §9). Step 2 encrypts shares *to the
settlement committee*, so no part of this sequence can run earlier. Any
statement that a stake may be committed before the committee is known has
been removed from this document.

0. **The committee's claim key.** Once selected, the settlement seats run a
   dealerless DKG for this round's threshold key `claim_pk` and each seat
   signs `(round_id, claim_pk)`. The key is valid only with signatures from
   ≥5 seats (`claim_key_attestation_ref`); a client MUST refuse to lock to
   a key without them. Otherwise one seat could serve its own key and, after
   the shares are released, claim a loser's stake for itself.
1. The player generates a random scalar `P` and puts the **point**
   `stake_point = P·G` in the Entry Contract — a point, not a hash, because
   only a point lets step 2 be checked.
2. The player splits `P` with **Feldman** verifiable secret sharing
   (threshold **5-of-7**) and encrypts one share to each settlement seat;
   `vss_shares_ref` points at the published shares and commitments. Each
   seat verifies its share against the commitments **and that the constant
   commitment `A0` equals `stake_point`**, and refuses the entry otherwise.
   This is what closes the loser's escape: with a hash, a player could deal
   consistent shares of some `Q ≠ P`, lose, watch reconstruction fail and be
   refunded at expiry. With a point the shares provably open to the lock's
   own secret.
   The player also chooses `F`, the fee preimage, and puts it in the Entry
   Contract in clear: the fee is owed once the round is `FINAL`, whatever
   the result, and must never share `P` — claiming a winner's fee lock would
   otherwise publish the winner's `P`.
3. The stake and the fee come from the **player wallet** (§24A.1):
   e-cash the player already holds in the round's federation
   (`federation_id`, §23.6). Only when the wallet holds less does the
   client ask for a Lightning deposit of the shortfall: the player's
   external wallet pays a **deposit invoice** into the federation, made
   through any gateway the federation lists, and the notes land in the
   player wallet. The gateway pays the federation first and learns the
   preimage only from its consensus, so it cannot keep the payment. It can
   delay: the invoice's CLTV is short, and a client moves to the next
   gateway after a timeout — a slow gateway costs the round, never the
   money.
4. The player's client spends the stake and the fee from the player wallet
   — in one federation transaction — into a **stake lock** and a **fee
   lock**, contracts inside the federation:

   ```text
   stake lock                          fee lock
   payment_image  Point(stake_point)   Hash(H(F))
   amount         net stake (§22A)     node fee (§22A)
   claim_pk       the attested claim_pk of step 0
   refund_pk      player_pubkey, derived from the player's seed (§24)
   expiration     federation block height + stake_expiry_blocks
   ```

   It is in nobody's balance. The federation's consensus lets it go only the
   three ways of §23.2.
5. `STAKE_COMMITTED` is recorded once ≥5 settlement nodes have **verified**
   the locks: the contract id at `stake_lock_outpoint` (and the fee lock's)
   equals the hash of a contract whose `payment_image` is the entry's
   `stake_point` (resp. `H(F)`), whose `amount` is the entry's net stake
   (resp. fee), whose `claim_pk` is the attested key, whose `refund_pk` is
   `player_pubkey`, and whose `expiration` is ≥ **`lock_height` +
   `stake_expiry_blocks`**, where `lock_height` is the federation's
   consensus height at which the transaction creating the lock was
   accepted - read from the federation, never from the client - and
   `lock_height` is no more than `stake_lock_freshness_blocks` (**12**)
   below the height at which the seat verifies. Seeing the lock is not
   enough: the player built it, and a short expiry alone would let a loser
   refund before settlement.

   **Play does not wait for it (RULED 2026-10-02: "Joining the
   round should take at most 2-3 seconds from clicking the Join button to
   the round actually loading").** The round loads and the player drives at
   once; the stake is checked **in the background**. The seats take and
   receipt the player's inputs from the first tick but **hold them** - no
   result is signed and no entry counts toward the round's membership -
   until five settlement seats have verified the locks as above. A stake
   not yet seen held takes nothing: a signer node takes none of that entry's
   play frames until it has seen the stake held (the client holds its ticks
   and asks again, `STAKE_NOT_SEEN`), and a first mark that reaches it only
   after the entry's start deadline (`join_tick + start_deadline`, §16) makes
   the entry **`ENTRY_VOID`** there: its
   inputs are dropped, it is excluded from the pool and the payout table,
   and whatever reached a lock goes back by forfeit or expiry (§23.2). The
   page shows the run as unconfirmed until the stake is seen, and says so if
   it never is. A player cannot win on a stake that never arrived, and
   cannot lose one either.

   **RULED 2026-09-24 (the owner: resolve every parked question).** The old
   check read "≥ current height + `stake_expiry_blocks`" while step 4
   builds the lock at "height + `stake_expiry_blocks`", so a lock built
   exactly as step 4 says was refused one block later (measured: 450
   against 316 + 144). The check is against the lock's own height, not
   against the verifier's clock, and the freshness bound is what the
   comparison with "current" was trying to buy: a lock verified within 12
   blocks of its creation still has at least 132 blocks - 22 hours on
   mainnet - to cover the round, the objection window and the settlement
   transaction. No margin is added to step 4; a margin would only move the
   same off-by-the-wait to a larger number.

`stake_expiry_blocks` is **144** — one day of blocks (ruled 2026-09-11).
It needs to cover only round + objection window + the settlement
transaction: a forfeit stays redeemable after expiry, and after expiry the
player's key alone refunds, so delay is never loss. The height is the
federation's own consensus view of Bitcoin.

## 23.2 What each outcome does

| Outcome | Action | Requires |
|---|---|---|
| `DELIVERED` (qualifying) | Forfeit the stake lock → it returns to the player's key | 5-of-7 settlement signature over the lock, published; the player's own client redeems it, and only the player can |
| `FAILED` / `FORFEIT` | Claim the stake lock inside the round's settlement transaction | `FINAL` result + elapsed `W` + no valid objection + ≥5 preimage shares released + 5-of-7 settlement signature over that transaction |
| `VOID` / `ENTRY_VOID` | Forfeit at once; if nobody acts, the lock expires | Nothing — after expiry only the player's key can take it |
| `REFUSED` — a round the signer nodes refuse (its donation set is not the one in force at its census height, or its series is not held), a stake locked for it and never entered | Forfeit at once → it returns to the player's key, without waiting for expiry | Each of ≥5 settlement signer nodes on its own record: it refuses the round, the lock stakes no entry it holds, the lock's image is `A0` of a handout it accepted for that round and its refund key that handout player's (who entered nothing), the federation holds the lock under the round's claim key; 5-of-7 signature over the lock's contract id; only the player's key redeems it |
| Payout to a qualifier | A payout contract in the same settlement transaction: a lock already past expiry whose refund key is the qualifier, redeemable at once by that key alone | Final payout table (5-of-7) + 5-of-7 settlement signature |

> **WINNINGS-AUTO (RULED 2026-10-01).** Winnings are paid
> **automatically into the player's federation wallet**. Every qualifier is
> paid by its payout contract in the settlement transaction - to its round
> key, inside the federation - and never by a Lightning send to an address it
> named: the player names nothing, is asked nothing, and no qualifier's share
> is pooled for want of an address. The player's client redeems every payout
> contract and every forfeited lock into the player wallet **by itself, the
> moment it exists** - no press, no withdraw step (§24A.1). Until the notes
> are in the wallet the amount is **pending** (§24, WINDOW-10-SPEC). Withdrawn:
> the Lightning-address payout of 2026-09-23 and the rule that a page collects
> only on the player's press.

The **settlement transaction** is one atomic federation transaction per
round: every loser's stake lock and every fee lock in; one payout contract
per qualifier and per paid node slot out. Every settlement node rebuilds it
from the public payout table, acknowledges it (§5A.3) and signs only the
transaction it rebuilt.

> **REFUSED-RETURN (RULED 2026-10-06 08:57).** A round the signer
> nodes refuse gets an immediate refund: a stake that was locked for it and
> never entered is not held until its expiry. The player's client hands the
> lock to the round's signer nodes; each checks it against its own record
> and signs the forfeit that returns it. It can never return a stake that
> entered: a lock any signer node holds as an entry's stake is refused
> there, and an entered stake is held by at least five.

The default path — nobody acting — is always the refund. That is what makes
infrastructure failure safe. It holds while the federation runs; a halted
federation is §22's residual, not a refund path.

**The fallback claim: a stalled settlement returns nothing (RULED 2026-11-07,
kanban #1268; REVISED the same day, kanban #1290, #1315: the four named seats
in place of the census key).** A stake lock and a fee lock of a named-claim
round (the ArenaLockContract of kanban #1131, from `NAMED_CLAIM_HEIGHT`) have
three ways out, not two:

```text
claim      t of the n named seats, with the preimage          at any time
fallback   t − 1 of the n named seats, no preimage            from lock height + stall_blocks
refund     the player's key                                   from expiration
```

- **Why the seats and not the census key.** The first ruling named
  `census_key(e)`. That gave one key, with no hold, no panel and no notice,
  a spend over every lock of a stalled round: three quiet seats plus a
  buyer with a third of the capital's shares (§5A.3B measured 33.5 %) could
  take the whole round, a FROST signature names nobody, holders are not
  benched, and 342 silent shares blocked the fallback for free. The four
  named seats are the authority the round already has: three quiet seats
  cannot stall four, four seats on a false table are named and slashable
  (§5A.3 offence (a) of kanban #1131), and the key's liveness is no longer
  a condition. **`stall_blocks`** is 36 on mainnet and testnet4, 3 on
  regtest; `expiration` stays `stake_expiry_blocks`.
- **What it pays:** the settlement the round's rules make - F, or F′ with a
  gone lock (kanban #1146), a late table, a market's book - rebuilt from the
  entries' FINAL results and read by the same rules every table is read by
  (§5A.3 table row, the payees of kanban #1138-#1143). It claims every lock
  of the round the federation still holds.
- **An entry with no FINAL** by then is paid by its result only when four
  of the seven seats signed one `PlayerResult` for it (each attributable
  and slashable by replay under §13C); below four, the entry is what the
  seats wrote (`VOID`, `ENTRY_VOID`: the stake back). Nobody replays at the
  fallback: with no four signatures nobody can say who won, and the refund
  is the right answer there.
- **The node row** of a fallback pays only the seats whose signed result or
  FINAL for the round is on the relays by `final_after + 60 s` (public
  inputs, so the table stays byte-equal); the rest of the fee goes to the
  reserves. A stall pays the quiet seats nothing.
- **Who files:** any of the four, in a turn by a hash of the round id and
  its key, through the same MuSig2 batch the claim uses (kanban #1135:
  body id, commits, the lowest four committed sign). The module hands core
  `KeyAgg` of the four named signers as the input key once `stall_blocks`
  have passed.
- **The bonds cover it:** `bond_min(settlement) >= max_round_volume`
  (§5A.3), so four named bonds cover four rounds' volume.
- **Why this closes P6.** A settlement needed 5 of 7 and a refund needed 3
  to stay quiet, and the committee is public from the beacon, so a losing
  player could buy three quiet seats after the draw. A stall now needs four
  quiet seats, which is also the number at which the stall note cannot
  form; that case is priced in §5A.3 as rate × payoff. Silence is still not
  slashed, because it still has no bytes; it no longer has to be priced for
  three seats. The stall rule stays for hygiene.
- **Not this:** the census key (above); a haircut on the refund (a refund
  minus a haircut still beats losing the stake); a lower threshold than
  four (three named seats could claim wrongly and the bonds would have to
  cover it); a liveness slash (a dropped relay would be slashed).
- **The triangle (kanban #1280).** Three things are wanted of a stake lock:
  the player cannot walk off with it, the refund needs no committee, and
  the refund pays the player. A stock lock gives two of the three: taking
  the player's key away is what makes the refund need a threshold at all,
  and a threshold is what three quiet seats can stall. The fallback claim
  keeps all three, because the refund stays committee-free and pays the
  player; it is only reachable if the four seats did not act first. It
  also invents no new authority: the four are the round's own seats.
- **Until `NAMED_CLAIM_HEIGHT`** a round's locks are stock LNv2 with two
  paths, and P6 stays the residual §22 names for them.

## 23.3 Why a loser cannot escape

The money left the player's wallet at entry and sits in a stake lock. Every
step afterwards — attestation, objection window, share release, settlement
— runs without the player's cooperation. Closing the browser, refusing to
answer, or deleting the client changes nothing.

## 23.4 Why a committee cannot quietly take it

Claiming a loser's stake lock requires the committee's threshold signature
and reconstructing `P`, which requires 5 of the
7 shares, which the mechanical rule releases only against a `FINAL` result —
and finality requires 5-of-7 game/verify signatures plus an objection window
that anyone in the world may use to disprove the result by replay (§13A).
From protocol 2 one set of 7 holds both roles and `overlap_count` is published
(§5A.9), every participant is bonded, and every one of these steps leaves a signed
artifact. Those seats cannot quietly take a stake. Three of them can still stall
one: §22, P6.

## 23.5 No pool wallet

The loser pool is per round (§18), so it never has to rest anywhere. It
exists only as the settlement transaction, which moves losers' locks straight
into qualifiers' payout contracts. No node and no minority holds a pooled
balance at any moment — there is none. The node fee travels in its own lock
(§23.1) and leaves by the same transaction, so a fee dispute never touches
another player's stake. Donations are not locked in the federation: the
player's wallet pays the §27A.4 recipients directly, every game, at entry
(ruled 2026-09-11); since the player wallet (§24A.1) that payment may leave the player wallet
through a gateway (§24A.1) and is still never locked. Winnings and refunds
are redeemed into the player wallet (§24A.1) as notes under the player's own
seed - the player's money, not a pool.

## 23.6 Construction and maturity — stated honestly

**RULED (2026-09-21): there is one custody construction, FEDERATION,
on every network.** The Round Contract's `custody_rules` names it and
nothing else; a round naming anything else is invalid, on regtest too,
because the regtest federation of `FEDERATION.md` runs on one laptop and
there is no reason left to test against something else.

**Fedimint-class federation, stake lock inside it.** Built from stock parts,
unpatched:

- the stake lock is Fedimint LNv2's `OutgoingContract`: claim by preimage
  and claim key, forfeit by the claim key to the refund key, refund to the
  refund key after expiry — enforced by the guardians' consensus;
- the claim key is a FROST (RFC 9591) BIP-340 key, which the federation
  checks like any other key;
- Lightning only at the edges: deposits and withdrawals through any of at
  least two gateways run by different operators, each payment atomic and
  over in seconds. No gateway holds a round's money or is needed by it;
- the player's balance between rounds is the federation's e-cash in the
  player wallet (§24A.1), and the federation itself lives by §23A.

Not used, by rule: a single-operator Lightning endpoint of any kind, a
patched federation, a Lightning node run by the committee.

**THRESHOLD_LN does not exist (RULED 2026-09-22 22:59).** It once
named a threshold-signed Lightning node (FROST over channel operations)
that was measured and found not buildable on lnd (its remote signer asks
for ECDSA by the node key and for MuSig2 shares, which a FROST committee
does not produce), and in practice it labelled the interim of the
committee's own lnd holding a hold invoice - custody by one operator, which
the fee could not even ride on. It is disposed of **completely**: the
custody field has **one** value, FEDERATION, and no other value is defined,
reserved, or kept for decoding. **A round that names anything else is
invalid, past rounds included**: a record from before this ruling that
carries the old value is not a round of this network and is neither
decoded, replayed, settled, listed nor counted; a node that holds such a
record treats it as it treats bytes that do not parse. There is no
decode-only label and no history exception. **On the wire (RULED
2026-09-22):** FEDERATION keeps the byte it has always had, and the byte
the withdrawn value used is **undefined** - not a value, not a reserved
slot, not a label; the decoder throws on it exactly as on a bad length or
an unknown type byte. Renumbering FEDERATION onto the freed byte is
forbidden, because every old record would then decode, silently, as
FEDERATION, which is the one outcome this ruling names. The door §23.6 once left open
for a later migration is closed with it: if such a node ever hardens, that
is a new revision, not a standing option.

**Guardians are not parked (2026-09-21; released again, 2026-09-24 morning).** The parking of "which
guardians" and `federationIsBonded` (PRIORITIES, 2026-09-16) is lifted. The
fleet pin's move to HEAD is released the same morning (2026-09-24),
so no rule in this chapter waits on the pin any more. The three slash
rulings - the slashing height, the affected players, several slashed nodes
- are closed at `e554dad2` (§5A.3); any "blocked on three rulings" note
elsewhere is stale.
§23A is to be built now: on testnet with a federation of **seven guardians,
5 of 7** (2026-09-27; it replaces the 3-of-4 of 2026-09-26 and the
2-of-2 that ran before it), on seven nodes, one guardian per node
(§23A.1's testnet column, §23A.2),
`federationIsBonded` on as ruled (the owner 07:33); on regtest with the
4-guardian rehearsal federation; on mainnet with a founding by §23A.2 once
ten guardian-capable operators are in the census. A paying round on testnet
is therefore a FEDERATION round with the fee lock, the stake lock and the
player wallet, and nothing else counts toward "the federation holds the
money".

**The creator does not get to pick the custodian**. The
Round Contract names `federation_id`, and a creator could name a federation
whose guardians are all his — then §22's guardian residual is not a residual
but the design. A federation is therefore valid for a paying round only if:

- at least its own threshold of guardians are **distinct bonded census
  nodes** at `census_height`, each advertising that guardian peer key under
  `guardian_of[]` (§5A.1) with a bond at or above the bracket's
  `bond_min_settlement`, so a guardian who colludes is slashable like any
  seat. **Every guardian / node must have its own bond or it may not take
  part** (2026-09-15). `federationIsBonded` stays on;
- the client has fetched the federation's configuration from its guardians
  and its hash equals `federation_id`;
- `federation_id` is on the client's known-good list, or the client shows it
  and its guardians and requires an explicit confirmation — the same rule as
  `sim_wasm_hash` (§5).

The Round Contract names `FEDERATION` and its `federation_id`. The residual
has two layers, both stated in §22: the settlement committee over one
round's locks, and the guardians over the federation — including that a
halted federation freezes refunds, because Fedimint has no unilateral exit.
This is the minimum achievable today under a browser-only client with no
central node, not a comfortable claim. Migration to threshold-signed
Lightning stays open for when it hardens.

---

# 23A. Federation lifecycle *(2026-09-21)*

A federation was at first something a round named and a stake sat in
for one round. Since the player wallet (§24A.1), it holds players' balances across many rounds.
This chapter says what the spec had not said: how a federation comes to
exist and who its guardians are, how many outages it absorbs, when it is
replaced and how every player's notes follow, what a guardian's bond is for
when he leaves, how guardians, seats and clients talk, how a player finds
his federation on any device, and what the player writes down.

the owner's rulings of 2026-09-21 are marked **RULED**. Everything else here is
**RULED HERE** and he can overrule it. All of it is **GAP** until built; the
`FEDERATION.md` rehearsal items 12-16 are its acceptance.

## 23A.1 Size, and what an outage does

Fedimint's consensus runs with `n` guardians and tolerates `f` faulty ones
where `n = 3f + 1`; a transaction is accepted by `2f + 1`. Nothing in this
chapter changes that; it chooses `n`.

**RULED (2026-09-21): the first mainnet federation has at least ten
guardians.** Ten is `f = 3`: seven of ten sign, three may be down at once
and no player notices anything. `federation_nominal` is a genesis parameter
(§27A.6), per network:

| | mainnet | testnet | regtest |
|---|---|---|---|
| guardians `n` | **10** | **7** (2026-09-27) | 4 |
| sign `n - f` (stock) | 7 | **5** | 3 |
| down at once, no effect `f` | 3 | **2** | 1 |

The signing threshold is stock Fedimint's, `n - floor((n - 1) / 3)`, which
equals `2f + 1` wherever this chapter writes that: 7 of 10, 5 of 7, 3 of 4.

**RULED (2026-09-27 10:04): testnet is seven nodes and seven
guardians, 5 of 7**, one guardian per node. It replaces the 3-of-4 ruling of
2026-09-26 22:54, which replaced the 2-of-2 that ran before it. Two may be
down and nothing stops, and a guardian lost leaves a DRAINING band before
CRITICAL, so testnet runs the same bands and the same succession mainnet
runs. Mainnet stays at least ten, 7 of 10. The committee sizes of the game
and of settlement are not this ruling.

**The testnet guardian endpoints (2026-09-27).** Every guardian
endpoint is a **public `wss://` a phone can open** (§23A.4: the client
talks to any guardian directly). Testnet's seven are on Tailscale Funnel:

| guardian | `guardian_endpoint` | local port |
|---|---|---|
| 1 | `wss://seat.example.com/guardian-1` | 31221 |
| 2 | `wss://seat.example.com/guardian-2` | 31231 |
| 3 | `wss://seat.example.com/guardian-3` | 31241 |
| 4 | `wss://seat.example.com/guardian-4` | 31251 |
| 5 | `wss://seat.example.com/guardian-5` | 31261 |
| 6 | `wss://seat.example.com/guardian-6` | 31271 |
| 7 | `wss://seat.example.com/guardian-7` | 31281 |

Seven guardians behind one host is a test network's arrangement, not
independence; mainnet's guardians are distinct operators (§23A.2).

**Seated, absent, gone.** An outage is Fedimint's business and is absorbed
up to `f`. This chapter counts something slower: guardians that are
*gone* - abandoned (§23A.5) or departed - and calls the rest **seated**.

```text
reserve = seated - (2f + 1)          how many more may be gone before halt

OPEN       reserve >= min(2, f)      rounds may name it; deposits accepted
DRAINING   reserve == 1              no new round names it; the client
                                     refuses deposits into it; succession
                                     has begun (§23A.6); everything else
                                     runs, withdrawals included
CRITICAL   reserve == 0              one more loss halts it: the client
                                     shows Withdraw and Move only
HALTED     seated < 2f + 1           every note and lock frozen (§22)
```

At ten: nine seated is still OPEN; eight is DRAINING and the successor is
being founded while a further momentary outage is still absorbed; seven is
CRITICAL. A federation is replaced two losses before it can halt, and
halting takes four guardians gone or down at the same moment. That is the
sense in which no outage reaches the player: the ones that could are
handled while there is still margin for the ones that cannot.

At seven (`f = 2`, testnet): seven seated is OPEN; six is DRAINING and
starts the succession; five is CRITICAL; four is HALTED.

At four (`f = 1`, regtest): four seated is OPEN; three is
CRITICAL at once - there is no DRAINING band, because a federation of four
has only one loss of margin - and CRITICAL starts the succession of
§23A.6 exactly as DRAINING does at ten; two seated is HALTED.

`federation_min = 2f + 1` is the CRITICAL line. Below it nothing moves and
no rule here can help; §22 says so.

**Timings (RULED 2026-09-21: fast; 36 h for arbitration).**
Everything in this chapter that waits, waits in blocks, and on mainnet:

| what | parameter | mainnet | ≈ |
|---|---|---|---|
| absence that is abandonment; halt before liquidation; load before a founding | `abandon_blocks` | 288 | 48 h |
| notice a guardian gives before leaving | `departure_notice` | 432 | 72 h |
| time a drawn set has to finish its DKG | `founding_window` | 432 | 72 h |
| how long a draining federation serves; late-claim tail | `drain_blocks` | 4032 | 28 d |
| the liquidation claim window (arbitration) | `claim_blocks` | 216 | **36 h** |

The 36 h is the owner's; the others are RULED HERE to match it. Testnet runs
the same clocks at about a twentieth (2 h / 3 h / 3 h / 24 h / 1.5 h,
the owner: much shorter) and regtest in tens of blocks; both in §27A.6.

## 23A.2 Who the guardians are: founding

**RULED 2026-11-07 (spec review, kanban #1297).** A cohort or succession founding seats at least `f + 1` guardians drawn from the seated guardians of existing OPEN federations (an operator may guard at most two OPEN federations), and only the rest from the free pool; and no federation younger than `drain_blocks` receives first deposits by default. Before this, ten self-declared operators bonded at `bond_min` while the free pool was empty were the whole draw, and the first-deposit rule sent every new player to them.

A guardian is a **bonded census node** (§5A.2), nothing else was ever
allowed (§23.6, 2026-09-15: every guardian has his own bond). To be
drawn it must also:

- advertise `guardian_capable` and a `guardian_endpoint` (§5A.1): it runs
  fedimintd and will answer the client and the seats there;
- **one node is one guardian, and the node runs it (RULED 2026-09-26, again 2026-09-27).** A node that advertises `guardian_capable` starts its own
  guardian inside itself with **zero configuration**: the node creates the
  guardian's keys from its own, takes part in the founding ceremony when
  drawn, serves `guardian_endpoint` itself, and stops the guardian when the
  role is turned off (§5A.1). The operator sees one thing - the node - and
  never a second service, a second config file or a second process to
  keep up. A node is never two guardians of one federation. Its
  `guardian_endpoint` is a public `wss://` a phone can open (2026-09-27);
- carry a bond of at least `bond_min_guardian`, the settlement floor of the
  highest bracket the network offers, because a guardian's exposure is the
  federation's whole reserve, not one round's. It is the network's number,
  never a seat's setting: mainnet's genesis names it; testnet4's and regtest's
  genesis bytes do not, and cannot without moving their network ids, so
  theirs stands beside genesis in code (regtest may keep a test's override).
  A change by §27A.3's notice is read at its height: the value in force at
  `trigger_height`, so a founding and its redraws cannot disagree *(2026-11-02)*;
- be a distinct `operator_id` from every other guardian of the same
  federation, one seat per operator (§5A.13), and guard **at most one OPEN
  federation** at a time - a draining one does not count. Independence
  between federations is what makes several of them worth having (§23A.3).

**What starts a founding.** One of four events, each at a Bitcoin height
that becomes the founding's `trigger_height` (the earliest wins):

1. **Genesis.** The network's first federation is drawn at the first height
   after genesis at which the census holds at least `federation_nominal`
   guardian-capable nodes of distinct operators. Not before: a network with
   six willing operators has no mainnet federation and no paying round,
   and says so rather than opening with six (RULED HERE, from the owner's
   ten).
2. **Succession** (§23A.6): a federation entered DRAINING or its guardians
   decided by threshold signature to be replaced.
3. **Load.** Every OPEN federation has been at or above 80% of its
   exposure cap (§23A.3) for `abandon_blocks`.
4. **Cohort** (protocol 2026.0.14; 2026-10-18, ruling 3:
   "10 new nodes find each other on the network automatically and create a
   new federation"). While a federation exists, the census holds at least
   `cohort_nominal` = **10** guardian-capable operators (an endpoint, at
   least `bond_min_guardian`) that guard no OPEN federation. An operator
   whose advertisement names a federation the seat holds no record of
   counts as guarding it, as for an OPEN one *(2026-10-18)*; a DRAINING federation frees its guardians, as before. They found a
   federation of their own, of `cohort_nominal` seats, drawn as below. The
   trigger is the first height of the current run at or above 10: once
   their adverts name the new federation in `guardian_of[]` the run ends,
   and the next ten are a later height. A cohort founding that goes void is
   drawn again at `founding_window + 1` blocks after its trigger height, the
   run's first height plus a whole number of those steps, so every seat names
   the same draw from the chain alone, however long it has run *(2026-10-21,
   kanban #495)*. A node that installs the custody
   role advertises itself guardian-capable at its public address
   `/guardian` and runs its guardian in setup mode until drawn.

**A trigger that goes void holds nothing back** *(2026-11-02, kanban #1025)*.
Genesis, succession and load redraw as a cohort does: while its condition still
holds, a void founding is drawn again at
`trigger_height + n x (founding_window + 1)`, the newest such height below the
tip, from the chain alone, so every seat names the same draw. Each redraw has
its own beacon and the rule of its own height. A trigger with no founding
started by `trigger_height + founding_window` is void, as a founding is when
the window passes. The condition ends when the old record names the successor
(succession), when the federations fall below 80 % (load), or when a federation
exists or too few operators remain (genesis). "The earliest wins" counts the
triggers on their first draw; only with none does the lowest redraw height win.
This applies on a network from its `FOUNDING_PRESSURE_HEIGHT` (§23A.3a), so
every seat moves together; before that a void trigger stands as it did.

**Who is drawn.** Bond-weighted stateless sortition, §5A.6 unchanged, with
the beacon block after `trigger_height` and the tag `'BLWP/v1/GUARDIAN'`,
over the guardian-capable census minus operators already guarding an OPEN
federation, one ticket per operator. `federation_nominal` are drawn, then
three alternates in order. Nobody hand-picks (2026-09-16 08:23; that
ruling named the sitting *seats* of a round, and the guardians of a
federation are drawn the same way but **once**, at founding - a Fedimint
federation's key set is fixed by its setup ceremony and cannot be redrawn
per round).

**The ceremony** is stock Fedimint setup - the guardians' distributed key
generation, unpatched, `disable_base_fees` on (2026-09-15) - among
the drawn, within `founding_window` blocks of the beacon. A drawn node that
has not joined the ceremony within a fifth of the window is replaced by the
next alternate; it is not slashed, because it held nothing. If the window
passes without a federation, the founding is void and it is drawn again
as above. The ceremony's output is the federation configuration;
`federation_id` is its hash, exactly as §23.6 already verifies it.

**Then, in this order:** every guardian re-advertises with `guardian_of[]`
naming `(federation_id, peer key)` (an advertisement update, §5A.2 - the
bond it already has stays its bond); the guardians sign the first **federation record** (§23A.4) with
`status = OPEN`; the seats and relays carry it. Only from then on may a
Round Contract name it (§23.6 unchanged: threshold of its guardians bonded
census nodes at `census_height`).

## 23A.3 Several federations, and which one a player is in

**RULED 2026-11-07 (spec review, kanban #1288; the line is #1104's, kanban #1343).** A guardian's bond counts toward `exposure_cap` only while its outputs maturing after `record height + drain_blocks` sum to at least `bond_min_guardian` (kanban #1104, 2026-11-03, built in 2.0 from `BOND_LOCK_HEIGHT`; it was never written here, which is how the review found the hole). That line is the stricter of the two (4,032 blocks on mainnet against #1288's 576) and the one with the reason: a drain takes `drain_blocks`, and the bond must cover the whole of it, so an abandonment can always be slashed before path A opens (kanban #1093's "bonds locked while guarding"). A lapsing guardian stays seated and takes one place out of the cap: `cap = max(0, seated − 2f − k) × the smallest qualifying bond`, `k` the seated guardians not qualifying (#1104 with #1295). A guardian whose bond is nearer reads as having given notice at `bond_maturity − departure_notice` (DEPARTED on schedule, no offence) and the cap drops the moment its bond stops counting; the owner page says so a season ahead. A guardian keeps counting by bonding a second output (§5A.3B "Multiple bond outputs") or by bonding a long maturity at founding. Before this the cap counted bonds any mature guardian could spend at will, and the offence and the spend were one transaction.

**Yes, several** - and for two reasons that have nothing to do with
balance. Succession (§23A.6) needs a second federation to exist while the
first drains, and the exposure cap (§22, F9) only means something if a
network can add capacity by founding another instead of stretching one.

What balancing can and cannot be: a player's notes live in **one**
federation, and a round settles in **one** federation, because its
settlement transaction is one atomic transaction inside one (§23.2). So the
choice is made **when a player first deposits and when a federation is
founded or drained** - not per round, and not by splitting one player over
several federations, which would only mean every second round needs a swap.

**Custody held is public.** A federation's reserve is its on-chain wallet,
which anyone can read from the chain (Fedimint's wallet module, stock). Its
collateral is public too: the bonds of its guardians. So:

```text
exposure_cap = (seated − 2f) × the smallest bond among its seated guardians   (RULED 2026-11-07, kanban #1295: it was (f + 1), which holds only at full seating; 4, 3, 2 at 10, 9, 8 seated)
load         = on-chain reserve / exposure_cap
```

**Why `f + 1` and the smallest (RULED 2026-09-21: players cannot
lose).** `f + 1` gone is the smallest number of guardians that halts the
federation (§23A.1). Their bonds are what §23A.5's liquidation pays the
players from. So the reserve may never exceed what the smallest possible
set of leavers forfeits: at ten guardians, four of the smallest bond. A
federation that wants to hold more raises its guardians' bonds or the
network founds another federation; it does not stretch the cover. The cap
of §22 and F9 is therefore no longer policy but a number every client
computes from chain data, and it is the number that makes "players cannot
lose" arithmetic rather than a promise. A deposit into a federation at
`load >= 1` is refused by the client; at 80% for `abandon_blocks` a new
federation is founded (§23A.2); the seats show `load` beside every round.

**Picking, RULED HERE (the owner's question: the one holding least):**

- **First deposit.** The client takes the OPEN federations of the census,
  drops those not on its known-good list (§23.6; or shows them and asks),
  and picks the one with the **lowest load**; ties by the newest beacon.
  That is the owner's rule applied where it works: new custody goes where the
  least sits against the most collateral.
- **A returning player stays** in his federation. The client offers **Move**
  when that federation is DRAINING or CRITICAL (then it is not an offer but
  the automatic migration of §23A.6), or when its load is above 90% and
  another OPEN federation is below 50%.
- **A round names one federation** (§23.6). The lobby shows every round with
  its federation and load; the player's own come first. Entering a round in
  another federation is a **swap** (§23A.6 mechanics: the notes leave the
  one and arrive in the other through a gateway that serves both, stock
  LNv2, seconds, the routing fee shown) and the client does it on the press
  with the fee shown - it is not refused, and it is not the default.
- **A seat opening a round** names the OPEN federation with the lowest load
  among those its own bond qualifies it to serve; a creator who names
  another has the client show why.

## 23A.3a Capacity pressure: paying for bigger bonds and bigger peg-ins *(2026-10-19)*

**RULED 2026-11-07 (spec review, kanban #1296).** `load` is read against the players' money, not the gateways': the federation record carries `player_reserve = reserve − Σ proved gateway e-cash` (each gateway's held proof, the threshold-signed read this section already defines), and load, the bands, the founding trigger and the health line are computed from it. A federation opens only if `2 × peg_in_min ≤ exposure_cap / 4` - on mainnet; on the test networks the condition never holds at `bond_min_guardian` (testnet4: 100,000 against 400,000), so there it is shown on the health page and the owner page as a warning and does not refuse the opening (RULED 2026-11-08, kanban #1366). It is a mainnet guard against gateways' money dwarfing the players' cover; with `player_reserve` the gateways' peg-ins no longer move `load`, which was the harm it was written against. Before this, load measured the gateways' peg-ins (the two mandatory mainnet peg-ins alone put a floor-bonded federation at load 1.25) and paid a guardian-gateway for pressure it created.

> Owner, 2026-10-19 ~22:05Z: "when the network is approaching capacity and deposits are likely to be halted due to bonds not being big
> enough there needs to be incentive to increase a nodes bond by receiving a far larger fee share when other nodes are not doing it.
> Warnings of this event must be on the health page, the node's dashboard and owner page, a plea to increase the bond. Also new installs
> should increase their minimum so the new node remains useful from the start." ~22:10Z: "Also peg ins may not be enough when capacity
> is stalling and needs to be incentivised to be bigger."

Deposits into a federation stop for two reasons:

1. **The bonds.** At `load >= 1` (§23A.3) the client refuses deposits. `exposure_cap = (f + 1) × the smallest seated bond`, so the cap
   only rises when the **smallest** bonds rise.
2. **The peg-ins.** A deposit arrives over Lightning, and the gateway pays it out of its own e-cash in the federation (its peg-in,
   §23A.9). When the seated gateways' e-cash runs low, deposits fail even while the cap still has room.

Today nothing pays a node to fix either. A guardian with a bigger bond earns the same even share as one at the floor, and a gateway's
share does not depend on its peg-in. This section adds that payment. It only applies while a federation is under pressure, and it ends
by itself once enough guardians and gateways have raised.

### The signal: everyone computes the same numbers

All inputs are public, and each is read at the **census height of the round** that pays (a founding has no round, and reads at its own
heights: "The founding draw under pressure" below):

| Input | Where it comes from |
|---|---|
| `bond_i` of each seated guardian | the census (the sum of its bond outputs, §"Multiple bond outputs") |
| `reserve`, `exposure_cap` | the federation record in force at that height (§23A.4, signed at threshold) |
| `f` | the record's `nominal` (§23A.1) |
| `pegin_g` of each seated gateway | the gateway's claim, proved as below |

```text
load      = reserve / exposure_cap                        (§23A.3)
headroom  = exposure_cap - reserve                        (sat a federation can still take in)
B*        = ceil( reserve / (0.5 × (f + 1)) )             the per-guardian bond at which load would be 50 %
                                                          (never below bond_min_guardian)
```

**Bands**, per federation:

| Band | Enters at | Leaves below | Meaning |
|---|---|---|---|
| CALM | - | - | as today |
| **PRESSURE** | `load >= 0.70` | `load < 0.60` | the bond weighting below applies; warnings start |
| **CRITICAL** | `load >= 0.90` | `load < 0.80` | deposits close soon; the warnings are urgent |
| **FULL** | `load >= 1` | `load < 1` | deposits refused (§23A.3) |

The gap between "enters" and "leaves" keeps a federation from flapping at a boundary. The band is part of the federation record, so every
seat reads the same one. A record's band is `capacityBand(its load, the band of the previous record)`. The previous record is the highest
verified record of that federation below this record's height; at one height, CLOSED first, then the lowest record id. A previous record
with no band reads as what its own load enters, no hysteresis. With no previous record the band starts from CALM. A repeat at one height
reads the height below, so it cannot walk the band.

Every guardian must start from the same previous record, or they sign different bytes and neither reaches threshold. Before it signs, a
guardian asks the federation's other guardians for theirs and verifies them at threshold, as the founding read does. A guardian that hears
from fewer than a threshold of them, or that cannot check a record because it has not read the census at that record's height, does not
sign this round, and the next step catches up.

Every record names a band, whatever its status: a band is a fact about load, and a status CRITICAL can come back, so the gap has to survive
it. Only an OPEN federation's band has any effect. Band CRITICAL and status CRITICAL are different things.

**The network is under pressure** when the OPEN federation with the **lowest** load is in PRESSURE or worse. New deposits go there
first (§23A.3), so that one federation decides whether the network can still take money in.

### 1. Bigger bonds earn a far larger custody share

While a federation is in PRESSURE, CRITICAL or FULL, its guardians' part of the GUARDIAN pool (§"Node fee", §23A.9: two thirds of it) is
**no longer split evenly**. Each seated guardian `i` gets the weight

```text
w_i = ( min(bond_i, B*) / B* ) ^ 2
share_i = guardians' part × w_i / Σ w
```

- **Squared, so one raiser is paid a lot more while the others don't.** Example: 7 guardians (`f = 2`), all at 50,000 sat, so
  `exposure_cap = 150,000`. The reserve is 130,000 sat, so `load = 0.87` and `B* = 86,667`.

  | Who has raised to B* | Raiser's share of the guardians' part | Each other's share | Raiser vs even (14.3 %) |
  |---|---|---|---|
  | nobody | - | 14.3 % | - |
  | one guardian | **33.3 %** | 11.1 % | **2.3×** |
  | three | 23.1 % each | 7.7 % | 1.6× |
  | all seven | 14.3 % | - | 1× (even again) |

- **Capped at B\*.** A bond beyond what the cap needs earns nothing extra. A whale cannot take the pool.
- **It costs real capital.** A bond added (a second bond output, §"Multiple bond outputs") is timelocked until `bond_maturity`, and it
  counts once it has 6 confirmations (§5A). It cannot be borrowed for a day to farm the share.
- **It is what lifts the cap.** The cap is `(f + 1) ×` the smallest bond, so the share is paid exactly for the move that frees capacity:
  every guardian below B\* holds the cap down, and every one at B\* stops doing so.
- **CALM: even, as today.** Guardians who raised keep their larger bond for the next pressure.
- **Not OPEN: even, whatever band its record names.** Its cap takes no new deposits, so a bigger bond frees nothing, and the weight pays
  for exactly that. The same goes for peg-in pressure in part 2. A record naming no band reads as it always did, so a network before
  `CAPACITY_BAND_HEIGHT` pays the same on every signer of every release.

Rounds settle as before: one payout contract per guardian, sized by these weights. The weights use only the record and census of the
round's census height, so every signer node builds the same outputs.

*Implemented from protocol 2026.0.20 (kanban #559/#543).* Every seat keeps each federation record it verified by height and reads the one in
force at the round's census height. For rounds and foundings, until records carry the capacity band, the band is the one the record's own
load enters (70 / 90 / 100 %, no hysteresis); a record that names its band is read as it says. The hysteresis of the bands table is for
the warnings: a seat's memory of the band it last showed never feeds a payout or a draw.

**The founding draw under pressure** (§23A.2). When the network is under pressure and a new federation is founded, candidates with a
bond of at least the network's `B*_net` (below) are seated first. So a non-guardian node that raises its bond is first in line for
the federation that adds capacity. The draw is otherwise §23A.2's: candidates at the bar take the drawn places before the others, in
ticket order among themselves, the others follow in ticket order, and the alternates carry on down the same list. *(Rulings 2026-11-02,
kanban #993.)*

- **Which bond.** Eligibility and weight stay the operator's, as §23A.2 has them. The bar reads the bond of **the node that takes the
  seat** (the one its ticket names), the sum of that node's outputs (§"Multiple bond outputs"), never the operator's sum:
  `exposure_cap` is `(f + 1)` times the smallest seated guardian's bond, so two small nodes summing to `B*_net` lift nothing.
- **Two heights.** Bonds, operators and `guardian_of[]` are the census at `trigger_height`, as the draw reads them. The records (reserve,
  `nominal`, status, `exposure_cap`, band) are those in force at `trigger_height - 12`: records step every 6 blocks and are built from a
  census 6 deep, so 12 back is the first height every seat can already hold. A trigger under 12 reads no records and is not under
  pressure.
- **Reading the records.** A seat does not use the newest it holds. Before it draws, it asks the seats it can reach for each
  federation's records at or below that height, verifies them at threshold, and uses the highest verified one from any of them. A
  record cannot be forged, so a seat that hides one changes nothing. Two records can stand at one height, since a record's reserve is
  read when it is gathered: a CLOSED one first, because a CLOSED federation cannot come back, then the lowest record id. Nothing about
  this goes on chain: a wrong read costs one redraw and no money.
- **Only a record counts.** `B*_net`, the band and the lowest load read the federations with a verified record at or below
  `trigger_height - 12`. A federation named in the census with no such record is left out and holds nothing back: a made-up id in an
  advert has no record, and keeps only its own operator out of the draw; a federation under 12 blocks old held no reserve at the cut.
  No record for any federation means no pressure. Only a seat's own unread chain holds it back: if it cannot read the census at a
  record's height, that is "not yet", as a beacon it has not read, and a record it was given and cannot check for that reason is not
  left out.
- **The band.** Each federation's band is the one its record names, else the one its load enters, as above. The network is under
  pressure when, by those records, the OPEN federation with the lowest load is in PRESSURE or worse; `B*_net` is over the OPEN ones among
  them.
- **The founding's id covers it.** With `B*_net` applied, `founding_id = H(tag, seed || trigger_height || pressure_bond)`; otherwise it is
  `H(tag, seed || trigger_height)`, byte for byte as before. Seats that read different amounts name different foundings, with different
  setup codes, and cannot meet in one ceremony: nobody can take a seat on the wrong number. **What is left:** a record that reaches
  some seats late can void one founding, and the rules for a void founding draw again. It cannot seat anyone wrongly.
- **From a height, per network.** One point per network, `FOUNDING_PRESSURE_HEIGHT`, named by the release after every seat of that
  network runs it; not named, nothing is under pressure and the draw is plain everywhere. Mainnet has it from genesis. The trigger's own
  height decides the rule: a `trigger_height` below the point draws plain forever, on any seat of any release, so a founding already
  drawn cannot change, and a cohort redraw takes the rule of its own new height. From the point, a node whose advertisement does not
  list the version (below) is not a candidate, whether or not the network is under pressure: it would compute another draw and burn an
  alternate. The counts that start a genesis or a cohort hold to the same rule.

### 2. Bigger peg-ins earn a larger gateway share

A deposit of `x` sat needs `x` of e-cash at a seated gateway. **Peg-in pressure** is the same idea for the gateways:

```text
P*        = max( peg_in_min, ceil( 0.25 × headroom / gateway_seats ) )
            the peg-in each of the 2 seated gateways should hold so that a quarter of the cap's headroom can arrive at once
pegin_pressure  when Σ min(pegin_g, P*) < gateway_seats × P*   (some seated gateway holds less than P*)
```

While an OPEN federation is in PRESSURE or worse **and** under peg-in pressure, the **gateways' part** of the GUARDIAN pool (its third,
§23A.9) is split

```text
v_g = ( min(pegin_g, P*) / P* ) ^ 2
share_g = gateways' part × v_g / Σ v
```

The same squared rule: the gateway that raises its peg-in to P\* while the other one doesn't takes about **80 %** of the gateways' part
(1 against 0.25 at half of P\*), not 50 %. In the ranking of §23A.9 ("The best two"), peg-in up to P\* comes **before** routed volume
while peg-in pressure lasts, so a gateway that can take the deposits is seated ahead of one that has routed more but cannot.

**What counts as the peg-in.** A claim states `pegInSats` (§23A.9). The weight counts it only if it is **proved**:
- the claim names its peg-in outpoints (`txid:vout@height`), each a deposit to F's on-chain wallet address that the gateway's own client
  requested;
- every guardian checks those outputs in F's wallet module (they are F's own UTXOs), and that each is at most `peg_in_max_age` blocks old
  at the first height of the epoch being seated;
- the counted peg-in is their sum.

`peg_in_max_age` is a genesis parameter: 4320 blocks on mainnet (about 30 days), 1008 on testnet4 (about a week, because a peg-in there
needs 100 confirmations), 100 on regtest. A coin stays in F's wallet long after the gateway spent the e-cash, so "still unspent" says
nothing about the gateway, and one old peg-in would otherwise earn weight and rank for ever. Staying weighted costs a fresh on-chain peg-in
every month. An honest gateway still holding month-old e-cash pegs in again to stay weighted, and with no pressure on it loses nothing.

**The height comes from the claim.** A guardian reads that one block and checks that the transaction is in it, the output exists and the
age holds: one block per outpoint, from the chain view it already has, with no index and no change to how it reads F's coins. A wrong
height counts nothing. Age is read at the epoch's first height, not at a guardian's tip, so every guardian signs the same proved amounts.

**From a rules epoch, per network** (`SEATING_RULES_EPOCH`). Before it a claim reads as it did: heights are ignored and no block is read.
From it an outpoint with no height counts nothing, and a claim with no outpoints hashes as before. A seat of a release before this
refuses a claim that names a height, the whole claim and not just the outpoint, so a gateway names heights only once its network has a
rules epoch, and that epoch is named after every seat runs this release. The gateway's height is read from its own chain view (`gettxout`
on the unspent coin).

*Implemented from protocol 2026.0.20 (kanban #559/#543).* A claim names its outpoints (`pegInOutpoints`, signed with the claim, each item
with its height as it stands; a claim naming none, or naming no heights, hashes as before). Each guardian reads F's own coins from its guardian's API at most every 10 minutes (the original wallet
module's spendable coins, or wallet v2's unspent outputs) and proves a gateway's claimed outpoints that are among them; an outpoint two
claims name counts for neither. The guardian signs each paid seat's proved peg-in into the epoch's gateway seating (§23A.9; a seating
that names none hashes as before), so a seating stands only on the same seats **and** the same proved amounts. A 2026.0.20 round
splits the gateways' part by `(min(proved, P*))^2` from the seating of its census epoch, with the record in force at its census height
and `peg_in_min` the network's gateway peg-in minimum (§23A.9 table); CALM, no peg-in pressure, or nothing proved - evenly. An outpoint
older than `peg_in_max_age`, or at a height that does not hold it, counts for nothing from the rules epoch (kanban #999, 2026-11-02).

**The held proof.** A peg-in proves money went in, not that the gateway still holds it as e-cash, and stock Fedimint gives a guardian no
way to read a gateway's notes. It does read a contract. So a gateway that wants peg-in weight in an epoch locks its e-cash in F for a
moment and shows the guardians' reads of that lock. *(Rulings 2026-11-02, kanban #1029, #1030.)*

```text
proof_height   the epoch's first height + 72
the lock       claim_pk       a fixed point nobody holds a key for: 02 || x for the first tagged_hash("ARENA/v1/HeldProofClaimKey", u32 i)
                              that is a curve point's x
               payment image  tagged_hash("ARENA/v1/HeldProof", gateway node key || epoch)
               refund key     the gateway's claim key, its node key
read window    Bitcoin tip in [proof_height - 3, proof_height]
holds if       blocks_left >= 6 in the guardians' count, at that read
HeldRead       { federation_id, epoch, gateway node, outpoint, contract_id, amount, blocks_left, tip_height },
               signed by a seated guardian's node key
the claim      held_lock { outpoint, contract_id, amount, reads }: at least the threshold, 2f + 1, of HeldReads
counted        min(proved, held, P*), floored as proved peg-ins are
```

- **Only this shape counts.** A guardian recomputes the contract id from those fields, and any other lock counts 0. A lock of this shape
  cannot be spent before it expires: nobody can sign for its claim key, and a claim on it is refused with or without a preimage (measured).
  A gateway holding the claim key of its own lock could cancel it at any time, so the rule is said of this shape only.
- **Two clocks.** Bitcoin height says when to read, the guardians' block count says how long the lock stands: 3 blocks for the window and
  3 of margin, so a read at the window's start still has 3 left at its end. A count that lags makes a lock last longer. A count that jumps
  after a lag can cut one short, which at worst lets the same money back two gateways once. Accepted.
- **Reads are signed, and the claim carries them.** A refunded lock reads as nothing, so a read that vanishes cannot go into a seating signed
  byte for byte. The gateway asks each seated guardian inside the window, and each reads the lock once and signs if it holds. `blocks_left`
  differs by read, and each is checked on its own. Fewer reads than the threshold count 0. A guardian that was down verifies the
  signatures and signs the same amount, so the gateway can refund right after expiry. The reads are judged by the federation record
  in force at `proof_height`.
- **What it costs.** The money is tied up until the threshold has read it, about 6 blocks at least, and the lock and refund cost a few
  hundred msat. While locked it cannot serve deposits. A gateway does this once per epoch, and only if it wants the weight.
- **With no held proof** the counted peg-in is 0: under peg-in pressure `v_g` is 0, the gateway earns none of the gateways' part and loses its
  rank before volume. Its seat stays filled. If neither gateway shows a proof, the part is split evenly, as "nothing proved" says. A lock two
  claims name counts for neither.
- **From a rules epoch, per network** (`SEATING_RULES_EPOCH`, as for `peg_in_max_age`). Before it a peg-in counts as it did and no lock is read.

**What it does not stop.** A lender can hand a gateway e-cash for an hour around `proof_height`. The same money cannot back two gateways,
because both proofs span one height, but it can be borrowed from outside, at the cost of the lender's same hour. Accepted. Whether deposits
through a gateway actually arrive is a routing question this does not test: availability, routed volume in the ranking and a client
falling over to the other gateway stay as they are.

*Implemented for 2.0 (kanban #998).* A seat answers `GET /held-proof` (the running epoch's window, the claim key, the threshold, whom to
ask) and `POST /held-read` (an ask signed by the gateway's node key, answered with a signed HeldRead). The gateway runs
`tools/gateway-held-proof.mjs`: `gateway-cli ecash send`, into a federation client, the lock, the reads, the wait to expiry, the refund,
`gateway-cli ecash receive`, every step journalled so a stopped run carries on. The proof is kept beside the claim file and served with the claim,
outside its signature: its reads are signed, and a claim's hourly renewal leaves it alone.

### 3. The warnings: health page, node dashboard, owner page

Every seat answers **`GET /capacity`** (public, no authentication): per OPEN federation its `load`, band, `headroom`, `B*`, how many
seated guardians are below `B*`, its seated gateways' proved peg-ins against `P*`, and for the network `B*_net`, the lowest load and
the network band. The three pages read it. The wording escalates like the `bond_min` notices of §27A.3:

| Band | Health page (everyone) | Node dashboard (`/Dashboard`) | Owner page (the operator, signed in) |
|---|---|---|---|
| PRESSURE | yellow line per federation: "*Federation X holds 74 % of what its bonds cover. Deposits stop at 100 %.*" plus guardians below B\* and gateways below P\* | **a plea:** "*Federation X is filling up. Your bond is 50,000 sat. Raise it to 86,667 sat and your custody share grows from 14.3 % to up to 33 % while others haven't.*" (a gateway: the same for its peg-in and P\*) | the same plea, with **Add a bond** (a second bond output: amount B\* - bond, the fee now, and when it counts) and, for a gateway, **Add to peg-in** |
| CRITICAL | red, at the top of the page: "*Deposits into X will close soon (92 %).*" | the plea at the top, urgent: "*Deposits close at 100 %. A bond added now counts after 6 confirmations, about an hour on mainnet.*" | the same, plus a notification on every sign-in until it is answered or the band ends |
| FULL | "*Deposits into X are closed until bonds rise or a new federation is founded.*" | "*Deposits are closed. Your bond decides how fast they reopen.*" | the same, with the shortfall in sat |

A node that is no guardian sees, while the **network** is under pressure: "*The network is near capacity. A bond of at least B\*_net
puts this node first in line for the next federation.*"

### 4. New installs start with a useful bond

The installer's bond step (§8) no longer offers `bond_min_guardian` as the minimum when the network is under pressure:

```text
B*_net          = ceil( Σ reserve / (0.5 × Σ (f + 1)) )   over the OPEN federations: the per-guardian bond at which the
                                                         whole network would sit at 50 % load
install_minimum = max( bond_min_guardian, B*_net )        rounded up to 10,000 sat
```

- The installer reads it from the seats' `GET /capacity` (two seats agreeing, as it reads the release) and says why: "*The network is at
  78 %. A bond below 86,667 sat would not help it take deposits, so this node starts at 90,000 sat.*"
- CALM: `B*_net` is below the floor, and the minimum is `bond_min_guardian` as today.
- This is the installer's floor, not the protocol's. The protocol's floor stays `bond_min_guardian` and changes only with notice
  (§27A.3), so nodes already running are never cut off by it.
- A gateway set up by the installer takes `max(peg_in_min, P*)` of the federation it joins as its peg-in, by the same reading.

### Versions and tests

- The weighting of 1 and 2 is a **protocol version** (the next after 18): every signer node must build the same payout outputs.
  Rounds of earlier versions pay evenly as before.
- The founding draw under pressure is **protocol 24**: every seat of a founding must compute the same draw. It changes no round, and
  it applies from `FOUNDING_PRESSURE_HEIGHT`, not from a round's version.
- The band in the record changes the record's bytes, so it starts at one height per network, `CAPACITY_BAND_HEIGHT`, named after every seat
  and installer node runs it and the page is deployed. Mainnet has it from genesis. A record with `height` at or above the point **must**
  name a band, a record below it **must not**, and anything else is refused by name. An installer node that has not updated past the point
  stops verifying records, the same cost as the tag switch, which is why the point is named last. `GET /capacity`, the warnings and the
  installer minimum need no version or height: they ship with the seats, the page and the installer.
- Tests: the example table above to the msat; flapping at 0.69 / 0.71 / 0.61; `B*` and `P*` at the floors; a guardian above `B*`
  earning no more than at `B*`; a peg-in whose outpoint is not F's earning nothing; the same payout outputs from every signer node.

## 23A.4 How guardians, seats and clients talk

Nothing here is a new protocol; it is which stock channel carries what.

| Who | To whom | How |
|---|---|---|
| guardian | guardian | Fedimint's own consensus P2P, stock; Arena never speaks it |
| client | federation | Fedimint client API over WebSocket to **any** guardian's `guardian_endpoint`; answers are threshold-verified by the stock client; the invite is the census's (below), never a link somebody sent |
| settlement seat | federation | the same API, from the Rust client crates: it reads locks to verify them (§23.1 step 5), submits the settlement transaction (§23.2), and watches confirmations |
| gateway | federation | stock LNv2 gateway, registered with the federation; the client reads the gateway list from the federation itself |
| guardian | seats, relays | signs and posts the federation record and absence attestations (below) |

**The federation record.** Signed by at least `2f + 1` of its guardians,
newest `height` with valid signatures wins:

```text
FederationRecord {
  federation_id, network_id
  invite                       the stock invite; its config hashes to federation_id
  nominal, threshold           n, 2f + 1
  guardians[]                  (peer key, node_pubkey, operator_id, bond_outpoint, guardian_endpoint)
  status                       OPEN | DRAINING | CRITICAL | CLOSED
  successor_id                 set from DRAINING on (§23A.6)
  gone[]                       (peer key, since_height, DEPARTED | ABANDONED, proof_ref)
  exposure_cap, reserve        as of height
  height
  capacity_band                CALM | PRESSURE | CRITICAL | FULL, after height, from CAPACITY_BAND_HEIGHT (§23A.3a)
  signatures[]                 >= threshold guardian signatures over all of the above
}
```

Every guardian serves the newest record at its endpoint; **every seat
mirrors** the newest record of every federation its census knows at
`GET /federations`; the record also goes to the round's
`publication_relays[]` (§25.2) so a federation's own guardians cannot be
the only source of the news that it is draining. A client verifies the
signatures against the guardians' keys as the census commits them (bond
output, §5A.2), checks that `invite` hashes to `federation_id`, and trusts
nothing about a federation that has no record it can verify.

**Absence attestations.** Each guardian signs, once a day while it lasts,
`(federation_id, peer, last_seen_height, height)` for every peer it has
not seen in consensus. `2f + 1` of them agreeing on a peer for at least
`abandon_blocks` is an **abandonment proof**: portable, verifiable by
anyone from the record's keys, and the fraud proof §5A.3B's arbitration set
slashes on. The arbitration residual of §5A.3B applies to it unchanged:
Bitcoin cannot check liveness either.

## 23A.5 A guardian leaves, and what his bond then does

**RULED 2026-11-07 (spec review, kanban #1289).** "Answering" in a halt proof means signing, not reachability. In the halt window every live guardian signs its own observation `{ federation, session S, first_height, height, peers_seen[] }`, naming the guardians it sees in P2P consensus; the slashed set is every guardian outside the largest mutually attesting subset, and a guardian that signs nothing is gone. A stub that answers `session_count` and signs nothing is ABANDONED. One signature per guardian, nothing on chain. The honest-but-partitioned residual stays as §5A.3B names it.

| Case | What it is | What happens |
|---|---|---|
| **Down** for less than `abandon_blocks` | an outage | nothing; Fedimint absorbs up to `f`; not recorded |
| **Departure with notice** | a signed `(federation_id, peer, leave_after_height)` with `leave_after >= now + departure_notice`, posted like a record | recorded `DEPARTED` at that height; if the federation would then be DRAINING, succession starts **now** (§23A.6) so the successor is OPEN before he goes; he serves until the earlier of the federation's CLOSED and the successor's OPEN, then his seat is gone with no offence and **his bond is untouched**: he stays a bonded census node, keeps sitting as a seat, and may be drawn as a guardian again (below) |
| **Emergency departure** (protocol 17) | the node's owner, with the node offline, posts a leave request signed by the node's **emergency key** (§23A.5a) at any seat | a node with no guardian role leaves the seating at once, its bond untouched; a guardian whose request arrives **before** `abandon_blocks` from his last seen height is recorded `DEPARTED` at once, the succession starts at once (§23A.6), and his bond is untouched; a request that arrives later changes nothing: the absence is abandonment |
| **Abandonment** | absent for `abandon_blocks` (attested, §23A.4); or his bond output spent while seated (the census sees it, §5A.2; a slash start on a template-3 bond is not such a spend, its hold output stays the bond, §5A.3B); or a departure that stops serving before its `leave_after`; or any guardian of a DRAINING federation who stops before CLOSED | recorded `ABANDONED` with the proof; **slashed** through §5A.3B; the federation's reserve counts him gone at once |

**A bond spent while seated (kanban #1054).** The census sees it, so no attestation is
asked. A guardian of the record in force whom the census no longer holds, and whose bond
it read as spent, stays listed, and the record has him ABANDONED from the height of the
spend, `proof_ref` its txid, so `nominal` and the threshold stay and the exposure cap
counts him gone at once. A node still bonded by another output is still seated, and
the cap follows what is left. A guardian who served his notice out first and spends at or
after `leave_after` has committed no offence. A slash start does not count; what ends its
hold output does, from that spend. With no other output there is nothing left to slash
on the chain: the record is what stands. An output left under the floor is slashed, on
the same `proof_ref`.

**From an ABANDONED row to a slash (RULED 2026-11-02, kanban #1058, #1059).** Being
written into the signed record is the filing, and nothing separate goes anywhere. An
ABANDONED row with no output of that node left ends there. Any output of his left
stands for the offence: the row's `proof_ref` names the evidence, for a spend the
chain's transaction and for an absence the attested row, and the record's threshold
of signatures is checked by whoever acts.

**One slash format (RULED 2026-11-02, kanban #1062).** Every slash commits to
`H(fraud_proof)`, so the rule that anyone can fetch the proof and re-check it has no
exception. A bare `proof_ref` names evidence, and an absence's is not retrievable
bytes. An abandonment's proof is:

```text
AbandonedProof { federation_id, node key, proof_ref, output,
                 the signed FederationRecord holding the row }    hashed, in the OP_RETURN
OP_RETURN = H(AbandonedProof) ‖ slash_height ‖ federation_id
```

It is tagged as every slash proof is. **The hash covers the record, signatures included
(RULED 2026-11-03, kanban #1065, reversing #1064).** The bytes under the hash are the
proof (§5A.3B). A checker fetches them, checks the hash, then the record at threshold on
its own census, that it is the proof's federation's, and that the row names this node
and `proof_ref`. For a spend, whoever checks also reads `proof_ref` on the chain; for an
absence, the record's signatures are the check (§5A.3B's residual). The notice was read
when the row was written, so `guardianSlashStands` is asked of the proof without one.
Two seats holding one record under different signatures hold two proofs of one offence,
each under its own hash, and a seat lists one output under the first proof it built for
it. Seats serve it by that hash, at `GET /slashes?proof=<hash>` and `GET /slash/<hash>`,
also after the slash has landed. Whoever posts a slash hands it to the seats first, at
`PUT /slash/<hash>`, because seats serving the bytes is what makes a proof retrievable.
A seat keeps a copy when the hash, the threshold and the row stand. Rehearsal 14's slash, which put `proof_ref` itself there, stays what it was: history,
on a test chain.

**Old rows (RULED 2026-11-02, kanban #1062).** A rule does not reach back. Only a row
with `since_height` at or above `ABANDONED_SLASH_HEIGHT`, one point per network, named
by the release that ships this, is acted on. Mainnet is from genesis. Testnet4's point,
157,492, is above every rehearsal: the newest ABANDONED row of any signed record has
`since_height` 157,091, and federation T2's guardians last ran at 157,491. Older rows
stay in the records, keep their meaning for the cap and the seat, and move no money.

- Every seat lists what the rows it holds left, at `GET /slashes` (`abandonedSlashes`),
  one per output, confirmed at or before the row's `since_height`. Money bonded after
  it stood for nothing at the time of the offence, and is not touched.
- Under templates 1 and 2 the arbitration set checks the record on its own census,
  reads the row and the output on its own chain, and spends path B with
  `OP_RETURN = H(AbandonedProof) ‖ slash_height ‖ federation_id`, the whole output less
  the fee into the liquidation escrow below. It waits there for the federation's end, as for
  abandonment by absence.
- A template-3 output is started on its newest presig, or the one at bonding, and the
  census key's holders check the record the same way before they sign.

**Leaving is legitimate, and costs nothing (RULED 2026-09-21).**
Guarding a federation is a term of service, not a life sentence, and leaving
it is not leaving the network. A guardian who posts his departure notice and
serves it out keeps his bond exactly as it is: he remains an eligible census
node, keeps earning as a seat (§22A), and is drawn as a guardian again when
the sortition picks him - unless his advertisement drops `guardian_capable`,
which is his to do at any time and costs nothing either. Only leaving the
**network** touches the bond, by §5A.3B's own paths (A at maturity, C
cooperative). The offence is never *leaving*; it is leaving **without
serving the notice**, because that is the one thing that turns a planned
succession into an emergency.

**Where a slashed guardian bond goes (RULED 2026-09-21: players
cannot lose; the rest to the protocol reserves, RULED 2026-11-02, kanban #976,
in place of 75% to the nodes and 25% to the developers).** The
slashing transaction (§5A.3B) does not pay anyone yet. It pays the whole
bond into a **liquidation escrow** of that federation: an output under the
arbitration set's k-of-m keys (§5A.3B), one per federation, or from template
3 under the census key with the bond going through its hold output first, that
is spent only in one of two ways:

```text
federation CLOSED (§23A.6)      nothing was lost, so nothing is owed:
                                the whole bond to the protocol reserves

federation HALTED (§23A.1)      liquidation, below: every unspent note of
                                the federation paid at face value first,
                                and a note shown late still paid from what
                                is left until four weeks after the halt;
                                only the remainder then, to the reserves
```

The escrow exists because a halt is rarely the first abandonment: a
guardian who leaves in month one and three more in month three halt it
together, and by then his bond must still be there. Slashing stays prompt
(path A returns a bond at maturity if nobody slashes, §5A.3B); paying out
waits for the federation's end.

**Liquidation (RULED 2026-09-21).** A federation that has been
HALTED for `abandon_blocks` with no recovery is liquidated:

1. The guardians still seated publish, signed, their copy of the
   federation's **spent-note set** (the nonces the consensus has already
   redeemed) as of the last session they hold. Any one copy suffices; the
   newest session wins.
2. The arbitration set opens a **claim window** of `claim_blocks` - **36
   hours** on mainnet (RULED 2026-09-21) - and advertises where claims go (§5A.3B's endpoints; every seat mirrors them
   at `GET /liquidations`). The client does the rest on its own: on every
   start it presents each unspent note it holds for that federation, as it
   would present them to the federation itself. A player who has only his
   seed recovers his notes through any guardian that still answers the
   stock backup query; a federation with no guardian left answering is the
   one case this cannot reach, and it is named.
3. A claim is valid if the note carries the federation's signature, its
   nonce is not in the published spent set, and it has not been claimed
   before. Valid claims are paid **at face value** from the escrow, which
   §23A.3's cap sizes to cover the whole reserve; only if the escrow is
   short - guardians whose bonds were never slashed because they never
   left, and no spent set published at all - are claims paid pro rata,
   and the client shows the rate.
4. At the end of the window the arbitration set pays every valid claim.
   A note presented late is still paid from what is left, until
   `drain_blocks` (four weeks) after the halt - the player who was offline
   for a weekend is not the one this rule is for. Only then is the
   remainder paid to the protocol reserves.
   Notes never presented by four weeks after the halt are the holder's
   loss, as they are in a CLOSED federation (§23A.6 step 6).
   **The ORDER is the whole of it**: a halted federation is liquidated
   note by note BEFORE a node or a developer sees a sat, so the people who
   run the network are paid only out of what no player claimed - never out
   of what a player could still have claimed. And no player's money is
   ever burned: what is unclaimed after four weeks is paid out, not
   destroyed.

What the liquidation does not do: it does not touch the federation's
frozen reserve, which stays where it is (and is released to the same
escrow if `2f + 1` guardians ever return); it does not need a single
guardian's cooperation beyond publishing a spent set, and it survives none
publishing at the cost of pro rata; it does not pay anyone who cannot
present a note. Testnet at 5 of 7: `f = 2`, the cap is three of the
smallest bond, three leavers halt it, and their three bonds pay every note.

**The abandonment proof in a halt.** §23A.4's attestations need `2f + 1`
guardians, which a halted federation no longer has. For a guardian gone
while or after the federation halted, the proof is instead the halt
itself - no new consensus session for `abandon_blocks`, which anyone can
observe at every guardian's endpoint and which the seats attest - together
with the attestations of however many guardians are still seated. The
arbitration residual of §5A.3B is the same in both forms.

**How a halt is proven, and what it slashes (RULED HERE, Claude, decided
on the owner's delegation 2026-10-14: "Decide the liquidation ruling
yourself"; measured first in FEDERATION.md rehearsal 17, where neither a
HALTED record nor the second abandonment proof could reach `2f + 1`
signatures with two of four guardians gone).** A halt is the one state a
federation cannot sign for itself, so it is not a federation record:

1. **The seats attest it.** Every census seat reads, at every guardian
   endpoint of a federation whose newest verified record is OPEN, DRAINING
   or CRITICAL, the guardian's session count. A seat that sees no guardian
   advance past session `S` signs a halt observation `(federation_id, S,
   first_height, height, answering[])` - the height it first saw `S` as the
   last session, the height now, and the peer keys that still answer their
   endpoint. A **halt proof** is such observations from a majority of the
   census's active seats, and never fewer than five, all naming the same `S`,
   each spanning at least `abandon_blocks`. The halt height is the latest
   `first_height` among them (no seat is believed to have seen it earlier
   than the others). It is verifiable by anyone from the census (the seats'
   bonded keys) - no guardian signature is needed, and a federation whose
   guardians all left can still be proven halted.
2. **It is refuted by progress.** A verified federation record, or any
   guardian's signed absence attestation, naming a session after `S` voids
   the halt proof: a federation that is merely slow is not liquidated. A
   recovery after the proof (`2f + 1` guardians back) is the existing rule
   - the escrow then takes the frozen reserve.
3. **Who it slashes.** Every guardian of the newest verified record that is
   not in the `answering[]` of a majority of the observations is
   ABANDONED by the halt proof itself, together with the attestations of
   however many guardians are still seated (zero is enough). A guardian
   that answered through the halt is not slashed: it stayed; the federation
   left it. This replaces, for a halt, §23A.4's `2f + 1`.
4. **Seats derive HALTED.** A seat holding a halt proof lists the federation
   HALTED at `GET /liquidations` and counts the liquidation clocks from the
   halt height; no HALTED record is signed by anyone.

**Notes still in issuance at the halt (RULED HERE, same delegation).** A
receive or a reissue whose transaction the consensus accepted, but whose
blind signatures the client had not yet collected when the federation
halted, left the player with no note and the federation with the inputs
spent - measured in rehearsal 17: 100,000 sat accepted, not issued, lost.
These outputs are claimable like notes:

1. The **issued set** is mintv2's own: every output the consensus accepted
   is a recovery item `Output { denomination, nonce_hash, tweak }`, where
   `nonce_hash` is the hash160 of the output's blinded message, served by
   every guardian at the public `recovery_slice` endpoint (the one a seed
   restore already reads). The guardians still seated publish their copy,
   signed with their node keys beside the spent set; a seat may also read
   it from any guardian that still answers.
2. A pending output's secret derives from the seed and `(denomination,
   tweak)` alone (mintv2 `output_secret`), so the client - or a seed
   restored elsewhere - can name it, and presents it as a **pending-output
   claim**: `(denomination, tweak, output secret)`.
3. The arbitration set recomputes from the secret the note's nonce and the
   blinded message (mintv2 `blinded_message`, through the fork's CLI); the
   claim is valid when hash160 of that blinded message is an Output item of
   the issued set at that denomination and tweak, the nonce is not in the
   spent set, and neither was claimed before. Valid pending-output claims
   are paid at face exactly as notes are, in the same window and the same
   pro rata, and late ones from what is left. Handing over the secret sells
   the output to the escrow as handing over a note does.
4. Nothing new is trusted: the issued set is the same kind of copy as the
   spent set (newest session wins, a copy that disagrees is named), and an
   output nobody can unblind for is never paid.

**Why no witness earns from it.** The abandonment proof is signed by `2f + 1`
guardians of the very federation (§23A.4), and the arbitration set cannot check
liveness, so the people who attest an absence must not gain from attesting it.
The reserves pay nobody for being there. Nothing ever goes to the successor's
guardians for being the successor either, so a slash is not a reason to want a
succession. And nothing goes to the reserves before the players are whole: the
escrow pays a liquidation first.

**A guardian's bond is otherwise a normal census bond** (§5A.3B): it stays
his bond until he spends it; path A lets him take it back from maturity on; path B is the arbitration
slash on a committed proof; path C the cooperative close. He may not spend
it while seated - that is the census's own definition of leaving without
notice. A slash start is nobody's spend of that kind: the census reads its hold output
as the same bond, so he stays seated and counted, and what ends the hold output ends
the bond (§5A.3B).

What the bond is *not*: restitution. A slash does not refill a reserve and
does not unfreeze a halt (§24A.3's second property, unchanged). It makes
walking away cost more than staying, which is the whole and only job of a
bond here.

### 23A.5a The owner's emergency key: leaving while the node is offline (protocol 17)

**RULED 2026-11-07 (spec review, kanban #1294).** An emergency departure is free only while the federation stays OPEN after it. A request that takes the federation to CRITICAL or below, and any DEPARTED row whose `since_height` lies inside `abandon_blocks` before a halt height, reads as ABANDONED whatever key signed it: the bond pays. A genuinely broken third machine inside one 48 h window loses its bond, the residual the halt proof already carries.

*(RULED 2026-10-19: "owner emergency key when node is offline ... derived von den 24 words, und erlaubt es bei jeder anderen Node sich
da einzuloggen und einen leave request abzusetzen"; "einloggen mit einem Emergency key. Es ist fishy sich mit den 24 Wörtern
einzuloggen"; the two cases below: "It works the way you proposed. Keep the bond.")*

A node that will be offline longer than it may be absent - its owner travelling, its machine broken - would otherwise lose its bond
to the abandonment rule. The owner takes it out instead, from anywhere, with a key that can do nothing else.

- **The key.** Derived from the node's 24 words on its own path (`ARENA/v1/EmergencyKey`), never stored on the node. The owner keeps it
  as a short **emergency code** (written down at install, shown again on the owner page). The 24 words are never typed anywhere else.
- **Named in the bond advert.** The advertisement carries the key's public key (an optional field, marker `0x5e`, protocol 17), so every
  seat checks a request against the census. A node without it in its advert has no emergency path.
- **The request.** `(node_key, posted_at)`, signed by the emergency key under `ARENA/v1/EmergencyDeparture`, posted to any seat (any
  node's page or the Arena site sign it in the browser from the code); seats pass it on as they pass departure notices.
- **Taken only fresh.** `posted_at` is the signer's own word, so a seat takes a request only while its tip is at most 6 blocks past
  `posted_at` (`EMERGENCY_FRESH_BLOCKS`), and signs a guardian `DEPARTED` only for a request it took itself: a late owner cannot date a
  request back into time without most of the federation's guardian seats.
- **What it does**, by role:

| The node | Its emergency departure | Bond |
|---|---|---|
| no guardian role (game/verify, settlement, liquidity) | out of every seating from `posted_at` on | untouched |
| a guardian, request **before** `abandon_blocks` from his last seen height | `DEPARTED` at once; the federation's succession starts at once, as for a notice that would make it DRAINING | untouched |
| a guardian, request **after** `abandon_blocks` | nothing changes: the absence is abandonment (§23A.4), attested and slashed | slashed |

- **A node online leaves as before**: the notice of `departure_notice` blocks. Only the emergency key skips the notice, and only while
  the node is gone - a node that answers again after its request is a new seat only by a new advertisement.
- **Leaked, the code can only take the node out** - no money, no settings, nothing signed in the node's name.

## 23A.6 Succession: back to nominal size

**RULED 2026-11-07 (spec review, kanban #1298).** A bond counts once across the records that name it: while the predecessor is not CLOSED, the successor's `exposure_cap` is `(seated − 2f) × smallest shared bond − reserve_old`, both figures from the records. Before this the same operators stood behind two reserves for up to 28 days.

**RULED 2026-11-07 (spec review, kanban #1309).** Drain shares are paid only for rounds with `census_height < draining_height + drain_blocks`; after that the predecessor reads as CLOSED for pay. A guardian-called succession names its reason (a `federation_nominal` change or a listed upgrade) or pays no drain shares.

Stock Fedimint 0.12 cannot, as far as this project has measured, add a
guardian to a running federation or hand a gone guardian's key share to a
new one (rehearsal item 12 measures it; if it can, that is the first path
and the rest of this section is the fallback, unchanged as a rule).
So a federation regains nominal size by being **succeeded**, and the
player's notes follow on their own.

**Trigger:** DRAINING (§23A.1); or a departure notice that would make it
DRAINING; or a threshold-signed decision of its own guardians (a planned
upgrade, a change of `federation_nominal` by §27A).

**Steps:**

1. **Found the successor** by §23A.2, with one change: the seated,
   non-departing guardians of the old federation are **seated first** in
   the new one - same operators, new key shares, continuity of who is
   trusted - and only the missing seats up to `federation_nominal` are
   drawn. If they are fewer than `f + 1`, everything is drawn. Under
   capacity pressure (§23A.3a) they stay first whatever their bonds, and
   the bar orders only the missing seats; if they are fewer than `f + 1`,
   everything is drawn and the bar orders all of it.
2. **Open it.** The successor's first record is `OPEN`. The old
   federation's guardians sign a record with `status = DRAINING` and
   `successor_id`; seats and relays carry both. From this record on no
   Round Contract may name the old federation (§23.6 checks `status`), and
   the client refuses deposits into it.
3. **Migrate, automatically.** On its next start and at every settlement
   it sees, a client whose notes are in a DRAINING federation moves them
   to the successor: a stock LNv2 send from the old federation paying a
   stock LNv2 receive invoice in the new one, through a gateway that
   serves both (rehearsal item 13 demands one; a gateway that serves only
   one routes over Lightning to one that serves the other, and the fee is
   shown). In chunks, atomic each, no press; the balance shows **moving**
   until it is done, then the new federation's name. Rounds already in
   flight finish in the old federation; their payouts redeem there (§24)
   and move by the same rule.
4. **Close.** The old federation's record becomes `CLOSED` when no lock is
   open in it and no round names it and either its reserve is below the
   dust it cannot pay out or `drain_blocks` have passed since DRAINING.
   Its guardians MUST serve until CLOSED (§23A.5: stopping earlier is
   abandonment); after CLOSED they may stop, and their bonds mature as any
   node's.
5. **Serving the drain is paid (2026-09-21: "no incentive to stay
   in a draining federation"; RULED HERE).** From DRAINING to CLOSED no
   round names the old federation, so its guardian pool would be empty
   while its guardians still hold every note not yet moved and every lock
   not yet settled. Therefore the **guardian pool of every round that names
   the successor is shared with the seated guardians of the draining
   predecessor**: one share per seat across both federations, so a
   guardian seated in both (the seated-first of step 1, which is most of
   them) earns two shares, and a guardian seated only in the old one still
   earns one, until the old record is CLOSED. The successor pays it because
   it exists on the old federation's work, and the rounds pay it because
   their players' balances came out of that drain. A drain is therefore a
   paid service with a bond behind it, not a bond alone; and it ends the
   sooner the more players move, which the client does on every start.
6. **What is left behind.** Notes in a CLOSED federation are lost to their
   holder, and it is said here: the client migrates on every start for
   `drain_blocks` - four weeks (2026-09-21) - the lobby says so
   from the first day, and a player who never opens the game in four weeks
   has kept a game balance for four weeks against the advice on every
   screen. The federation's guardians cannot
   sweep them to him; they do not know whose they are. That is the cost of
   blind notes and it is bounded by `drain_blocks` and the stake ceiling.

**Testnet** (5 of 7) drains like mainnet, on its own clocks (§27A.6): one
guardian gone makes it DRAINING, a successor of seven is founded with the
six seated first, and every wallet migrates on its own. The succession path
is exercised on testnet before mainnet needs it.

## 23A.7 How a player finds his federation

Nothing is typed, and no link decides it.

- **First start, no seed kept.** The client reads the census (headers and
  bond outputs, as it already does for committees), builds the federation
  list from `guardian_of[]`, fetches each federation's record from any seat
  or relay, verifies it (§23A.4), keeps the OPEN ones on its known-good list
  (or shows the rest with their guardians and asks), and picks by §23A.3.
  The lobby then shows: the federation's name, `seated / nominal`, its
  status band, its load, and the guardians' operator names - before the
  first deposit, and beside the balance always.
- **Same browser.** The kept player (§24) names its federation.
- **New device.** The player types his seed words (§23A.8). The client asks
  every OPEN and DRAINING federation of the census for the stock backup
  under that seed; the one that has it is his, and the stock recovery
  rebuilds the notes. Unredeemed contracts are found through
  `GET /settled?since=` as §24 already says.
  **RULED AS BUILT (2026-10-04): no guardian backup.** The
  notes come back through Fedimint's own **recovery**, which the client
  runs in the browser. mintv2 rescans the federation's issuance history for
  the notes this wallet secret's keys made. The fork's recovery timed out
  on tokio's clock, which panics on wasm32, so it is patched to the
  runtime's clock (`lock-client/fedimint-mintv2-recovery-wasm-clock.patch`).
  The page marks a seed the player typed in (a hash of it, never the
  seed). The first open of that seed's player wallet in a browser that
  keeps none is then `LockClient.recover`, not an empty join. Every later
  open, including one after a recovery a closed or reloaded tab cut short,
  waits for any recovery still pending. A seed the page made itself is
  joined as before. Today the census lists one federation, so it is the
  federation the lobby names that is recovered. Asking every census
  federation in turn waits until a second one is listed. After a restore,
  both devices hold the same notes: whichever spends one first spends it,
  and the other device's copy is refused as spent. A federation that has since
  CLOSED is shown as such with what §23A.6 step 5 says.
- **Rounds elsewhere** are shown with their federation and entered by swap
  (§23A.3), never silently.

## 23A.8 The player seed: twelve or twenty-four words

**RULED (2026-09-21):** the player receives a **BIP39 mnemonic** -
twelve words by default, twenty-four on request (RULED HERE: twelve is the
default because the balance is a game balance under a stake ceiling, and a
seed that is written down beats one that is not) - to write down. It is
shown from the settings screen (§24B), backed up by the player typing **all**
of its words back, in order, which the client checks - the button is named
**Backup** (2026-09-21; three words in random positions is
withdrawn) - never leaves the browser, and is
never seen by any node, seat, guardian or gateway. On another device the
player types it, and nothing else is needed (§23A.7).

**RULED AS BUILT (2026-10-04): no standard BIP-39
derivation and no migration.** The page shows **24 words**, which encode
the 32-byte player seed directly: the BIP-39 wordlist and checksum over
those bytes as entropy, never PBKDF2 key stretching (`bip39.js`). Every
key stays this game's own tagged hash of that seed. The Fedimint wallet
secret is `walletSecretFor(seed, federation_id)`, and its root is
`DerivableSecret::new_root(secret, "BLWP/v1/LockClient")`, not a BIP-39
seed. So the words restore this game's wallet and keys, and a stock
BIP-39 tool given the same words derives other keys. Both restore inputs
(Settings "use my seed" and the key-backup prompt) take the 24 words or
the 64 hex. The tree below is the original design; where the two differ,
this paragraph is what is built.

Everything the player owns derives from it, with domain separation, so that
one backup restores all of it and no key is ever reused across purposes:

```text
mnemonic (BIP39, English wordlist, 12 or 24 words)
  -> root                        BIP39 seed
  -> wallet                      the stock Fedimint client's root secret is
                                 this root; it derives per-federation secrets
                                 by federation_id itself, and its backup and
                                 recovery run under it unchanged
  -> identity key                taggedHash('BLWP/v1/IDENTITY', root)
                                 (§0.12: the display name now follows the
                                 player across devices, RULED HERE)
  -> round key per round         taggedHash('BLWP/v1/ROUND_KEY', root ‖ round_id)
                                 (§24: refund_pk, payout key; fresh per round)
  -> fingerprint                 of the identity key, shown for §24's
                                 out-of-page comparison
```

A lost seed loses the notes and every contract those keys can refund; a
seed in someone else's hands is that person's wallet. Both are stated on
the screen that shows the words, in those words.

---

## 23A.9 Gateway seats: who hosts the federation's Lightning *(2026-10-18)*

**RULED 2026-11-07 (spec review, kanban #1310).** A migration (§23A.6 step 3) or a swap (§23A.3) goes only through a gateway whose published send and receive fees are at or under `gateway_fee_max` in the federation record (reference 0.1 % + 10 sat); else any registered gateway under it; else the client waits and says so. The gateway seating names the fee a seat was seated at, and a seat above it is below the minimums (unpaid).

> "We need 2 guardians per federation and there is currently no process who
> will host the guardian. Modify the spec for it and come up with additional
> incentives from the custody node fee that people want to host a guardian.
> If more than 2 nodes in the federation want to host a guardian a clear
> process must choose the best guardians possible, make the rules and
> requirements clear." (2026-10-18)

**What is meant.** The thing hosted is the federation's **Lightning
gateway**, the role that needs a peg-in. A federation keeps its 4 to 10
*guardians* (§23A.1). Fedimint cannot run on two guardians: four is its
minimum against one fault. §23 already demands Lightning "through any of at
least two gateways run by different operators". Until now nothing said who
runs them. This section does.

**Two gateway seats per federation** (`gateway_seats` = 2), held by two
**different operators** among the federation's own seated guardians. A
gateway seat is a stock LNv2 gateway (§23A.4), registered with the
federation. The federation record (§23A.1) names the seated gateways, and
clients use those two first.

### Who may stand

A node is **eligible** for a gateway seat of federation F in an epoch when
all of these hold:

| Requirement | Mainnet | Testnet4 | How it is checked |
|---|---|---|---|
| A **seated guardian of F**, not departing | - | - | the federation record |
| Its gateway is **announced** (`/gateway-claim`, signed by the node key: gateway URL and Lightning node key) and **registered with F** | - | - | F's own gateway list |
| **Inbound liquidity from outside F** (deposits from the wider Lightning network come in through it; the ring's channels do not count) | ≥ 250,000 sat | ≥ 100,000 sat | stated in the signed claim (remote balance of its active public channels to peers that are not F's custody nodes) |
| **Outbound liquidity** (payouts leave through it) | ≥ 250,000 sat | ≥ 100,000 sat | stated in the signed claim (local balance) |
| **E-cash in F** for receiving: its **peg-in** | ≥ 2,000,000 sat | ≥ 50,000 sat | the gateway's peg-in, made by the node's custody agent; shown by its first receives |
| **Availability**: running, its LND synced, answering | ≥ 95 % of the epoch | ≥ 95 % | each guardian probes every candidate every 10 minutes |
| **Bond** | ≥ `bond_min_guardian` | ≥ `bond_min_guardian` | the census |

An **epoch** is 144 blocks, about a day.

**The channel ring** *(2026-10-18; the installer's LND had no inbound liquidity, so its gateway could take no deposit)*:
once a federation is founded, its custody nodes, in node-key order, each open one public channel of 150,000 sat (testnet4) to the
next. Every gateway then has one channel out and one in, made by the federation's own nodes, with nothing run by anyone else.
- The opener dials the next node at the Lightning address its claim names. LND asks the router for its peer port (UPnP/NAT-PMP);
  without it, the address is empty.
- A node nobody can dial dials its previous neighbour, which then opens over that connection.
- A pair where neither side can be dialled stays without a ring channel and says so.

**The outside channel and Tor** *(2026-10-18: "If the incoming channels are only connected between them with nothing outside it's no good"; "Measure if lnd is accessible from the outside after installing if not install tor")*:
- Each gateway also opens one channel of 100,000 sat (testnet4) to a well-connected hub outside its federation, so payers and payees on the wider Lightning network reach it. On testnet4 the hub is the the test host's LND C at its onion address; mainnet hubs are named before mainnet.
- Most installed nodes take no incoming connection (no open port, a dynamic address). Before LND starts, two seats try to reach its peer port (9735) from outside:
  - reached: LND announces that address;
  - not reached: the node runs Tor (the Tor Project's bundle in the release; the system's tor on linux-arm64), and LND runs hybrid. Others dial its permanent onion address; it still dials clearnet peers directly.
- The ring and the outside channel then reach every node.

### The best two

At each epoch boundary, every seated guardian ranks the eligible candidates
by, in order:

1. **Lightning volume routed for F** in the epoch: LNv2 contracts F's
   consensus saw completed through the gateway, in sat, floored to 1,000.
   This is the same number for every guardian.
2. **Two-way capacity**: the smaller of inbound and outbound, floored to 100,000 sat (outbound alone takes no deposit).
3. **Availability**, floored to whole percent.
4. **Bond** of the operator.
5. **Ticket** `H('BLWP/v1/GATEWAY' || beacon || node_pubkey)` on the
   epoch's first block, lowest first. Nobody hand-picks.

The flooring makes honest guardians measure the same values.

**Seating:**
- The top two operators are signed as a separate **gateway seating** for the epoch, not written into the federation record.
  Once the epoch is over, each seated guardian signs its seating of it: the paid seats (the seated ones less a seat held below
  the minimums) and each paid seat's peg-in as that guardian proved it. The seating **stands only when at least the threshold of
  the seated guardians signed the same body**; a guardian that ranks differently is outvoted by the threshold, and a seating
  without enough signatures does not stand.
  - The activation epoch N is a constant per network (`SEATING_RULES_EPOCH`), never switched by hand: regtest/devnet 0 (the rules on
    from the first epoch); testnet4 and mainnet fixed at the 2.0 tag to `N = floor(tag height / 144) + 14`, with the deploy gate that
    every guardian of every live federation runs 2.0 by epoch N − 2. Until it is fixed for a network, the rules are off there.
  - From the activation epoch of the seat's network (`SEATING_RULES_EPOCH`), decided by the seating's own epoch, each guardian
    floors a paid seat's proved peg-in to whole 100,000 sat before it signs, so guardians reading the federation's coins minutes apart
    sign the same body; a seat one guardian proved and another could not check still splits them.
  - From the activation epoch of the seat's network (`SEATING_RULES_EPOCH`), decided by the seating's own epoch, a seating of
    epoch E is judged against the federation record in force at E's last block, height `(E + 1) × 144 − 1`: its seated guardians
    and threshold, not those of the record a seat holds when it gathers.
  - Never by a build's version or the clock: until the network's activation epoch is fixed, every guardian signs and judges as 1.9.x does
    (exact peg-ins, the record held now), so a mixed 1.9.x / 2.0 rollout signs the same bodies.
- **The seats rotate every epoch** *(2026-10-20: "rotate the guardians daily every 144 blocks among those that want to be
  gateways in the federation")*: the holders of the epoch before step back, with all of their operator's nodes. The eligible
  operators that did not hold a seat take the seats first, in rank order. The holders fill what is left, in rank order, so with
  no other eligible operator a holder keeps its seat. "The epoch before" is the seating its guardians signed for it, else the
  guardian's own ranking of it; every guardian keeps its probes, its ranking per epoch, the routed volume and the signed
  seatings across a restart.
- **Clients use the seated gateways first**: a deposit into F, and each leg of a swap, tries F's seated gateways before any other
  gateway F lists.
- A brand-new federation has no volume yet, so its first two are ranked
  by capacity, availability, bond and ticket.
- **A draining federation has one seat** *(2026-10-20: "those that are DRAINING only need 1, that is a hard rule. All federations
  need 2 of 2 gateways, draining gateways at least 1")*: DRAINING, or CRITICAL while it drains into its successor. It takes no
  deposits, it only pays out while its funds move on.
- **Never without a gateway** *(2026-10-20: "There needs to be at least 1 gateway")*: when no operator is eligible, the best
  candidate that can still serve - a seated guardian whose gateway is registered with F and holds e-cash in F - holds one seat,
  ranked as above, and the seating names it as below the minimums. It keeps the seat only until an operator is eligible.
- **Otherwise fewer than two eligible:** the empty seat stays empty and the seating says so. The federation still runs, and clients
  may use any registered gateway. The operators set up the second gateway rather than leave a seat empty.

### What it earns (from the custody fee)

The **GUARDIAN pool** of the node fee (4/3 % of gross volume on protocol 11 and later, §"Node fee"; gateway seats exist only from
2026.0.15) is the custody fee. It is split:

```text
GUARDIAN pool (4/3 %)
  2/3 -> the seated guardians, evenly            (10 guardians: 0.089 % each)
  1/3 -> the seated gateways, evenly             (2 gateways:  0.222 % each)
```

- A gateway seat therefore earns **2.5×** what a guardian earns, plus its
  own Lightning routing fees. A gateway that is also a guardian, which every
  gateway seat is, earns both shares.
- **Which epoch pays a round:** the signed seating of the **last whole epoch before the round's census height**
  (`floor(census_height / 144) - 1`), since an epoch can be measured and signed only once it is over. That seating names only the
  eligible seats, so a seat earns its share for a round only if it was eligible in that epoch. With no standing seating for that
  epoch the round pays no gateway; it does not fall back to an older epoch's seating. A gateway that holds its seat below the minimums
  (never without a gateway, above) serves but is not paid; its share goes to the other seat, or to the guardians.
- An empty or unearned gateway share goes to the other gateway seat. With no
  gateway seated, it goes to the guardians. The mirror, from protocol 22: with
  no eligible guardian in a round, the custody pool's guardian part goes to the
  eligible gateway seats, evenly; only the custody pool moves, and the gateway
  seats' own share and the liquidity providers' shares are paid as with
  guardians. Only with no eligible gateway seat either does the custody pool
  go to the two committees (game/verify and settlement), half each, the odd
  millisatoshi to settlement.
- Paid like every share: one payout contract per seat in the round's
  settlement transaction, to the advertisement's `payout_pubkey` (§23,
  2026.0.13).
- This split is **protocol 2026.0.15**. Rounds of earlier versions pay the
  guardian pool as before.
- **Under capacity pressure** (§23A.3a) both parts are weighted instead of
  even: the guardians' by bond up to `B*`, the gateways' by proved peg-in up
  to `P*`, each squared.

### In the installer

The custody step says all of the above before anyone opts in:
- the requirements in the table and what a gateway seat earns;
- the peg-in it needs.

It then sets the gateway up: LND, its channels, the gateway on it, and the
peg-in from the node's wallet. The node announces its gateway, and its
federation's guardians rank it from the next epoch on.

## 23A.10 Liquidity providers: incoming Lightning for every new node *(2026-10-18)*

> "This is a real problem. On mainnet everybody needs incoming liquidity. Spec a fourth service for nodes: LND liquidity provider.
> This service alone listens to new nodes and creates incoming liquidity for them. Incentive are part of the 4 % node fees. Gets 1 %
> from the node fees in the federation like other services." (2026-10-18)

### The problem

A node that runs Lightning (every custody node: its gateway) starts with **no incoming liquidity**. Its own channels are outgoing:
it can pay out, but a player's deposit cannot reach it. Buying inbound costs money and time; a new operator should not have to.

### The fourth service

A **liquidity provider** is a node with its own LND and coins in it. Its one job: open a channel **to** each new Lightning node of
the network, so that node can receive. It is a role like game/verify, settlement and custody; a node may hold any of the four.

| | Game / verify | Settlement | Custody | **Liquidity** |
|---|---|---|---|---|
| Does | replays a round, signs who won | co-signs paying the winners | holds the players' bitcoin (guardians), connects it to Lightning (gateways) | opens channels **to** new nodes so they can receive |
| Share of the 4 % node fee (from 2026.0.16) | 1 % | 1 % | 1 % (⅔ guardians, ⅓ the two gateway seats) | **1 %** |
| Shared by | the round's 7 seated nodes | the round's 7 seated nodes | the federation's guardians and gateway seats | the federation's **liquidity providers** (below) |

### Requirements

| Requirement | Testnet4 | Mainnet |
|---|---|---|
| The **liquidity amount** L: one channel to one node | 100,000 sat | 250,000 sat (2026-10-18: "250k per node") |
| **Deposit**: coins in the provider's LND wallet, free for new channels, when it starts and to stay eligible | ≥ 5 × L = 500,000 sat | ≥ 10 × L = 2,500,000 sat |
| Its own LND, reachable (an open port, or Tor: §23A.9 "The outside channel and Tor") | yes | yes |
| A bond | ≥ `bond_min` | ≥ `bond_min` |

L matches the inbound a gateway seat needs (§23A.9), so one provider channel makes a new gateway eligible.

### Who opens to whom: at least 1, at most 2 per node

**Any number of nodes can be providers** - unlimited (2026-10-18: "There can be an unlimited amount of liquidity providers";
"It's also not that it's limited to 2 LPs, that is just our setup now" - the two on testnet4, LND C and LND D, are only the start).
The limit is per **new node**: each gets channels from one or two of them. The liquidity pool is shared by all of them, by coins held.

Every provider publishes a **liquidity claim** at its seat (`GET /liquidity-claim`), signed by its node key:
- its LND key and address;
- its free funds;
- its open channels to nodes: the peer's LND key and the capacity.

It renews the claim every 10 minutes. The nodes that need liquidity are the custody nodes whose gateway claims (§23A.9) name an LND key.

For each such node N, every provider computes the same thing from the same claims:
1. **Count** N's provider channels: the claims whose channels name N's LND key, with capacity ≥ L.
2. If N has **2 or more**: nothing to do.
3. Otherwise the **candidates** are the providers without a channel to N and with free funds ≥ L, ranked by the ticket
   `H('BLWP/v1/LIQUIDITY' || N's node key || provider node key)`, lowest first.
4. The top `2 − count` candidates open one channel of L to N. The others wait.

No coordinator is needed. Each provider sees the others' opens in their claims and stops at 2. A provider that does not open
within an hour of being ranked top is skipped next time: it drops out of the ranking for N until it opens.

A provider keeps a channel open while N is a custody node of the network. It may close it when N has left (no gateway claim for a day).

### Pay

From **protocol 2026.0.16** the node fee of a paid round (4 % on protocol 11 and later) is split into **four pools of 1 %**:
game/verify, settlement, custody, liquidity.
- The **liquidity pool** of a round goes to the **liquidity seats** of the round's federation: the providers with an
  active channel of ≥ L to at least one of the federation's custody nodes.
- **Weighted by available balance** *(2026-10-18: "Fee must be dependant on available balance too if there is more than
  one")*. With more than one seat, each provider's share is proportional to its **weight**: the liquidity it makes available to
  the federation, floored to 10,000 sat.
  - weight = the capacity of its channels to the federation's custody nodes + its **free balance** (coins in its LND wallet, ready
    for new channels);
  - the channel capacities are public in the Lightning graph; the free balance is proven: the claim lists the wallet's outpoints,
    each with a signature by its address key (LND `SignMessageWithAddr`), and a guardian counts only outpoints that are unspent on
    its own chain and signed;
    - the message is `BLWP/v1/LIQUIDITY_FUNDS:<node key hex>:<txid>:<vout>`, so a coin proves one provider's balance only; the
      signature is Bitcoin's signmessage (sha256d of the prefixed message, 65-byte compact ECDSA, base64), for P2WPKH (the
      recovered key's hash160) and P2TR addresses (LND signs with the internal key: the recovered key's BIP-86 output key);
    - the coins are part of the signed claim (at most 50, largest first); the amount counted is the guardian's chain's
      (`gettxout`, confirmed only), never the claimed one; a coin listed twice counts once;
  - the shares are floored, and the leftover millisatoshis go out in the round's order, as in every pool.
  - in the guardians' signed list (the liquidity seating) each weight is **floored to L** (100,000 sat testnet4, 250,000 mainnet):
    free balances move by the minute, and guardians reading a few minutes apart must still sign the same list to reach the threshold.
- **Below the deposit, no share** *(2026-10-18: "Once a liquidity provider has not enough funds left he never receives
  part of the 1%")*: a provider whose **proven free balance + the capacity of the channels it gave** is below the deposit minimum
  (5 × L on testnet4, 10 × L on mainnet) has weight 0 and earns nothing of the liquidity pool. Once topped up to the minimum it earns
  again. *(2026-10-18, "ok accepted": the channels it gave count, so giving liquidity never removes the share - measured:
  LND D held 600,000, gave one channel of 100,000 and kept 496,150 free; free-only it would have dropped out after one channel.)*
- The federation's guardians check every provider's claim each epoch (144 blocks) and **sign the list**, the same way as the
  gateway seating (§23A.9: threshold of the seated guardians). The settlement pays only a signed list.
- With no liquidity seat, the pool goes to the custody pool.
- Rounds of earlier versions keep the three pools of the 4 % (or 5 %) fee.

**Fee proposals (§27A, fee-proposal.js).** A proposal changes the total node fee (`roundNodeBps`, today 400 = 4 %), never the
split: from 2026.0.16 each of the four services takes a quarter of whatever total a passed proposal sets. A node fee of 6 % pays
1.5 % per service; one of 2 % pays 0.5 %.

### In the installer

- The Roles step shows the four services and the fee split as four pools of 1 %.
- Choosing **Liquidity provider** adds the Lightning step (LND, or your own) and, in the Bond step, the **liquidity deposit**
  (5 × L on testnet4). The deposit goes to LND's own wallet.
- The provider service runs as a service of the node.

### On the owner page and the dashboard

A **Liquidity** card:
- LND's free coins and the deposit minimum, with a warning when below;
- the channels it gave (node, capacity) and what they earned;
- a **top-up address** (LND's wallet).

### Live on testnet4

Two providers run on the test host, so the coordination is tested for real: **LND C** and **LND D**, each with its own Tor onion
address and its own deposit.

# 24. Wallet integration

Nostr Wallet Connect, BOLT11 QR, deep link, or WebLN where available.

Rules: the wallet seed never enters the game; the wallet stays external; the
stake amount must be visible; permissions minimal; and **no assumption that
generic NWC permissions cryptographically encode the Round Contract** — NWC
budgets are wallet-side policy, and the reliable boundary is the budget
ceiling plus the wallet's own confirmation screen. The protocol binds the
stake to the Entry Contract via `stake_point`, not via wallet permissions.

**The refund key.** Under the stake lock the money returns to
`refund_pk`, a key the client builds the lock with — not to the wallet that
paid. A lying client (§35A) would set it to an attacker's key and the wallet
would show only a deposit. Therefore:

- `player_pubkey` is derived from a **player seed** the player holds and
  backs up - a BIP39 mnemonic of 12 or 24 words, §23A.8 -
  fresh per round (so locks are not linkable across rounds), and
  the client shows its fingerprint where the player can compare it outside
  the page;
- a client whose hash is not on the known-good list (§5) cannot enter a
  paying round, the same rule as `sim_wasm_hash`;
- the NWC budget bounds what a compromised client can lose per window.

A lost player seed loses the locks it can refund. That is the trade for
having no node in the refund path.

**The player wallet survives the tab (2026-09-14; generalized to
the player wallet 2026-09-21).** Collecting a payout from the federation and
paying it out over Lightning takes minutes (measured live: 414 s from the
press to the player's invoice settled). A tab closed inside that time used
to take the collected e-cash with it, because the round's wallet was kept in
the tab. Now the wallet is the player's, not the round's (§24A.1),
and the rules are:

- **What the player's money needs is kept in the browser, not in the tab**:
  the player wallet's database, and for every round entered its record (the
  round, the invite, the seats, the lock, and the seed the round's key comes
  from). The next start of the client - a reload, another tab, a restarted
  browser - opens the same wallet under the same seed. A tab with no kept
  player creates a fresh seed, which is a new player (§0.12: two tabs are
  two players only while neither has deposited or entered); a browser with a
  kept player opens that player, one tab at a time.
- **Winnings and refunds arrive on their own (2026-09-21).** The
  client redeems every forfeit and every payout contract for one of its
  round keys into the player wallet the moment it is available: while the
  tab is open, as soon as the committee's signature or the settlement
  transaction is seen; otherwise on the next start, which looks at every
  kept round that is not yet settled into the wallet and at what the
  federation still holds for its keys. No press is needed. It is the
  player's own key redeeming into the player's own notes, so nothing
  changes hands. The Withdraw is the one action that pays out over
  Lightning, and it is the player's.
- **Pending, then in the wallet.** From `STAKE_COMMITTED` the lobby and the
  end screen show the stake as **pending**. The winnings, or the stake coming
  back, show as **pending the moment the player's result is
  `PROVISIONALLY_FINAL`** (RULED 2026-10-01, WINDOW-10-SPEC) - not
  when the objection window closes and not when the payout table is final -
  with the amount and what they wait on: the window's close in UTC (or, in a
  round that waits on a no-quorum entry, the later time it waits to, §13A), the
  settlement signature, the redemption. While other players' results are
  still arriving the amount is the payout table computed over the results
  signed so far, and it updates as they arrive; it is marked as such. **If
  the payment becomes invalid** - a valid objection, a re-run, `VOID`,
  `FORFEIT` - **the pending line disappears**, and whatever the new result
  earns takes its place. The moment the notes are in the wallet the pending
  line clears and the balance shows them.
- **The game tells the player.** The wallet balance is shown wherever the
  player can enter a round or withdraw, beside the federation's name.
- **One tab at a time uses the wallet** (a browser lock); another tab shows
  the wallet as open elsewhere and takes over when that tab closes.
- A kept round is dropped once it is settled with nothing left in the
  federation for its key. The wallet is never dropped by the client.
  Cleared browser storage loses the wallet's notes unless the federation's
  stock backup restores them from the seed (FEDERATION.md rehearsal item
  10; AS BUILT,: Fedimint's recovery from the seed, run in the
  browser, finds them again, §23A.7); what the federation still holds in contracts for a round key comes
  back from the seed alone.
- **On another device** (2026-09-14: alice plays on her desktop,
  forgets to withdraw, and plays on her iPhone two hours later): the seed
  backup is brought in. The wallet's notes recover through the federation's
  stock backup under that seed (AS BUILT,: through Fedimint's
  own recovery under that seed, in the browser, with no backup kept by the
  guardians, §23A.7). For contracts not yet redeemed, the client
  asks each seat for the rounds it settled in the last 24 hours
  (`GET /settled?since=`), each listed with the keys its settlement pays and
  the refund keys of its verified locks - both public already. The client
  derives its key per round from the seed and matches it there; it asks
  nothing per round, so no seat learns which rounds it looks for. A matched
  round's contract comes from `/round` and must hash to its id; the round
  is then kept and redeemed like one the device joined. The node stores
  nothing new and never holds the seed. Notes a device holds without a
  backup stay on that device until it starts again; a lock refused at the
  door, known to no seat, comes back only on the device that made it.

---

# 24A. Playing many rounds without approving each one

A round is two minutes and a stake is 100 sats, so a player who sits down
for half an hour signs fifteen payments. That is not a payments problem, it
is the reason they stop playing.

The fix is to remove the **approvals**, never the locks. Every round keeps
its own stake lock, its own `stake_point` bound to its own Entry Contract,
its own VSS-shared preimage and its own expiry refund (§23). What changes is
where the stake comes from and where the winnings go.

## 24A.1 The player wallet

**RULED (2026-09-21):** the round wallet of §24 is the **player
wallet**: one wallet per player seed and federation, kept in the browser,
into which the player deposits, from which every stake is paid, into which
every payout and refund is collected **automatically the moment it is
available** (WINNINGS-AUTO, 2026-10-01: by the client itself, with no press) (shown as *pending* until then, §24), and from which the player
withdraws over a Lightning invoice whenever he likes, in any amount. No
custody, and no channel to any central server.

What it holds is the federation's **e-cash**: bearer notes issued by the
guardians under blind signatures (stock Fedimint mint module). Whoever holds
a note can spend it; the guardians cannot tell whose it is; nobody else has
it. The notes are derived from the player's seed, so the seed is the wallet.

```text
deposit    the external wallet pays a BOLT11 invoice through any listed
           gateway -> e-cash in the player wallet (LNv2 receive, atomic,
           §23.1); any amount the player chooses
stake      the client spends e-cash from the player wallet into the round's
           stake lock and fee lock (§23.1 step 4): no invoice, no gateway,
           no Lightning payment; the lock's refund_pk is a fresh per-round
           key from the same seed (§24)
result     a forfeit (DELIVERED, VOID) and a payout contract (§23.2) are
           redeemed by the player's round key into the player wallet, by
           the client, as soon as they exist; pending until then
withdraw   the external wallet issues a BOLT11 invoice for any part of the
           balance; the client pays it from e-cash through any listed
           gateway (LNv2 send, paid only against the preimage, §23.6)
```

Why this is not custody, stated the way §22 states things:

- **Nobody holds it.** No Arena node, seat, committee or gateway holds a
  note or can move one. The seats never see the wallet; a gateway sees one
  payment at a time and is paid only against its preimage. A client that
  is closed, deleted or offline keeps its notes; nothing needs anyone to
  act.
- **What it is a claim on** is the federation's reserves - exactly the
  claim a stake lock is, and under the same residual (§22: a guardian
  threshold, a halted federation). The stake lock alone carried that residual for the
  length of a round. The player wallet lets the player extend it for as long as he
  leaves notes in the wallet. That is the whole change to the trust
  statement, and the reason the client MUST show the balance beside the
  federation's name and guardian count, and offer Withdraw wherever it
  shows the balance. The federation exposure cap (§22, FEDERATION.md F9)
  counts standing balances, not only locks.
- **What a lying client can take** (§35A, F2) is the balance, no longer an
  NWC budget per hour. The bounds are unchanged: a known-good client hash
  for paying rounds (§5), the seed-derived keys with a visible fingerprint
  (§24), and the balance itself, which is the player's choice. The client
  says so where it asks for a deposit.
- **Unlinkability improves.** Blind signatures cut the link between a
  deposit and the stake it funds at the federation; refund keys stay fresh
  per round (§24). A gateway sees deposits and withdrawals, never rounds.
- **No channel anywhere.** The player holds no Lightning channel. The
  client speaks to the federation's guardians (any of them, as a Fedimint
  client does) and, only when the player deposits or withdraws, to any one
  of at least two gateways run by different operators (§23.6). A gateway
  down is a retry through the other, never a loss, never a wait for anyone.

**Approval fatigue is solved by the wallet, not by wallet permissions.** A
stake spent from e-cash the client already holds needs no external approval
at all. Nostr Wallet Connect, QR, deep link and WebLN remain the ways to
*deposit*, and an NWC budget remains a sensible bound on a top-up; the
caveat of §24 stands: an NWC budget is wallet-side policy and encodes
nothing about a round. The binding of a stake to its round is still
`stake_point` in the Entry Contract.

**The seed is the wallet.** The client says on every load that no backup of
the seed exists until the player has made one with the Backup button (§24B);
nothing is gated on it; a lost seed loses the notes
and every contract the seed's keys can refund (§24). The federation's stock
backup and recovery (mint module, encrypted to the guardians under the seed)
is what brings a wallet back on a new device; the rehearsal in
`FEDERATION.md` (items 8-11) must prove it before real money.

**Empty wallet, first round.** A player with no balance is asked for a
Lightning deposit of at least the stake plus fee, and the client locks from
the wallet the moment the notes arrive - the earlier per-round deposit is
this case, not a second path (§23.1 step 3).

**Donations** (§27A.4, §22A "The donation set") are paid at entry from the
player wallet **inside the federation**: one output per recipient key in the
same transaction as the stake and fee locks *(RULED 2026-10-03;
replaces the Lightning payment to each recipient's LNURL ruled here
earlier, which stays for the rounds published with an LNURL set)*.

## 24A.2 The payment surface, and all of it

| Direction | Mechanism |
|---|---|
| Player deposits | BOLT11 invoice through any listed gateway into the player wallet, any amount; NWC budget, QR, deep link or WebLN |
| Player pays a stake | E-cash from the player wallet into the round's stake lock and fee lock (§23.1); no Lightning payment |
| Player is paid a win or refunded | A payout contract or a forfeited lock to the player's round key, redeemed into the player wallet by the client as soon as it exists; pending until then |
| Player withdraws | Any part of the balance to a BOLT11 invoice from the external wallet, through any listed gateway |
| Donations are paid | One output per recipient key, by share (§22A, §27A.4), in the player's lock transaction inside the federation; redeemed by the recipient's own key (LNURL over Lightning only for rounds published with an LNURL set) |

Lightning at the edges only, when the player chooses; stakes and winnings
move inside the federation, under the player's own keys, and nothing waits
in a Lightning node.

## 24A.3 What was considered and rejected: committee-held session balances

A single 1000 sat deposit spent across ten rounds was specified and then
**removed**. It is recorded here so it is not re-invented, and so the
player wallet is not mistaken for it.

It required a **committee to hold the remainder between rounds** in its
Lightning node, and that is custody. Three properties killed it, in order
of severity:

1. **No unilateral exit.** Once a deposit settles, the sats are inside the
   committee's Lightning node - not in a script a timelock can open. An
   on-chain escrow would give the player a real way out on their own, and
   its closing fee exceeds a 100 sat stake. **The construction that fixes
   it is unaffordable at exactly the size that needs it.**
2. **Slashing is punishment, not restitution.** A committee that goes dark
   leaves the player waiting. Slashing hurts the operator, returns no sats,
   and shortens the wait by not one day.
3. **It inverts the default.** Under §23, total failure refunds the player
   by expiry - *doing nothing returns the money*. A settled balance requires
   somebody to act. No cap, schedule or penalty converts one into the other,
   because that is simply what "the payment settled" means.

**The stake lock is not a session balance.** Each round's deposit
is locked the moment it arrives, with the player's own key as the refund
key. Properties 2 and 3 hold: a committee that goes dark costs a wait until
expiry, and expiry returns the stake to the player's own key with nobody
else acting. Property 1 does not, and it is said here rather than hidden: a
stake lock has no exit to Bitcoin, so a federation that halts freezes it.
That is the price of having no single node in the stake path, bounded by
the stake ceiling and the federation exposure cap (§22).

**The player wallet is not a session balance either.** Take the
three properties against it:

1. *No unilateral exit* - the same as the stake lock, already accepted
   above, for as long as the player chooses to hold notes. A federation that
   offers stock on-chain withdrawal gives an exit through the guardians;
   that is a federation action, not a unilateral one, and is not claimed as
   one.
2. *Slashing is punishment, not restitution* - does not arise. No
   committee and no node holds anything, so there is nobody to go dark
   except the federation itself, which is §22's residual and applies to a
   lock just the same.
3. *It inverts the default* - it does not. The notes are in the player's
   browser under the player's seed. Doing nothing leaves the money with the
   player; nobody has to act for him to keep it, and short of §22's guardian
   threshold nobody can act to take it.

What was rejected was a balance somebody else holds. What the player wallet adds is a
balance the player holds. The remaining difference from the stake lock alone is exposure
in time, stated in §24A.1 and §22, and shown to the player.

---

# 24B. The lobby, the settings screen and the seed — what the player sees *(2026-09-21)*

Three rulings on the reference client, written here because §24A.1 and
§23A.8 depend on them. A client whose hash is on the known-good list (§5)
does all of it; a client that does not is not a paying client.

## 24B.1 The balance is in the lobby, always, and never in the game

**RULED:** the player wallet's balance (§24A.1) is shown in the lobby at all
times: the amount, the federation's name beside it (§23A.3), and, while a
round of the player's is not yet settled into the wallet, the **pending**
line of §24 under it - present from the moment the result is
`PROVISIONALLY_FINAL`, gone if the payment becomes invalid (WINDOW-10-SPEC). It is **not shown in the game**: the truck, the
mission and the war are the whole screen there (WAR_TACTICS.md §0), and a
number that changes while the player drives is a distraction that decides
nothing. Withdraw, Deposit and Move (§23A.3) are lobby actions, next to the
balance.

## 24B.2 The settings screen

**RULED:** a settings icon **top right in the lobby** opens the settings
screen. It holds exactly:

- **Name.** The display name of §0.12 - the derived `adjective-animal-NNNN`
  by default, changeable here, published as §0.12 says.
- **Donation.** The developer donation of §27A.4 as six choices, `0 1 2 3
  4 5 %`, one selected; the recipients of the donation set shown beside it
  (§22A: a donation to an undisclosed address is not a donation). The
  choice is the client's and the player's; no node may change it (§27A.4).
- **Seed phrase.** A button that shows the player's twelve or twenty-four
  words (§23A.8), behind a screen that first says what they are (below),
  and a button named **Backup** (2026-09-21) that asks the player to
  type every word back in order and checks them. Until a Backup has
  succeeded once, the settings screen and the lobby both show that **no
  backup exists**.

Nothing else is in settings. Federation, load and guardians are shown by
the lobby (§23A.7); wallet actions are lobby actions (§24B.1).

## 24B.3 The seed notice

**RULED:** when the game loads and the seed has never been verified, the
lobby says so before anything else: *no backup of your seed phrase exists;
if this browser is lost, so is your balance; open settings to write it
down.* The notice is a line, not a modal, and it gates **nothing** (2026-09-21: no lock): the player may deposit, enter and play with it
standing. It stays until a Backup has succeeded once. The warning is the
whole of it, and the balance the player risks by ignoring it is his.

The screen that shows the words carries the usual rules, in this order, in
those words or plainer:

1. Write the words down on paper, in order. Do not photograph them, do not
   paste them anywhere, do not keep them in a file.
2. Anyone who has these words has your balance. Nobody who runs this game
   will ever ask for them - not a node, not a guardian, not support.
3. If you lose them and this browser, the balance is gone. Nobody can
   restore it; the federation does not know it is yours (§24A.1).
4. On another device, type them in and everything comes back (§23A.7).

Backup is the whole phrase: every word, in order, typed back and checked
(§23A.8). A partial check is not a backup.

---

# 25. Lobby and discovery

Finding a ROUND is not authoritative: project website, community sites, a
direct link, a QR code, or a copied `round_id`. A lobby may hide a round
from its UI; it cannot make a valid round invalid, and a player with the
Round Contract can always connect directly.

Finding the NODES is a different matter and is not left open: it is chain
state, and §25.1 says exactly how.

## 25.1 Discovery is chain state *(new)*

**RULED 2026-11-07 (spec review, kanban #1312).** Omission is the attack, so the second source is normative: a client that pays takes bond lists from at least two independent providers and uses the union, and checks completeness over the recent window from BIP158 filters since a compiled-in census checkpoint (every bond pays `BOND_MARKER`; a few MB a month). A list that one provider serves alone is enough to look, not to lock.

Playable M2 on regtest/testnet4 uses this section, not a later milestone:
bond outputs, census, committee_time, and the advertisement in the funding
transaction. Lightning settlement is M3. Committee size is genesis: 2-of-2
on those nets, 5-of-7 on mainnet.

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
guardian <-> guardian: consensus             Fedimint's own P2P, stock (§23A.4)
client / seat -> federation                  Fedimint client API to any guardian
federation records, absence attestations     every guardian and every seat,
  (§23A.4)                                     AND publication_relays[]
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
public that the accused does not control. The Round Contract names where:
`publication_relays[]` (§6, §13A) — data, not infrastructure, and anyone may
add a mirror. A proof carries its own verification, so any channel will do;
what a watchtower needs is to know where to look, and a contract that named
none left the objection window with nothing to watch.

> Direct is fast and bounded; public is censorship-resistant. A proof that
> is both accusing and time-limited needs both.

## 25.3 Transport, stated plainly *(new)*

There is no NAT traversal anywhere in this protocol and no peer discovery
in the networking sense. Nodes are reachable servers with a declared
`endpoint`; players are browsers, which can open connections and never
accept them. The "P2P" in this document means **no central provider**, not
peers behind routers finding each other. A browser can never be a node,
which is why `arena-node` is separate software.

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

**And when the address moves anyway: an address announcement, off chain**
*(2026-10-21, kanban #562: "1 default, 2 for updates so no needed updates")*.
A stable address is the default - a named tunnel or the operator's own
domain, set at install and on the owner page. When it changes all the same
(a quick tunnel comes back under a new name after a restart), the node signs
an **address announcement** with its node key - `{ node, endpoint, atMs }`
under the tag `BLWP/v1/ADDRESS_ANNOUNCEMENT` - and pushes it to every census
node's seat (`POST /address-announcement`; `GET /address-announcements`
lists what a seat holds). Whoever looks for the node - a seat, another
guardian's P2P tunnel, a founding's code exchange - takes its newest valid
announcement over the census endpoint, unless the advertisement is newer.
No transaction, no fee, no confirmations: the census entry stays the node's
identity and its bond, and only where to find it moves. An announcement dated
more than 10 minutes ahead is refused.

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
node fee:                5 sat (5%, Bitcoin Arena)
developer donation:      0 to 5 sat (player's choice; default 5: 2.5 protocol devs, 2.5 game dev)
census_height:         H (Bitcoin), roots in the contract
published_at:          11:50   committee unknowable, no entry possible
committee_time:        11:55   beacon -> both committees fixed, entry opens
start_time:            12:00
entry closes:          12:00:00  (at the start: all start together)
T_run:                 82 seconds
objection window W:    600 s wall time (fixed, WINDOW-10-SPEC)
GAME/VERIFY:           7 slots, 5-of-7   (known from 11:55)
SETTLEMENT:            7 slots, 5-of-7   (known from 11:55)
```

At 11:50 the contract's hash confirms on Bitcoin (`publication_txid`); the
lobby shows it with **committee: pending** and no entry button. At 11:55 the
beacon value appears, both committees are selected, and every client
recomputes and verifies them against the census roots. The entry window
opens. Between 11:55 and 12:00, 37 players enter. At 12:00 the round starts.

Alice joins at 12:01. Because the committees have been known since 11:55,
she can build a valid entry: she generates `P`, VSS-shares it to the seven
settlement nodes, signs her Entry Contract, and her client spends 100 sat
from her player wallet into a stake lock in the federation (a Lightning
deposit first, had the wallet been short). Five settlement nodes
confirm the lock; five game/verify
nodes issue EntryReceipts. She rolls out, publishes inputs and checkpoints,
and delivers.

Her client uploads the full transcript to two committee nodes and a mirror
before showing the victory screen. Five game/verify nodes replay and sign
`DELIVERED, score 18,321`. The round's end is 12:01:37 UTC (entry close
12:00:00, plus the 15 s post grace, plus 82 s), so its window runs 12:01:37
to 12:11:37 on every node. Her result is provisionally final at 12:02:10,
and her lobby shows her stake and her rank share as **pending** at once,
with "window closes 12:11:37 UTC". Nobody objects; from 12:11:42 the seats
sign `FINAL`, and with the fifth it is.

At 12:07 entry closes: 61 players. Final results: 24 delivered, 31 failed,
6 forfeit → loser pool 3,700 sat. The deterministic payout table is acknowledged
5-of-7. The settlement committee forfeits the qualifiers' locks back to
them, releases preimage shares for the losers, and signs one settlement
transaction that moves the losers' locks straight into the qualifiers'
rank-weighted payout contracts — every action a 5-of-7 threshold ceremony.

Alice's client redeems her 100 sat stake and her rank share into her player
wallet the moment the settlement transaction is seen; from 12:02:10 until
then her end screen and her lobby showed them as pending. She plays on from the wallet, or withdraws to
her own Lightning wallet whenever she likes. No central game server decided
she won, and at no instant did any single party hold her money.

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
| game difficulty, damage, army, round timings | config proposal, DESIGN class (§27A.7); a round MAY override within its contract. **Until the ballot is built: by ruling, §27A.7.8** | a ballot, then the round |
| the donation set | signed by the donation authority | one key, nothing else (§27A.4) |
| `genesis_parameters`: committee shape, thresholds, beacon | not within a network. Changing them creates a **successor** network by hard fork (§27A.8) | a ballot, UPGRADE class |
| the core, message formats, new unit types, new parameters | hard fork with a code commitment (§27A.8). **Until the ballot is built, a new core may run beside the old under the same `network_id`, by ruling, §27A.7.8** | a ballot, UPGRADE class |
| backwards-compatible protocol additions | software version; adoption is running it (§27A.5) | nobody in particular |

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

**`node_fee_bps` fails this test and is not here** *(moved to §27A.7)*. The
fee is paid by the **player** and declared exclusively by its
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

**Changing a declaration is deliberately not free.** It means an
advertisement update (§5A.2): a transaction, its fee and its confirmations.
It never means a new bond - a confirmed bond stays the bond (2026-09-28). Governance therefore moves at the speed of capital, and a
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

**Two donation sets in Bitcoin Arena (§0A.8).** What this section governs is the
**protocol devs'** set: one per network, signed by the donation authority.
Each game names its **own** set in its manifest, signed by the game dev's
key (§0A.3); the network's authority cannot change a game's set, and a
game dev cannot change the network's. A player's donation is split half to
each.

The donation set cannot be a median: it is not a scalar, and the capital
holders are not the people whose work is being funded. It also cannot be
fixed forever, because addresses change.

It is signed by one key, and that key - with its recovery key - is part of
what defines the network:

```text
network_id = H( genesis_parameters
             || donation_authority_pubkey
             || donation_recovery_pubkey
             || predecessor            // 0 at genesis, else §27A.8
             || fork_certificate_hash ) // 0 at genesis
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
| **authority stolen** | The thief signs a set with a higher serial pointing at their own keys, and players with donations on pay them until it is noticed. Answered by a rotation from the recovery key: **no fork, the census survives.** Nothing else is touched - no round, no stake, no payout, no committee. |
| **authority lost** | Same remedy. Rotate and carry on. |
| **both lost** | The set freezes at its last published serial and every donation keeps going where it was already going. Everything else works. There is no further recovery and there should not be. |
| **recovery stolen** | The thief can seize the authority. It is therefore **exactly as sensitive as the authority key** and must be stored accordingly - the fact that it is used once in years makes cold storage realistic, not optional. |
| **both stolen** | The network's donations are lost to the thief, and this is the case a fork is for. It costs a census. |

The damage is bounded in every row: donations are voluntary, capped by
`donation_bps_max`, and every recipient is displayed before wallet approval
(§22A). A player who has donations switched off is unaffected by all of it.

### 27A.4.1 The developers' own ballot (2026-10-16)

**RULED 2026-11-07 (spec review, kanban #1302).** A change of the set needs the authority key **and** approvals by more than half of the recipients' `share_bps`, so the authority key alone moves nothing; a recipient's share can be cut only with its own signature or by the cold admin key; a frozen set keeps paying its recipients' own keys, never one address. Whether the protocol developers' 2 % stays mandatory (§27A.9.1) or returns to §0A.8's player choice is the owner's decision, open on kanban #1302; the single-key risk is closed either way.

The developers paid by a donation set may replace it themselves, without the admin key and without
a new network id:

- **Proposal.** Any recipient of the set in force signs `DonationProposal { network_id, serial,
  parent_set_id, entries[] }`: the new entries (share_bps summing to 10000, each optionally vesting,
  below), `serial` above the parent's, `parent_set_id` the id of the set in force it replaces.
- **Approval.** Each recipient of the parent set may sign `DonationApproval { proposal_id,
  at_height, accept }` with its recipient key; `at_height` is the signer's chain tip.
- **Threshold.** Accepting approvals are ordered by `at_height` (then key). The proposal is
  **approved** at the first approval after which the accepting recipients hold **more than half**
  of the parent's share_bps (> 5000, "50.01 %"). It is refused once the denying recipients hold
  5000 or more.
- **In force.** An approved proposal is a donation set with `valid_from = at_height + 1` of the
  approval that crossed the threshold, ordered against the admin key's sets by serial as any other
  set (§27A.4: the highest serial in force wins). A round names the set in force at its census
  height, so rounds already published keep theirs and every new round takes the new one; nodes
  take it as soon as they hold the approvals. The network id does not change.
- **Vesting.** An entry may vest: `vesting { target_bps, start_height, days }`. Its share grows
  every day (144 blocks) by `(target_bps - share_bps) / days` from `start_height` until it reaches
  `target_bps`; until then the part not yet vested is paid to the other entries in their own
  proportions. A newcomer starts at share_bps 0; an existing developer's share can vest upward the
  same way. A later approved proposal ends any vesting by replacing the set.

### 27A.4.2 Contribution agreements: a share earned by results the chain can read *(RULED 2026-11-08, kanban #1346)*

A person who markets the Arena is paid from the protocol developers' donation set, and the
whole agreement lives in the node: every target, every percentage, every date is a record the
seats read, and his share is whatever the chain says he has earned. No initial investment, no
commission, no spreadsheet, no trust in a report. What stays outside the node is only what no
protocol can judge: cause for a termination, a non-compete, the law.

**The record.** A `ContributionAgreement` is an entry of a donation set (§27A.4.1: proposed and
approved like any set change, and signed by the contributor's own recipient key too):

```text
ContributionAgreement {
  recipient_pk      his key in the set
  site_keys[]       his referral programs (the website payout keys his pages name as
                    frontend_pk, §22A; each a ReferralName he signed)
  start_height
  base              { target_bps 250, cliff_blocks 26,280 (~6 months), days 730 }
  tranches[]        { bps 250, milestone, window_blocks, expires_height }   four of them
  attribution_floor_bps  3000
  tail_blocks       52,560 (~12 months)
}
```

Target 12.5 % of the set: 2.5 % for time, 10 % for results.

**The base (2.5 %).** Nothing vests before `start_height + cliff_blocks`; at the cliff the
days that passed vest at once, then `target_bps / days` per day (144 blocks), as §27A.4.1's
vesting does. The base is the trust he is given for showing up, no more.

**The tranches (4 × 2.5 %).** Each vests, whole, at the first height at which every seat reads
its milestone as met, and never after `expires_height` or after he has left. A milestone is a
function of rounds that **count** (kanban #1218: a derived contract, standard committees, the
committee's signed account) and of entries that carry one of his `site_keys` as `frontend_pk`:

| | milestone, read from counted rounds since `start_height` |
|---|---|
| T1 | 1,000 distinct identities (kanban #1276's proof) whose **first** paid entry on the network carried one of his site keys |
| T2 | 300 of T1's identities with a paid entry at least 4,032 blocks (4 weeks) after their first |
| T3 | mainnet, and in one `window_blocks` (12,960, a season) the gross stake of entries carrying his site keys is at least 20 % of the gross of all counted rounds |
| T4 | in six consecutive windows of 4,320 blocks (30 days), the share of **new** identities whose first paid entry carried his site keys is at least 30 % |

**Whose keys are his (2026-11-08, the owner: he runs the website and every social account).**
The project's own site key, the `frontend_pk` of bitcoinarena.io, is never one of his
`site_keys`: a player who comes to the site directly, or from someone else's link, counts for the
project. His `site_keys` are the referral programs he makes for his campaigns, one per post,
clip or series of posts, each a link of the form `bitcoinarena.io/r/<name>` that the page keeps
and the client writes into the entry's `frontend_pk`. Social platforms pass no usable referrer
(X wraps every link in t.co and most in-app browsers send none), so the link itself carries the
name. What the node then measures is exactly what he influences: whether his posts bring
players. Growth through the homepage, word of mouth or the developers' own threads stays the
project's. Outside the node, before the agreement starts: the domain, the Cloudflare account,
the social accounts, the Arena Nostr key and the site key are owned by the project with the
recovery in the owner's hands; he has operator access that can be withdrawn.

**Per network (RULED 2026-11-08, kanban #1349).** Mainnet and testnet4 run the numbers above.
Regtest and a devnet run the same rules at test scale, as a genesis table like the lock's
`stall_blocks`: T1 3 identities, T2 2 of them back after 6 blocks, T3 20 % over a 12-block
window with the network's "mainnet" condition read as the genesis `main` flag so a devnet can
test it, T4 30 % in 3 windows of 6 blocks, and a read lag of 6 blocks in place of 288. The
counts are not fields of the agreement: every agreement on a network reads the same scale.

**The attribution floor.** A tranche vests only if, over its own window, new identities whose
first paid entry carried his site keys are at least `attribution_floor_bps` of all new identities
on the network. Growth that comes from elsewhere vests him nothing past the base: that is the
whole point, and the reason the base is small.

**Reading it the same everywhere.** Every input is a seat-readable fact that already exists:
counted rounds (#1218), identity proofs (#1276), the `frontend_pk` of each Entry Contract, block
heights. A seat computes his vested `share_bps` at a round's census height and pays the set
accordingly; two seats holding the same counted rounds pay the same. Rounds a seat cannot check
do not count, for him as for the leaderboard.

**Leaving.** There is no buyback in cash and no valuation to argue about; the stream itself is
the price.
- **He leaves (signs `ContributionLeave`):** the unvested part lapses; the vested part keeps
  paying for `tail_blocks` and then ends.
- **He is removed for cause (the cold admin key signs `ContributionTermination { cause }`):**
  the unvested part lapses and the vested part ends at once. Whether the cause holds is a matter
  for the law, not the node; the node only records who signed what.
- **Expiry:** a tranche not met by its `expires_height` (reference: `start_height + 157,680`,
  three years) lapses.

**Why it is this way.** Time-vesting a large share pays a person for the network's luck;
vesting it on results the chain can attribute to his pages pays him for his work and nobody
else's. A commission would make him sell rounds; a share of the developers' set makes him grow
the network. And every number being public means the agreement cannot drift, be misremembered,
or be renegotiated downward in private: a change is a new set, approved like any other.

## 27A.5 Discrete changes: rough consensus
 *(changes that break replay are §27A.8.)*

This covers **backwards-compatible** additions only - an optional field, a
new advertisement hint, an extra diagnostic message. They are not numbers
and cannot be medians, and they need no mechanism: a change ships as a
software version and takes effect when enough nodes run it that rounds using
it can find a committee. Nodes advertise `supported_protocol_versions`
(§5A.1) and a Round Contract names the one it needs, so a round nobody
supports simply finds no committee and never starts.

This is slower and less tidy than a vote. It is also the only version that
does not require someone to be in charge.

**Where it stops.** The moment a change alters what a transcript *is* - the
core, the simulation, a new unit, a new message the committee must agree the
meaning of - rough consensus is not enough, because deterministic replay
(§13A) needs both sides to establish they ran the same code. Those are hard
forks and go through §27A.8 with an explicit code commitment.

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
  slash_hold_blocks      template 3: start to earliest release (§5A.3B)
  slash_return_blocks    template 3: start to the node's return (§5A.3B)
  slash_fallback_blocks  template 3: start to the census key's release (§5A.3B)
  census_key_shares_max  template 3: the cap on a census key's shares (§5A.3B)
  census_key_bond_min    template 3: B of a census key, the lowest bracket's bond_min (§5A.3B)
  census_key_0           mainnet: { public_key, holders[], threshold }, the key the
                         genesis founders made and who holds it (§5A.3B)
  genesis_height         mainnet: where the census key's chain scan starts (§5A.3B)
  notice_period          for a rise in bond_min (§27A.3)
  bracket_table          the §5A.10 stake ceiling table
  bond_marker            the §25.1 discovery address
  randomness_source      the beacon (see below)
  genesis_config_hash    the game_config the network starts on
  federation_nominal     guardians per federation (§23A.1)
  federation_min         below this a federation is CRITICAL (§23A.1)
  bond_min_guardian      a guardian's bond floor (§23A.2)
  peg_in_max_age         the oldest peg-in that still counts (§23A.3a)
  abandon_blocks         absence that is abandonment (§23A.5)
  departure_notice       notice a guardian must give (§23A.5)
  founding_window        time a drawn set has to finish DKG (§23A.2)
  drain_blocks           how long a draining federation serves (§23A.6)
  claim_blocks           the liquidation claim window (§23A.5)
}
```

**The genesis config.** `genesis_config_hash` is the `config_hash` of the
first `game_config` (§27A.7.1) - the one with no `parent` - and it carries
the network's opening `node_fee_bps`, brackets, damage table and timings.

Changing any of this is not an operation within a network; it produces a
**successor** network, which §27A.8 makes verifiable rather than merely
possible.

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
| guardians per federation (`federation_nominal`) | **10** (7 of 10) | **7** (5 of 7, 2026-09-27) | 4 (3 of 4, the `FEDERATION.md` rehearsal) |
| `federation_min` | 7 | 5 | 3 |
| `abandon_blocks` / `departure_notice` / `founding_window` / `drain_blocks` / `claim_blocks` (the owner: fast; 36 h arbitration) | 288 / 432 / 432 / **4032** / **216** (≈ 48 h / 72 h / 72 h / **28 d** / **36 h**) | **12 / 18 / 18 / 144 / 9** (≈ 2 h / 3 h / 3 h / 24 h / 1.5 h; the owner: much shorter) | 10 / 10 / 10 / 100 / 10 |
| confirmations | 6 | 2 | **1** |
| `series_lead_min` = `series_start - committee_time` (CENSUS3D-1401, TN24-1405) | **72 h** | **24 h** (testnet4) | regtest's own blocks |
| census lead = `series_start - census cutoff` (TN24-POST-1409) | **72 h** | **36 h** (testnet4; 12 h publication window) | regtest's own blocks |
| writer horizon (rounds generated ahead, TN24-1405) | 72 h | **72 h** | 72 h |
| `bond_maturity` | ~30 days | ~1 day | **100 blocks** |
| `slash_hold_blocks` / `slash_return_blocks` / `slash_fallback_blocks` | 6 / 432 / 288 | 1 / 108 / 72 | **1 / 36 / 24** |
| `census_key_shares_max` | 1024 | 1024 | **1024** |
| `census_key_bond_min` | the lowest bracket's value, in genesis | 50,000 sat (its live floor) | **50,000 sat** |
| `notice_period` | ~30 days | ~1 day | **10 blocks** |
| stake ceiling | §5A.10 table | testnet sats | play money only |
| beacon | Bitcoin block after `committee_time` | Bitcoin block | **mock, seeded** |
| governance | 1008 / 1440 / 2016 | 144 / 144 / 0 | **1 / 6 / 1** |

Two nodes and 2-of-2 on regtest is the point of it: the whole settlement
path - stake locks in a regtest federation, VSS, a 2-of-2 FROST signature, the objection window,
the payout table - runs on one laptop.

### Where blocks come from on regtest

There is a chain - regtest is a full Bitcoin node, just one whose blocks you
mine yourself with `generatetoaddress`, instantly and for free. So nothing in
the protocol changes shape: `census_height` is a real height, bonds are real
UTXOs at a real depth, `bond_maturity` is a real `nLockTime`. Where mainnet
waits thirty days for a bond to mature, you mine 100 blocks in a second.

The beacon is the one part regtest does **not** take from its chain.
Committee selection uses the first Bitcoin block after `committee_time`
(§5A.5) precisely because it is mined *after* the contract confirmed and
nobody can grind against it. That property is worthless in a test and gets
in its way: whoever runs regtest mines the block, so the seed is theirs
anyway, and a hash you cannot fix means no test can select a known
committee twice.

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
    round_duration_s        82       // how long a run lasts (4920 ticks); every run of a round starts together
    round_period_s          90       // a new round every 90 s; the 8 s between is the result card
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

The army is simulated, not painted. Each tank and each rifleman has a
named goal each tick (front, foe, or retreat) and steps toward it.
Gunships run their own side of the front and always aim a living target
or a cluster near `frontline_z(x)`, not a timer-drop on empty ground.

A second air arm is liquidation bombers. Each live futures liquidation
scrambles one strike; a simulation toggle covers quiet tape. Aim is
tactical near the front. Crater radius follows liquidation size, lasts
10–20 rounds, and is avoided by units. The truck taking that ground is
irradiated (health, death) with a visible atom warning. Not a gunship.
The picture is M1 too (2026-09-03): Claude-designed bomber and
atom-bomb-on-drop, Bitcoin skins for bears and for bulls, a crater the
truck drives into after the bomb, radiation on the ground. HUD warning
stays. Not a later polish letter. Feeds (2026-09-04): no free
all-exchange tape; BTC liquidations from Binance, Bybit, OKX, Bitget,
Gate.io, MEXC, Kraken Futures, Hyperliquid into the same strike. HUD
shows amount per exchange; many in one tick become one summary (sums +
exchanges). Wait until each venue has at least one hit, no time cap.
Units occupy the front line wherever `frontline_z(x)` sits — not a
parking lot on their spawn side. Heading follows travel. This is M1
playability: the enemies you see are doing a job, or the core has not
replaced the old army yet.

  economy {
    node_fee_bps            500      // 5% of the gross round amount, INCLUSIVE (Bitcoin Arena, §0A.8; BLWP had 200).
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
network. Its operator vote cannot touch the donation set: that set changes by
the admin key (§27A.4) or by the developers it pays, through their own ballot
(§27A.4.12026-10-16) - never by the nodes. And it cannot change protocol rules or message
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
a fixed price for occupying the whole network's attention for a month, and
it is not refunded on success. Refunding it would make proposing free for
anyone confident of passing, which is exactly the party a rate limit is for.

`proposal_deposit_sats` is a median scalar (§27A.2) - the network prices
proposing through the mechanism that needs no proposal - but it is
**capped**, and the cap is what keeps it from becoming a censorship lever:

```text
proposal_deposit_sats  <=  bond_min(lowest bracket) / 100
```

The median is bond-weighted, so without a cap the largest bondholders set
the price of proposing. A deposit of a million sats is nothing to them and
total exclusion for a small operator, and they could raise it precisely
because it binds them least - the self-binding test of §27A.2 is satisfied
in nominal sats while failing in proportion to means.

Tying it to the smallest `bond_min` fixes that: any node eligible to serve
at all has already locked a hundred times the deposit, so the right to
propose is implied by the right to participate and cannot be priced away by
people with more capital.

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

**RULED 2026-11-07 (spec review, kanban #1300).** The turnout floor is replaced by a floor on YES over everyone eligible, so a NO can never cause a pass (the old pair, turnout 40 % and approval 66 %, let 30 % YES pass only when 10 % honest NO showed up): DESIGN passes with YES > 50 % of non-abstaining weight **and** YES ≥ 15 % of all eligible capital; MONEY with ≥ 66 % **and** YES ≥ 26 % of all eligible capital; an UPGRADE keeps §27A.8's 34 %. A MONEY vote counts only bonds that meet §27A.9.5 rule 1's age, so rented 31-day capital does not set the fee. `node_fee_bps_max` is a genesis parameter: raising it is an UPGRADE the clients must choose to follow.

In block heights, because that is the only clock the network agrees on -
the same clock the census already uses.

| Phase | Blocks | ≈ | What happens |
|---|---|---|---|
| Review | 1008 | 7 d | Published, votes not yet counted. Time to find that it is broken *before* anybody has committed to it. |
| Voting | **1440** | **10 d** | `OP_RETURN` votes confirm. |
| Cooldown | 2016 | 14 d | Outcome known, change **not** live. Operators upgrade; anyone who dislikes it exits by spending their bond after maturity. |
| Activation | at `activation_height` | | |
| **Total** | **4464** | **~31 d** | |

`activation_height` MUST be at or after the end of cooldown; a proposal that
names an earlier one is invalid on its face.

**A seat decides a ballot 3 blocks deep at least (RULED 2026-11-06, kanban #1196,
#1152).** A seat decides a proposal once its last voting block is buried as deep
as 6 blocks, counting the block itself, but never later than the block before
`activation_height`. It never decides at fewer than 3. A proposal whose
`activation_height` leaves fewer than 3 blocks after its last voting block is invalid on its
face, so a 1- or 2-block reorg can never activate or undo a config after rounds
were made under it. A deeper reorg that replaces the counted last block reopens
the decision, as before. Regtest keeps its own schedule (1 / 6 / 1) and depth 1.
This applies to proposals published at or after the network's `BALLOT_DEPTH_HEIGHT`
(regtest 0, testnet4 the height its seats roll to this rule, mainnet from its first
block). Older proposals keep the old rule, so seats on older releases never split
over them.

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

And a **repeal** runs on a short schedule - review 0, voting 720, cooldown
2 (RULED 2026-11-06, kanban #1196: it was 0, which let a repeal decided 3 deep
activate before its decision was final; regtest stays 0 / 6 / 0; testnet4 votes
one day, 144, as every testnet4 ballot does since kanban #785, with the same
cooldown 2 - RULED 2026-11-06, kanban #1200) - but *only* if it names the
config in force's **direct parent**, within one normal cycle (4,464 blocks) of
the activation it undoes, at its class's thresholds (RULED 2026-11-07, kanban
#1307: "any ancestor that was live before" let a fee config repealed years ago
come back in five days with no exit window); anything else is a proposal. And
*only* if its `config` is byte-identical to an ancestor that was
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

Pairing is an `arena-operator:` URI (an old `blwp-operator:` one still pairs) - endpoint plus a 32-byte token the node
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

### 27A.7.8 Until the ballot is built *(interim, 2026-10-04)*

The ballot of §27A.7.2-§27A.7.4 and the fork certificate of §27A.8.1 are not
built yet. Until they are, a change to the game's rules is made **by the
network's authority, by ruling**, and it is made the same way a passed
ballot would make it - never by editing the rules a round already names:

- **A rule change is a new `game_config` with its own `config_hash`**, under
  the **same `network_id`**. `genesis_config_hash` stays the config the
  network was founded on and is never rewritten: it is where the chain of
  configs starts (§27A.6), not the config every round plays. A later config
  is encoded with its version first, so no two configs can be read as each
  other, and its hash is computed from the core's own constants, never
  typed.
- **A change that needs a new core installs it beside the old one, under the
  same `network_id`.** Each core plays its own config, and a round names the
  pair: `sim_wasm_hash` and `config_hash` (§6). A node holds every pair a
  published round names - an old core is kept, frozen, for as long as a
  round on it can be replayed - and a node that does not hold a round's pair
  is not selectable for it (§27A.7.5). A client lists the pairs it knows and
  refuses a known core under a config it does not play, exactly as it
  refuses an unknown core (§5).
- **No round is moved.** A round keeps the pair it was created under to the
  end (§27A.7.5). A new pair is used only by rounds created after the change,
  and a paid series only from the next series published. Where rounds were
  created on a new core before its config had a hash, that one pair is kept
  for those rounds only, bounded by a committee-time cut-over, and refused
  for any round after it.
- **Each change is recorded** with its ruling, its date, the old and new
  hashes and the cut-over (FEDERATION.md, "Rulings").

This is not the governance of §27A.7: nobody votes and nothing is on chain.
It keeps the two properties that matter until the ballot exists - every
round is scored by the rules it entered under, and every change is visible
by hash - and it is replaced by §27A.7 / §27A.8 as soon as those are built.
The first change made this way: core `de2f263d` with config `dbb49344`
(C the bed fill, par 1800 ticks, §18A.3) beside `2069b4c2` with the
founding config `bbae68dc`. The second, the same day: core `7e2123d1` with
config `f51759b6`, whose exposure is weighted by the load's heat as §18A.3
writes it (`de2f263d` weighted it by C, which counted a full bed twice);
`de2f263d` stays installed for the free rounds made on it.
The third, the same day (2026-10-04, world grinding): config
`2170f250` (`encodeGameConfigV4`: v3's fields and a world rule) on the same
core `7e2123d1` - one world per round, `round_seed`, shared by every player
of the round (§12). `f51759b6` stays installed for the rounds published on
it (the 10-06 series); the first rounds on `2170f250` are the free pair's
from its roll at 2026-10-04 16:44Z and the 10-07 paid series.

## 27A.8 Hard forks: a successor, not a stranger

Everything so far can only change numbers. New message types, a changed
core, a new unit on the battlefield, a parameter that does not exist yet -
none of it fits, and §27A.5's answer (ship it, adoption is running it) is
honest but incomplete: it cannot carry the network's identity, its bonds or
its history across the change.

And the change genuinely **is** a new network. `genesis_parameters` is
committed in `network_id` (§27A.6), so altering the committee shape, the
beacon or the core is by construction a different network with a different
census. That is a property worth keeping, not a bug to route around.

(Until the fork certificate is built, a new core runs beside the old one
under the same `network_id` instead, by ruling - §27A.7.8.)

So the mechanism does not deny it. It makes the new network **provably the
successor of the old one**:

> `network_id` stops being a value and becomes a **chain**. A successor
> commits to its predecessor, so descent is verifiable by anyone, from
> Bitcoin alone, with no announcement to trust.

### 27A.8.1 The fork certificate

```text
fork_certificate {
  predecessor           network_id(n)
  proposal_id           the ratified UPGRADE proposal
  genesis_parameters    the successor's, in full
  code_commitment {
    source_tree_hash    reproducible-build manifest
    core_wasm_hash      the deterministic core specifically
    toolchain           pinned
  }
  activation_height
  vote_proofs[]         txid + merkle path + block header, per vote
  tally                 turnout and approval, by bonded weight
}

network_id(n+1) = H( genesis_parameters(n+1)
                  || donation keys
                  || predecessor = network_id(n)
                  || H(fork_certificate) )
```

**This is what separates a hard fork from a random fork.** Anyone may copy
the code and launch; what they cannot produce is a certificate whose votes
are in the Bitcoin chain under the predecessor's census. A fork without one
is a **sibling** - a new network starting from nothing, exactly as §27A.4
always said. A fork with one is a **successor**.

**`code_commitment` is why this class exists at all.** Deterministic replay
(§13A) is only meaningful against a known core: two nodes disagreeing about
a transcript must be able to establish that they ran the same code. So the
core's hash is voted on explicitly and reproducibly, and a node verifies its
own binary against it before serving. A change to the core is unavoidably a
hard fork for exactly this reason - old nodes cannot replay new transcripts,
and a replay that cannot be reproduced cannot settle money.

### 27A.8.2 The UPGRADE class

| | turnout | approval | review | voting | cooldown | total |
|---|---|---|---|---|---|---|
| DESIGN | 30% | >50% | 1008 | 1440 | 2016 | ~31 d |
| MONEY | 40% | ≥66% | 1008 | 1440 | 2016 | ~31 d |
| **UPGRADE** | **51%** | **≥66%** | **2016** | **2016** | **4320** | **~58 d** |

A hard fork can change anything, including the thresholds that would govern
the next one, so it carries the highest bar the network has - but the bar is
the **threshold**, not the calendar. Waiting longer does not make an upgrade
safer; it makes upgrading rare enough that the network stops being able to
fix itself, which is its own failure mode.

**What 51% and 66% actually cost an attacker.** Turnout is of all bonded
capital and approval is of the weight that did not abstain, so the floor is
their product: **~34% of the bonded capital can carry a fork** if the rest
stay home. That is the price of a network that can still upgrade itself, and
it is defensible only because §27A.8.5 holds - a fork reaching that bar wins
the *name* and nothing else, while every bond, stake and running round stays
out of its reach. Turnout is the defence that scales with attention: capital
that shows up is capital an attacker must out-weigh, not merely outlast.

**Scrutiny is 28 days, not 14.** Votes may be changed until the window
closes (last vote by height wins, §27A.7.3), so a defect found on day 25 can
still flip an approval that was already cast. The review phase only decides
when counting *starts*; it never stops being possible to react.

**The 30-day cooldown is the one number that is not a preference.** It is at
least `bond_maturity`, so an operator who rejects the fork can let their bond
mature and be entirely out **before activation** - not stuck holding locked
capital in a network they refused. Shortening the cooldown below
`bond_maturity` would make dissent cost money, which is precisely what
§27A.8.3 exists to prevent.

### 27A.8.3 Bonds cross, but only if their operator says so

A successor with an empty census is a successor in name only - every
operator would have to post fresh capital and wait out `bond_maturity`,
which in practice means the network can never upgrade at all.

So bonds carry. A bond created under an ancestor is valid in the census of
network `n+1` when its operator publishes a **re-affirmation**:

```text
OP_RETURN  "ARN"  FORK  network_id(n+1)[0:8]  schnorr_sig(bond key)
           3      1     8                     64                = 76 bytes
FORK = 0x46 ('F'); the signature is the bond's node key over
  taggedHash("ARENA/v1/Reaffirmation", network_id(n+1) || bond_txid || bond_vout)
```

One small transaction, the same shape as a vote (§27A.7.3). It moves no
capital, spends no bond, and starts no new maturity clock. It names no
outpoint: the signature binds it to one bond, and a census tries it against
the ancestor bonds it found, as a tally tries a vote (`reaffirm.js`; it also pays this network's marker dust, so it is findable as
an advertisement update is). The ancestor's bonds are found by the ancestor's
marker and read by its advertisement layout and id (`ancestor.js`); one that
is not re-affirmed is named in the census and not counted.

**It is opt-in, per operator, and that is not a detail.** A vote decides
what the successor *is*; it does not decide whose capital serves it.
Carrying bonds automatically would let a winning majority conscript the
minority into a network they voted against, and a bond is a hostage in
a way a vote is not - it is locked, it cannot be topped up, and it cannot be
withdrawn before maturity.

An operator who re-affirms nothing keeps a bond on network `n`, still
recoverable at `bond_maturity` exactly as before. **Nothing about a fork can
strand capital.**

### 27A.8.4 How a client follows a fork it has never heard of

A client meets a Round Contract naming a `network_id` it does not know. It
asks any node for the fork certificate, and walks:

```text
unknown network_id
  -> certificate -> predecessor
  -> certificate -> predecessor
  ...
  -> the network_id COMPILED INTO THE CLIENT
```

At each step it checks the votes against Bitcoin itself - the proofs are
txids and merkle paths, so this is header validation and nothing else.

**The trust anchor is the client's own built-in `network_id`, never a
server.** A client that has been offline for a year can rejoin across two
forks without asking anybody's permission, and an attacker cannot splice in
a link, because every link needs a ratified supermajority of a census that
existed on chain at the time. This is the same property §25.1 gives discovery: the answer comes
from Bitcoin, so being lied to requires lying about Bitcoin.

A client MAY refuse to follow automatically and ask the player. It MUST NOT
follow a chain whose root it does not recognise.

### 27A.8.5 What a hard fork still cannot do

**RULED 2026-11-07 (spec review, kanban #1301).** This section predates the reserves (§27A.9) and is corrected: reserves follow the guardians, so a reserve output carries the `network_id` it was paid under, and guardian code releases it only for a proposal ratified by that network's census; the ancestor never stops, so both sides run the same rule. A client **MUST** ask (never follow automatically) when the certificate's re-affirmed weight is under 66 % of the ancestor census, a figure that is on chain.

A winning supermajority holds unlimited power over the *rules*. It holds
none over *funds*, and the difference is where the safety of the whole
scheme sits:

- **In-flight rounds are untouched.** A round binds to its `network_id` and
  `config_hash` at creation (§27A.7.5). Activation cannot reach into a round
  that is running, and cannot rescore a `FINAL` result.
- **Stakes are not reachable.** Settlement is stake locks whose claim key is a committee that
  existed under the old rules; a new network cannot sign for an old one,
  because the keys are the old census's.
- **Bonds are not reachable.** They are timelocked outputs with recovery
  paths that a fork does not rewrite. The worst a fork can do is decline to
  count a bond in *its* census.
- **The ancestor does not stop.** Nodes that do not re-affirm keep serving
  network `n` with their census intact.

> **A hard fork cannot steal. It can only leave, and take a name with it.**
> The worst outcome of a hostile supermajority is a split network, not a
> theft - and the split is legible, because both sides have certificates and
> anyone can see which census ratified which.

There is deliberately **no repeal** for an upgrade (§27A.7.6 repeals within
a network; a fork is not within one). It needs none: the ancestor never
stopped existing, so the way back is to keep running it.

### 27A.8.6 Examples of what needs this class

| Change | Why it is a fork, not a config |
|---|---|
| A new unit type - say a helicopter that lifts the truck | Adds state to the simulation. Old nodes cannot replay a transcript containing it, so no committee spanning versions can agree a score |
| Changing the core's fixed-point width, or any `mulFast` rounding | Silently changes every score ever computed. Determinism is the product; this is the sharpest possible fork |
| A parameter that does not exist yet - weather, night rounds, cargo types | `game_config` is a fixed shape and a ballot votes on a complete instance of it; a new field has nowhere to live |
| A new message type in the committee protocol | 5-of-7 must agree on what a message *is* before it can agree on its contents |
| Changing the committee shape, or the beacon | `genesis_parameters` - immutable by construction (§27A.6) |
| Replacing the Bitcoin beacon with something else | Same, and it changes what "unpredictable" means for sortition |
| Moving the bond script template to a new Taproot layout | Old and new bonds are not comparable capital; the census would be counting two different things |

And, for contrast, what does **not** need it: damage numbers, round length,
bracket sizes, the score curve, the node fee, the army's speeds. All of that
is §27A.7, because none of it changes what a transcript *is*.

---

## 27A.9 Protocol reserves and project funding *(2026-10-16; SPEC LOCKED, not yet built)*

The network gets a fund of its own, the **protocol reserves** - a DAO treasury that no single key
spends. Every paid round pays into it; the bonded nodes decide, in two stages, what it pays out.

### 27A.9.1 The split *(RULED 2026-10-16)*

A paid round's 10 % of the gross stake (§0A.8) is split anew:

| | today (§0A.8) | from the reserves version |
|---|---|---|
| nodes (three pools, §22A) | 5 % | **4 %** |
| developers: protocol + game (half each, as today) | 5 % | **4 %** (2 % + 2 %) |
| **protocol reserves** | - | **2 %** |
| net stake | ≥ 90 % | ≥ 90 % |

**The whole split is mandatory** *(LOCKED 2026-10-16)*: nodes 4 %, reserves 2 % and the
developers' 4 % (2 % protocol, 2 % game). The developers' share is no donation on this version, and
the player cannot lower it; §0A.8's lowerable 5 % does not carry into it.

An in-game item (§0A.9) pays **40 % nodes** and **20 % protocol reserves** of its
list price, both mandatory, and the **developers' share the player chooses: 40, 30, 20, 10 or 0 %**
(protocol + game, half each) *(2026-10-16: "yes it's 40 30 20 10 0"; it replaces 's
50-0 % on this version)*. As in the developers' share is added on top: the player pays
60 % + the chosen share of the list price - 100 % at the default of 40 %, 60 % at 0 %.

The new split is a protocol version: rounds of a game version that requires it carry it, older
rounds keep theirs ("updates before feature freeze": versions run side by side).

**Rounding, as built** *(`arena-protocol/src/reserves.js`, protocol version 11 -
`RESERVES_VERSION`, not yet spoken)*: every share is floored to the msat; a round's net stake takes what
the floors leave, so the parts sum exactly to the gross. An item's developers' share is split half to the
protocol developers (floored) and the rest to the game developers, and its price is the sum of its parts:
a 100 sat entry pays nodes 4,000, protocol devs 2,000, game devs 2,000, reserves 2,000 and keeps 90,000 msat; a
500 sat item costs 500 sat at the 40 % default (nodes 200, reserves 100, devs 100 + 100) and 300 sat at 0 %.

### 27A.9.2 Where the reserves are, and how they are seen

- Each paid entry's reserve share is an output of its own in the entry's federation, like a donation
  output (§22A): amount = 2 % of the gross stake, floored to msat; an item purchase's reserve output
  = 20 % of its price.
- **Custody: the federations' guardians** *(2026-10-16: "Guardians. Multiple federations. When
  one federation is drained it is automatically moved to a healthy one"; this replaces the earlier
  custody (a))*:
  - The reserves are held in the federations themselves, in each federation where entries paid
    them. The federation's guardians release them, by their own threshold, only for a payout that
    names a passed proposal (§27A.9.3).
  - There may be several federations; `GET /reserves` shows the reserves per federation and their sum.
  - **When a federation is drained** (§23A: draining, succession, liquidation), its reserves move
    automatically to a healthy federation, as the players' funds do. No vote is needed for that
    move; it is recorded on every node like a payout.
- **The move, as built** *(2026-10-17 decision A)*:
    - **Trigger** (every seat, from its own verified records): federation X is DRAINING or CRITICAL and still holds unspent reserves.
      A HALTED federation waits; its notes are frozen.
    - **Destination:** X's successor when it is OPEN with a reserve key, else the lowest-id OPEN federation with one. No healthy
      federation means no move.
    - **Steps:** X's 5-of-7 pays, as a payout of kind `move`:
      - the amount is all of X's unspent reserves less the fees, with no change output;
      - the invoice comes from a gateway of Y for an incoming contract whose claim key is **Y's reserve key**, its preimage
        the hash of the move's own seed (stake-lock tool `--mode receive-to-key`);
      - every X signer reads that contract through its own port before it signs;
      - then Y's 5-of-7 claims it into a reserve output (`--mode claim-incoming`, FROST-signed).
    - **Recorded** on every seat (state CLAIMED). `/reserves` shows X at 0 and Y up by the claim.
    - **Not built:** a move out of a HALTED federation, splitting over destinations, a re-try after a refund.
- **The reserve output, concretely** *(slice 3 plan)*: in the entry's ONE lock transaction
  (FEDERATION.md "Donations in the federation"), beside the stake lock, the fee lock and the developers'
  outputs, one **reserve lock**: an LNv2 contract with `claim_pk` = `refund_pk` = the federation's
  reserve key (§27A.9.2, the 5-of-7 key of its guardian seats, `GET /reserves`) and an expiry far beyond
  any round (a refund to the reserve key itself, so the money never leaves the reserves' control).
  - The Entry Contract on version 11 names the reserve outpoint beside the donation outpoints.
  - A signer node takes such an entry only if the federation holds that output, to that federation's
    reserve key, for exactly `roundSplit(gross).reservesMsat`, as it refuses a wrong stake lock.
  - On version 11 the developers' outputs are the mandatory 2 % + 2 % (no `donation_bps` to lower) and
    the fee lock is 4 %.
  - An item purchase on version 11 carries its reserve lock (20 % of the list price) the same way.
  - **As built for items** *(2026-10-16: "Go" on (A))*: a game version decides an item's terms.
    - A version whose manifest requires protocol 11 (Tick Tock v4, 76f50510…, v3 in every other term) sells its items on the
      reserves' terms: nodes 40 % (equal per served node, floored), **exactly 20 % to the payment federation's reserve key as
      one output**, and the developers' 40/30/20/10/0 % over the two donation sets. An older version keeps 's terms.
    - The purchase record is written as **layout 12** (a record layout, not a protocol version). It names the share, the game
      version's id and the reserve key it paid (`purchaseOutputsReserves`, `purchaseStands` in `purchase.js`).
    - A seat checks the record against that version and against the federation's reserve key it holds. A record on the old
      terms is checked only against a version selling on them.
    - Once kept, every output has been checked with the federation. The reserve output is then kept as a reserve row (the
      purchase id in the entry's place, `item` = "game · item id"), so `GET /reserves` counts it.
    - The page pays nothing before five of the game's nodes name the federation's reserve key. Its share choices and prices
      follow the terms of the version the shop sells from.
  - A round is published at version 11 only for a federation whose reserve key is made.
- Each round's dashboard shows what the round paid in.
- Every node serves `GET /reserves`: the total held, by federation, the last rounds' payments in,
  and every payout with the proposal that decided it - all from its own store, as `/donations` is.
- testnet.bitcoinarena.io shows the total and the latest payments in and out.
- **As built** **:
  - `GET /reserves` answers `totalMsat` and `entries` over all federations, the newest 50 payments in (`paidIn`), and per
    federation its `reserveKey`, `heldMsat`, `entries` and `paidIn`. With `?all=1` it lists every payment in.
  - `payouts` stays `[]` until payouts are built.
  - The figures are the seat's own rows under the federation's reserve key: those it kept at a lock (slice 3), and those it
    took from other seats. A row from another seat is kept only after this seat's own port into the federation holds that
    payout contract to the reserve key for exactly that amount. This is the same check `/lock` makes, done every 2 min,
    in `arena-node/src/reserve-book.js`.
  - So every seat that reaches the federation comes to the same total.
  - The node dashboard's round list has a Reserves column: what each round paid in.
  - bitcoinarena.io shows the reserves' live total under the fees (Economics), with its payments in and how many nodes agree,
    once five nodes name the same total *(2026-10-17: "Find a prominent place on the website ... Under the fees")*. The
    Arena games screen no longer carries a reserves box (2026-10-17: "no need to show the details").

- **What a slash pays in (RULED 2026-11-02, kanban #976).** The rest of a slashed bond (§5A.3, §23A.5)
  enters as a reserve output, shown as `slash` in `GET /reserves`, and is spent only as any reserve is.
  - It is on-chain money entering federations, so it counts in their load (§23A.3). It is **spread over every OPEN
    federation with a reserve key**, so that no single one takes it all: the lowest load is filled up to the next
    one's, then both together, and so on, none past 80 %. With loads of 20, 40 and 70 %, the first takes it up to 40,
    the first two up to 70, then all three up to 80.
  - Every seat computes the same parts from the federation records at the release's height. One escrow spend pays
    them, one peg-in each. A part too small to peg in joins the largest. An escrow spend reads the records in force
    at the height it names in its `outputs[]` (RULED 2026-11-03, kanban #1085, §5A.3B "The escrow spend").
  - What does not fit stays in its escrow and enters when a federation has room. A slash never closes a federation
    to deposits.
  - A network with no reserve key yet keeps it in the escrow until there is one.
  - **As built (kanban #978):** the arbitration set reads the federations from its seats (`GET /federations`, `GET /reserves`) and
    takes only what more than half of those that answered name alike. `slash-reserves.js` computes the parts. Fees come off the escrow, so off the
    reserves' part, and a loss stays whole while the bond covers it. A federation a ruling closed to new peg-ins (`ARENA_ARBITER_RETIRED`) takes no
    part, and a loss in it is still paid there. The real loss needs five FINAL signatures on the false run (`GET /audit-run`): a seat cannot say a
    run settled by saying so. A seat keeps a slash's reserve row from the set's signed event, once its own port holds that payout contract.

### 27A.9.3 Project funding proposals

A **project funding proposal** is a forum post with threads:

- `purpose` (free text: what the money is for);
- `amount_sats` (X) and `lnurl` (where X is paid);
- `author`: **any key**, which signs it - a player, a developer or a node *(2026-10-17: "Anyone can do a proposal to
  pay out, doesn't have to be the dev"; it replaces "a bonded node's key")*. The proposal may pay anyone's LNURL.

Anyone - node or player - may comment, in threads; comments are signed by their writer's key and
carry no weight in any count.

**Stage 1 - the signal (1 week, 1008 blocks).**
- Anyone may post a proposal; the seats keep any one that its author's key signed.
- Nodes signal support.
- It passes when the nodes supporting it are **at least 15 % of the nodes active in the 72 hours
  (432 blocks) before** its signal period ends.
- **An active node** *(LOCKED 2026-10-16)* is a node that served a round in those 72 hours;
  nodes are counted one each, not by bond.
- This filters and starts the discussion; nothing is paid on a signal.
- **As built** *(2026-10-16: signals are "signed messages kept and passed on by the seats. Not on-chain
  signals"; the spec timings are the rule on testnet4 and mainnet)*:
  - `FundingProposal` { network_id, author, published_height, amount_sats, lnurl, purpose } (type 0x2e), signed BIP340 by its
    author. A seat keeps it when its signature stands and it is not dated ahead of the seat's chain; the author may be any key
    (2026-10-17; until then only a bonded node in the seat's census).
  - `FundingComment` { proposal_id, parent_id, author, at_height, text } (0x2f), signed by anyone.
  - `FundingSignal` { proposal_id, node, at_height } (0x30), signed by a bonded node.
  - `PlayerName` { network_id, player, at_ms, name } (0x31), signed by the player's identity key *(2026-10-17: "Have custom
    names in the protocol")*. `name` follows the lobby's rule (1-24 letters and digits, with space, dot, dash or underscore between);
    empty means the name made from the key. A seat keeps the newest per player and refuses one dated more than 10 minutes ahead
    of its clock; `GET /funding` serves them as `names`. A page checks each signature itself, so a node can leave a name out but
    cannot write one. `arena-protocol/src/player-name.js`.
  - `arena-protocol/src/funding.js` holds these objects, the window and the rule; `arena-node/src/funding-book.js` is the seat's
    store and decision.
  - Seats keep them (`funding_items`) and hand each new one on to every seat once: `POST /funding` { kind, hex },
    `GET /funding`.
  - A node's owner posts, signals or comments through the owner doors `/owner/funding-propose`, `-signal` and `-comment`. The
    node signs with its own key.
  - The signal runs [published_height, published_height + 1008).
  - Once it is over, each seat decides it **once** and writes the outcome down:
    - the active nodes are those whose signed FINAL falls in [median time(end − 432), median time(end)), read from every
      seat's FINALs;
    - a signal counts once per node, inside the period, from an active node;
    - the proposal passes at supporters × 100 ≥ 15 × active.
  - `ARENA_FUNDING_SCHEDULE=short` (a 1-block signal) is only for the live end-to-end proof on the throwaway T federation.

**Stage 2 - the vote (2 weeks, 2016 blocks).**
- A proposal that passed its signal goes to a vote of the bonded nodes, **weighted by bond**.
- The votes are Bitcoin transactions, as §27A.7.3's: `OP_RETURN`, signed by the bond key, YES / NO /
  ABSTAIN, the last one by height counts.
- Eligible: the bonds active at the start of the vote (snapshot), and of those only bonds **3 months old and locked 3 months
  past the vote**, weighted by their age (§27A.9.5 rules 1, 2).
- ~~**Turnout** *(2026-10-16: "30%")*: at least 30 % of all bonded capital votes.~~ *Replaced 2026-10-17 by §27A.9.5
  rule 3: YES at least 20 % of everyone who could vote.*
- **Passes at 60 %** *(RULED 2026-10-16: "Voting threshold is 60%")*: YES holds at least 60 % of
  the bond weight that voted YES or NO (ABSTAIN counts for turnout only).
- Comments continue.
- **As built** *(2026-10-17: "The vote is the next slice. Use the sequence you just wrote")*:
  - Only a signal a seat decided **passed** opens a vote. It runs [signalEnd, signalEnd + 2016), with signalEnd = published + 1008.
  - **The census** is the bonds active at signalEnd: #329's `censusAt`, taken once and kept. Each bond weighs its amount.
  - **A vote** is 's 77-byte OP_RETURN "ARN" 'V': proposal_id[0:8], YES / NO / ABSTAIN, and the bond key's BIP340
    signature over (proposal id, choice).
    - It counts only inside the period.
    - Per bond, the last vote by height counts; a tie in one block goes to the lower txid.
  - **Passes** when turnout ≥ 30 % of the snapshot's bonded capital and YES ≥ 60 % of YES + NO. ABSTAIN counts for
    turnout only.
  - **Reading:** each voting block is read once for the proposal's votes and held to by its hash. A reorg of held blocks
    reads them again.
  - **Deciding:** a seat decides once the last voting block (signalEnd + 2015) is 6 deep, counting the block itself, as
. It writes the outcome once with that block's hash: YES / NO / ABSTAIN / total sat, turnout %, approval %, bonds
    voted.
    - Later votes, a later census or more blocks do not move it.
    - A reorg that replaces the counted last block reopens it.
  - `GET /funding` shows each proposal's `vote`: its period, the census height, the blocks read, the running count and the
    outcome.
  - Code: `funding.js` (votePeriodOf, fundingTally) and `funding-book.js` (voteRound).

**Payout.**
- Once the vote passes, X sat leave the reserves to the proposal's LNURL.
- The payout is recorded beside the proposal on every node.
- One payout per proposal.
- A proposal larger than the reserves at payout time pays nothing and says so.
- **As built** *(2026-10-17: "Accepted: the 5-of-7 LNURL payout you just wrote. Build that slice.
  No new fork.")*, in `arena-node/src/reserve-payout.js`:
  - **Who signs:** the seven guardian seats of the federation that holds the reserves (its reserve key's DKG shares); any 5 of
    7 sign.
    - The lowest-key guardian coordinates; the next takes over after 2 blocks of silence.
    - The other seats check what they are told and record it.
  - **Which federation pays:** the lowest federation id whose unspent reserves cover X plus fees.
  - **One payout plan per proposal:**
    - the reserve outputs it spends (oldest first, no more than X plus fees needs);
    - an invoice for exactly X sat from the proposal's LNURL (LUD-06/16: amount and description hash checked);
    - the lowest live gateway;
    - the outgoing contract to the invoice (output 0) and the change back to the reserve key (output 1).
  - **Signing:** every signer rebuilds the plan from its own records and refuses anything else. Two 5-of-7 BIP340 signatures
    under the reserve key: the federation transaction (`settle`, the inputs spent by `refunds`) and the invoice's consensus
    hash the gateway checks (`send`).
    - A nonce pair signs one list once. A coordinator that takes over gets fresh nonces.
  - **Allowed** only when that seat's own record has the vote decided passed, no payout record exists for the proposal, and
    that federation's unspent reserves cover X plus the federation's and the gateway's fees.
  - **States:** PLANNED → SENT (accepted) → PAID (the preimage checked against the invoice) or REFUNDED (the gateway did not
    pay; the expired contract was spent back to the reserve key). SHORT: the reserves cannot cover it; nothing is paid, for
    good.
    - A silent LNURL or a wrong invoice signs nothing, and the next pass asks again.
    - *(2026-11-06, kanban #1159)* A seat's own steps: SUBMITTING (the signed transaction kept before it goes in), REFUNDING
      (the same for the refund), EXPIRED (a plan with no transaction 12 blocks after the seat first held it).
    - After a stop, a SUBMITTING or REFUNDING seat hands in the same transaction again, or finds its output 0 held.
    - A plan expires only when the seat's port shows every input unspent. Its inputs are then free, and the next attempt
      is a new plan with its own nonce.
    - Only the guardian whose turn it is opens a plan (one turn per 2 blocks, in key order, starting again after the last).
      Every commit and share it asks for is signed by its node key. A plan a seat already holds goes on with any guardian.
    - The invoice's, gateway's and expiration's window is checked once, at the seat's first commit.
  - **Records:** one record per proposal on every seat (`reserve_payouts`). A second plan for a proposal is refused, and a
    spent output is never planned again.
    - *(2026-11-06, kanban #1156)* A record handed to another seat is signed by the sender's node key. A seat keeps it only
      from a guardian seat of the federation whose step it is (the destination's for a move's claim).
    - SHORT is kept only when the seat's own reserves cannot pay either. A step past PLANNED is kept only when the seat's
      own port shows the plan's transaction and its spent inputs (a seat with no port keeps the signed record and the
      preimage).
    - Every write is one compare-and-set step along one transition table. The inputs and the rows it makes (change, refund,
      winners, claim) go in the same step. A kept row is never replaced by one with other fields.
  - **Shown:** `GET /reserves` lists `payouts` and no longer counts spent outputs; `GET /reserve-payouts`.
  - **Not built:** a re-try after a refund, a payout split over federations, giving up on an LNURL silent for days.

### 27A.9.4 Decided *(2026-10-16)*

1. Turnout: at least 30 % of all bonded capital must vote, or the vote fails and nothing is paid.
2. On this version the whole round split is mandatory: nodes 4 %, reserves 2 %, developers 4 %
   (2 % protocol, 2 % game). The developers' share is not a donation the player can lower.
3. Items: nodes 40 %, reserves 20 %, developers 40 / 30 / 20 / 10 / 0 % as the player chooses
   (replacing 's 50-0 %).
4. Custody: the federations' guardians, in several federations. A drained federation's reserves move
   automatically to a healthy one.
5. An active node for the 15 % served a round in the last 72 hours, counted one per node.
   *Superseded 2026-10-17 by §27A.9.5 D6: served rounds in 3 of the last 4 weeks, with a seasoned bond.*

### 27A.9.5 The hijack defences: five rules *(LOCKED 2026-10-17: "Make it 3 months", "older nodes that have been longer in the game can get a factor that increases their weight", "It needs to be more simple so people understand it" - comment 2820, "Yes and document it"; it replaces D1-D6 of comment 2819)*

**The attack they close:** anyone may propose a payout to themselves (§27A.9.3). Without these rules an attacker bonds a lot of
bitcoin after seeing the proposal, votes YES, takes the payout and unbonds when the ~30-day bond lock ends: about 5 weeks of parked
capital for all of the reserves.

| # | Rule | Numbers (blocks) |
|---|---|---|
| 1 | **Who votes:** a bond at least **3 months old** when the proposal is published, **not spent before `last + lockAfterVote`**: a bond spent earlier has its vote voided after the fact (chain state, every seat computes it), and the denominator of rule 3 is **every** seasoned bond, not the long-locked ones *(RULED 2026-11-07, kanban #1299: the old "stays locked" rule made the electorate whoever chose a multi-year lock, so an attacker's long bonds could be 100 % of rule 1's weight)*. | `season` 12,960; `lockAfterVote` 12,960 |
| 2 | **How much it counts:** bond sats × **age factor** at publication: **1×** under a year, **2×** from one year, **3×** from two. Old nodes outweigh new money up to 3 : 1. | `year` 52,560 |
| 3 | **When it passes:** **60 %** of the votes cast (YES of YES + NO; ABSTAIN counts for neither) say YES, **and** YES is at least **20 % of everyone who could vote** (the total weight of rule 1's bonds). | |
| 4 | **How much it can take:** one proposal at most **10 %** of the paying reserves; all payments in **3 months** at most **25 %** of what the reserves held at the window's start. Over its own cap a proposal is never paid; a payment over the window cap waits. | `capWindow` 12,960 |
| 5 | **Time to say no:** nothing is paid for **2 weeks** after the vote's last block. A stop needs the floor a pass needs: the NO weight up to that payment is at least **20 % of rule 1's weight**, so a revolt stops a payout and one late NO does not *(RULED 2026-11-07, kanban #1311)*. Rule 4's caps are read against the federation record's threshold-signed reserve figure, the one read every seat shares. Every payout goes in **4 monthly parts** of a quarter each, the odd sats in the last; a proposal under 4 sat is one part *(RULED 2026-11-06, kanban #1198: it was "above 1 % of the reserves", but no reserve figure is read the same by every seat, so two seats named different tranche ids for one proposal; the count now follows the proposal's amount alone)*. Each payment is due at `last + delay + k × trancheEvery` and is paid only when that block is 6 deep **and a re-count of every vote up to it still passes rule 3**: a new NO, or a YES turned NO, stops that payment and every later one, for good. | `delay` 2,016; `trancheEvery` 4,320 |

**The signal** counts only active nodes: a bond 3 months old (rule 1's age) and rounds served in **3 of the last 4 weeks**
(`week` 1,008).

**As built** *(`arena-protocol/src/funding.js`: `voteWeights`, `ageFactor`, `fundingTally`, `capStands`,
`trancheSchedule`, `activeInWeeks`; `arena-node/src/funding-book.js`: `payments`)*:
- The vote's census keeps each bond's confirmation height and its advertisement's `bond_maturity` (template 2). A bond without one
  has no vote.
- "Age" is the age of the node's current bond. An advertisement update keeps it; a new bond starts again at zero.
- A passed vote is read on through its last payment's due block.
- **The number of parts is the same on every seat** *(kanban #1175, 2026-11-06; awaiting a ruling)*: every payout goes in 4 parts,
  an amount under 4 sat in one. The count was the amount over 1 % of the reserves the seat held at its first ask. Seats hold different
  reserve rows, so they named different part ids and a payout plan was "no passed vote" at its peers. No figure of the protocol
  reserves is read alike by every seat, so rule 5's 1 % is not applied. Each part is its own payout (id: the proposal's for a single
  payment, else a tagged hash of the proposal and the part). A row the old rule fixed is set right while no part is payable yet, and
  rule 4 counts a proposal's payouts under either id. A cancellation is kept once (compare-and-set) and never moves.
- A stopped proposal keeps listing the parts due before the stopping one, so their records still stand on every seat.
- The payout's signers apply the same caps and re-count to their own records before they sign. A seat without the chain tip pays
  nothing.
- The short schedule of a live proof (the T3 federation) scales these: season 24, lockAfterVote 48, year 72, delay 6,
  trancheEvery 6, capWindow 144, week 108.
- **Known limit (fail-safe):** a seat finds bonds by scanning blocks, 2,016 back from a census height after a restart
  (`CENSUS_LOOKBACK`). A bond older than its scan is not in its census, so it does not vote and is not counted in "everyone who
  could vote". Votes lose weight this way, never gain it.
  - No vote can pass in a network's first 3 months.
  - Mainnet needs a bond index before rule 1 can be met after restarts.

**On bitcoinarena.io** *(2026-10-17: "Add a Project Proposals section to the website where people can comment and
review")*:
- A **Project proposals** section lists every proposal five of the testnet's nodes hold, with its stage and every comment, threaded.
- A visitor comments, replies or proposes with their own key: an nsec, or a key that browser keeps. The page builds and signs the
  same `FundingComment` / `FundingProposal` the seats read (`arena-client/src/funding-page.js`, the Arena page's bundle) and hands
  it to every node (`POST /funding`).

**Project improvement proposals (PIPs)** *(2026-10-17: "Project improvement proposals, PIP. Each item set to vote are prefixed
with PIP. Users can sign in with their ingame key and their custom name or their generated name")*:
- The forum is its own page beside the Arena: testnet.bitcoinarena.io/proposals.
- Every proposal five nodes hold is a **PIP-N**, numbered by publication: published block, then id. The earliest is PIP-1.
- A player signs in with their **in-game key**: the identity key of their wallet seed, the key the lobby and the board use. An
  nsec or a new key also works.
- Everyone is shown by name: their `PlayerName`, else the name made from their key. A name set in the game's Settings or on the
  forum is signed and handed to every node.
- A PIP has three parts *(2026-10-17)*: a title, what it does (Markdown, tables included), and how it improves
  Bitcoin Arena (its games, protocol, tools or players, not only the protocol). They are kept in the proposal's one signed
  `purpose` (at most 4,000 characters) as the title line, the content, and a last section `## How it improves Bitcoin Arena`. The
  forum renders the Markdown safely: no HTML a writer types reaches the page.

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
| 3+ settlement nodes down | Settlement delayed; unclaimed stake locks expire → refund to the player's key |
| A gateway down or refusing | Client uses another listed gateway; a gateway cannot keep a payment |
| Federation halted below its threshold | Every lock frozen, refunds included — the stated residual (§22) |
| No block after `committee_time` within the grace period | The entry window never opens — no stake was committed, so nothing needs refunding |
| Census roots in a contract do not match the chain | Contract invalid; no node issues receipts; no entry possible |
| Client's chain view is wrong (bad header source) | If the forged view is also the contract's, the player locks to the forger's committee and loses the stake — the corrected statement of §5A.4. Prevented only by verifying headers from ≥2 independent sources (§25.1); a mismatch between an honest view and the contract fails the entry safely |
| Arbitration set inactive | No slashing; deterrence lost. Rounds settle and refund normally; bonds recoverable by the node after `bond_maturity` |
| Arbitration set slashes without a valid proof | Templates 1 and 2: bond stolen from that node. Template 3: no money moves without the round's two panels before `slash_fallback_blocks`, and their signers are slashed; after it the census key alone can release. Publicly provable from the committed proof hash; player funds untouched (arbitration cannot reach stakes) |
| Lightning payout route fails | Retry within the claim window |
| Website compromised | Wallet approval still required; hashes/mirrors; donation cap limits the damage |
| 5 game/verify nodes collude **and** the victim's transcript is unavailable | Residual result-integrity failure; five bonds slashable afterwards |
| 5 settlement nodes collude | Residual settlement failure on in-transit funds; five bonds slashable from `NAMED_CLAIM_HEIGHT` (the claim names its signers, kanban #1131); before it the FROST signature names nobody and no bond is at risk |
| A passed config makes rounds unplayable | Nodes decline to serve it; those rounds find no committee and never start. Repeal runs on the short schedule (§27A.7.6). No pause exists and none is needed |
| Config activates mid-round | Cannot happen: a round is bound to the `config_hash` it was created under (§27A.7.5) |
| Operator API token stolen | At worst a wrong vote. No token can spend a bond or reach player funds (§27A.7.7) |
| Governance turnout below the floor | Proposal fails. The config in force is unchanged, which is the safe direction |
| Hostile supermajority passes a hard fork | The network splits; it is not robbed. In-flight rounds, stakes and bonds are all out of reach of a successor (§27A.8.5), and the ancestor keeps running for whoever does not re-affirm |
| A fork is launched with no ratified certificate | It is a sibling network starting from an empty census, not a successor. Clients cannot walk it back to a root they recognise and will not follow it (§27A.8.4) |
| Operator declines to re-affirm after a fork | Keeps serving the ancestor; bond recoverable at `bond_maturity` as always. No vote can conscript a bond onto a successor (§27A.8.3) |

No cell leaves funds in an undefined state, and no cell erases a `FINAL`
result.

---

# 29. What was intentionally removed from earlier versions

From an earlier draft: separate sequencer network, time-witness network, DA network,
verifier network, backup sequencer committees, multiple settlement profiles,
complex finality certificates, mandatory rolling entropy, multi-layer quorum
failover.

From an earlier draft (removed since): the **stateful rotation cursor**, because it
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
9. **No node holds player funds between rounds.** Money is in flight during
   a round and nowhere else. Session balances, deposits, wallets, credit and
   any other resting float are out of scope permanently (§24A.3) — not
   deferred, not optional, not behind a flag.
9. No central internal player balance.
10. `FINAL` losses cannot later become refunds due to an infrastructure attack.
11. One public `arena-node` package for all roles.
12. 5% node fee (Bitcoin Arena; 2% under BLWP) distributed deterministically to eligible selected slots and guardians.
13. Developer donation optional at protocol level and possibly 0%.
14. No privileged developer admin key.
15. **Committee seed from randomness published after the round_id** (§5A.5).
16. **Mandatory bonds with objective slashing** (§5A.3).
17. **Self-dealing is priced and overturnable, not declared:** 5 of 7 bonded slots (§5A.6) and replay inside `W` (§13A); a player declares no operator (§5A.13).
18. **Refund-by-default custody: doing nothing returns the stake** (§23).
19. **An objection window in which anyone can overturn a result by replay** (§13A).
20. **Explicit equivocation and no-quorum rules** (§13B, §13C).
21. **The census is chain state, and eligibility uses objective criteria only** (§5A.2–5A.4).
22. **Selection weight is linear in the bond** (§5A.6) — square-root or any
    concave weighting rewards splitting a bond and must never be used.
23. **Committees are fixed before any stake is committed** (§5A.5, §9, §23.1).

Items 15–23 were added by the security reviews.
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
Can anyone download/run arena-node?       YES
Can nodes enable either/both roles?      YES
Can existing rounds finish?              YES
Can stakes be refunded if nothing runs?  YES (stake-lock expiry, §23), while
                                         the federation itself runs (§22)
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

# 34. Scalability and the replay budget

Player financial worlds are independent, so nodes replay players
individually and networking scales per player, not full-mesh.

Every committee member replays **every** run of its round — that is the
service the node fee pays for, and sampling would weaken exactly the property that
makes a quorum meaningful. The consequence is a hard capacity relation
rather than an assumption:

```text
max_players_per_round
=
(measured_replay_speed x result_window) / T_run
```

Example with `T_run` = 82 s and the 600-second result window: at a measured
30× realtime the ceiling is 219 players per committee node; at 60× it is
439. The window is fixed (WINDOW-10-SPEC), so rounds larger than that
require a faster core or per-node partitioning of the replay set — a design decision to be
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
- the Bitcoin block after `committee_time` for committee selection and
  round randomness — miner influence bounded by the block reward against
  the stake ceiling (§5A.5);
- their client's view of the Bitcoin chain for the census (§5A.4) — **not
  bounded**: a forged view that matches a forged contract hands the stake to
  the forger, which is why paying rounds need headers from ≥2 independent
  sources (§25.1);
- for slashing *deterrence only*, the arbitration set (§5A.3B) — it can
  never touch a player stake, and the protocol settles and refunds correctly
  without it;
- fewer than 5-of-7 selected seats being malicious **or** at least one honest
  party holding their receipted transcript; from protocol 2 one set of 7 holds
  both roles (§5A.9), so this is one condition, not two independent ones.

For a player to be paid, as distinct from not being robbed, at least 5 of the 7
must also answer: 3 silent seats stop an entry or a round, and a losing friend
gets a free bet (§22, P6).

A player does **not** need to trust: one official website; one lobby; one
authoritative game server; one result server; one payout operator; another
player; a house bankroll; the round creator (who influences neither
committee nor outcome).

---

# 35A. Threat model — the cases that changed

| Threat | Capability | earlier draft | this protocol |
|---|---|---|---|
| Committee grinding via chosen `round_id` | Offline hashing | **Total theft**, undetectable | Impossible without predicting the beacon (§5A.5) |
| Free Sybil into the census | Register many nodes | 24–30% of rounds controllable at zero cost | Bond per identity; √-weighted selection makes splitting pointless (§5A.3, §5A.6) |
| Player runs the nodes of their own round | Operate nodes | Self-signed wins | 5 of 7 bonded slots needed (§5A.6); anyone overturns a false result by replay (§13A); no declaration is asked (§5A.13) |
| Colluding quorum signs a false loss | 5 bonded operators | Unappealable | Anyone can overturn it by replay within `W`; signers slashed (§13A) |
| Colluding quorum **inflates a score** rather than faking a win | 5 bonded operators | Not considered | Same objection path: the canonical transcript replays to one score only; a table that does not equal `F(...)` is slashable (§13A, §20) |
| Player runs multiple forks and submits the winner | Modified client | Undefined handling | Automatic forfeit on proven equivocation; receipt gossip surfaces it (§13B, §10) |
| Committee disagreement | Node faults | Funds stuck, undefined | `VOID` + refund, or forfeit if caused by equivocation (§13C) |
| Who holds the stake during the round | — | **Unspecified** | A stake lock in the federation; refund is the default; movement needs a quorum signature + preimage shares; no pool wallet (§23) |
| Guardians collude, or the federation halts | Guardian threshold | Not considered | Guardians are independent bonded census operators; the round names its federation; exposure capped; no unilateral exit is a stated residual (§22, §23.6) |
| A gateway withholds a deposit or withdrawal | One gateway | Single-operator endpoint | Atomic payments: it cannot keep money; the client falls back to another listed gateway (§23.6) |
| **Loser deals shares of the wrong secret**, reconstruction fails, the lock expires to him | Any player | Undetectable with a hash: Feldman proves consistency, not the preimage of sha256 | `stake_point` is a point and Feldman's `A0` must equal it; a seat refuses the entry otherwise (§23.1) |
| **Lying client sets the refund or payout key** | Compromised web host | Refund went to the paying wallet by construction | Key from the player's seed with a visible fingerprint; known-good client hash for paying rounds; NWC budget (§24) |
| **A seat serves its own key as `claim_pk`** | One settlement seat | Not considered | `claim_pk` valid only with ≥5 seats' signatures (§23.1 step 0) |
| **Player builds a lock with a short expiry or wrong fields** | Any player | Not considered | STAKE_COMMITTED only after ≥5 seats verified every field via the contract id (§23.1 step 5) |
| **Three seats stall settlement** so losers are refunded | 3 settlement seats | Listed as delay only | Not slashable: silence is not signed bytes (§5A.3). **Closed from `NAMED_CLAIM_HEIGHT`:** after `stall_blocks` four named seats pay the FINAL's settlement (§23.2, kanban #1268, #1290), so three quiet seats return nothing; four quiet seats are the priced residual of §5A.3. Open only for stock-lock rounds before that height (§22 P6) |
| **Five seats sign a settlement with no ack behind it** (an off-table claim) | 5 settlement seats | Not considered | Before `NAMED_CLAIM_HEIGHT` the FROST signature names nobody, so no bond is at risk (§5A.3, "only bytes the accused signed"). From the height the claim names its five signers and offence (a) of kanban #1131 takes their bonds; measured on regtest (s48a): all seven seats filed against exactly the five, five slash starts, the round settled on F′ (kanban #1146) |
| Compromised web host sets a huge donation | Serve a lying client | Uncapped | Capped at 100%, second confirmation above 5% (§22A) |
| Round with a backdoored simulation core | Publish a round | Player trusts the hash blindly | Client refuses unknown `sim_wasm_hash` for real money (§5) |
| **Census divergence** — participants disagree on who is eligible | Selective gossip, withheld advertisements | Committee disputes, ungrounded rounds | Census is chain state at `census_height`; subjective criteria removed; outpoint ordering is unmineable (§5A.2–5A.4) |
| **Bond splitting to buy selection** | Split capital across identities | An earlier draft's √ weighting **doubled** an attacker's weight when splitting | Linear weighting: same capital, same total weight; control cost is capital share (§5A.6) |
| **Identity mining for a low ticket** | Grind `node_pubkey` | Favourable sort/ticket position | Tickets and ordering derive from the bond **outpoint**, which cannot be chosen after funding (§5A.4, §5A.6) |
| **Entry before the committee exists** | — | Shares encrypted to an unknown set; stake at risk under a committee the player never saw | Structurally impossible: entry opens at `committee_time`, and the Entry Contract cannot be built earlier (§9, §23.1) |
| **Arbitration slashes without cause** | k-of-m arbitration keys (template 3: 2/3 of bonded capital) | Bond theft from an honest node | Template 3: a fixed hold output and two drawn panels per round (§5A.3B). Slash must commit to a retrievable proof; unilateral recovery at `bond_maturity`; arbitration is disjoint from committees and cannot reach stakes (§5A.3B) |
| **Operator playing his own round** | Anonymous operator | Self-signed win | The 5-of-7 capital requirement (§5A.6) and the replay objection (§13A) stop it; a player declares no operator (§5A.13) |
| DDoS after a loss is final | Network attack | Already handled | Unchanged: `FINAL` results survive (§14) |
| **Round grinding by mass publication** — publish many contracts, promote the one whose committee is yours | Any creator with census share | Free: timestamp receipts cost nothing and any five nodes could backdate them | `publication_txid`: the contract's hash in a block before the beacon block; every candidate costs a transaction, ordering is objective (§5A.5, P1) |
| **Self-dealing quorum never publishes its transcript** — nothing to replay, objection impossible | Player running 5 game/verify slots | Result `FINAL` on five signatures | `FINAL` only after ≥5 settlement seats retrieved and posted the transcript to `publication_relays[]`; `W` counts from posting (§13A, P2) |
| **Creator names his own federation** | Round creator | Not considered | A federation is valid only if its threshold of guardians are bonded census nodes, config hash matches, known-good list (§23.6, P3) |
| **Forged chain view** | Whoever feeds the client its headers/census | "Never funds" — false | Corrected: it is the stake; ≥2 independent header sources mandatory for paying rounds (§5A.4, §25.1, P4) |
| **Fork selection by a player-run quorum** | 5 game/verify slots | Claimed caught by replay — false, the fork is genuine | Stated residual, priced by capital; publication makes the chosen fork public (§22, P5) |
| **Withholding** receipts or signatures, to stop an entry or a whole round | 3 of the 7 seats | Not considered | Griefing, and a free bet for a losing friend: the stake comes back out of the winners' pool. Unpunishable: silence leaves no artifact. 14.8 % at 20 % of capital, 35.3 % at 30 %, and committees are known hours ahead, so a player can choose those rounds. Stated residual (§22, P6) for stock-lock rounds; from `NAMED_CLAIM_HEIGHT` the census key's fallback claim pays the FINAL's settlement after `stall_blocks`, so a stall returns nothing (§23.2, kanban #1268). Repeated, it leaves the draw (§5A.3, protocol 26) |

---

# 36. Architecture summary

```text
                  GITHUB / MIRRORS
                        |
          ONE OPEN-SOURCE arena-node PACKAGE
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
          +--- objection window 600 s -+
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
5% node fee      -> eligible selected slots and guardians (5/3 % per pool, Bitcoin Arena)
0% or chosen     -> optional developer donation
```

---

# 37. Final principle

> There is one open-source `arena-node` package that anyone can download and,
> with a bond on Bitcoin, register — and that bond output *is* the census
> entry, so everyone derives the same eligible set from chain state.
> Committees are selected deterministically, with weight linear in the bond,
> from randomness that does not exist when the round is created — so nobody
> can choose their own judges, and splitting capital across identities buys
> nothing. The committees are fixed before any stake is committed. Seven selected instances verify results and five
> matching signatures make a result provisionally final; anyone in the world
> may overturn it within the objection window by replaying the transcript.
> The same seven hold shares of each stake's preimage
> and a threshold wallet, so no single party ever holds player funds, and
> doing nothing refunds everyone. A fixed 5% infrastructure fee (Bitcoin Arena; 2% under BLWP) goes to the
> slots that served; the developer donation is the player's choice and may be
> zero. Anyone can create a round, and no company is required to decide who
> won or to move funds.

That is the Bitcoin Arena protocol.

---

**End of the Bitcoin Arena protocol specification**
