# BLWP V1 custody: FEDERATION — the stake lock

DECIDED, the owner 2026-09-11 14:19. Written by the independent review session.
It replaces this file's 13:24 version. In PRIORITIES it supersedes the
committee-signed lnd (13:41, measured NO), the invoice-first join through a
patched fedimintd, and the submarine swap with invoice, hold and cancel on
the operator's lnd.

The Round Contract names `FEDERATION` (§23.6). Never single custody. No
central gateway and no central node: **no single node is needed, and no
single node can take money.**

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
2. **Deposit.** Alice's wallet (NWC budget, QR, WebLN) pays a stock LNv2
   receive invoice for this round, made through a gateway her client picks
   at random from the federation's list. The gateway puts its own ecash into
   an incoming contract *before* it learns the preimage, so it cannot keep
   her money. If it fails, the HTLC returns to her wallet and her client
   asks the next gateway.
3. **Lock.** Her client spends that incoming contract into the stake lock and
   the fee lock, in the same federation transaction where it can. No balance
   is left standing between rounds (§24A.3).
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
6. **Payout.** Alice's client redeems her payout contract with her key
   (`Refund`, open at once) and
   withdraws over Lightning through any gateway. That is stock LNv2 send:
   the gateway is paid only against the preimage; otherwise the contract
   refunds her.

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
- **Player key.** A lost refund or payout key loses that lock. Keys come from
  a seed the player backs up.

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
4. **Federation fees:** `disable_base_fees` (`lnv2-server/src/lib.rs:298`),
   or the base fees (1 sat per LNv2 input/output, 100 msat per note) go into
   the round's quote.
5. **Spec** §6, §9, §22, §23, §24A updated (v4.6.2, with this file).
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

---

## Rulings (the owner 2026-09-11)

- `stake_expiry_blocks` = **144** (one day). It must cover only round +
  objection window + the committee's settlement transaction: a forfeit is
  redeemable after expiry too, and after expiry the player's key alone
  refunds.
- **Donations:** the player's wallet pays the §27A.4 recipients directly,
  every game, at entry, outside the federation. Nothing of a donation is
  locked.

## Security findings (Fable, 2026-09-11 15:00) — open, each needs a ruling

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
