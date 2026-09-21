# BLWP V1 custody: FEDERATION — the stake lock

DECIDED, the owner 2026-09-11 14:19. Written by the independent review session.
It replaces this file's 13:24 version. In PRIORITIES it supersedes the
committee-signed lnd (13:41, measured NO), the invoice-first join through a
patched fedimintd, and the submarine swap with invoice, hold and cancel on
the operator's lnd.

The Round Contract names `FEDERATION` (§23.6). Never single custody. No
central gateway and no central node: **no single node is needed, and no
single node can take money.**

Amended 2026-09-21 (the owner: the **player wallet**, spec §24A.1, v4.6.3): the
stake is spent from e-cash the player holds in the federation, winnings and
refunds are redeemed into that wallet automatically and shown as pending
until then, and Lightning is used only when the player deposits or
withdraws. Steps 2, 3 and 6 below, the residuals, rehearsal items 8-11 and
the rulings of that date carry it. Nothing about the lock changes.

Amended the same day (the owner: the federation's **life**, spec §23A, v4.6.4):
at least ten guardians on mainnet (7 of 10), testnet stays 2 of 2, drawn by
sortition from bonded guardian-capable census nodes, replaced by succession
two losses before a halt with every player's notes migrating on their own,
abandonment slashed through the bond, and the player's BIP39 seed. Rehearsal
items 12-16 below are its acceptance.

---

## The one idea

The stake does not wait in a Lightning node. It waits as a **contract inside
the federation**, enforced by the guardians' consensus. Lightning is only the
door in and out, through any of several gateways; each payment is atomic and
over in seconds.

That contract already exists in stock Fedimint 0.12.0: LNv2's
`OutgoingContract`, an HTLC inside the federation. Read from source
(`modules/fedimint-lnv2-server/src/lib.rs:501-528`,
`modules/fedimint-lnv2-common/src/contracts.rs`):

| Witness | Condition | Money goes to |
|---|---|---|
| `Claim(preimage)` | before expiry, preimage matches, tx signed by `claim_pk` | whatever the signed tx says |
| `Cancel(sig)` | forfeit signature by `claim_pk`, any time | `refund_pk` only |
| `Refund` | after expiry (federation block count) | `refund_pk` only |

A transaction's inputs are checked as plain BIP-340 under the key each input
names (`fedimint-core/src/transaction.rs:105-120`), so a FROST group key is
simply a key. No patch, no new consensus rule, no Lightning node of our own.

---

## The stake lock

```text
OutgoingContract {
  payment_image  Hash(H(P))    P from the Entry Contract, VSS to the settlement seats (as today)
  amount         net stake     §22A
  expiration     federation block count + stake_expiry_blocks
  claim_pk       the round's settlement committee FROST key (5 of 7; 2 of 2 on test nets)
  refund_pk      the player's key, named by the Entry Contract
  ephemeral_pk   unused here
}
```

Beside it sits a **fee lock** with the same keys for the 2% node fee (§22A
collects it inclusive, from every player, not only from losers).

---

## Money flow — Alice delivers, Bob fails, 100 sat

1. The committees are known (§23.1 precondition). Alice picks `P`, puts
   `H(P)` in the Entry Contract, VSS-shares `P` to the settlement seats. As
   today.
2. **Deposit.** Alice's player wallet (§24A.1, v4.6.3) holds e-cash in this
   federation from an earlier deposit or an earlier win. If it holds less
   than stake plus fee, her external wallet (NWC budget, QR, WebLN) pays a
   stock LNv2 receive invoice, made through a gateway her client picks at
   random from the federation's list, and the notes land in her player
   wallet. The gateway puts its own ecash into an incoming contract *before*
   it learns the preimage, so it cannot keep her money. If it fails, the
   HTLC returns to her wallet and her client asks the next gateway.
3. **Lock.** Her client spends e-cash from her player wallet into the stake
   lock and the fee lock, in one federation transaction. No Lightning
   payment and no gateway is in this step. What stays in her wallet stays
   under her seed, in nobody's balance but hers (§24A.3).
4. `STAKE_COMMITTED` when the round's threshold of settlement seats have
   seen the lock confirmed by the federation. Play starts only then.
5. After `FINAL` + objection window:
   - **Alice DELIVERED:** the committee FROST-signs the forfeit of her
     lock and publishes that signature. It can only send money to
     `refund_pk`; her client builds and signs the redeem (audit point 1).
   - **Bob FAILED / FORFEIT:** the seats release `P` shares (as today). Each
     seat then rebuilds **one settlement transaction** from the public payout
     table. Inputs: every loser's stake lock (`Claim(P)`) and every fee lock.
     Outputs: one payout contract per qualifier (a pre-expired lock,
     `refund_pk` = the qualifier's key, audit point 2) and one per paid node
     slot (§22A). A seat signs only the txid it rebuilt itself; one FROST
     signing covers every input (audit point 3).
   - **VOID / ENTRY_VOID:** the committee forfeits the locks at once. If
     nobody acts, the lock expires and the player's client takes it back with
     its own key.
6. **Payout.** Alice's client redeems her payout contract and her
   forfeited stake lock with her round key (`Refund`, open at once) into
   her player wallet, on its own, the moment they exist; her screen showed
   both as pending until then. She plays the next round from the wallet, or
   withdraws any part of it over Lightning through any gateway, to an
   invoice her external wallet issues. That is stock LNv2 send: the gateway
   is paid only against the preimage; otherwise the notes return to her
   wallet.

There is **no pool wallet**. §18's loser pool is per round, and it is
exactly that one atomic transaction.

---

## Who can do each act

| Act | Before (measured) | Now |
|---|---|---|
| invoice | bob's lnd | any listed gateway, deposit only; atomic, cannot take it |
| hold | HTLC in bob's channel | stake lock in the federation's consensus |
| settle | preimage 2 of 2, msat land in bob's lnd | `P` by threshold **and** FROST by threshold **and** guardian consensus |
| cancel | one daemon alone | FROST by threshold (§23.2) |
| pay | harness pool | payout contracts in the same transaction |
| hold a balance | harness pool, or the wallet that paid | the player, as e-cash under the seed (§24A.1); no node, no gateway |

---

## Who the 7 are each round

Census of bonded nodes (§5A.2–5A.4). After `committee_time` a Bitcoin block
is the beacon. Bond-weighted stateless sortition (§5A.6); game/verify drawn
first and removed with its `operator_id` siblings, settlement from the rest
(§5A.9). The settlement seats run a DKG and hold `claim_pk` **for this round
only**. The guardians are a separate, longer-lived set.

---

## Built from

- **Stock, unpatched, pinned:** fedimintd 0.12.0 (mint v2, lnv2, wallet).
  LNv2 receive and send through gateways. `OutgoingContract`'s three witness
  paths.
- **Recognised:** FROST (RFC 9591) with BIP-340 signatures; VSS of `P` as
  today.
- **New code, ours:** client-side transaction building from those stock
  inputs and outputs (browser: `fedimint-client-wasm`; node: the Rust client
  crates); the committee's deterministic rebuild and signing. No consensus
  code, no Lightning node, no cryptography of our own.
- **Stopped:** `tools/fedimint-lnv2-hold.patch`, the invoice-first join
  through a patched fedimintd, the committee-signed lnd, the submarine swap
  into an on-chain pool.

What is new and must be rehearsed: `claim_pk` is not a gateway. The consensus
paths are the ones every LNv2 payment runs; this use of them is not.

---

## Residuals (§22)

- **Guardians.** A threshold of guardians colluding can take the
  federation's reserves. If the federation halts, every lock freezes,
  refunds included: Fedimint has no unilateral exit to Bitcoin. Bounded by a
  federation exposure cap and §5A.10's stake ceiling.
- **Settlement committee.** A threshold colluding can take that round's
  locks. Unchanged from §22.
- **Gateways.** Can refuse or fail a deposit or withdrawal; cannot take it.
  Needs at least two gateways run by different operators.
- **Player wallet (v4.6.3).** Standing e-cash is the same claim on the
  federation a lock is, for as long as the player leaves it there. Counted
  in the exposure cap; shown beside the federation's name; Withdraw offered
  wherever the balance is.
- **Player key.** A lost seed loses the wallet's notes and every lock its
  keys refund. The seed is backed up before the first deposit; the
  federation's stock backup brings the notes back under it.

---

## Conditions before real money

1. **FROST and DKG** from, or bit-matched against, an audited implementation
   (Zcash Foundation `frost-secp256k1-tr` and its DKG; check the `-tr`
   version is inside the audit). `frost-bip340.js` and `dkg.js` are tested
   against RFC 9591's base-suite vectors only. Never a trusted dealer.
2. **Guardians** are independent, bonded census operators. The Round
   Contract names the federation by id; more than one federation may exist.
3. **At least two gateways** run by different operators. The client picks at
   random and falls back.
4. **Federation fees:** MUST `disable_base_fees` (`lnv2-server/src/lib.rs:298`)
   (the owner 2026-09-15). Base fees stay 0. The game's 22A node fee is 2% to
   sitting seats and is not a Fedimint fee.
5. **Spec** §6, §9, §22, §23, §24A updated (v4.6.2, with this file); §24
   and §24A.1 for the player wallet (v4.6.3).
6. **The rehearsal below passes.**

---

## The rehearsal that proves or kills this

Regtest, unpatched fedimintd 0.12.0 (4 guardians, 3 of 4), two gateways, a
2-of-2 committee:

1. deposit into a lock with `claim_pk` = the FROST key; the guardians accept it
2. the committee's forfeit, redeemed by the player
3. one settlement transaction: losers' locks and fee locks in, payout
   contracts out; accepted; a 1-of-2 signature refused
4. `Refund` after expiry by the player's key; before expiry refused
5. gateway A down: deposit and withdrawal go through B
6. one guardian down: everything still completes
7. no single key and no macaroon moves a round's money
8. deposit into the player wallet; a stake spent from it into a lock with no
   Lightning payment between; the lock verified by the seats as in item 1
9. a payout contract and a forfeit redeemed into the wallet by the client on
   its own, with no press; two rounds played from the wallet with no
   deposit; then one withdrawal of the whole balance through B while A is
   down
10. a fresh browser with the seed alone recovers the wallet's notes through
    the federation's stock backup, and finds unredeemed round contracts
    through `GET /settled?since=`; nothing is asked of a node that the node
    does not already publish
11. cleared browser storage with no backup made: what returns from the seed
    and what does not, written down and shown to the player before the
    first deposit
12. **can stock 0.12 reshare?** measure whether a running federation can
    seat a new guardian or move a gone guardian's share; the answer decides
    whether §23A.6's succession is the first path or the fallback
13. **succession on regtest:** a 4-guardian federation with notes in three
    wallets and one open lock; one guardian abandons (attested); a successor
    of 4 is founded with the three seated first; every wallet's notes move
    on their own through a gateway that serves both, with no press; the lock
    settles in the old federation and its payout moves; the old record goes
    CLOSED; nothing lost anywhere, and the amounts written down
14. **abandonment to slash:** the attestation set of item 13 committed in a
    slashing transaction by the arbitration keys, 75% evenly to the active
    census nodes minus that federation's guardians, 25% to the donation
    set; and a departure with notice that is *not* slashed and leaves the
    bond and the census seat as they were
15. **the seed alone, another device:** twelve words typed into a fresh
    browser find the federation among three, recover the notes and the
    unredeemed contracts, and show the same display name
16. **testnet 2 of 2:** one guardian down halts; back up resumes; nothing
    lost - stated as the limit of what testnet can prove
17. **liquidation on regtest:** a 4-guardian federation (3 of 4) with notes
    in three wallets at 90% of its cap; two guardians abandon, attested and
    slashed into the escrow; the federation halts for `abandon_blocks`; the
    two seated guardians publish the spent set; each wallet's client
    presents its notes on its own start and is paid at face from the
    escrow; a note already spent is refused; the remainder goes 75% / 25%;
    then the same with **no** spent set published, paid pro rata, the rate
    shown

---

## Rulings (the owner 2026-09-11)

- `stake_expiry_blocks` = **144** (one day). It must cover only round +
  objection window + the committee's settlement transaction: a forfeit is
  redeemable after expiry too, and after expiry the player's key alone
  refunds.
- **Donations:** the player's wallet pays the §27A.4 recipients directly,
  every game, at entry, outside the federation. Nothing of a donation is
  locked.

## Rulings (the owner 2026-09-21)

- **The player wallet** (§24A.1, v4.6.3): the round wallet is one wallet
  per player seed and federation. The player deposits into it, stakes from
  it, and withdraws from it over a Lightning invoice, any amount, any time.
  No custody; no channel to any central server: the client speaks to the
  guardians and, on deposit or withdrawal, to any of at least two
  independent gateways, and holds no Lightning channel at all.
- **Winnings arrive on their own.** The client redeems a payout contract
  and a forfeit into the player wallet the moment it is available, with no
  press; until then the stake and the winnings are shown as **pending**
  (§24).
- **The federation's life** (§23A): the first mainnet federation has at
  least ten guardians; testnet is the 2-of-2 that runs today; the player
  gets a BIP39 seed of 12 or 24 words to write down. Founding by sortition,
  the draining bands, several federations picked by load, abandonment and
  the bond, succession with automatic migration, and the channels are
  RULED HERE in §23A for the owner to overrule.
- **Guardians earn from the 2%** (§22A): three equal pools, game/verify,
  settlement, and the seated guardians of the round's federation, paid in
  the settlement transaction. The 2% stays.
- **A slashed guardian bond** goes 75% evenly to the active census nodes and
  25% to the developers (§22A's donation set), never to the guardians who
  attested the absence (§23A.5).
- **Leaving is free.** A guardian who serves his departure notice keeps his
  bond and his census seat; only leaving without notice is slashed (§23A.5).
- **Every role is opt-in** (§5A.1): a node advertises what it takes part in
  - game/verify, settlement, guardian, any combination or none - and is
  drawn for nothing else. A node that wants no custody leaves
  `guardian_capable` off.
- **FEDERATION is the only custody** (§23.6): THRESHOLD_LN is withdrawn on
  every network; a round naming it is invalid; its records decode and that
  is all. This file is no longer "V1 of two"; it is the construction.
- **Players cannot lose** (§23A.3, §23A.5): the exposure cap is `(f + 1)`
  times the smallest seated guardian bond, so the smallest set that can
  halt the federation forfeits enough to pay every note; slashed guardian
  bonds wait in a per-federation escrow under the arbitration keys; a
  federation HALTED for `abandon_blocks` is liquidated - the seated
  guardians publish the spent-note set, the client presents every unspent
  note on its own, each is paid at face - and only the remainder goes 75%
  to the active census nodes and 25% to the developers, as it does whole
  when a federation CLOSES with nothing lost.
- **Fast** (§23A.1): the liquidation claim window is 36 h (the owner);
  abandonment 48 h, notice and founding 72 h, drain and late-claim tail two
  weeks (RULED HERE to match).
- **Serving a drain is paid** (§23A.6 step 5): the guardian pool of every
  round naming the successor is shared per seat with the draining
  predecessor's seated guardians until it is CLOSED, so staying is income
  and leaving is a slash, not a slash alone.
- **Guardians are not parked** (§23.6): §23A is built now - testnet on the
  2-of-2 that runs, seated by its two bonded operators; regtest on the
  4-guardian rehearsal; mainnet by founding once ten guardian-capable
  operators are bonded. `federationIsBonded` stays on.

## Security findings (Fable, 2026-09-11 15:00) — RESOLVED in spec v4.6.2 (the owner 15:10: "alles dokumentieren und lösen")

Where each fix now lives: F1 §7 + §23.1 steps 1–2 (`stake_point`, Feldman
`A0`); F2 §24 (seed-derived key, fingerprint, known-good client hash); F3
§23.1 step 0 (attested `claim_pk`); F4 §23.1 step 5 (field verification);
F5 §23.1 step 2/4 (`fee_preimage`); F6 §5A.3 (withheld signature is an
offence); F7 §23.1 step 3 (short CLTV, timeout); F8 §24 (fresh key per
round); F9 §22 (policy cap). All in §35A's table.

Adversarial pass over the stake lock. Ranked. None is a Fedimint bug; each
is a hole in how *we* use it, and each has a fix from tested parts.

**F1 — A loser can escape by dealing shares of the wrong secret. HIGH.**
The player deals `P` by Feldman VSS and commits `H(P)` as the lock's
`payment_image`. Feldman proves the shares are consistent, not that they
open to the preimage of a sha256 hash (PRIORITIES: "the Feldman residual on
the split preimage - no discrete-log group"). So a player deals consistent
shares of `Q ≠ P`, plays, loses; the committee reconstructs `Q`, the claim
fails, the lock expires, the loser is refunded. The hold-invoice design had
the same hole. The lock closes it: LNv2 accepts
`PaymentImage::Point(pk)` with the preimage as the scalar
(`lnv2-common/src/contracts.rs`, `verify_preimage`). With a point image,
Feldman's constant commitment `A0 = P·G` must equal the image, so every seat
verifies at dealing time that its share is a share of the lock's own secret.
Fix: the Entry Contract commits to a point, not a hash; seats refuse an
entry whose Feldman `A0` is not that point. The Lightning deposit stays a
stock invoice — no PTLC on Lightning.

**F2 — The page chooses the refund key. HIGH.**
Under a hold invoice a refund went back to the wallet that paid, by
construction. Now the client builds the lock, and a lying client (the
compromised web host of §35A) sets `refund_pk` — and the payout key — to
the attacker's key. The wallet's own screen shows a deposit and nothing
about where the refund goes. Bounds: the NWC budget caps the loss per hour;
§5's known-good client hash for real money; the player's key derived from a
seed the player holds and can check. Fix to rule: the refund and payout key
is derived from the player's seed and shown as a fingerprint the player can
compare outside the page; a client whose hash is not on the known-good list
cannot enter a paying round.

**F3 — A seat can substitute the committee key. HIGH.**
The player asks a seat for `claim_pk`. A rogue seat serves its own key; the
player locks to it; after `FINAL FAILED` the honest seats release shares,
the rogue reconstructs `P` and claims the loser's stake for itself. Fix:
`claim_pk` is valid only with signatures from a threshold of the round's
settlement seats over `(round_id, claim_pk)`; the client refuses to lock
without them.

**F4 — Lock fields must be verified before STAKE_COMMITTED. HIGH.**
The player builds the lock, so a seat MUST check every field through the
contract id (audit point 8): `payment_image` = the entry's commitment,
`amount` = net stake, `claim_pk` = this round's key, `refund_pk` = the
entry's player key, `expiration ≥ current height + 144`. A short expiry
alone lets a loser refund before settlement. §23.1 step 5 must say this.

**F5 — The fee lock must not share `P`. MEDIUM.**
Fees are collected from everyone (§22A), so the fee lock is claimed for
winners too. If it carries the same image as the stake lock, claiming it
publishes the winner's `P`, breaking "a DELIVERED run's preimage never
leaves". Fix: the fee lock carries its own image with a secret `F` the
player hands the seats openly at entry — the fee is owed once the round is
FINAL, whatever the result.

**F6 — A settlement stall favours losers. MEDIUM.**
Three seats that refuse to sign the settlement transaction stall it; locks
expire; losers are refunded and winners are not paid. §28 lists it as delay
→ refund, but it is also an incentive: a loser with friends on three seats.
§5A.13 keeps operators out of rounds they play; the objection window and
bonds do not reach a refusal to sign, because it leaves no artifact. Fix to
rule: a seat's signing round is logged and a missing signature after the
window is slashable by the others' signed record; or accept it as residual.

**F7 — A gateway can grief a deposit. LOW.**
It cannot keep money, but it can hold the player's Lightning HTLC up to the
invoice's CLTV, or fund the contract after entry closes. The player is out
of the round, not out of money; the deposit is then withdrawn. Fix: short
deposit CLTV, several gateways, the client moves on after a timeout.

**F8 — Refund keys are linkable. LOW.**
Every lock is public in the federation with its `refund_pk`. A fresh key per
round from the player's seed removes the link; the guardians still see
amounts and timing.

**F9 — The federation exposure cap is policy, not protocol.**
Fedimint has no per-federation limit we can enforce. The cap is the stake
ceiling (§5A.10) times rounds in flight, kept by the round contracts naming
that federation.

## Still open (the owner)

- Which federation(s), and who the guardians are.
- Inbound liquidity moves from our lnd to the gateways.

---

## Source audit (Fable, 2026-09-11 14:40) — what the concept must say exactly

Read from fedimint 0.12.0; each point changes a line above or adds one.

1. **A forfeit needs the player.** `Cancel(sig)` returns `refund_pk` as the
   key that must sign the *transaction* (`lnv2-server/src/lib.rs:522-528`).
   So the committee publishes its forfeit signature (a BIP-340 signature by
   `claim_pk` over the contract id), and the **player's client** builds and
   signs the redeem. A player who never returns is refunded by expiry with
   the same key. Nobody else can ever redeem it.
2. **A payout contract is a pre-expired lock.** `expiration = 0`, `refund_pk`
   = the qualifier, any `payment_image`. `Refund` passes at once
   (`lib.rs:515-521`), signed by the qualifier alone. No forfeit signature,
   no preimage. Outputs are only inserted, never validated (`lib.rs:577-582`).
3. **The committee signs raw.** Every input's key is checked as BIP-340
   over the txid (`fedimint-core/src/transaction.rs:105-120`) and the server
   collects one key per input (`fedimint-server/src/consensus/
   transaction.rs:50-77`). One FROST signature over the txid serves every
   input of the settlement transaction. The stock client's
   `finalize_and_submit_transaction` wants `Keypair`s (`fedimint-client-
   module/src/transaction/builder.rs:31-35`), so the committee builds the
   `Transaction`, FROST-signs its hash, sets `NaiveMultisig` and submits
   through the API's `submit_transaction` (`fedimint-api-client/src/api/
   mod.rs:478`).
4. **Expiry is Bitcoin height by guardian vote:** the threshold-th highest
   vote (`lib.rs:801-821`). 144 blocks is one day at the target; on regtest
   blocks must be mined for a Refund to open.
5. **Fees are per input and per output** (`lib.rs:561-565, 640`): 1 sat each
   by default, 100 msat per note. Run the federation with
   `disable_base_fees`, or the payout table carries the fee. Amounts are
   msat; there is no dust floor, so a 98 sat payout is a valid contract.
6. **One transaction is at most ~50 KB** (`MAX_TX_SIZE`,
   `fedimint-core/src/config.rs:38`): about 300 locks and contracts. A round
   larger than that settles in several transactions, split by a
   deterministic rule; atomicity is then per chunk.
7. **The browser needs its own wasm.** `fedimint-client-wasm` dispatches to
   ln (v1), mint, wallet, meta only (`fedimint-client-rpc/src/lib.rs:
   343-372`); LNv2 is absent. A small Rust crate on the stock client
   crates, built to wasm, exposes: receive via gateway, lock, redeem
   forfeit/refund, withdraw. Rust code, ours, no consensus code.
8. **Seeing a lock:** `outgoing_contract_expiration(outpoint)` returns
   `(contract_id, expiration)` (`lib.rs:737-743`). A contract id is the hash
   of the whole contract, so a seat that has the contract from the player and
   sees its id at that outpoint has verified every field. The entry commits
   to the lock's outpoint.
