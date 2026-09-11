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
     lock. That signature can only send money to `refund_pk`; her client
     redeems it.
   - **Bob FAILED / FORFEIT:** the seats release `P` shares (as today). Each
     seat then rebuilds **one settlement transaction** from the public payout
     table. Inputs: every loser's stake lock (`Claim(P)`) and every fee lock.
     Outputs: one payout contract per qualifier (`claim_pk = refund_pk` = the
     qualifier's key) and one per paid node slot (§22A). A seat signs only
     the txid it rebuilt itself; one FROST signing covers every input.
   - **VOID / ENTRY_VOID:** the committee forfeits the locks at once. If
     nobody acts, the lock expires and the player's client takes it back with
     its own key.
6. **Payout.** Alice's client redeems her payout contract with her key and
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

## Open rulings (the owner)

- `stake_expiry_blocks` (replaces `htlc_cltv_days`).
- Donations: §27A.4's recipients are LNURLs with no Fedimint key. Either the
  player's wallet pays them directly at entry, or recipients get a key.
- Which federation(s), and who the guardians are.
- Inbound liquidity moves from our lnd to the gateways.
