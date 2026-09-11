# BLWP V1 custody: Federation

the owner 2026-09-11. This is the V1 decision for where stake money lives
during a round and how it moves. It is not code. Claude (independent
review session) should validate whether we should build this, against
`multiplayer_p2p.md` §23 and §5A, and against “only recognised, tested
procedures — do not invent a money system.”

Round Contract names `FEDERATION` (§23.6). Never single custody.
No central payment endpoint: a single operator `lnd` is forbidden.

---

## What this is for

A player pays a stake (hold invoice). During the round the money is in
flight. After the objection window:

- winner: stake returns; payout comes from the pool
- loser: stake enters the pool
- VOID: nobody acts, CLTV expires, wallet refunds

Today on regtest the loser settle lands in **one operator’s lnd channel**.
The winner is paid from an on-chain taproot pool a **harness** funded.
Nothing in `blwp-node` sends sats into that pool. That is single custody
plus a fake pool. This file replaces that.

---

## Decision

**V1 = Fedimint-class federation** (guardians + Lightning in front).

Not:

- an operator bridge (channel close / swap by one person)
- a 5-of-7 Lightning node we assemble ourselves (Threshold-LN / FROST on
  every channel op) — spec §23.6 calls that *emerging*, not a product

Spec: two constructions satisfy “no single party can move funds”:
Threshold-LN (cleanest fit, not solved) and Fedimint-class + Lightning
gateway (production-ready, same residual). V1 uses the mature one.

**13:13 addendum:** payment must not go through one person’s node.
Invoice, hold, settle, pay need the **same quorum** as the mint
(5 of 7 mainnet, 2 of 2 on a two-slot test net). A *single* gateway
`lnd` owned by one guardian is forbidden.

Practical reading that stays inside tested software:

- The **mint** is Fedimint (known).
- Lightning in front is **not** “the owner’s lnd”. It is Lightning
  **operated by the federation** — multiple gateways run by guardians,
  or one logical gateway whose keys the guardians already control as
  part of that product, not a new FROST-lnd we write.
- If Fedimint cannot issue/settle/pay without a single-operator LN
  node, that is a **blocker to name**, not a reason to invent Threshold-LN.

---

## Money flow (concrete)

Alice and Bob, 100 sat stake. Net after 2% fee: 98 sat (22A).

1. Alice picks preimage `P`, puts `H(P)` on the Entry Contract, splits
   `P` with VSS to the settlement seats (threshold = the round’s
   settlement threshold, not a hard-coded 5).
2. The federation’s Lightning path issues a **hold invoice** for `H(P)`.
   Alice’s wallet pays it. The HTLC is accepted, not settled — in nobody’s
   balance.
3. `STAKE_COMMITTED` when enough settlement seats have **seen** the held
   HTLC (≥5 of 7, or 2 of 2). Play starts only then.
4. After `FINAL` + objection window:
   - Alice delivered: **cancel** her HTLC (money back to Alice) and
     **Lightning pay** her rank share **from the federation**.
   - Bob failed: reconstruct `P` at threshold, **settle** his HTLC;
     those sats are now in the federation (the pool).
   - VOID: do nothing; CLTV refunds the wallet.

Default if infrastructure dies: refund. One guardian offline: quorum
still acts. One guardian alone: cannot move a satoshi.

---

## Who the “7” are each round

The **mint** is longer-lived. It is not re-created every block.

The **7 who must nod this round** are the **settlement committee**,
drawn **once per round**, not every Bitcoin block.

1. Census: bonded, eligible nodes on chain (§5A.2–5A.4).
2. After `committee_time`, a Bitcoin block is the beacon (randomness
   published *after* the round is named).
3. Bond-weighted **stateless sortition** (§5A.6): for each eligible node,
   `ticket = H(committee_seed || outpoint || role)`, `weight = floor(bond/bond_min)`,
   `score = ticket / weight`. Lowest 7 scores sit.
4. Game/verify is drawn first and removed; settlement is drawn from the
   rest (§5A.9). Overlap only if the remainder is too small; the client
   must show it before anyone pays.

Deterministic: same chain, same bonds, same beacon → same 7. Anyone
recomputes. No vote, no admin pick. Linear weight: splitting capital
does not multiply selection power.

Mainnet: 7 slots, threshold 5 (genesis parameters). Test nets: the
contract’s slot count (2 of 2).

Those 7 are the quorum that **authorises** this round’s hold/settle/pay
against the federation. They are not a new mint.

---

## Federation vs Threshold-LN (why V1 is federation)

| | Federation (Fedimint-class) | Threshold-LN |
|---|---|---|
| What is 5-of-7 | Mint / guardian quorum | Channel keys (FROST/VLS on LN ops) |
| Where the 100 sat sit | Federation + LN in front | The 5-of-7 channels themselves |
| Invoice | Federation LN path | The threshold node itself |
| Status | Product, used in the field | Spec: emerging, not a solved product |
| Risk today | Known residual (quorum collusion; gateway freeze if LN is one node) | Unknown implementation bugs on real money |

We do not invent a 5-of-7 `lnd`. We use Fedimint. We do not put payment
on one operator’s node.

---

## What is still not built

Regtest rehearsal: loser +98000 msat in one lnd channel; winner payout
`PAYOUT_QUEUED` from a harness pool; dust 330 sat so 98 sat cannot be
an on-chain taproot output. Testnet4: 0 inbound, paying round 503.

Wiring federation is the work. Open rulings that are **not** this file:
inbound liquidity; `htlc_cltv_days`; dust remainder / fee rate; 22A
weighting / collecting fee and donation (23.5).

---

## Review questions (for the independent Claude session)

1. Does this match §23.1–23.6 and §5A.6–5A.9, or does it contradict the
   spec’s “one Lightning endpoint”?
2. Can Fedimint (tested) issue hold invoices, settle, cancel, and pay
   winners **without** a single-operator LN gateway? If not, what tested
   layout still has no central payment endpoint?
3. Should V1 still be federation, or does “no central endpoint + only
   tested procedures” force us to wait / pick something else?
4. Name blockers. Do not invent a money protocol. Recommend yes / no /
   yes-with-conditions on building this.

English. Measure against the spec file, not this summary alone.
