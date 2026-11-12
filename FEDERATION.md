# Bitcoin Arena V1 custody: FEDERATION — the stake lock

DECIDED, 2026-09-11 14:19. Written by the independent review session.
It replaces this file's 13:24 version. In PRIORITIES it supersedes the
committee-signed lnd (13:41, measured NO), the invoice-first join through a
patched fedimintd, and the submarine swap with invoice, hold and cancel on
the operator's lnd.

The Round Contract names `FEDERATION` (§23.6). Never single custody. No
central gateway and no central node: **no single node is needed, and no
single node can take money.**

Amended 2026-09-21 (the owner: the **player wallet**, spec §24A.1): the
stake is spent from e-cash the player holds in the federation, winnings and
refunds are redeemed into that wallet automatically and shown as pending
until then, and Lightning is used only when the player deposits or
withdraws. Steps 2, 3 and 6 below, the residuals, rehearsal items 8-11 and
the rulings of that date carry it. Nothing about the lock changes.

Amended the same day (the owner: the federation's **life**, spec §23A):
at least ten guardians on mainnet (7 of 10), testnet 5 of 7 (2026-09-27), drawn by
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

Beside it sits a **fee lock** with the same keys for the node fee (5% in Bitcoin Arena, §0A.8; §22A
collects it inclusive, from every player, not only from losers).

---

## Money flow — Alice delivers, Bob fails, 100 sat

1. The committees are known (§23.1 precondition). Alice picks `P`, puts
   `H(P)` in the Entry Contract, VSS-shares `P` to the settlement seats. As
   today.
2. **Deposit.** Alice's player wallet (§24A.1) holds e-cash in this
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

## Who posts the rounds (2026-10-26, kanban #702; spec §5A.5)

The owner: "The round runners must be an integrated part of the node. Who decides what round is posted today? There is something in
the spec." The spec decides, and every node now runs it itself - no runner process, no operator by hand.

- **Who.** Each UTC day has a duty order: the nodes of the census at the day's anchor block, sorted by a hash of the network, the day
  and each node's key. Every node computes the same list; GET /duty on any node shows the top 3.
- **What.** The first node posts the next day's rounds of every app in every open federation, one transaction per app, from 00:00
  UTC (the primary grid). The second node posts a second grid of the same day from 02:00 UTC (the backup grid), on its own coins,
  with a different census block and a later committee time, so one reorg or one bad coin cannot take both.
- **Which one is played.** One per window. The primary while its committee can be drawn; otherwise the backup. Seats mark each
  paid round `played` and pages only offer the played one. Once a backup round holds a stake on a seat, that seat takes no
  stake in the same window's primary.
- **Missed.** If the first node has not posted by 01:00, the second posts it; by 02:00, the third. A missed backup moves to the third
  node at 03:00, never to the node that posted the primary. A day whose postings die (a reorg, a fork the network left, a
  conflicted coin) or that is not drawable 4 h before it starts gets an emergency grid for the rest of it.
- **Paying.** The node pays from its own Bitcoin Core wallet, confirmed coins first, at 0.1 sat/vB (raised to at most 1 sat/vB
  if still unconfirmed 3 h before the committee time). The fee comes back from the series' node fee to the node's key (it signs
  every grid as its creator - which is also how anyone sees who posted it). A node without a wallet, without confirmed coins, or
  reading the chain through Electrum says so on GET /duty and its owner page, and the day falls to the next node.
- **Turning it off.** `duty_post=off` in arena.conf (default `auto`: on while the wallet holds confirmed coins; `on` always tries).
  `duty_wallet` names the wallet, `duty_fee_rate` and `duty_max_fee_rate` the fees.

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

## Liquidity providers: incoming Lightning for every new node (2026-10-18; spec §23A.10)

- **The problem:** a new Lightning node (every custody node's gateway) has no incoming liquidity, so no deposit can reach it.
- **The fourth service:** a liquidity provider opens one channel **to** each new node so it can receive.
  It earns **1 % of the node fee** of its federation's rounds, as each of the other three services does from protocol 2026.0.16
  (game/verify 1 %, settlement 1 %, custody 1 %, liquidity 1 %).
- **Amounts:** one channel L = 100,000 sat on testnet4 (250,000 on mainnet). The deposit is ≥ 5 × L on testnet4 (10 × L on
  mainnet), coins in the provider's own LND wallet.
- **At least 1, at most 2 per node:** every provider publishes a signed liquidity claim at its seat (its channels, its free funds).
  For a node with fewer than 2 provider channels, all providers rank the candidates the same way (a ticket on node and provider
  keys) and the top ones open. No coordinator.
- **Paid** from a guardian-signed list per epoch, like the gateway seats; with no provider, the pool goes to custody. With more than
  one provider the pool is split by **available balance** (the owner: "dependant on available balance"): each provider's channels to the
  federation's nodes plus its proven free coins, floored to 10,000 sat. A provider whose free coins plus the channels it gave are
  below the deposit minimum earns nothing of it until topped up (2026-10-18: giving liquidity never removes the share).
- **Proven free coins:** the claim lists the provider's coins, each signed by its address key for that provider's node. A guardian
  counts a coin only when the signature is good and its own Bitcoin Core shows it unspent, at the chain's amount, never the claimed
  one. A guardian therefore needs its own Core (Electrum mode serves no `gettxout`).
- **Live on testnet4:** nodes 1 and 2 are the providers, their LND C and LND D on the test host. Node 1 proves 672,182 sat in 4 coins,
  node 2 600,000 sat in 1 coin (measured 2026-10-18 16:41Z against the the test host's testnet4 Core).

## Who hosts the Lightning: two gateway seats, and what they earn (2026-10-18; spec §23A.9)

> "We need 2 guardians per federation and there is currently no process who will host the guardian. Modify the spec for it and come
> up with additional incentives from the custody node fee that people want to host a guardian. If more than 2 nodes in the federation
> want to host a guardian a clear process must choose the best guardians possible, make the rules and requirements clear."

Read as the **Lightning gateway**, the role that needs the peg-in. A federation keeps its 4 to 10 guardians: Fedimint cannot run on
two. Every deposit and withdrawal above goes "through any of several gateways", and this is who runs them.

- **Two gateway seats per federation**, held by two different operators among its seated guardians and named by a seating that a
  threshold of its guardians sign each epoch (144 blocks).
- **To stand** (testnet4 / mainnet):
  - a seated guardian whose announced gateway is registered with the federation;
  - inbound liquidity from outside the federation of at least 100,000 / 250,000 sat (deposits from the wider network come in through it;
    the ring does not count) and outbound of at least the same (payouts);
  - one channel to a hub outside the federation (testnet4: the the test host's LND C over Tor); a node nobody can dial gets an onion address
    (Tor), measured at install: LND's port is tried from outside first;
  - a peg-in of at least 50,000 / 2,000,000 sat;
  - inbound comes from the federation's **channel ring**: once it is founded, each custody node opens one 150,000 sat channel to the
    next in node-key order (custody agent), so every gateway gets one channel in and one out from the federation's own nodes;
  - up 95 % of the epoch (every guardian probes every candidate every 10 minutes);
  - a bond of at least `bond_min_guardian`.
- **The best two**, ranked in order by:
  1. Lightning volume routed for the federation;
  2. two-way capacity (the smaller of inbound and outbound);
  3. availability;
  4. bond;
  5. a ticket on the epoch's beacon.

  The two are signed as a separate gateway seating per epoch (not in the federation record), once the epoch is over; it stands only with
  the threshold of the seated guardians' signatures over the same seats. From the activation epoch N of the seat's network (`SEATING_RULES_EPOCH`, one
  constant per network: regtest/devnet 0; testnet4 and mainnet fixed at the 2.0 tag to `floor(tag height / 144) + 14`, every guardian of
  every live federation on 2.0 by epoch N − 2; nobody switches it by hand), decided by the seating's own epoch, each guardian floors a seat's proved peg-in to whole 100,000 sat before signing, and a seating of
  epoch E is judged against the federation record in force at E's last block (`(E + 1) × 144 − 1`), not today's guardian set; until
  that epoch is named every guardian signs and judges as 1.9.x does. The seats rotate every epoch (144 blocks, 2026-10-20): last epoch's holders step back for the eligible operators that did not hold a seat; with nobody else eligible they keep it. A draining federation has one seat, and a federation is never without a gateway (the best one that can serve holds a seat below the minimums, unpaid). An empty seat is stated.
- **What it earns, from the custody fee** (protocol 2026.0.15, so the 4 % node fee of protocol 11 on): the guardian pool (4/3 % of every
  round's volume) splits **2/3 to the guardians, 1/3 to the two gateway seats**. With ten guardians that is about **0.222 %** of volume
  per gateway seat against 0.089 % per guardian (a seat holder is a guardian too: 0.311 % in all), plus the gateway's own Lightning
  routing fees.
  - Unearned shares go to the other seat, then to the guardians.
  - A round is paid from the signed seating of the last whole epoch before its census height (`floor(census_height / 144) - 1`); with no
    seating standing for that epoch, no gateway is paid and the guardians keep the pool - no fallback to an older epoch.
  - The mirror, from protocol 22: with no eligible guardian in a round, the custody pool's guardian part goes to the eligible gateway
    seats, evenly; only the custody pool moves, and the gateway seats' own share and the liquidity providers' shares are paid as with
    guardians. Only with no eligible gateway seat either does the custody pool go to the two committees (game/verify and settlement),
    half each, the odd millisatoshi to settlement.
- **The installer** says all of this in its custody step:
  - it sets up LND, its channels, the gateway on it, and the peg-in from the node's wallet;
  - the node's custody agent announces the gateway (a claim signed by the node key) once its federation is founded.

Full rules: multiplayer_p2p.md §23A.9. Code: arena-protocol `gateway-seats.js`, `gateway-claim.js`, `gateway-seating.js`, `fee.js`
(the 2026.0.15 split); arena-node `gateway-watch.js`; the installer's `gateway.js` and `custody-agent.js`.

## Leaving while offline: the owner's emergency key (spec §23A.5a, protocol 17)

From the 24 words the installer derives an **emergency key** and shows it as a short code to write down. The bond advert names its
public key. With the node offline, the owner opens any node's page (or the Arena site), types the code, and posts a signed leave
request. A node with no guardian role leaves the seating at once; a guardian whose request arrives before `abandon_blocks` is
`DEPARTED` at once and the succession starts. In both cases the bond is untouched. A guardian whose request comes later is abandoned
and slashed, as before. The code can do nothing else. A seat takes a request only within 6 blocks of its tip and signs a
guardian `DEPARTED` only for one it took itself, so a late request cannot be dated back. Pages: `/Dashboard/emergency` on every node,
`offline/` on the Arena site.

## Residuals (§22)

- **Guardians.** A threshold of guardians colluding can take the
  federation's reserves. If the federation halts, every lock freezes,
  refunds included: Fedimint has no unilateral exit to Bitcoin. Bounded by a
  federation exposure cap and §5A.10's stake ceiling.
- **Settlement committee.** A threshold colluding can take that round's
  locks. Unchanged from §22.
- **Gateways.** Can refuse or fail a deposit or withdrawal; cannot take it.
  Needs at least two gateways run by different operators.
- **Player wallet.** Standing e-cash is the same claim on the
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
   (2026-09-15). Base fees stay 0. The game's 22A node fee is 5% (Bitcoin Arena; 2% under BLWP) to
   sitting seats and is not a Fedimint fee.
5. **Spec** §6, §9, §22, §23, §24A updated with this file; §24
   and §24A.1 for the player wallet.
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
    does not already publish. **AS BUILT (2026-10-04):**
    Fedimint's own recovery, not the stock backup. The browser runs it
    through the wasm lock client (`LockClient.recover`, the fork's
    recovery clock patched for wasm32). Measured on testnet4, page 0.0.2737:
    a second fresh browser given the first one's 24 words recovered its
    100 sat in 7.2 s.
11. cleared browser storage with no backup made: what returns from the seed
    and what does not, written down and shown to the player before the
    first deposit
12. **can stock 0.12 reshare?** measure whether a running federation can
    seat a new guardian or move a gone guardian's share; the answer decides
    whether §23A.6's succession is the first path or the fallback. **RUN
    2026-10-14 01:55Z (`tools/rehearsal-12-regtest.sh`,
    private regtest on the test host): it cannot - succession is the path.**
    The 0.12 source has no reshare (no endpoint, no CLI; the peer set is
    the setup API's, before the key ceremony). A running federation's
    guardian, asked as its admin for a fifth guardian started fresh:
    setup status "ConsensusIsRunning"; add-peer, set-local-params,
    start-dkg and restart_federation_setup all "Invalid rpc id" (the setup
    API is gone once consensus runs). The fifth guardian takes g0's code,
    and its start-dkg is refused ("The number of guardians is invalid").
    After: the same federation id, 4 guardians in g0's config, consensus
    running.
13. **succession on regtest:** a 4-guardian federation with notes in three
    wallets and one open lock; one guardian abandons (attested); a successor
    of 4 is founded with the three seated first; every wallet's notes move
    on their own through a gateway that serves both, with no press; the lock
    settles in the old federation and its payout moves; the old record goes
    CLOSED; nothing lost anywhere, and the amounts written down. **RUN
    2026-10-14 01:44-01:50Z (`tools/rehearsal-13-regtest.sh`
    + `tools/rehearsal-13.mjs`, private regtest on the test host, EXIT 0 in
    319 s):** p1-p3 paid in 249,999,872 msat each; p3 locks 100,000,000
    under the committee's claim key (arena-stake-lock, ids match, expiry
    472). Guardian 3 stops; on 3 of 4 the committee settles the lock to p1
    with one signature (accepted, payout 100,000,000, fees 0) and p1
    collects it by Refund (accepted). Successor fb7acaf4 (3 seated first +
    1 drawn). Pass 1 moves p1 349,999,616, p2 249,999,872, p3 134,216,192;
    p3's lock change, 15,783,424, was still in issuance and moves on pass 2
    (a client moves on every start). After: every old balance 0; in the
    successor p1 349,999,616, p2 249,999,872, p3 149,999,616 = 749,999,104
    of 749,999,616 - the 512 msat are the federation's fee on the lock and
    on the collect. The gateway pegged its old e-cash out, 19,672,576 msat
    left behind (the old audit still covers it: 20,191,000 in its wallet).
    Records: the old one naming the successor (CRITICAL, 3 signers) and
    CLOSED (3) verify, CLOSED with 2 is refused; the successor OPEN (4)
    verifies. The 4 old bonds are spent at maturity, refused one block
    before.
14. **abandonment to slash:** the attestation set of item 13 committed in a
    slashing transaction by the arbitration keys (run under the split of the
    time; since kanban #976 the rest of a slashed bond goes to the protocol
    reserves, nothing to nodes or developers); and a departure with notice that is *not* slashed and leaves the
    bond and the census seat as they were. **RUN 2026-10-13 ~22:40Z (`tools/rehearsal-14.mjs`, private regtest on the test host):** census
    of 8 bonded nodes, A = n1-n4 and B = n5-n8, 3 of 4. A4 absent 10 blocks
    (abandon_blocks): 2 attestations, or one spanning 9 blocks, prove
    nothing; 3 stand. The slashing transaction (5 of 7 arbitration keys; 4
    refused) commits the proof id and slash_height 145 and moves the
    100,000,000 sat bond into the escrow (99,997,000, fee 3,000). A CLOSED:
    the escrow pays n5-n8 18,749,062-18,749,064 sat each (74,996,250, 75 %)
    and the donation set 24,998,750 (25 %), fee 2,000; 4 of 7 refused,
    mined. B3 (n7) gives notice at 147 for 157 (one block less is refused),
    serves to 157 and stops: B1, B2, B4 attest from 157, and the slash is
    refused (DEPARTED); his bond is unspent, so he keeps his census seat.
    The same absence from 156 is ABANDONED and slashed. Found and fixed: a
    seat's record took a due notice before the proof, so a guardian who
    stopped before leave_after was recorded DEPARTED.
15. **the seed alone, another device:** twelve words typed into a fresh
    browser find the federation among three, recover the notes and the
    unredeemed contracts, and show the same display name. **AS BUILT
:** 24 words, one federation listed. The notes (item 10) and
    the unredeemed rounds (the 24 h `/settled` scan) are recovered.
    "Among three" waits for a second federation in the census.
16. **testnet 5 of 7:** two guardians down, everything still completes; a
    third down halts, back up resumes, nothing lost; one guardian gone
    starts a succession to seven that every wallet follows on its own; a
    phone opens every one of the seven `wss://` endpoints
    MEASURED on testnet4 federation B (2026-10-14): two down (g6, g7 SIGSTOP) - consensus kept advancing
    (1013-1017, 16:15-16:27Z) and a PAID round completed on five: deposit 305,000 msat through gw-b, stake and fee
    locks, play, PROVISIONALLY_FINAL at 7/7 signer nodes, settlement ACCEPTED in B (txid 3bb90d97, 21:13Z) while
    the two were still paused; a third down halted the sessions at 1017 for 10 min and all seven resumed together
    (1018-1020); after the paid run both rejoined at once (1106-1108 on all seven). A PHONE OPENS EVERY ENDPOINT (2026-10-15 16:53Z, `phonews.mjs`): headless Chrome
    as an Android phone (Pixel 7 UA, 412x915, touch, 4G: 150 ms round trip, 9/1.5 Mbit/s) on the live page's origin
    testnet.bitcoinarena.io opened all 14 guardian sockets, A g1-g7 (`wss://tn4.bitcoin-arena.io/guardian-N/guardian`) and
    B g1-g7 (`.../fed2-N/guardian`), and each answered `session_count`: A 5391 from all seven (opened in 181-834 ms,
    answered in 248-947 ms), B 1484 from all seven (opened 1234-3039 ms, answered 1610-5330 ms; Chrome opens one socket
    per host at a time, so the later ones wait for the earlier). OPEN: the succession to seven on testnet (measured
    on regtest only, item 13).
17. **liquidation on regtest:** a 4-guardian federation (3 of 4) with notes
    in three wallets at 90% of its cap; two guardians abandon, attested and
    slashed into the escrow; the federation halts for `abandon_blocks`; the
    two seated guardians publish the spent set; each wallet's client
    presents its notes on its own start and is paid at face from the
    escrow; a note already spent is refused; the remainder goes on (75% / 25%
    when this was run; to the protocol reserves since kanban #976);
    then the same with **no** spent set published, paid pro rata, the rate
    shown. **RUN 2026-10-14 ~01:27-01:35Z (`tools/rehearsal-17-regtest.sh` + `tools/rehearsal-17.mjs`, private
    regtest on the test host, fedimintd with `fedimint-spent-nonces.patch`):**
    our federations run **mintv2** (the probe, testnet4 A and B): the patch
    adds `blwp_spent_nonces` (admin) to it and a client `module mintv2
    validate`, the stock CLI having no check. Bonds 4 x 500,000 sat, cap
    1,000,000; p1-p3 paid in 3 x 299,999,744 msat; p3 sent 100,000,000 msat
    to p1, received. g3 stopped: 3 attest, the slash (5 of 7) moves 497,000
    sat into the escrow, the CRITICAL record verifies (3 signers). g2
    stopped at 341: HALTED - and **neither the abandonment proof (2 of 3)
    nor any record (2 signers, 3 needed) stands; open for a ruling**: a halt
    by abandonment cannot be proven, so the second bond is never slashed.
    g0 and g1 each gave their spent set (session 1, 52 nonces, 220-293 ms),
    identical. Every wallet sent its notes while halted (mintv2 send works
    offline). Claims at 351: p1 60 notes, p2 60, p3 48 accepted; p3's spent
    string (12 notes) refused by the spent set. From the one slashed bond:
    pro rata 0.6212; had both been slashed (994,000 sat): at face, remainder
    194,001,024 msat, after drain_blocks (441) 75 % to the 4 nodes outside
    the federation (36,375 sat each) and 25 % to the donation set (48,501).
    No spent set: the spent string is paid too, 0.5522 from one bond, at
    face from two. **Found:** in this run p1's received 100,000 sat was
    still in issuance at the halt (the receive said Success, the notes need
    3 signature shares, 2 guardians answer): p1 handed over 299,999,744 and
    holds 0 - an in-flight payment is lost at a halt (in the first run the
    same step finished before it and p1 handed over 400,000,000).
    **Both findings RULED (Claude, on the owner's delegation 2026-10-14):**
    multiplayer_p2p.md §23A.5 "How a halt is proven" (the seats attest a
    halt - no session past `S` for `abandon_blocks`, a census majority and
    at least five; no HALTED record; a guardian that answered through the
    halt is not slashed) and "Notes still in issuance at the halt" (the
    seated guardians publish the issued set; the client presents a pending
    output's secrets; paid at face like a note).

---

## Rulings (2026-09-11)

- `stake_expiry_blocks` = **144** (one day). It must cover only round +
  objection window + the committee's settlement transaction: a forfeit is
  redeemable after expiry too, and after expiry the player's key alone
  refunds.
- **Donations:** since 2026-10-03, paid inside the federation - one output
  per recipient key in the player's lock transaction (below, "Donations in
  the federation"; multiplayer_p2p.md §22A). Before, the player's wallet
  paid the §27A.4 recipients' LNURLs directly, outside the federation.

## Rulings (2026-10-03)

- **A stake nobody claims comes back at settlement, not at expiry.** `stake_expiry_blocks` stays **144** - the
  backstop if the signer nodes never settle (a shorter expiry would let a loser take the stake back before the
  settlement claims it, and would change every round's contract). When a round's settlement paid **no winner**, every
  lock it did not claim - a FAILED run, a DELIVERED run below the score - is forfeited back to its player's refund key by
  the signer nodes as soon as their settlement is ACCEPTED (each signer node on its own record: settlement ACCEPTED, no
  winner's share, the lock not among its claims, no entry of the round still inside its window). The player's client
  redeems it at once: the stake is back in the player wallet minutes after the run, within one federation transaction of
  the settlement. A walk-away (FORFEIT at the door) is never a refund (2026-09-30); the fee lock and the donation are
  not returned.
- **Late join (series from 2026-10-03 22:00Z):** a series may close each round's entry 45 s after its start
  (`LATE_JOIN_MS`, in the template's bytes, so in the series id). A player who joins a running round plays a full run
  from his own join - the run, the first-mark deadline and the door all count from the entry, not the round's start -
  so his run ends up to 45 s after the others'. The signer nodes take a NEW entry of such a round until its entry close
  + 15 s (the time a join begun before the close takes to lock and post); the same entry posted again is still taken.
  Rounds closing entry at their start keep the old door. SUPERSEDED 2026-10-04 14:30 (the owner): every run ends
  with the round at start + 82 s (a late entry names the round's ticks gone as its join tick and plays the rest), and
  the signer nodes take a new entry only before start + 37 s - 45 s or less of the run left is too late; the bytes'
  start + 45 s stand, no new series. Brought into multiplayer_p2p.md §5A.5 (Timing, late join) and §13A. Published: T1 fa570b05 (2026-10-03 22:00-23:58:30Z) and T2 4d8f738a
  (2026-10-04 00:01:30-23:58:30Z), tails of the live paid round's contract; full series for 10-05 and 10-06 follow
  once their census blocks exist (>= 72 h of rounds).
- **Every amount that comes back is a row in the wallet's history:** a stake back with no payout is a "Refund" row
  (money in), next to deposits, stakes, winnings, donations and withdrawals.

## Rulings (2026-10-04) - the rules a round plays, and how they changed

Brought into multiplayer_p2p.md the same day (the owner: "We don't want a conflict, solve it in the spec"): §18A.3 (C and
T), §27A.7.8 (rule changes by ruling until the ballot is built), with §27A.1 and §27A.8 pointing to it. What is left here
is the record: the dates, the hashes and the one transition pair.

- **One world per round (world grinding; evening).** Config `2170f250` (genesis.js `encodeGameConfigV4`: v3's
  fields and a world rule, 1 = shared per round) on core `7e2123d1`: every player of a round drives
  `round_seed = H(committee_seed || "world")` (§5A.5, §12) - the player chooses nothing about the world, an entry's world
  secret is 32 zero bytes and the seats refuse any other. `f51759b6` (per-player) stays installed for the 10-06 series.
  Free pair on `2170f250` from its roll at 16:44Z; testnet4 seats at 17:02-17:03Z, so the 10-07 series publishes on it.
  Measured: free round 7e294027, two players with different keys, the same world seed 0x8b99aa, both runs signed 2/2.
- **The score's C and T (08:54, 09:17).** C is the bed fill: room used over the bed, the sum of cargo.js `roomFor` over
  the vsizes on the bed, 0 empty to 1 full, set by the load at roll-out (init 0); a load that carries no room (stored
  before the room crossed) keeps 0.7. T is par 1800 ticks: 1.5 until 1200 ticks (20 s), 1 at 1800 (30 s), 0.25 from
  7200 (120 s). In the spec: §18A.3.
- **A round names the config of the rules it plays (fix 1 of the 2026-10-04 spec audit; §27A.6 "a round is bound to
  the config it was created under").** Each core plays its own config: 2069b4c2 the founding config bbae68dc, de2f263d
  the config dbb49344 (genesis.js `encodeGameConfigV2`: versioned, hashed from the core's own constants, naming par, the
  T bounds and the cargo rule). Seats hold core+config pairs per game and refuse any other (arena-node/src/plugins.js,
  since the game's manifest lists them); the client lists the same pairs per game (arena-protocol/src/known-games.js
  `KNOWN_GOOD_GAMES`) and refuses a known core under a config its game does not list.
- **The network id commits to the founding config only.** It is the config the network was founded on (read from the
  frozen 2069b4c2 core) and does not move when the rules do - no refound. Later configs live beside it under the same
  network id, each named by the rounds that play it (§27A.6, §27A.7.8).
- **Until governance exists, a rule change is a new config (and core) hash under the same network id, by the
  authority's ruling.** The new core de2f263d and its config dbb49344 came into force by this ruling, without the
  DESIGN ballot (§27A.7) or the hard fork with a new network id (§27A.8.1) the spec prescribes - no ballot code exists,
  and a new network id is a refound. In the spec: §27A.7.8, the interim rule until the ballot is built.
- **Exposure is weighted by the load's heat (option 1 of the audit).** de2f263d weighted exposure by C, so a full bed
  counted twice - in E and again as C. The core after it, 7e2123d1, weights it by heat as §18A.3 writes it; its config
  f51759b6 (v3) is v2's fields and the exposure weight. de2f263d stays installed (frozen, its own replay bundle, on the
  page as a third core) for the free rounds made on it; the 10-06 paid series is the first paid series on 7e2123d1.
- **One transition pair, by date.** The free rounds the series pair opened from 08:23Z name de2f263d with the founding
  config (they were made before its config had a hash); they are not rewritten. The seats accept that pair only for a
  round whose committee time is before 2026-10-04 13:00Z and refuse it after; the client accepts the pair, the seats
  hold the date. Paid rounds take the new core only from the next published series (10-06, published 12:30Z), and
  that series names 7e2123d1 with f51759b6; every round published before stays on 2069b4c2 with the founding config.

## Donations in the federation (2026-10-03, ruled; options decided here)

2026-10-03: "We'll use the federation(s) as donation layer. Every dev has its own client with a private key that
corresponds to the 66.67% or 33.33% stake in the donation set." Measured the same day, the Lightning way failed twice:
the rounds named LNURLs no browser could reach (every share UNPAID), and a 666 msat share found no route over a channel
whose min_htlc was 1 sat - most mainnet channels refuse below 1 sat, and the fixed fee per hop (0-1 sat) is as large as
a 2 sat donation.

**The set names keys, not LNURLs - one set for the network, no per-federation subsets.**

```text
donation set = signed by the network's donation authority (as today)
  [ { recipient_pk: 33-byte secp256k1 key, share_bps: 6667, label: "dev a" },
    { recipient_pk: ...,                    share_bps: 3333, label: "dev b" } ]     sum = 10000
```

A key is valid in every federation, and every round already names its federation, so a round's donation goes to the
same keys in that round's federation. Options weighed:

| Option | For | Against |
|---|---|---|
| **One set of keys, any federation (chosen)** | a new federation needs no new set; one key per dev; nothing to keep in step | a recipient carries the custody risk of every federation rounds name, until it withdraws |
| A subset per federation | a dev can refuse a federation | the set must be re-signed for every new federation; a round in a federation the set forgot pays nobody |
| One key + a per-recipient list of refused federations | refusal without per-federation keys | a share in a refused federation has nowhere to go; deferred until somebody needs it |

**Paid in the lock transaction, not over Lightning.** The player's client already spends from the player wallet into
the stake lock and the fee lock in ONE federation transaction (step 3 of the money flow). That transaction gains one
**donation output per recipient**: a payout contract as §5 builds them - a pre-expired lock with `refund_pk` =
`recipient_pk`, which the recipient redeems with its own key at any time. No gateway, no route, no minimum HTLC, no
Lightning fee; msat amounts as they are (floor each share, remainder to the first recipient, as §22A). The donation
leaves the wallet in the same transaction as the stake: a stake that is locked is a donation that is paid.
- **Not returned**, as before: a walk-away or a refunded stake does not bring the donation back (§22A: voluntary,
  outside the pool). A join that locked and then failed has given its donation.
- **Enforced by the seats:** the Entry Contract names the donation outpoints beside the stake and fee lock outpoints;
  a signer node takes an entry whose `donation_bps > 0` only if the federation holds those outputs, each to its
  recipient key, each for its share of `donation_msat`. A wrong or missing output is refused like a wrong stake lock.
- **Recipient B on LND C, the LNURL service and the forwarder retire** with the last round that names an LNURL set.

**Found by the recipient's own client, which asks every federation it knows.**
- Each signer node keeps the donation outpoints of the entries it took, by recipient key and federation:
  `GET /donations?key=<recipient_pk>[&since=<ms>]` -> `[{ federation_id, round_id, entry_id, outpoint, amount_msat }]`.
  Public (the entries are), and checkable: the client confirms each outpoint with the federation itself.
- The dev's client holds one private key. It learns the federations from the rounds the seats serve (each round names
  its federation and invite), asks the seats for its outpoints, redeems each in its federation into its own e-cash
  there, and withdraws it to **the dev's own LND, configured in that client** (2026-10-03): the client has its
  LND make an invoice for what it collected and pays it from the federation through a gateway (stock LNv2 send; the
  gateway is paid only against the preimage, otherwise the notes come back). One Lightning fee for many donations, and
  the money ends on the dev's own node, not in a wallet someone else runs.
- One key across federations links a dev's donations together; for named devs that is the point. A per-federation
  tweak of the key is possible later without changing the set.

**A donation outside any round** *(2026-10-17: "donate to developer, a popup opens with an amount to choose from
100, 500, 1000, 5000 satoshis or custom"; "B e cash")*:
- The player gives from the popup in three places: Tick Tock's countdown box, the footer strip of every other game, and the main
  testnet UI's footer (the protocol developers).
- The wallet pays the amount split over the set's keys exactly as a round's donation is split, in one federation transaction of
  pre-expired payout contracts with the donor's key as their image (`paySubmit`, as an item is paid).
- The donor signs a `DonationGift` { target (network 0 / game 1), game developer, game name, donor, federation, txid, total, outputs,
  at_ms } (type 0x44, `arena-protocol/src/donation-gift.js`) and hands it to a seat (`POST /donation-gift`).
- The seat keeps it only if:
  - the outputs are exactly that split over the set it holds for the target (a hosted game's set, or the network's set in force);
  - the federation holds each output as built;
  - the transaction is not already another gift's.
- A kept gift's outputs are indexed under each recipient key (`GET /donations?key=`), where the developer's own client already
  redeems a round's donations. The record is then handed on to every seat. `GET /donation-gifts?donor=` lists a donor's gifts.

**What changes, all of it a hard fork of the formats:** the donation set's recipient record (key instead of LNURL),
the Entry Contract (donation outpoints), the signer nodes' entry check and index, the page's lock transaction, a
recipient client. Rounds already published keep the LNURL set they name (and the 10-03/10-04 forwarder). Brought into
multiplayer_p2p.md §22A "The donation set", §24A and its payment table (2026-10-04).

### Amended 2026-11-11 (kanban #1486): no developer or reserve money for an entry that is not accepted - protocol 27

Ruled by the owner, feedback #010 (100 sat staked, 94 came back, the 6 sat donation outputs were lost although no seat took the
entry): "Er sollte keine fees entgegen nehmen wenn die order nicht angenommen wird", and "1 ja" to "should the 6 sat (developers +
reserves) come back when the seats refuse an entry?". This replaces **Not returned** above for rounds of protocol 27 and later.

**Where the money moves.** On a paid game round of protocol 27 or later (not a market: a market already does this, §0A.7a), the
entry's developers' 4 % and reserves' 2 % ride in its **fee lock**, beside the nodes' 4 %. Markets have done this since
2026-10-09. The lock transaction has **no donation outputs and no reserve output**:

| | protocol 11-20 (today) | protocol 27 |
|---|---|---|
| entry `fee_msat` | nodes 4 % | nodes 4 % + developers 4 % + reserves 2 % = 10 % |
| entry `donation_msat` | developers 4 % + reserves 2 % | 0 |
| `donation_outpoints`, `reserve_outpoint` | named, paid at lock time | none (an entry naming them is refused) |
| net stake in the stake lock | 90 % | 90 % (unchanged) |
| developers and reserves paid | at lock time, whatever happens | in the round's settlement, for counted entries only |

**How the seats check it.**
- Entry door (round.js): fee = the whole 10 % of the stake, donation 0, no reserve or donation outpoint.
- Fee-lock gate (`feeLockPays`), page and seat: sized on the whole 10 %, the rate the lock really holds.
- `/stake-lock` gate: sized on the same 10 %.
- `/fee-lock` (`verifyFeeLock`): unchanged. The lock must hold exactly the entry's `fee_msat`, under the round's claim key, H(F).
- Settlement (`feeSettlement` with `gifts`): every counted entry's fee lock is claimed as before.
  - The nodes' table is still 4 % of the gross (the fees in force at the census height).
  - Each counted entry's reserves part is its own 2 %, summed, and paid as one `reserve` payout to its federation's reserve key.
    On a round that takes any federation, each federation pays its own key (`splitByFederation`).
  - The rest of the fee locks above the nodes' table goes to the round's two donation sets (`splitDonation`), as `donation key` payouts.
    Each one lists the entries that paid into it (`parts`).
  - Both are scaled to what the claimed locks pay after the guardians' fees, as the nodes' shares are.
  - Both are indexed as rows, so `GET /donations` and `GET /reserves` list them, as a market's are.
  - A late loser's second settlement (`lateLockSettlement`) does the same with its one fee lock.

**How a refused or void entry gets them back.** They are in the fee lock, so they come back exactly when the stake does:
- **Round refused** (§23.2 REFUSED, `/refused-lock`): the fee lock is kept under H(handout id || "fee") and forfeited at once,
  beside the stake. This is unchanged code.
- **ENTRY_VOID** (an outage refund): the stake is forfeited at once. On protocol 27 the fee lock is now forfeited with it
  (`GET /forfeit?lock=fee`), under the same conditions as the stake: this seat's own record, no two first marks, the proof pull.
  The page already asks for the fee lock's forfeit whenever it redeems a stake.
- **VOID, a refunded outcome, an entry refused at the door after its lock, a seat that never verified the lock:** the fee lock is never
  claimed (`feeSettlement` counts no refund), and it expires back to the player's key with the stake lock (`stake_expiry_blocks`).
- **Late:** a late VOID or refund is not claimed. A late FAILED or FORFEIT is an accepted entry and pays like the others.

Nothing is lost except the guardians' own fee on the lock and its return. An **accepted** entry (DELIVERED, FAILED, FORFEIT,
a walk-away) pays the developers and the reserves exactly as before: the same 4 % + 2 % of its stake, now at settlement.

**One caveat** (Pick b, unchanged): where the fee-lock gate does not mint, because a lock that small cannot pay a sitting seat
after the guardians' fees, there is no fee lock. Then the nodes, the developers and the reserves all get nothing from that entry.
The 10 % stays in the player's wallet. At 10 % the gate mints for smaller stakes than at 4 %.

**Old entries keep working.** The rule is the round's version, never the entry's or the seat's word:
- A round below 27 is checked and settled exactly as before: donation and reserve outputs at lock time, a 4 % fee lock. No byte,
  check or settlement of it changes.
- A protocol-27 round is a new version (constants.js `GIFTS_IN_FEE_LOCK_VERSION`, in `SUPPORTED_PROTOCOL_VERSIONS`).
- **A mixed network does not split:** the census seats a round only on nodes whose advert lists its version (census.js). A node on an
  older release does not list 27, so it is never drawn for such a round. It keeps serving rounds of the versions it speaks.
- An older page or seat cannot decode a protocol-27 round at all ("protocol version 27, this build speaks ..."), so it neither enters
  nor settles one by the old rule.
- Posters choose the version (`max(template, game's required)`), so protocol 27 starts when the posters' templates name it, after the
  seats and the page that speak it are deployed.
- **Why 27:** 21 is the drawn attestors' label (#630). 22-26 are taken on the 2.0 branches (auditor, source hosts, founding pressure,
  census key, stall). Versions are cumulative (`>=`), so the 2.0 line must keep 27 for this rule or renumber both together.

## Rulings (2026-09-21)

- **The player wallet** (§24A.1): the round wallet is one wallet
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
  least ten guardians; testnet is 5 of 7, seven nodes, one guardian per
  node (2026-09-27); the player
  gets a BIP39 seed of 12 or 24 words to write down. Founding by sortition,
  the draining bands, several federations picked by load, abandonment and
  the bond, succession with automatic migration, and the channels are
  RULED HERE in §23A for the owner to overrule.
- **Guardians earn from the node fee** (§22A; 5% in Bitcoin Arena): three equal pools, game/verify,
  settlement, and the seated guardians of the round's federation, paid in
  the settlement transaction. The total is 5% in Bitcoin Arena (2026-10-06).
- **A slashed guardian bond** pays whoever it owes, and the rest goes to the
  protocol reserves (§23A.5, kanban #976). Nothing goes to the nodes, the
  developers or the guardians who attested the absence.
- **Leaving is free.** A guardian who serves his departure notice keeps his
  bond and his census seat; only leaving without notice is slashed (§23A.5).
- **Every role is opt-in** (§5A.1): a node advertises what it takes part in
  - game/verify, settlement, guardian, any combination or none - and is
  drawn for nothing else. A node that wants no custody leaves
  `guardian_capable` off.
- **FEDERATION is the only custody** (§23.6): THRESHOLD_LN does not exist,
  on any network, for any round, past rounds included; a record naming it
  is an invalid contract and is not decoded (2026-09-22 22:59). This
  file is no longer "V1 of two"; it is the construction.
- **Players cannot lose** (§23A.3, §23A.5): the exposure cap is `(f + 1)`
  times the smallest seated guardian bond, so the smallest set that can
  halt the federation forfeits enough to pay every note; slashed guardian
  bonds wait in a per-federation escrow under the arbitration keys; a
  federation HALTED for `abandon_blocks` is liquidated - the seated
  guardians publish the spent-note set, the client presents every unspent
  note on its own, each is paid at face - and only the remainder goes to
  the protocol reserves, as the whole bond does when a federation CLOSES
  with nothing lost.
- **Nothing is ever burned** (§5A.3, §23A.5): every slash remainder, a
  round's or a federation's, after a halt too, goes to the protocol reserves.
  `slashRemainder: BURN` is withdrawn.
- **The client** (spec §24B): balance always in the lobby, never in the
  game; settings icon top right with name, donation 0-5% and the seed
  phrase behind a **Backup** button; a no-backup notice on every load until
  the player has typed the whole phrase back once, gating nothing.
- **Fast** (§23A.1): the liquidation claim window is 36 h (the owner);
  abandonment 48 h, notice and founding 72 h, drain and late-claim tail
  **four weeks** (the owner).
- **Serving a drain is paid** (§23A.6 step 5): the guardian pool of every
  round naming the successor is shared per seat with the draining
  predecessor's seated guardians until it is CLOSED, so staying is income
  and leaving is a slash, not a slash alone.
- **Guardians are not parked** (§23.6): §23A is built now - testnet on a
  federation of seven guardians, 5 of 7, one per node; regtest on the
  4-guardian rehearsal; mainnet by founding once ten guardian-capable
  operators are bonded. `federationIsBonded` stays on.

## Rulings (2026-09-27 10:04)

- **Testnet is seven nodes and seven guardians, 5 of 7** (stock threshold
  `n - floor((n - 1) / 3)`), one guardian per node. It replaces the 3-of-4
  ruling of 2026-09-26 22:54. Mainnet stays 7 of 10.
- **Every guardian endpoint is a public `wss://` a phone can open.**
  Testnet's seven: `wss://seat.example.com/guardian-1` to
  `/guardian-7`, local ports 31221, 31231, 31241, 31251, 31261, 31271,
  31281 (spec §23A.1).
- **Zero config**: a node starts its own guardian; the operator sees one
  thing.

## Rulings (2026-09-26 22:54)

- **Testnet federation is 3 of 4**, not the 2-of-2 that ran. Mainnet stays
  at least ten, 7 of 10. Committee sizes are not this ruling. *Replaced by
  5 of 7 on 2026-09-27.*
- **One node is one guardian**, started by the node itself with zero
  configuration; the operator sees one thing, never a second service
  (spec §23A.2).

## Security findings (Fable, 2026-09-11 15:00) — RESOLVED in the spec (the owner 15:10: "alles dokumentieren und lösen")

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
