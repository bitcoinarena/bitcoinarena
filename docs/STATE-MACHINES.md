# State machines

Every explicit and implicit state machine of Bitcoin Arena: its states, transition table, invariants and where its state is kept.
Implicit ones count as much as explicit ones: a status column, a nullable field that means "done", an in-memory map or set used as a
guard, a file on disk, a retry loop, an "already paid" check, browser storage.

**How this file was made.** Three audits read the code (kanban #1148-#1195 on 2026-11-06 morning; #1204 and #1210 that evening). This file
is their state machine sections, by area (#1204) and by kind of path (#1210), merged without change. Line numbers refer to the 2.0 line
(worktree-health-199, 6e84fed99 for #1204, 14260fd20 for #1210) unless a section says 1.9 (interim-2026.1.9.17). The findings - the invalid
states and transitions the code could reach - are kanban tickets, not this file: "State machine (area, severity): ..." on the board.

**Kept up to date by the release gate** (tools/release/state-machine-audit.md, kanban #1205): before every release the audit runs on the
release commit and brings this file up to date with it - new machines added, changed ones rewritten, removed ones deleted.

## Contents
1. [Rounds and settlement](#1-rounds-and-settlement)
2. [Markets, prices, items, seasons](#2-markets-prices-items-seasons)
3. [Reserves, funding, slashing, arbitration](#3-reserves-funding-slashing-arbitration)
4. [Federations, ballots, census, seating, duty](#4-federations-ballots-census-seating-duty)
5. [The player page and its wallet](#5-the-player-page-and-its-wallet)
6. [Installer, node lifecycle, and every state-changing door](#6-installer-node-lifecycle-and-every-state-changing-door)
7. [Money paths, end to end](#7-money-paths-end-to-end)
8. [Effects and their records (crash/restart)](#8-effects-and-their-records-crashrestart)
9. [Interleavings inside one process](#9-interleavings-inside-one-process)
10. [Decisions several seats must share](#10-decisions-several-seats-must-share)
11. [State the 2026-11-06 fixes introduced or changed](#11-state-the-2026-11-06-fixes-introduced-or-changed)
12. [The page, its storage and its frames](#12-the-page-its-storage-and-its-frames)
13. [State the 2026-11-10 audits (5, 6) introduced or changed](#13-state-the-2026-11-10-audits-5-6-introduced-or-changed)

## 1. Rounds and settlement

*From #1204, `settlement.md`.*

#### SM-1 The round's settlement row (`lock_settlements`)
Files: store.js:984; round.js:3031 `putLockSettlement` (INSERT OR REPLACE); settlement.js:124 `ROW_EDGES`, `settlementRowStep`, 2214 `#putRow` (the only writer).
States: none, SUBMITTING(txid), ACCEPTED(txid), REFUSED(txid).

| from | event | to | guard |
|---|---|---|---|
| none | own pass, intent before submit (2631) | SUBMITTING(T) | none |
| none / REFUSED / SUBMITTING(T') | `take()` of a signature over this seat's own rebuild (2131) | SUBMITTING(T) | FROST verify; protocol 27: refused while SUBMITTING/ACCEPTED on another txid (2105) |
| SUBMITTING | `recordSubmit` landed (2381) | ACCEPTED(T) | `verified` (payouts stored + locks gone, or Arena `locksSpent`) |
| SUBMITTING | refused, a history txid reads `in` (2397) | ACCEPTED(**T_other**) | `verified` |
| SUBMITTING | refused, every history txid `out` | REFUSED(T) | `checkedAll` |
| SUBMITTING | kept pass: `federationSaw` / history `in` (2540-2560) | ACCEPTED(T or **T_other**) | `verified` |
| REFUSED | `recover()` history `in` (2415-2421) | ACCEPTED(**T_other**) | `verified` |
| SUBMITTING(T) | own pass, new rebuild T' (2631) | SUBMITTING(T') | **none** (see SETTLEMENT-2) |
| ACCEPTED | anything | (no move) | final |

Invariants the code means to keep: ACCEPTED only on what the guardians hold; ACCEPTED is final; REFUSED only after every kept txid was asked.
Broken implicit invariant: "the row's txid = `lock_settlement_moves.txid` = the in-memory build's txid" (SETTLEMENT-1).

#### SM-2 Federation rows and late rows (`fed_lock_settlements`, `late_lock_settlements`)
store.js:1060, 1166; settlement.js:2236 `#putScoped`, 2323 `checkScoped`, 2347 `recordScopedSubmit`, 815 `settleLate`, 2671 `#settleFederations`.
They use the same edges as SM-1 through `settlementRowStep`. History is in `scoped_settlement_txids` (store.js:1136); moves are written per txid (`keepScopedMoves` 857, 2119, 2727).
The round counts as ACCEPTED once every federation row is ACCEPTED (round.js:3082 `settlementState`).

#### SM-3 Settlement txid history, moves and shares (implicit)
`lock_settlement_txids` (store.js:1086; round.js:3144 insert once, its signature filled in later), `lock_settlement_moves` (store.js:1075; round.js:3138, **INSERT OR REPLACE, one row per round**), `lock_settlement_shares` (round.js `putLockSettlementShares`, INSERT OR REPLACE).
Writers: `keepMoves` (settlement.js:2156), called from `take()` 2132 and from the own pass at 2630. The own pass writes before `#putRow` and does not look at the row.
Readers that pair "the row" with "the moves": `federationSaw` 2172 (falls back to history), `#goneStakes` own-claim check 1415, `indexRecovered` 2783, `lateMessage` 461-466, `lockAfterSettlement` 342, forfeit.js:304, 376-380, server.js:4303, 9012, 9700.

#### SM-4 The batch a protocol-27 scope stands on (`named_batches` / `named_batch_txids`)
store.js:1109, 1123; round.js:3189 `putNamedBatch`, 3218 `standNamedBatch`; settlement.js `namedBatchStep`, 1605 `#keepBatch`, 1628 `batchFor`, 1639 `#standBatch`.
none -> standing(T); standing(T) -> standing(T') only while the row is not SUBMITTING/ACCEPTED on another txid. A batch of another S is kept beside the standing one. When the row moves to T', the standing batch moves with it (`#standBatch` in `#putRow` and `#putScoped`).

#### SM-5 Lock fate (`lock_fates`, #1184)
store.js:1236; forfeit.js:142 `LOCK_FATE`, 143 `lockFateStep`, 163 `markLockFate`; round.js:2991 `putLockFate` (INSERT OR IGNORE, then read back).
none -> CLAIMING (settlement ack 1724, asker ack 1735, share 2083, take 2113) | RETURNING (forfeit share 470, take 519/526, combine 574). Both are final, and the other one is refused. If a store has no row, it falls back to `claimedOutpointsOf` (round.js:3002).
Stored per outpoint. It is never cleared.

#### SM-6 Gone stakes F' (#1146 A, #1183)
`gone_stakes` (store.js:1096; round.js:3161, INSERT OR IGNORE, never removed), memory `#suspectGone` (set at 2647, 1702 `peerSaysGone`, 977 NO_LOCK_HELD) and `#goneLocks`.
settlement.js:1406 `#goneStakes`: kept, so gone. If suspect and the lock is not stored or has <= GONE_MARGIN_BLOCKS left, it is gone unless it is in `own` (1415: the claims of `lock_settlement_moves`, **only when row.txid === moves.txid**). Once a lock is gone it is gone for good, and `planOf` applies it to every later rebuild, ACCEPTED rounds included.

#### SM-7 Send attempt (`winnings_sends`, `donation_sends`, `late_winnings_sends`, #1154/#1186)
store.js:360, 387, 1180; send-state.js `SEND`, `sendMove`; round.js:2466 `putSendPlan` (ON CONFLICT DO NOTHING), 2481 `markSend` (compare-and-set on `statesBefore`).

| from | to | where |
|---|---|---|
| (none) | PLANNED | propose 143, check 179, checkResend 465 |
| PLANNED | HELD / FUNDING / SENDING / PAID | sendAll 750; `paid` 728 (seat-signed preimage) |
| FUNDING | FUNDING / SENDING / PAID | sendAll (txid on disk before the submit) |
| SENDING | SENDING / PAID / REFUNDED | gateway answer; refund (c) |
| PLANNED attempt 0 | deleted | `dropPlannedSends` round.js:2512 (only while every row is PLANNED attempt 0); called from `dropIfStale` 245, `check` 238, planSends loop |

Derived: CONTRACT_FATE LIVE/EXPIRED/GONE/NEVER (winnings-send.js:382). It reads attempt 0's contract at `built.txid` (340) and counts GONE only when a row is ACCEPTED on that txid (392).

#### SM-8 Which send plan is kept (attempt 0) and the plan certificate
winnings-send.js:179 `check` (a lower `planKey` replaces the kept plan only from a seat, only while `replaceable` 256: no SUBMITTING/ACCEPTED, all PLANNED); 245 `dropIfStale` (guard: **only** "not ACCEPTED"); plan-taken.js (a threshold of signed acceptances); settlement.js:2944 `planAgreed`, 2974 `takeCertificate`. `planCertificates` lives only in memory (settlement.js:274), so GET /settle-taken forgets it on restart.

#### SM-9 Settle retry (`settle_retries`, #1186) and the other retry clocks
settle-retry.js `RETRY` WAITING/SETTLED/EXPIRED, `retryStep`; round.js:2963 `putSettleRetry` (compare-and-set); settlement.js:2451 `retryUnsettled`.
none|WAITING -> WAITING (tries+1, next_at_height = tip + retryBlocks) | SETTLED (row ACCEPTED) | EXPIRED (tip >= last stake-lock expiration + 6). SETTLED and EXPIRED are final.
These live only in memory: `#retriedAt`, `#retrying`, `#settling` (one settle per round in flight, 2510), the `confirmSoon` counter (60 per round per process, never reset, 3053), `retryPlan` (120), the settle-backoff map (settle-backoff.js).

#### SM-10 FROST/MuSig2 nonce pairs (memory)
settlement.js:277 `pairs`; commit 2029, share 2065; forfeit.js `pairs`, commit 436; winnings-send.js commit 506, share 532.
fresh -> committed -> listed (signed one list, spent) -> a fresh pair on the next commit. A restart loses every pair, which is safe. Commit and share of a settlement need a seat's signed ask (`#askRefusal`, 2033 and 2070). The ack door (1720) and the send-commit/send-share doors do not.

#### SM-11 Entry finality (#1173)
finality.js:180 `finalityStep`, 168 `PENDING_OBJECTION_MS`; round.js:3684 pending_objections, 3706 `putEntryFinal` (INSERT OR IGNORE); store.js:1149, 1157; server.js:410 `withPendingObjection`, 416 `objectionIntake`, 12013-12090 POST /objection; verify.js:1473-1509 one check in flight per entry (FIFO).
computed (null / PROVISIONALLY_FINAL / SUSPENDED / FINAL / VOID / FORFEIT) -> FINAL kept once (entry_finals). A pending objection that arrived before final_after holds SUSPENDED, but **only for 120 s after its arrival**. An objection that reaches an entry already kept FINAL is re-dated to final_after and counts as late. A restart deletes all pending rows (server.js:930).

#### SM-12 Forfeit and refused-lock return
forfeits (store.js:1210; round.js:2951 INSERT OR IGNORE); refused_locks (round.js:2360, POST /refused-lock server.js:10514). `Forfeit.message` (forfeit.js) derives the result again on every call: ENTRY_VOID, qualifier FINAL, nobody won (needs ACCEPTED plus `lockSettlementMoves`/shares), attested return (needs ACCEPTED plus moves), book return, refused round. `#signable` reads the lock fate first.

#### SM-13 Stake-secret release
stake-secret.js:138 `mayRelease` (derived: FINAL plus CLAIM, attested FINAL, §13B proof, no-quorum FORFEIT); 243 `answer` (only to a seat of the round, sealed); 275 `open` (own share, then held_shares from store.js:208 / round.js:1589, then peers; reconstructed value kept in memory `openedKept`). Once a share is released it cannot be taken back. Release does not read the lock fate.

#### SM-14 Settlement acks (`settlement_acks`)
store.js:1012; round.js `putSettlementAcks`: one row per (round, scope, txid), and a row with more acks replaces it. This is evidence for offences. It never decides settlement state.

#### SM-15 Stall book
stall-book.js:51 tables `stall_notes`, `stall_noted` (once per round and stage), `settle_passes` (round.js:2807, INSERT OR REPLACE per round/scope). RESULT/FINAL/SETTLEMENT due -> noted (final) -> signed note. SETTLEMENT means "the row is not ACCEPTED 2 h after final_after" (107-112).

#### SM-16 Held reads (memory)
held-read.js:25-62: `signed` (one answer per lock per epoch) and `asks` (12 per gateway per epoch). Both are dropped when the epoch moves on and on restart. A second read after a restart may sign a different blocksLeft. Harmless.

#### SM-17 Named-claim gate (memory)
named-claim-gate.js: yes is kept for good, no is asked again after `againMs`, and a gate not asked yet refuses while it asks. Nothing found.

#### SM-18 Caches
verify-kept.js (verdicts on fixed bytes; safe), kept-read.js (key and age; `forget` bumps a generation), stake-secret `mineKept`, tx-record.js `tx_steps` (INSERT OR REPLACE, pruned by age; diagnostics). None of these moves money.

## 2. Markets, prices, items, seasons

*From #1204, `markets.md`.*

#### SM-1 Order batch (BATCH) - node/order-batch.js
States ABSENT, DECLINED, SIGNED, CERTIFIED, VOID (93-101); read by `#state` 159-166 from market_batches / market_batch_declines / market_batch_voids; moved only by `#move` 174-190 (BEGIN IMMEDIATE, compare-and-set).

| from | event (door) | to | guard |
|---|---|---|---|
| ABSENT | POST /batch `accept` 372 | SIGNED | `#check` 325 (leader, cutoff within +interval / -maxLag, orders received before cutoff and close, sells within holdings), `#signGuard` 361 (no batch held above k, none below undecided, no item in another batch) |
| ABSENT | POST /batch-void-ask `voidAsk` 572 | DECLINED | `#askStands` 550 (round seat's signed ask over a set k's leader signed, k inside the book), now >= cutoff(k)+interval |
| ABSENT/DECLINED/SIGNED | POST /batch-certificate `certify` 431 | CERTIFIED | >= needed distinct seat signatures, same batch_id as held |
| ABSENT/DECLINED/SIGNED | POST /batch-void `applyVoid` 594 | VOID | n-needed+1 distinct seat declines |
| CERTIFIED, VOID | - | terminal | |

Invariants: one set per (round,k); a seat signs upward only; an item is in one batch; VOID deletes the row and frees its items. Persisted: SQLite. Quorum intersection holds for every committee size receiptsNeeded knows (2/2, 5/7, 5/9, 2/3).

#### SM-2 Order / book event placement - node/order-batch.js
market_orders.batch / market_book_events.batch: NULL (unbatched) -> k (in batch k, `#store` 407) -> NULL again only on VOID (614-616). Tradable time = `received_ms` = max(lock verifiedMs) (`#syncTradable` 208). Invariant: an order with received_ms >= close is never batched (proposal 263, `#check` 347). Persisted.

#### SM-3 Sync read of other seats' certificates - node/order-batch.js 722-770
SYNC_STATE UNREAD -> KEPT (`#syncStep` 'kept', epoch unchanged) -> STALE (a certificate stored outside a read). In memory with per-seat cursors `#after` and the `ReplayGate` (refused orders, 10 min or forever). Restart = UNREAD (safe, costly). server.js `bookSyncedAtClose` 2377 (memory, once per round per process).

#### SM-4 Market outcome (MARKET_STATE) - proto/attested.js 278-321, node/game-market.js 108-147, node/round.js 3422-3451
| from | evidence / clock | to | guard |
|---|---|---|---|
| OPEN | first standing outcome received at t < D | ATTESTED (firstMs=t, finalAt=t+W) | evidence `receivedMs` < deadline D |
| OPEN | a held game VOID received < D | VOID (game) | |
| OPEN | now >= D, nothing received < D | VOID (deadline) | |
| ATTESTED | contradiction / game VOID received < min(finalAt, D) | VOID (dispute/game) | |
| ATTESTED | now >= finalAt | FINAL | |
| FINAL, VOID | - | terminal | casMarketState refuses (store triggers too) |

Evidence intake: POST /outcome `holdOutcome` server.js 716-744 (attestationTimely: after resolve time, before D), POST /game-outcome 10118 and the sweep (game-market.js `hold` 289-332: before D, after source end). Persisted: market_states (CAS), outcome_attestations, game_outcomes (INSERT OR IGNORE). All clocks are each seat's own (`receivedMs` = local now).

#### SM-5 Game-market sweep - node/game-market.js 406-459
In-memory `pending` map: new -> due (nextMs) -> retry every 30 s -> removed when any game_outcome is held, past D, or round gone. `fetched` source contracts (memory, 4096). Restart re-scans by rowid cursor from 0.

#### SM-6 Drawn attestor (protocol 21, kanban #630/#920) - node/drawn-attestor.js
Per round, in memory only: `samples` (40 min), `starts` (RISES rule opening value), `words` (round -> signed word or null, pruned to 512 at 122), `held` (Set). No word -> word signed once window end + 5 s passed (wordFor 85 / wordForSource 69) -> combined 5-of-7 -> `hold` (local intake + POST /outcome to peers) -> held. Restart: everything lost.

#### SM-7 Fixed attestor daemon - packages/arena-attestor/bin/arena-attestor.mjs
`samples` on disk (atomic tmp+rename, 54-60); `words`, `posted`, `noRound` in memory (63-69). Word signed once per round between window end+10 s and end+1 h (140); posting retried every 5 s to each seat sequentially, 8 s timeout each (160-170), until 200/201; no deadline awareness.

#### SM-8 Price feed - node/price-feed.js
Legacy (<5): per (round,k) LEGACY_SAMPLE_STATE SIGNED/HELD; `price_signed` written before the signature leaves (#stepSign 260), ends first-wins in `price_ends` (319-347). Protocol 5: `heard` readings per key (memory; ends k=0/kClose persisted with INSERT OR REPLACE 638), a key with two readings counts for none; sample = median of the counted readings once >= needed. RoundResult (`result` 376 / `#result5` 729): STATELESS - signed afresh on every GET /round-result over whatever readings are held then.

#### SM-9 Item purchase (PURCHASE_STATE) - node/item-purchase-seat.js 25-47, 70-125
(none) -claim (BEGIN IMMEDIATE)-> PENDING -federation checks-> KEPT; PENDING -drop-> (none); stale PENDING (10 min) taken over. After KEPT: reserve row, donation rows, gossip (server.js 9208-9212) - outside the state.

#### SM-10 Leaderboard winners (WINNERS) - node/leaderboard-freeze.js 42-55
OPEN -freeze (own read, after toMs+2h15m, INSERT OR IGNORE)-> FROZEN -plan (check passed; CAS)-> PLANNED (one list per payout; same list again ok). Callers reserve-payout.js 482 (bindWinners), 593, 820 (binds on a peer's PLANNED record), 952 (union). Persisted: leaderboard_winners.

#### SM-11 Season account a seat signs (implicit) - node/season-read.js 45-57, 108-140; proto/season.js 398-424
"Signable" = every entry's payoutMsat non-null (settlement ACCEPTED here). The signed account includes each entry's `player` = h2h identity proof (`putIdentity`, first wins) else the lobby name record's `identityPubkey` (lobby_names, newest `atMs` wins, round.js 2822) else the round key. Re-computed and re-signed on every GET /season-rounds. No terminal state: the account can change after it was signed.

#### SM-12 Nostr badges / results publication - node/nostr-badges.js, node/nostr-results.js
Rows nostr_badges / nostr_badge_defs / nostr_results: made -> (attempts, next_ms) retries -> published_ms set, or given up at maxAttempts. Week rows nostr_badge_weeks (awarded once, INSERT OR IGNORE); `boardNext` retry clock in memory. Award first-kept per (d, player, scope).

#### SM-13 Referral name - node/referral-names.js 18-50
Per site: newest (clamped) atMs wins, ties by record hash, one BEGIN IMMEDIATE step.

#### SM-14 Market earnings - node/market-earnings.js
lock_settlements ACCEPTED without market_earnings row -> row (game NULL = not a market, never looked at again). Cosmetic.

#### SM-15 Series pull / writer - node/series-pull.js, node/series-writer.js
`refusedAt` (memory, retry 5 min); writer `written` map and `broken` flag (memory, cleared by restart). Rounds themselves persisted via Round.open.

#### SM-16 App fetch / plugin install - node/app-fetch.js 95-129, node/plugin-package.js 58-102
App: absent -> cache filled (sha checked) -> staged `.fetching` -> renamed with marker. A moved pin removes the old copy before the fetch (113). Plugin: dir per game id, re-verified at load; removed = renamed `.removed-`. Both recover on restart.

#### SM-17 Grid publication (tool) - node/grid-build.js 91-128
fund -> sendrawtransaction -> announce/POST /series with retries; no record between broadcast and announcement (operator tool, re-runnable).

## 3. Reserves, funding, slashing, arbitration

*From #1204, `reserves.md`.*

#### SM-1 Reserve payout record (`reserve_payouts.state`)
Files: reserve-payout.js:79-100 (enum, PAYOUT_NEXT), 233-263 (`transition`, the one CAS write), 525-558 (`expireIfDue`), 784-860 (`learn`, `mayReplace`), 863-1170 (coordinator).
Persisted: SQLite `reserve_payouts` (one row per proposal / leaderboard id / move id), with `planned_at`, `attempt`, `submit_sig`, `refund_sig`.

| from | event | to | guard |
|---|---|---|---|
| none | own plan stands (`round`, :912) / commit opens (`commitHere`, :595) / signed record (`learn`) | PLANNED | turn holder (`mayOpen` :509), `planStands`, inputs not spent by another payout |
| none | coordinator finds no payer (:889) / signed SHORT (`learn` :789) | SHORT | `shortStands` recompute (signer seats only) |
| PLANNED | signed 5-of-7 tx kept before hand-in (`submit` :1080) | SUBMITTING | CAS |
| PLANNED | 12 blocks, all inputs unspent in federation (`expireIfDue` :555) | EXPIRED (inputs released) | port read |
| PLANNED/SUBMITTING | federation accepted (or output 0 held) | SENT (payout) / PAID (leaderboard) | `submit` :1089-1101 |
| SENT | contract expired (`advance` :1156) | REFUNDING -> REFUNDED | refund sig kept first |
| SENT | gateway preimage checks (`advance` :1161) | PAID | sha256(preimage) = paymentHash |
| PAID (move) | destination claim accepted (`claimMove` :1060) | CLAIMED | CAS |
| EXPIRED | next attempt plan | PLANNED (attempt+1) | `laterAttempt` |
| any non-terminal (via `learn`) | guardian-signed record | along PAYOUT_NEXT | `saidByGuardian` :679, `federationSays` :756, `planStands` only when this seat is a signer of `rec.plan.federation` (:817-821) |

Invariants: one record per proposal; an outpoint is held by at most one proposal (`reserve_payout_inputs` PK); terminal REFUNDED/SHORT/CLAIMED.

#### SM-2 Reserve input lock (`reserve_payout_inputs`)
reserve-payout.js:107, 225 (`spentBy`), 251-255 (insert inside `transition`), 250 (release on EXPIRED / new attempt).
States: free -> held(proposal) -> free (only by EXPIRED/replace of the same proposal). Keyed by outpoint string ONLY (no federation).
Consumers: `unspent(fed)` :275, server.js:1902-1908 `reserveHeldSats`, server.js:1953-1960 `moves()` (drained-federation amount), GET /reserves figures (server.js:1739).
Invariant assumed: only a real plan of the federation that holds an outpoint can hold it. Not enforced (RES-2).

#### SM-3 Reserve signing nonce pairs (memory)
reserve-payout.js:222 `pairs` Map `${planId}:${kind}` -> up to 8 pairs; pair: share null -> share set (list fixed) :612-647.
Lost on restart (safe: a fresh pair is drawn). Commit/share asks must be signed by a member of `guardians().get(fed).members` (`askStands` :488).

#### SM-4 Reserve committee and reserve key (derived + memory + DKG DB)
server.js:1675-1688 `reserveGuardians` (members = census entries whose advert names the federation in `guardianOf`, reserve-members.js:11-22);
server.js:1696-1721 `reserveKeyFor` (key kept per epoch, reserve-key-cache.js); server.js:1722-1735 `reserveRound` (DKG every 2 min);
arena-protocol/src/dkg.js:411-423 (combine needs a contribution from EVERY member).
States per federation: no members -> members(epoch E) -> DKG dealing -> key(E) kept -> (members change) -> key dropped (`dropMoved` :1725) -> DKG for E'.
Invariant assumed: members are the federation's real guardians. Not enforced (RES-1).

#### SM-5 E-cash exchange (`ecash_exchanges.state`)
ecash-exchange.js:25-32 enum, 56-67 CAS transition, 86-142 `step`, 145-170 `send`.
none -> receiving (row before reissue) -> taken | refused -> sending (pay amount named) -> paid. Key: sha256 of the trimmed e-cash STRING (:78).
Persisted: SQLite. Serialized by an in-process promise queue (:51, :79-80).

#### SM-6 Funding payment row (`funding_payments`)
funding-book.js:47-73 (`fundingPaymentStep`: null -> FIXED -> CANCELLED; FIXED -> FIXED refix while nothing payable), 186-202 (CAS write), 203-238 (`payments`).
Tranche count = f(amount) since #1175 (:37). Persisted SQLite.

#### SM-7 Funding signal / vote outcome
funding-book.js:383-405 (`decide`: signal outcome written once, INSERT OR IGNORE `funding_outcomes`), 104-181 (`voteRound`: census once, blocks by hash, outcome once, reopened on reorg of the counted last block).
signalling -> passed | failed (never revisited). voting -> passed | failed (reopens only on reorg).

#### SM-8 Reserve alarm (`reserve_alarms`)
reserve-alarms.js:21-55 (`alarmStep`), 61-113. null|WITHDRAWN -> RAISED -> CONFIRMED (2 seated signers) ; RAISED|CONFIRMED -> WITHDRAWN (unbacked spend reorged).
Effects: deposits refused (`alarmRefusal` :121), liquidation halt source (liquidations.js:20-24), theft slashes. Persisted SQLite (server.js:5719-5724).

#### SM-9 Liquidation mirror (memory)
liquidations.js:20-25 halt sources (record, seats' halt proof, standing alarm); :25 `copies` Map fid -> signer -> newest spent-set copy, memory only, refilled by guardians every 10 min (server.js:6445-6460).

#### SM-10 Liquidation claims + arbiter payout (`claims` Map persisted by `save`; `v` state in the arbiter's state file)
liquidation-claims.js:29-64 `offer` (nonce -> claim, refused if claimed or in spent set), 71-101 `offerPending`, 104-126 `plan`, 144-235 `payOutLiquidation`:
none -> escrowTxid -> claimedMsat -> per batch notesPay ASKED -> PAID (paidNonces) ... -> after window remainderPay ASKED -> PAID (remainderTxid).
Inputs: tools/arbiter.mjs:426-441 `liquidationOf` (first seat that lists the federation; first spent-set copy any seat lists).

#### SM-11 Keyed payout (NONE -> ASKED -> PAID)
keyed-payout.js:14-60. ASKED (key + list) saved before the tool; retry reads `pay-sent` back; rejected -> next key `key#n`.
Used by slash-release-run.js:642-688, liquidation-escrow-run.js:381-436, arbiter.js:476-497, liquidation-claims.js:205, 224.

#### SM-12 Slash carrier output (`slash_carried`, `slash_margin_owed`, memory `carrying`)
slash-release-run.js:607-694 (`payOn`): {} -> claimedMsat -> pay ASKED -> paidTxid (+ margin owed written in one transaction :679-684). Re-entry guarded by the server's `carrying` flag (server.js:4643) and the per-tag Set.

#### SM-13 Liquidation escrow claim locks (`liq_claim_locks`) and carried outputs (`liq_carried`)
liquidation-escrow-run.js:42 CLAIM_LOCK free -> held -> carried; :327-354 lock taken synchronously before signing; :381-436 carry with keyedPay.

#### SM-14 Slash release send (`slash_release_sent`), fee coin (`slash_fee_coins`), census-key anchor
slash-release-run.js:49, 99 (none -> proposed -> sending -> sent); slash-start-run.js:31, 95 (none -> funding -> funded -> filing -> filed); census-key-run.js:48 (anchor none -> sending -> refused|sent). All persisted.

#### SM-15 Census-key signer session (memory)
census-sign.js:41-43, 87-98: none -> committed -> used, CAS; caps perDigest 4 / perKey 32 / total 256 / checking 16 (:31), sessions pruned after 10 min (:98). Door unauthenticated (server.js:12231).

#### SM-16 Arbiter MuSig2 session (memory)
arbiter.js:540-589: open -> signing -> closed; `allow` checked at nonce and partial. Policy tools/arbiter.mjs:411 (no open/handled proof against the node).

#### SM-17 Hold return (`hold_returns`)
hold-return.js:31-32, 142-160: none -> owed | kept | sent; owed -> kept | sent; kept and sent final. Persisted in round.db (server.js:4395).

#### SM-18 Donation gift (`donation_gifts`, txid UNIQUE) - donation-gift-seat.js:13-46: none -> kept (one txid one gift).
#### SM-19 Faucet book (tools/faucet.mjs:42-95) - serialized queue; grant row written before paying, removed on failure.
#### SM-20 Zap pending (zap-address.js:47-72) - pending (JSON file) -> receipt | expired; no cap on pending.

## 4. Federations, ballots, census, seating, duty

*From #1204, `federation.md`.*

#### Part A: founding, records, halts, update stage, retire, guardians, gateways

##### SM1 Founding phase (one founding, one seat)
Files: founding.js 50-53 (PHASE, NEXT, foundingStep), 63-212. Persisted: memory only. The own code is kept on disk in
`<guardian dir>/founding-code.json` (founding-seat.js 204-208, founding.js 124-142).

| from | event | to | guard |
|---|---|---|---|
| COLLECTING | every seated code held, own posted, addPeer for each, startDkg | DKG | founding.js 184-197; `added` set (in memory) stops a peer being added twice |
| COLLECTING | thresholdOf(seated) seated nodes' own seats say `federation: true` | RUNNING | federationSeen 101-108 (node must be seated; seat bound to its census endpoint in founding-seat.js 415-427) |
| DKG | own guardian `setup.done()` true | RUNNING | 152-153 |
| DKG | threshold of seated say so | RUNNING | 101-108 |
| COLLECTING, DKG | tip >= windowEnd | VOID | 156-160 |
| COLLECTING | no-shows past the alternates | VOID | 167-174 |
| RUNNING, VOID | anything | unchanged | foundingStep, 150 |

Side state: `codes` (first signed code per node wins, take 85-94), `noShows`, `seatedSince` (alternates seated at the tip of the advance
that replaced them, 176), `posted`, `started`, `refreshed` (one fresh setup per founding in postOwn, 133-138).
Invariants: RUNNING and VOID are final; a code counts only signed by its node under the trigger height's tag; a no-show is never seated again.

##### SM2 Founding seat: trigger, current founding, voided draws, fresh setup
Files: founding-seat.js 243-441; freshSetupStep 163-177; fileKeySet 180-192; node-start.js 129-145 (freshSetup re-reads the key files).
Persisted: `current`, `voided`, `capable`, `loads` in memory; foundings a fresh setup was asked for in `<guardian dir>.fresh-tried.json`
(server.js 5943).

| from | event | to | guard |
|---|---|---|---|
| no current | trigger t, beacon and census read | current = createFounding(t) | 356-408 |
| current (key k) | trigger key changes | new current | 356; a RUNNING founding keeps its trigger (343, 2.0 only) |
| draw k, no current | tip >= t.height + window | voided(k) | 347-350 (2.0 only) |
| current | founding VOID | voided(k) | 439 |
| current, via null | guardian now in setup, or freshWait | current rebuilt (codes re-read, phase reset) | 356 |
| named, no guardian in setup | GUARDIAN reading DOWN, not tried | tried(k) on disk, then guardian freshSetup | 383-399, freshSetupStep 170-177 |
| named | reading UNKNOWN | freshWait, asked again next tick | 391 |

Invariants: nothing set aside on an UNKNOWN reading; tried is written before the guardian is touched; freshSetup refuses when key files exist.

##### SM3 Federation record kept per federation (one seat)
Files: federation-records.js recordStep 102-111, keep 170-187, gather 627-702, mirror 738-784, restore 705-736, mySignature 606-624,
mySignatureWithGone 811-872. Persisted: `store.save` (newest per federation) and `store.saveAt` (per height); `kept`, `draining`, `halted`,
`history` in memory (160-167). Doors: GET /federation-record server.js 11515-11539 (no auth), GET /federations 11803, GET
/federation-records-at 11792.

Status derived from the signed body: OPEN / DRAINING / CRITICAL / HALTED / CLOSED (arena-protocol federation-record.js statusFor 47-53;
7 guardians: 7 seated OPEN, 6 DRAINING, 5 CRITICAL, <5 HALTED; threshold 5).

| kept | next (verified at threshold) | from | result | guard |
|---|---|---|---|---|
| none | any | any | taken | recordStep 103 |
| height h | height < h | any | refused (still into history) | 104, 178 |
| height h | height > h | any | taken | 105 |
| CLOSED at h | not CLOSED at h | any | refused | 106 |
| X at h | worse at h | mirror | refused | 107-108 |
| X at h | better or equal at h | mirror | taken | 109 |
| X at h | anything at h | gather, restore | taken | 109 |

Side effects of a take: `draining` set for DRAINING/CRITICAL/CLOSED/HALTED else cleared (182); `halted` keeps the lowest height of the
current HALTED run and is cleared by any non-HALTED take (183-185).
Gather is a two-ask protocol: ask 1 every guardian signs the plain body (no one gone) for anyone (mySignature 606-624); ask 2 the body with
gone named, each gone entry checked by the signer (mySignatureWithGone 811-872, the #1157 fix). A failed gather falls back to mirror (896).
Invariants (intended): CLOSED final at its height; no gone without a proof each signer checks; height only grows.

##### SM4 Halt clock and halt proof (one seat)
Files: halts.js clockStep 54-65, observe 91-124, take 127-135, proofOf 138-151; arena-protocol halt-proof.js haltProof 63-101.
Persisted: `<store>.halts.json` (observations, newest height per observer and federation; `seen` per federation) - server.js 5854-5856.
Door: POST /halt-observations server.js 11814-11819 (any active census seat's signed observation).

| clock (seen) | event | to | guard |
|---|---|---|---|
| none | pass | { session: reading or 0, firstHeight: tip } | 56 |
| S | reading > S | { reading, tip } | 57 |
| S, old rule | reading != S | { reading, tip } | 57 |
| S, never heard | no reading, need-1 peers name > S | { that session, same firstHeight } | 60-63 |
| S | tip - firstHeight >= abandon_blocks | signs observation at S, posts it | 113-119 |

Proof: >= haltQuorum observations at one session S each spanning abandon_blocks (halt-proof.js 74-89); void if `laterSession > S`
(91-92); halts.js passes this seat's own session as laterSession only when every kept observation is below it (146); void if this
seat's reading this pass is below S (149, #1158). Observations never expire.

##### SM5 Update stage per fellow guardian (2.0 only)
Files: update-stage.js FELLOW 31-38, fellowStep 60-68, stageDecision 79-104, createStageBook 107-121; doors GET /release and GET
/update-stage server.js 7081-7116. Persisted: table `update_stage_seen (node, version, since_ms)`.

| fellow | reading this ask | to | row kept |
|---|---|---|---|
| any | none / unsigned / wrong nonce | SILENT (on trial) | deleted |
| any | signed, other version | ELSEWHERE | deleted |
| any | signed, on V, healthy false | TRIAL | deleted |
| any | signed, on V, healthy | TRIAL until now - max(since, startedAt) >= 1 h, then PROVEN | { V, since } |

Go when onTrial + waitingBefore < f (node-key order among ELSEWHERE). `healthy` is the fellow's own `fetch('http://127.0.0.1:<apiPort>/')`
answering at all (server.js 7082-7085).

##### SM6 Retiring an empty federation
Files: federation-retire.js 47-56 (retire book), server.js 5717 (`<store>.retire.json`), 5806 (retiringOf), 5809-5825 (timer), 8038-8063
(owner door). 1.9: server.js 4782, 4786-4800, 6873-6895. Persisted: retire.json; guardian dir renamed by node-start.js retire 110-120.

| from | event | to | guard |
|---|---|---|---|
| none | owner POST /owner/federation/retire, typed RETIRE | consented | audit holdsNothing and record reserve 0, at that moment only (8053-8060) |
| consented | own gathers / signs | this seat builds the body CLOSED | retiringOf (federation-records.js bodyFor, closed: true) |
| consented | record CLOSED, no successor, threshold of guardian seats list it CLOSED | guardian dir set aside, setup guardian started; book `retiredAtMs` | 5813-5822 |

No revoke, no expiry, no re-audit.

##### SM7 Guardian RAM snapshots and restore
Files: guardian-ram.js ramRestore 42-82, takeClean 84-90, ramGroupSnapshot 141-178, ramFinal 180. Persisted: `<data>/ram-snaps/` (snap-*,
`current` symlink, `clean` marker), RAM dir under /dev/shm.
States: on disk -> in RAM (first snapshot = disk copy); running (group snapshot each minute, all frozen together or none written);
clean stop (ramFinal writes `clean`); restore: clean (marker matches) | unclean (any other snapshot) | fresh (never snapshotted) | refused
(no RAM, no snapshot). The clean marker is removed at every start (84-90). No finding.

##### SM8 Guardian recovery after an unclean restore
Files: guardian-recover.js decideGroup 136-167, ramRecover 223-269, decide 303-334, latecomer 341-356. Persisted: `<RAM base>/recover/<fed>/`
(peer-<id>.json, verdict.json, decide.lock dir).
Verdicts: consistent | repair (drop 0x05+0x01 on the top, behind ones lone) | lone (wait for a peer past its session, then start) |
unchecked | refuse. Lock: mkdir decide.lock, stolen after verdictWaitMs. loneWait takes the highest single peer answer (173-184), but a timeout
starts the guardian anyway (268), so a lying peer changes nothing a timeout would not. No finding.

##### SM9 Gateway watch per federation (a guardian)
Files: gateway-watch.js 48-58 (epochs, volumes, cursor, seatedBy), probeOnce 104-157, view 159-244. Persisted: tables gateway_probes and
gateway_state (server.js 5986, 5999). Epoch rows kept 2 epochs, seatedBy 4; the volume cursor and the volumes saved together (155), so a
crash between them re-reads, never double-credits. Probes are timer-only (server.js 6052-6060). No finding.

##### SM10 Founding pressure reading (2.0 only)
Files: founding-pressure.js 36-82. Persisted: `answers` per trigger height, in memory. States per trigger height: unknown -> B*_net | null
(cached) ; or throws ("not yet") while a record handed in cannot be checked for want of the census at its height (70). Records are taken
from every reachable seat's GET /federation-records-at (43-51), unbounded per seat.

##### SM11 Small derived states (no finding)
- federation-endpoints.js createEndpointsOf 69-92: per federation endpoints cached 10 min (1 min on a miss); local client.json first, else
  the first guardian that answers client_config.
- opening-federation.js 10-16: the federation a new round opens on = lowest load among records with status OPEN (reads SM3).
- pegin-check.js peginVerdict 36-59: mismatch | waiting | credited | unchecked, pure.
- guardian-probe.js guardianAnswers 56-69: ours / not ours / no answer, pure (password-checked).


#### Part B: ballot, census, seating, presence, absences, heartbeat

##### B1. Config proposal (ballot) - proposals.js, ballot-tally.js
States: COUNTING | PASSED | FAILED | ORPHANED (`PROPOSAL_STATE`, proposals.js:38). Persisted: `ballot_proposals(id, json)` (server.js:1473-1475, INSERT OR REPLACE per row, never DELETE). In memory: `held` Map (proposals.js:48), tally's `open` / `votesByHeight` / `hashByHeight` caches (ballot-tally.js:76-79).

| from | event | to | guard |
|---|---|---|---|
| (none) | POST /proposal or peer pull, `add` | COUNTING | deposit in the named block of this chain (main.js:466-472, `confirmations >= 1`), `proposalStands`, history known (else 503) (proposals.js:80-131) |
| COUNTING | pass: phase read, last voting block `depth` deep | PASSED / FAILED | `transition` CAS on state (proposals.js:59-78), anchor = hash of last voting block (ballot-tally.js:237-241) |
| PASSED/FAILED | anchor hash differs, publication block same | COUNTING | `undecide` (ballot-tally.js:162-163) |
| any but ORPHANED | publication block differs | ORPHANED | `orphan` (ballot-tally.js:160-161) |
| ORPHANED | publication block same again | COUNTING | `restore` (ballot-tally.js:153-154) |
| ORPHANED | posted again from another block | COUNTING | `add` re-checks, `transition(ORPHANED->COUNTING, record)` (proposals.js:124-127) |
| COUNTING (open) | last-read block hash differs / is above the tip | COUNTING, votes re-read | `open.delete` (ballot-tally.js:155-158) |

Invariants: an RPC error never moves state (chainHashReader throws, pass skipped: ballot-tally.js:48-55, 187-190); store write precedes memory (proposals.js:50-53); a decided proposal is not re-tallied; invalid-on-face proposals (#1196) never counted. The #1152 fix (three answers, never delete, peer pull, min depth) is present and correct on 2.0; see FED-B5 for one cache gap it left.

##### B2. Census cache (roster) - roster.js, main.js
States per (series-or-census key, view start, census height): absent -> derived (memory `this.censuses`, roster.js:257, 619) -> stored (`census_kept`, roster.js:151-155) ; refusals memoised per block object in `REFUSED_AT_BLOCK` (roster.js:132, 609-612). main.js `chainCensusKept` (main.js:400-429) keys by height AND block hash.

| from | event | to | guard |
|---|---|---|---|
| absent | censusFor, derivation matches the round's root (or root less a held absent claim) | derived + stored | root compare (roster.js:592-621) |
| absent | derivation does not match | refused (memoised per block object) | not memoised while the absent claim is "not yet" (roster.js:610) |
| derived | any later ask with the same memory key | derived (returned as is) | non-series: root compare against kept root; series: none (roster.js:543-553) |
| stored | restart, ask | derived | store key carries the census block hash (#786, roster.js:564-570) |

Invariant intended (#786): a census kept on a branch the chain left is never served again. Holds for the store and main.js, not for the memory key (FED-B2).

##### B3. Reserve seating - seating-agent.js
States per (round, role): no PRESENTs -> PRESENTs held (`seat_presents`) -> own signature (`seat_signed`, one row, may be replaced by a justified second signature #738) + `seat_sigs` (every signature by seating id) + `seat_seen` -> certificate (`seat_certs`, first wins, INSERT OR IGNORE: seating-agent.js:207) | equivocation (`seat_equivocations`: 199). In memory: `certs`, `seatings`, `starts`, `tables`, `resting`/`failing` (peer backoff), `reseats`.

| from | event | to | guard |
|---|---|---|---|
| none | POST /present, own PRESENT | PRESENT held | verifyPresent, window, drawn or left out (seating-agent.js:340-365) |
| PRESENTs | seating_close tick, seated | own signature | no cert, no `seat_signed` row, `presignMine` (seating-agent.js:682-692, 698-720) |
| own signature S | a member signed T not before S | own signature S' | canNeverStand + ordered rule + justification (seating-agent.js:747-812) |
| signatures | all seated signed one seating | certificate | keepCert, second differing cert -> equivocation |

Invariant: no seat signs one seating twice (checked against `seat_sigs`: seating-agent.js:700-704). The three writes of one signature (`seat_signed` 706, `seat_sigs` 709, `seat_seen` 715) are separate statements (FED-B6).

##### B4. Presence book / absent claims - presence-book.js
States per census root: no claim -> claim held (`absent_claims`, INSERT OR REPLACE: presence-book.js:418) ; proofs `presence_proofs` / `presence_certs` (INSERT OR IGNORE), heartbeat certs `hb_certs` (bigger replaces smaller: 341-348).

| from | event | to | guard |
|---|---|---|---|
| none / held | POST /absent (server.js:11665-11668, no auth), fetchClaim from a peer (server.js:2677-2682), own posting (2767) | held (replaced) | well-formedness only (presence-book.js:386-420) |
| held | roster censusFor of a 22 round | census less absent, or refusal memoised per block | root less claim nodes = round's root, proofs checked (roster.js:470-492) |

Invariant intended: absence only with proof (threshold-signed certificates). The claim slot itself is last-writer-wins and unauthenticated (FED-B3).

##### B5. Absences, departure notices, emergency requests - absences.js, absence-producer.js
Per (fid, peer, attester): newest attestation; per (fid, peer): ONE departure notice, newest `postedAt` wins (absences.js:78-87); per node: earliest emergency request (92-101). Cap `max = 4096` per map. Persisted as one JSON file `<db>.held-absences.json` (server.js:667-673, `writeFileSync`, rewritten whole on every offer). Producer: `lastSeen` / `lastSigned` per peer id, JSON state file (server.js:6373-6374).

| from | event | to | guard |
|---|---|---|---|
| none / older | POST /absence (server.js:11567-11571), own producer | attestation held | signed by its attester (any key) |
| none / older notice | POST /departure (server.js:11607-11611), own Leave (7663) | notice held for (fid, peer) | signed by the node key the notice itself names (absences.js:79), newer postedAt |
| none / later | POST /emergency-departure (takeEmergency, server.js:2831-2848) | request held | advert names the emergency key, fresh (emergencyDepartureStands) |
| notice held | record gathering at leave_after (federation-records.js:668, 678) | gone row DEPARTED | departureFor -> departureStands (node key must be the record's) |
| attestations 2f+1, abandon_blocks | record gathering | gone row ABANDONED (slashable on 2.0: arbiter.js:379-389) | abandonmentProof |

Invariant intended: a guardian that gave notice is DEPARTED, never ABANDONED, its bond untouched (§23A.5 "Leaving is legitimate"). Broken by FED-B1.

##### B6. Heartbeat slots - heartbeat-agent.js
Per (round, slot): beats (`hb_beats`, first per node) -> own HEARD (`hb_heard`, first per member, signed once after close) -> certificate (`hb_certs`, replaced by one with more signers). In memory: `sent` (beat once per process), `heardOut` (resend once). A restart before close can sign a second HEARTBEAT (different bytes, harmless: INSERT OR IGNORE at members). No finding.

##### B7. Others (derived, no transitions worth a table)
`standing.js` (entry standing recomputed per read from finality and settlement rows), `node-standing.js`, `uptime.js` (`uptime_spans`, owner page only), `seatings.js` (missed-in-a-row counter, owner page), `source-ballot.js` (stateless steps; the page holds the deposit txid), `approved-sets.js` (publisher tool's kept tally; replaced by the last answer of one local seat).


#### Part C: duty, adverts, owner and operator doors

##### SM-C1 Day posting (one per item and day slot, primary or backup)
Files: `duty-day.js` createDayDuty 206-647; `duty-guard.js` dayDueCapped 272, postingVerdict 204, dayVerdict 224; protocol `duty.js` dayPostDue 130, backupPostDue 169.
States: NOT_DUE -> DUE -> PUBLISHED (kept file, verdict pending/unconfirmed) -> {published, beacon, seats, drawn} | DEAD; day verdict none | pending | drawable | dead.

| from | event | to | guard |
|---|---|---|---|
| NOT_DUE | clock reaches rank's hour | DUE | `posted` false (620-623), rank <= cap (625), order read, mempool read (604-608) |
| DUE | `publish` returns | PUBLISHED | canPay (632); file written by `keep(k)` 284 after the broadcast |
| PUBLISHED | judge each pass | stage update | postingVerdict 400; reorg of census block -> DEAD 387 |
| PUBLISHED | wallet confirmations < 0 | DEAD | 398-399 |
| any | marker of the day that counts | posted=true | `marks.some(m.counts ...)` 620 (#1168) |

Invariants: one primary per day per item network-wide; "posted" read only from markers that count (OWN/DUTY/TRUSTED) or this node's own wallet tx (621-623).
Persisted: `<dir>/<item>-<slot>.json` and `-e<n>.json` (keep 234), `status-<item>.json` (570). Memory: `seen.mine`, `censusAt`, `poolSeen`, `creatorOfTx`.

##### SM-C2 Marker standing (MARKER, derived each pass, #1168)
Files: `duty-day.js` 50-74 (markerStanding 67), creatorOfMarker 237-245, standingOf 247-258, look 600-605; `duty-poster.js` creatorOf 318-326; `server.js` announcedCreatorOf 12795.
States: OWN | DUTY | TRUSTED | UNREAD | FOREIGN.

| input | to | guard |
|---|---|---|
| txid in kept files / replaced / seen.mine | OWN | 235 |
| some ARNS id in the tx has a held or announced line whose creator is in the day's order | DUTY | 240-243, 72 |
| creator in ARENA_DUTY_CREATORS | TRUSTED | 70 |
| no creator / no order | UNREAD | 69, 71 |
| creator outside both | FOREIGN | 72 |

Invariant intended: only a duty poster's posting counts. Persisted: nothing (recomputed); `creatorOfTx` (txid -> creator) memory only, never invalidated. NOT bound: the marker's tx to the series' publication, the series' game to the marker's item, the series' day to the marker's slot (see FED-C1).

##### SM-C3 Fee raise of a posting (BUMP, #1168)
Files: `duty-day.js` BUMP 83-95, settleBump 373-380, judge 404-411, look 584-585.

| from | event | to | guard |
|---|---|---|---|
| NONE | unconfirmed, mtp >= committee - 3 h | ASKED (file written) | 404-406 |
| ASKED | bumpfee answers | DONE + new txid, replaced[] (file written) | 408, 411 |
| ASKED | bumpfee throws | DONE, txid unchanged | 409 |
| ASKED (at start) | wallet `replaced_by_txid` | DONE + that txid | 376-377 |
| ASKED (at start) | no replaced_by_txid OR the RPC threw | NONE | 376 `catch { by = null }`, 378 |

Invariant intended: the posting's file always names the transaction the wallet holds. Persisted: `k.bump`, `k.bumped`, `k.replaced` in the kept file. See FED-C2 for the two error edges.

##### SM-C4 Re-announce and keep-alive of a posting (#1126)
Files: `duty-day.js` reannounce 431-445, keepAlive 451-489, postKept 333-349.
States per posting: announcedTxid == txid (done) | announce {txid, tries<=6, atMs}; posted [{took, of}] + postedAtMs; lastSent (memory).
Guards: not dead, day not over, every 10 min (DUTY_RESEND_EVERY_MS), lines posted only once the posting's own txid is in a block (338).
Persisted: kept file; `lastSent`/`inFlight` memory only (a restart sends at once - harmless).

##### SM-C5 Emergency grid of a day
Files: `duty-day.js` watch 495-569; `duty-guard.js` emergencyDue 239-255, foreignConfirmed 50.
Inputs: own emergency postings not dead + foreign counting emergency markers (516), in flight (517-518), confirmedAny (521-522).
Transitions: not due -> due (dead / nothing posted in duty hours / not drawable by start-4 h or committee+4 h / no confirmed rounds by start-8 h) -> waits rank*20 min (`dueSince` memory 530) -> published (`-e<n>.json`). Blocked by: day over, in flight, emergencies >= 3.
Invariant: at most 3 emergency grids per app per day, counted from markers that count (#1168).

##### SM-C6 Duty poster engine and wallet (duty-poster.js)
Files: `duty-poster.js` 154-436. States: setting off|on|auto x wallet canPay (readWallet 169-176, on 178, canPay 179); engines per game/role (memory); chainView cached by best hash (183-193); `creators` map rebuilt when held count changes (319-324).
Guard: auto posts only with a payable wallet. Persisted: nothing beyond SM-C1 files.

##### SM-C7 Announced grids (POST /expected)
Files: `server.js` announceGrid 6074-6098, door 7174-7178, expectedEntries 6100-6110, pendingRead 6178-6200; 1.9 5021-5042, door 6052.
States per series id: absent -> announced {creator, publication.txid} -> (ON CONFLICT) re-announced with another publication -> gone after lastClose.
Guards: creator signature over series id (6080-6081), the tx bytes carry the series' ARNS output (6083-6084). Not guarded: who posts, whether the tx is valid, signed, broadcast or the same one as before (FED-C5).
Persisted: `expected_grids` table + `announced` Map.

##### SM-C8 Owner (owner.js)
Files: `owner.js` createOwner 70-171; `owner-leave.js` takesRound 42; doors `server.js` 7302-8215.
States: UNOWNED(code) -> OWNED -> LEAVING <-> OWNED; settings sub-state.

| from | event | to | guard |
|---|---|---|---|
| UNOWNED | POST /owner/claim with the log's code | OWNED | 118-129: signature, code, 409 if owned |
| OWNED | signed leave | LEAVING(atMs) | authorize 163-169; idempotent (135) |
| LEAVING | signed stay | OWNED | 142-147 |
| OWNED | any signed action | action | authorize: signature, +-120 s, `used` replay set (73, memory) |

Invariants: one owner; every POST door under /owner/ except claim calls `owner.authorize` (checked: 7612-8215). Persisted: owner file (store.write); replay set `used` in memory only (a restart forgets it for the 120 s window - feeds FED-C4).

##### SM-C9 Operator tokens (operator-tokens.js)
Files: `operator-tokens.js` 33-79; first() called at start `server.js` 945 (1.9 869); door `server.js` 7266-7300.
States: list of {id, hash, scopes}; [] -> (start) pairing token minted -> minted/revoked by owner signature (7612-7621).
Invariant intended: a token exists only if the owner minted it or at first start. Conflated: an empty list after revoke-all reads as "first start" (71) (FED-C7).
Persisted: token file (store.write), pairing file 0600 + log line.

##### SM-C10 Own advertisement (advert-self.js)
Files: `advert-self.js` ownAdvertDue 50-69, advertSelfOnce 96-136, createAdvertSelf 155-182; `server.js` 6401-6442.
States: current | due -> read (lastRead, memory) -> posted (`.advert-self.json` {txid, want, atMs}) -> census takes it 6 deep.
Guards: same `want` within 6 h (52-53); a recorded update still in the mempool (99); a scan lock file per bitcoind (76-88).
Persisted: `.advert-self.json` written AFTER the worker broadcast (178) (FED-C6); lock file.

##### SM-C11 Address book (address-book.js)
Files: `address-book.js` take 17-26, own 28-34; protocol `address-announcement.js` 38-51.
States per node: none -> newest {endpoint, atMs}. Guards: node signature, atMs <= now + ADDRESS_FUTURE_MS (43), strictly newer wins (51). Persisted: `address_announcements`. No finding.

##### SM-C12 Window chain header view (tip-view.js)
Files: `tip-view.js` 23-57; used as `round.chainView` (`server.js` 1064, `main.js` 659).
States: pending -> view {firstHeight, headers}; a block that does not link drops 12 and re-reads (38-43).
Invariant gap (no finding): a reorg that keeps or lowers the height is not seen until a block above the held tip arrives (loop 36 does not run when `tip <= held tip`). The evidence it feeds now decides by `seen_ms` (round.js markCounts 2688-2693), so the stale tip hash is cosmetic there.

##### SM-C13 Beacon source (beacon-source.js)
Files: `beacon-source.js` 41-136. States per (committeeTime, depth): unread -> reading -> held; held -> dropped when the window shows another hash at its height (121-127), re-checked every 30 s. Memory only. No finding.

##### SM-C14 Publication wait (publication-wait.js)
Files: `publication-wait.js` awaitPublishedBeacon 40-94. Loop state (memory): current txid, rate, bumpedAt; -> ok (beacon above publication) | dead (beacon at/before publication) | throw after maxLooks. Fee raised only after a block that took other txs. No finding.

##### SM-C15 Spent-set copy (spent-set-producer.js)
Files: `spent-set-producer.js` 33-69; timer `server.js` 6445-6458 (halted federations only). Stateless: nonces read, then session_count, signed as session-1. The two reads are not atomic, but run only for halted federations, where no session completes in between. No finding.

##### SM-C16 Service at-boot settings (service-settings.js, service-control.js)
`service_settings` (id, at_boot), default on (11); setAtBoot only for OWN_SERVICES (12-13); doors `/owner/service(s)` authorized (7809-7900). No finding.

## 5. The player page and its wallet

*From #1204, `client.md`.*

#### SM-C1 E-cash in flight: merge and exchange records (kanban #1149 fix)
Files (2.0 @ 6e84fed99): `packages/arena-client/src/ecash-transfer.js` (edges 30-38, step 43-51, CAS move 70-81, sendKeptEcash 151-171, recoverEcashIntent 174-184, receiveKeptEcash 193-225, advanceEcashExchange 243-283, exchangeEcashInto 290-319, resumeEcashExchanges 322-337); lock client `lock-client/src/lib.rs` sendAllEcash 828-844, sendEcash 847-857, sentEcash 862-878, receiveEcash 924-940; drivers `src/arena-ui/index.html` merge receiveKeptPass 7889-7928, mergeOne/take 7954-7995, handover 7660-7666, exchange ARENA_EXCHANGE_INTO 5122-5156, ARENA_PREPARE_FUNDS 5158-5183 (called from the lobby paint, 8708).
Persisted: localStorage `arena.ecash.pending.<fed16>.<ms>.<from>` (merge), `arena.ecash.exchange.<ms>.<i>` (exchange), one JSON record each `{v:3,state,...}`; the bearer string also in the sending wallet's operation log tagged `{arena_intent: key}` (2.0 lock client only). Seat side: `ecash_exchanges` table (packages/arena-node/src/ecash-exchange.js 25-31, #1160).

| from | event | guard | to |
|---|---|---|---|
| none | intent written (putRoomy) | key absent (CAS vs null) | intent |
| intent | wallet send returned / found by sentEcash(key) | CAS | kept |
| intent | send threw before commit, or sentEcash(key) = null | CAS | none |
| kept (merge) | receive Success/AlreadyReceived, credited >= agreed | federation of string = fed | none |
| kept (exchange) | seat written before POST | CAS | handed |
| kept (exchange, resumed) | never handed | - | reclaiming |
| handed | seat answers e-cash | - | answered |
| handed | seat answers 400/404/409/429 | `SEAT_NOT_TAKEN` | reclaiming (refusedBySeat) |
| handed | silent >= 10 min, !seatTook | clock | reclaiming |
| handed | silent < 10 min | - | handed |
| reclaiming | receive back Success | - | none |
| reclaiming | Rejected, refusedBySeat && seat | - | refused (terminal) |
| reclaiming | Rejected otherwise | - | handed (seatTook) |
| answered | receive Success, credited >= agreed | federation = to | none |
| answered/kept | credited < agreed | - | short (terminal) |
| answered | Rejected | - | refused (terminal) |

Invariants: a bearer string exists only after its intent is on disk; one seat per string; removed only on a credited receive; short/refused kept forever as evidence; merge intents are resolved only by the wallet that sent (`fromKey === cur`, index.html 7896; `left.fromKey === fromKey`, 7976-7979). The exchange records carry no phrase; the merge records carry `fromKey`.

#### SM-C2 Seat e-cash exchange as the page sees it (#1160 seat, #1149 page)
Seat `packages/arena-node/src/ecash-exchange.js`: none -> receiving -> taken -> sending -> paid | receiving -> refused (25-31, CAS 55-67). Refusals before the row is read or regardless of it: 400 (72-76), 409 maxMsat (77), 409 other pair (90), 409 no port (92-93), 409 "is <state> here" (141), 404 exchange off (server.js 10447). The page reads every 400/404/409/429 as "the seat took nothing" (ecash-transfer.js 40, 234).

#### SM-C3 Liquidation claim (kanban #1148 fix)
Files: `packages/arena-client/src/liquidation-claim.js` (edges 24-25, claimStep 31-35, presentNotes 54-136, collectLiquidationPayouts 174-190); driver `src/arena-ui/index.html` claimLiquidations 4606-4661, timer 8504 (load + every 10 min).
Persisted: `arena-liquidation-ecash-<fid>` (one record per federation, not per phrase), `arena-liquidation-pending-<fid>` (issuance requests), `arena-liquidation-paid-<txid>:<idx>` (payout collected, raw setItem), `arena-liquidation-checked-<fid>` (2.0 only: "this seed held nothing", per federation, not per phrase).

| from | event | guard | to |
|---|---|---|---|
| none | in window, signed liquidation stands | height known, standingLiquidation k-of-n | intent |
| intent | sendAllEcash() (untagged) returned notes, kept written | - | kept |
| intent | send threw / wallet empty | - | none |
| intent (left by a closed tab) | next pass | - | none, then a fresh intent for what the wallet still holds |
| kept | POST to the signed door answered ok | !memoryOnly | posted |
| posted | >= 1 h | - | posted (re-POST) |
| kept/posted | a later signed event lists this pass's payoutPk as accepted | `taken` with the CURRENT phrase's key | none |

Invariants: notes only to the signed door, only in the window; a kept record is dropped only on a signed acceptance. Not held: the record is not bound to the phrase whose notes it holds; an intent has no link to the wallet's send (no `arena_intent` tag).

#### SM-C4 Paid record: item purchase, developer gift, zap (memory only)
Files: `packages/arena-client/src/item-buy.js` buyItem 70-124; `packages/arena-client/src/donation-gift-page.js` giftDonation 33-67, zapPlayer 74; drivers `src/arena-ui/index.html` onBuy 9332-9337, buyShopItem 9343-9370, zapInFederation 6650-6664. Recipient side: `identity.js` collectZaps 254-289 (`arena.zaps.collected`, last 500 outpoints).
States (implicit, all in memory): built -> paySubmit sent -> accepted (lockAccepted) -> record POSTed -> kept by a seat. `{ ok:false, step:'record', retry: body }` is returned and dropped by every caller; nothing is written to storage between "paid" and "kept by a seat" (giftDonation writes only a history row, 50).

#### SM-C5 Swap, Move, Evacuation receive legs (LNv2 through a gateway)
Files: `packages/arena-client/src/page-lock.js` migrateFromDraining 3210-3243, evacuatePlayerWallet 3268-3277, swapForRound 3316-3349, movePlayerWallet 3364-3380, swapPlayerWalletForRound 3387-3398, ledgerFederations 3399-3413; drivers ARENA_EVACUATE index.html 8397-8424 (automatic on DRAINING/CRITICAL), the join's swap, the Move panel.
States (memory only): invoice made in `to` -> paid from `from` -> awaitReceive Claimed -> history rows moved-in/moved-out (ledgerAppend). Which wallets the page opens again = ledgerFederations (history rows + pending deposit keys) + wallets already open (ARENA_SUM_BALANCES 8142-8170).

#### SM-C6 Merge runs (in-memory guards)
`src/arena-ui/index.html`: `combiningBy` (7846, one run per federation, dropped after 60 s by the guard 8047), `mergeNoOpen` (7872, 120 s), `mergeDeadFeds` (7876, 5 min after 2 misses), `arena.wallet.empty.<fed>.<phrase>` = entry count when found empty (7933-7935, 7966), `arena.wallet.known.<fed>.<phrase>` remembered balance, `ARENA_PHRASES_HELD_HERE` + `navigator.locks arena.phrase.<16>` (8000-8015). A second run after the 60 s guard cannot double-send a phrase: it waits 8 s for that phrase's lock and gives up (8005-8008).

#### SM-C7 Developer donor client (packages/arena-donor)
`src/donor.js`: donation: listed at seats -> recorded (donations.jsonl, append + fsync, 376-383; rate first, 397-408) -> redeemed / spent (redeemAll 133-147) -> read receipt to every seat (deletes the seats' rows, 409-422). Unclaimed outputs: none -> noted -> recover (backup, recover, reopen until balance, swap | keepFailed) (claimUnclaimed 189-223, `state.json` via tmp+rename, bin/arena-donor.mjs 34). Withdraw: per gateway, stop when e-cash left without Success (225-245, 286-302). No finding: a receipt names only recorded AND redeemed/spent outpoints; `spent` is "guardians hold no contract there", which only the recipient key can cause after the seat verified the outpoint.

#### arena-sdk, arena-web
`packages/arena-sdk/src/*` are 4-line re-exports of arena-protocol; no state. `packages/arena-web/src` is React presentation: component state only, plus three localStorage conveniences (owner currency, MarketCreator draft, SetupStatus hidden flag); every money step it shows is driven by page-lock.js / index.html callbacks covered above. No state machine of its own.


#### SM-L1 Stake lock record (kanban #1162 fix)
Files (2.0): `packages/arena-client/src/page-lock.js` 1740-2017 (lockRecordStep 1759, lockRecordOf 1768, stepLockRecord 1776, keptLockStake 1803, saveLock 1866, reconcileKeptLock 1920, keptLockUse 1948, bindLockEntry 1978, markLockCommitted 1991); driver `src/arena-ui/index.html` 3654-3700, 3876-3990.
Persisted: localStorage `arena.lock.saved.<round>.<pk16>` (the record), `arena.lock.intent.<round>.<pk16>`, `arena.lock.orphan.<tag>.<atMs>`; Web Lock `arena.lock.<tag>` in memory.

| from | event | guard | to |
|---|---|---|---|
| none | PLAY: intent written (putRoomy, room reserved) | - | intent |
| intent | an intent that failed or is > 120 s old | copied to orphan (only when not failed) | intent (new) |
| intent | lockSubmit answered (txid written into the intent) | - | intent removed, record written submitted (accepted for an old lock client) |
| submitted | `made.accepted` resolves (only in the making tab) | - | accepted |
| submitted | reload: lockStatus stored | - | accepted |
| submitted | reload: 3 reads 2 s apart, none stored | - | refused |
| submitted/accepted | markLockCommitted | entry matches | committed (final) |
| refused | new PLAY | - | overwritten by the new lock |

Invariants: only accepted/committed records are reused (submitted is checked first); `entry` written once; lockRecordOf reads the saved record first, so an intent under it is invisible. Nothing outside keptLockStake and the tests reads `arena.lock.intent` / `arena.lock.orphan`.

#### SM-L2 Collect record (kanban #1163 fix)
`saveCollect` 2519, `markCollectDone` 2650 gated by `collectState` 2634, `tidyStorage` 354. Persisted: `arena.collect.<round>.<seed16>[.oN]` `{done}`, notes `arena.payout.*` / `arena.stakeback.*`, `arena.tabempty.<round>` (index.html 4388).
open -> done only when the payout is none/gone/collected (or owed with a final redeem), the stake gone/none/collected (or owed with a final redeem/refund) and the tab wallet 0. Done records are skipped; Rescan (index.html 4794) clears `done`. tidyStorage drops `arena.lockdb.<round>` once done with `tabMsat '0'` and > 1 h old; under pressure any done record's lockdb.

#### SM-L3 lookOwed sub-states (page-lock.js 2931-3032, memory, re-derived on every look)
payout: collected (note) | waiting (no agreed settlement) | none | owed | gone (`held(s.txid)` false). Stake: collected | waiting | gone (no seat-named lock held) | owed by forfeit (forfeitOf on `locks[0]`) | owed by refund (`expiredBack`) | refused-return. Locks come from `findLock` 2020-2045: the union of every asked seat's `/stake-lock` answer, in node order.

#### SM-L4 Pending deposit (kanban #1179 fix)
`pendingAdd` 1033, `depositEnded` 1060, `scanLostDeposits` 1109. Key `arena.deposit.pending.<fed>.<op>` one per deposit. pending -> Claimed (history row `dep-<invoiceHash>` first, then the entry removed) | Expired | Failure. `lost` entries dropped only after a complete scan.

#### SM-L5 Ledger rows
`ledgerAppend` 1697: one key per row `arena.ledger.<fed>.<id>`, id from content, written once; `markLockCommitted` patches the stake row's entry (one-row lists handled).

#### SM-L6 Lock-client tab store commit
`lock-client/src/store.rs` 198-220, `lockStoreFor` page-lock.js 160: a commit writes every touched key, then removes deleted ones; no rollback (a refused put leaves part of a commit). A store over `LOCK_ROOM_CHARS` moves to memory, one way. 1.9 store.rs 201-208 still writes and deletes in operation order.

#### SM-T1 The tab's hold on its phrase (kanban #1164 fix)
Files (2.0): `src/arena-ui/index.html` arenaSeedKeeper 2513-2615 (EDGES 2542, lockPhrase 2556-2581, beat 2584-2594, pagehide 2595, ready 2598-2604, lockSeen 2605), useWalletGate 2614 -> page-lock.js 521-545 (openPlayerWallet waits on it).
States (memory `state`): free, asking, held, waiting, lost, dropped.

| from | event | guard | to |
|---|---|---|---|
| free | beat -> lockPhrase(cur) | the session holds a 64-hex phrase | asking |
| asking | `ifAvailable` granted | session key still cur | held |
| asking | not granted, `arena.seed.collecting.<16>` < 30 s | - | waiting (queued request) |
| asking | not granted, no fresh collecting mark | - | dropped (session phrase removed, new tab id, reload) |
| waiting | queued request granted | - | held |
| held/waiting | request rejected (an older page stole) | - | lost (reload) |
| any | phrase taken in this tab without reload | lockedFor changes | free |

Invariants intended: nothing steals a phrase's lock; no wallet of the tab's own phrase opens before the tab holds it; a restore is refused when the phrase's lock is seen held. Gap: `ready(hex)` resolves at once for any hex other than the tab's own phrase (2600), so other phrases' wallets are protected only where each caller takes `arena.phrase.<16>` itself. Takers: withRecordPhrase 4433-4455 (writes the collecting mark), merge 7997-8018 (no mark), handover responder 7635-7670 (its own phrase); the deposit resume `others()` 8083-8094 takes none.
Persisted: sessionStorage `arena.player.seed`, `.from`, `arena.tab.id`, `arena.wallet.fresh`; localStorage `arena.seeds`, `arena.seed.held.<16>` (4 s heartbeat), `arena.seed.collecting.<16>`; Web Lock `arena.phrase.<16>` for the tab's life.

#### SM-T2 Kept round wallets and the per-round lock
index.html holdRound 4360-4371, roundWallet 4373-4381, lookRound 4392-4412, TAB_EMPTY 4387-4391. Per round id: not held -> held for the tab's life (`heldRounds` + a never-resolving Web Lock `arena.round.<roundId>`); another tab gets `held:false, look:null`. The lock and `arena.tabempty.<round>` are keyed by round only; the round database by round and seed (`arena.lockdb.<round16>.<sha(secret)16>`, page-lock.js 160).

#### SM-T3 Join (`window.ARENA_JOIN`)
index.html 8850-9070, 9142-9160; lock step 3880-4015. States: joining (finding), refused, joined, picked; flags cancelled, locking, held, loaded, committed, missed.

| from | event | guard | to |
|---|---|---|---|
| none | PLAY, row not painted yet | 3 s retry (8873) | joining (finding) |
| joining | another PLAY | `!locking && !next` (8915-8921) | refused, cancelled |
| joining | 600 s without a stage | 8963-8971 | refused, cancelled |
| joining | lock step | cancelled re-check 3992, sync to 4007 | locking = true |
| joining | entry made, start ahead | ARENA_JOIN_GOES_ON 9157 | held -> joined at the start |
| joining | market pick / hidden move | 9014-9035 | picked |
| any | ARENA_REFUSED_JOIN | 9142-9152 | refused, cancelled |

Persisted: memory and the address bar (`round`, `play=1`); localStorage `arena.paid.run` (2 s heartbeat, stale after 6 s, 6038-6066), `arena.pending.<round>.<entry>`; sessionStorage `arena.pending.mine`; the lock record (SM-L1).

#### SM-T4 Play socket (Client)
`packages/arena-client/src/client.js` state 563, connect 972-1019, connectFirst 1030-1048, reconnect 1074-1119, send 1151-1158, endRun 1878-1891, close 2482. opening -> ready <-> dropped -> ended; one reconnect loop at a time (`reconnecting`). One `said` FIFO across sockets; a close is ignored when `this.sock !== sock`; any socket's open sets `this.sock = sock`. Memory only.

## 6. Installer, node lifecycle, and every state-changing door

*From #1204, `installer-doors.md`.*

#### SM-I1. Installer state file (state.json) - kanban #1178 fix as it stands
Files: `packages/arena-installer/src/state.js` 37-137 (2.0 = 1.9 except 2 lines).
States: absent -> fresh `{step:'chain'}` (only when state.json AND .bak are ENOENT) -> written (atomic, .bak first) ; unreadable -> `StateUnreadable` (refuse).
| from | event | to | guard |
|---|---|---|---|
| any | `update(fn)` | `{...now, ...patch}` | `withStateLock(state.json.lock)` (O_EXCL file, stale after 10 s or dead pid), re-read inside lock, `atomicWrite` .bak then file (72-92, 113-124) |
| file torn | `read()` | .bak content | parse fallback (103-111) |
| both bad | `read()` | throw | never a fresh state |
Invariants: every writer goes through `update`; .bak == last committed state. **Broken by** two writers outside state.js (finding INSTALLER-DOORS-29): `node-services.js` 362-368 (`followQuickTunnel`, plain `writeFileSync` text replace, every minute from the custody agent when the quick host moved) and `launchd-interactive.js` 42-75 (fixed `${stateFile}.tmp` + rename, no lock, no .bak).
Lock caveat: stale-takeover is check-then-unlink (87): two waiters that both judge a dead holder stale can each unlink the other's fresh lock (narrow; needs a crashed holder + 2 contenders).

#### SM-I2. Wallet on-chain action (onchain-action.js) - kanban #1165 fix
Files: `onchain-action.js` 29-209; callers wizard.js 939/991/1016, add-bond.js 42/156, rebond.js 53, identity-switch.js 68, change-roles.js 64/152, custody-agent.js 115-221. Persisted: state.json `onchain.{open,last,seq}`.
| from | event | to | guard |
|---|---|---|---|
| none | `onchainAction` build ok | BUILT (hexes+txids+ops) | CAS: no open action, `seq` unchanged, kind not `repeat` (191-196) |
| BUILT | every tx broadcast ok / ALREADY / seen since `a.tip` | SENT | `transition` CAS (151) |
| BUILT | tx refused by CONFLICT regex and none of txs[at..] seen since `a.tip` | VOID | `transition` CAS (143-146) |
| SENT | effect ok (`key-switch`: one SQLite txn, CAS on old key) | DONE + ops applied in same write | `transition` CAS (159) |
| DONE/VOID | - | terminal; `last[kind]` kept | `once` / same `key` answer `already` |
Invariants: one open action per wallet; nothing built while one is open; ops written exactly once with DONE.
Gaps (finding INSTALLER-DOORS-31): DONE means "accepted by the one mempool asked", never re-checked; `txSeen` on Core scans at most 300 blocks (wallet.js 119-130), so a long-open BUILT whose tx was mined earlier can be judged VOID.

#### SM-I3. Node update (update.js journal) - kanban #1166 fix
Files: `update.js` 189-295 (journal, resume, rollback), 515-812 (moveNode); `auto-update.js` 59-240. 2.0 = 1.9 (update.js identical; auto-update.js differs only by the guardian stage gate).
Persisted: `<home>/update-journal.json` (atomic), `<home>/update.lock` (`{pid, atMs, boot}`), `backups/<stamp>/`, `releases/.unpacked-<base>`, `auto-update.json` (written, never read).
| from | event | to | guard |
|---|---|---|---|
| none/KEPT/ROLLED_BACK | `beginJournal` | STOPPING | refuses over an open journal (225-231); update.lock held |
| STOPPING | backup written | BACKED_UP | `journalStep` CAS (212-218) |
| BACKED_UP | units written | UNITS_WRITTEN | CAS |
| UNITS_WRITTEN | services started | STARTED (+reachUrl) | CAS |
| STARTED | same key + version answers + no leftovers | KEPT | CAS (745) |
| any open | failure / resume finds it unhealthy | ROLLING_BACK -> ROLLED_BACK | CAS; DB restored only if `served` false (245, 291, 803) |
| (outside the journal) ROLLED_BACK | next auto-update tick (30 min) for the same `latest.json` | STOPPING again | **no guard** (finding INSTALLER-DOORS-9) |
Invariants: an open journal is finished (kept or rolled back) before any new update; DB is not put back once the new release answered (`served`). Backups: one full copy of node.db (+WAL) per attempt, never pruned (`backupNode` 166-172; no remover anywhere).

#### SM-I4. Custody agent tick (custody-agent.js 123-327)
Implicit state = fields in state.json `custody.*` + LND channel list + `node.db.guardian` entry. Steps run in order, first unmet one acts per tick:
| state | event | to | guard |
|---|---|---|---|
| open on-chain action | tick | resume it, nothing else | `resumeOpen` (126) |
| liquidity role, no `liquidityFund` | tick | `liquidity-fund` sent (once) | onchainAction once |
| guardian drawn, `custody.guardianOf.federationId != g` | tick | advert update with guardian_of (once per fid) | onchainAction once (173-196) |
| gateway not joined | tick | joined; `gateway.federations` merged | gateway's own answer |
| `pegInSats`, no pegIn for fid | tick | peg-in (once per fid) | load cap read from seat (211-213) + once |
| claim older than 1 h / URL moved | tick | gateway-claim.json rewritten (plain writeFileSync), `custody.claimAtMs` | - |
| no channel to hub | tick | outside-fund (once ever) / `openTo` then `custody.outside` | LND pending/open list is the guard (250) |
| ring next changed | tick | close old, then fund (once ever) / open | LND lists (276-324) |
Invariant relied on: `custody.guardianOf` true <=> the node's NEWEST advertisement names guardian_of. **Broken by `rebond`** (finding INSTALLER-DOORS-10).

#### SM-I5. Owner binding (arena-node owner.js; persisted `node.db.owner.json`, claim code file)
| from | event | to | guard |
|---|---|---|---|
| unclaimed (code in memory + file) | POST /owner/claim with code + valid sig | claimed {pubkey} | code compare, sig, 2-min window, replay map |
| claimed | leave / stay / settings | owner.leaving / settings | `authorize`: sig by owner key, window, replay map |
Replay guard `used` (73, 95, 110) is memory only: lost on restart (see INSTALLER-DOORS-26).

#### SM-I6. Wizard session (wizard.js 150-190, 1140-1189)
token (memory, 30 min) -> session cookie (sha256 kept in `sessions.json`, 7 days idle) -> Finish clears all. Host allow-list + `x-arena-wizard` header on POST. No finding.

#### SM-L1. Node process and its guardians (main.js 766-791, node-start.js 68-201, guardian.js 229-400)
In-memory `guardian`/`next` handles: none -> starting -> running(kept|adopted|child) -> halted/exited -> restarted.
| from | event | to | guard |
|---|---|---|---|
| running | owner stop (`guardianControl.stop`) | none | - |
| running, cookie fingerprint changed | cookieWatch (154-167) | halt, start fresh | none against exitWatch |
| running, `alive()` false | exitWatch (174-189) | start fresh | once a minute per slot; `guardian !== g` re-check after start |
| setup | `retire` / `freshSetup` | database set aside, setup again | key files re-read (kanban #1177) |
| any | SIGTERM/SIGINT | `node.close()` then exit(0) | `stopping` flag |
Invariant: one fedimintd per data dir. Not guarded between cookieWatch and exitWatch (finding INSTALLER-DOORS-32).

#### SM-L2. Core sandboxes (core-sandbox.js 107-262, core-supervisor.js, core-host.js)
Per thread `cache` key -> sandbox: loading -> loaded -> ended (deadline 2 s/30 s/120 s, heap death, array budget, RSS backstop) ; or `refused` at load.
| from | event | to | guard |
|---|---|---|---|
| none | `sandboxFor` | loaded or {refused} cached | LOAD_MS |
| loaded | call misses deadline / dies / grows process RSS > 416 MB | ended (terminal for this cache entry) | - |
| ended / refused | any later `sandboxFor` | the same dead entry | `askedAt` refreshed on every ask, so the idle sweeper never drops it (239, 252-261) |
Replays run in a fresh Worker each (replay.js 260-287), so their cache dies with them; the daemon's own thread keeps its entries for the process lifetime (h2h `decide` verify.js 686-688, `runTicks`/`runLengthFits` plugins.js 120-140, ghosts' `stepTo`). Finding INSTALLER-DOORS-11.

#### SM-L3. Guardian P2P tunnels (p2p-tunnel.js 122-180; server.js 12381-12411)
`ports` Map port -> {key, slot, root, state: new|opening|listening|shared|failed}; synced every 60 s from the census.
Invariant assumed: one census node per port. Not true: `p2pTunnelPort` = 20000 + sha256(key) mod 10000 and `sync` keeps the last entry per port (160). Finding INSTALLER-DOORS-7.

#### SM-L4. Transcript and unused-round pruning (transcript-prune.js, server.js 4236-4280)
round row -> (claim window over) transcripts deleted -> (unused and past end+W+claim) round + committee/seating rows deleted. `used` set read before the batch, all in one SQLite transaction, no await inside. No finding. Note: `seat_signed`/`seat_sigs` go with an unused round; a re-POSTed old round starts with no record of what this seat signed for it (past every window).

#### SM-L5. Replay pool (pool.js)
queues[3] -> running (<= workers) -> resolved. `order` (every started key) is never trimmed: grows for the process lifetime (memory, cosmetic).

#### SM-L6. Transcript posting to relays (relay.js 23-38, verify.js 1415-1428)
not posted -> PUT + GET back at each listed relay (sequential) -> posting row when one holds it. No timeout on either fetch (finding INSTALLER-DOORS-30).

#### SM-L7. Game Nostr relay (nostr-relay.js, run as tools/nostr-relay.mjs)
events table (INSERT OR IGNORE; replaceable kinds keep newest per pubkey/kind/d). No bound on stored events from any author; REQ scans the whole table per filter. Finding INSTALLER-DOORS-33.

#### SM-D. Every state-changing HTTP door of server.js (2.0)
Three slices. Findings named in the tables by their slice id (doorsA-n, doorsB-n, doorsC-n) map to INSTALLER-DOORS-n as listed at the top of Findings.

2.0 = worktree-health-199 6e84fed99 (line numbers), 1.9 = interim-2026.1.9.17 6243790a3. GET doors that only read the store or files are left out, except
GETs that write a cache/table, fan out, spawn a process, or draw a signature.

##### SM-D1. Doors (7047-8360)

| door | server.js line | caller (who is meant to call it) | auth / proof checked | state it moves (where persisted) | guarded? |
|---|---|---|---|---|---|
| ANY /gateway, /gateway/* (proxy) | 7054-7060 | federation clients reaching the node's gatewayd at its public api-addr | none at the seat; gatewayd's admin routes need its bcrypt password (installer gateway.js 56, random) | whatever gatewayd does; seat holds one socket per request (no timeout, outside `timed`) | partly: gatewayd's own auth; no timeout or body limit in the proxy |
| GET /release | 7081-7093 | fellow guardians' seats (update-stage), with ?nonce= | none; answer signed with node key over the asker's nonce (tag ARENA/v1/ReleaseAnswer, update-stage.js 42-45) | signature drawn per call; a local fetch to the guardian API (3 s) | yes for the signature (domain tag); no rate limit |
| GET /update-stage | 7096-7114 | the node's own auto-updater (arena-installer auto-update.js 43, via 127.0.0.1) | none (open to the internet; ?version= is any string) | update_stage_seen rows (DB, update-stage.js 113-118): written or DELETED; one GET /release fan-out to every fellow | no: see doorsA-1 |
| POST /held-read | 7152-7156 | a seated guardian's gateway (§23A.3a) | ask signed by the gateway node key (checkHeldAsk), node and asker seated in the record (held-read.js 29-39), MAX_ASKS 12 per gateway/epoch | in-memory `signed`/`asks` maps (held-read.js 26, 40-45), a HeldRead signed with the node key, two federation-client calls | yes (counters reset on restart: 12 more reads per restart, harmless) |
| GET /pending | 7168-7171 | /health, health watcher, markets UI | none | caches blockIds/blockMtp (bounded by PENDING_BACK), pendingKept; one mempool RPC per expected grid (6184-6188) | partly: cost scales with POST /expected entries (doorsA-2) |
| POST /expected | 7174-7178 | the grid publisher (grid-build.js 107, duty-day.js announce) | series line parses, is a grid, lead valid; creator signature only if the line names a creator (creator.js 38-45); tx only parsed, never looked up | expected_grids table + `announced` map (6072-6097); pendingKept.forget() | no: unbounded, see doorsA-2 |
| GET /gateway-seats | 7211-7215 | other seats, owner page | none | gateway-watch view: held-lock judgement cache (gateway-watch.js 60) | yes (cached per lock) |
| POST /operator/vote | 7284-7298 | operator UI with a vote-scoped token | operator-tokens.js check (hash, timingSafeEqual) | node key signs H(proposal, choice); nothing persisted, nothing broadcast | yes |
| GET /owner/leave | 7310-7327 | owner page (public) | none | stakeLocks.guardians() outgoing read per call | n/a (read; one outbound call per GET) |
| GET /owner/rounds | 7348-7400 | owner page (public) | none | auditEarned memory cache (3202), up to 8 settlements.summaryOf reads per GET | yes (bounded by own audit work) |
| GET /owner/version | 7408-7413 | owner page (public) | none | latestReleaseFor: outgoing fetch, reader kept (4343-4350) | yes (kept reader) |
| GET /owner/bond | 7424-7448 | owner page (public) | none | hand-set seat (ARENA_BOND_CLI): execFileSync bitcoin-cli getbalances on the event loop per GET (7444-7446, add-bond-wallet.js 36, 104-108) | no rate limit (doorsA-10) |
| GET /owner/dev/donations, /owner/dev | 7572-7598 | owner page (public, no signature) | none | learnRoundApps fan-out to all seats (954-990, roundTried cache), fiat-rates.json write + CoinGecko fetches for missing rows (fiat-rates.js 33-63), up to 12 s per GET | partly (doorsA-10) |
| POST /owner/claim | 7610 | first owner, with the claim code from the node log | owner.js check (sig, 2-min window, `used`) + 12-char code (2^60) | owner file (store.write), claim-code file cleared (owner.js 120-131) | yes (no await between check and write) |
| POST /owner/operator/mint, revoke, list | 7612-7621 | owner page | owner.authorize | operator token store (hash list, file) | yes (replay after restart: doorsA-8) |
| POST /owner/funding-propose, -signal, -comment | 7625-7650 | owner page | owner.authorize | fundingBook row (dedup by bytes), forwardFunding fan-out | yes |
| POST /owner/leave | 7652-7673 | owner page | owner.authorize | owner file `leaving` (owner.js 132-139), one departure notice (absences file) + POST /departure to every seat | partly: doorsA-4 |
| POST /owner/market-publish | 7676-7690 | owner page (market creator) | owner.authorize + node in census at tip-1 | adoptPackage: plugins dir, hosted map | yes |
| POST /owner/plugins/install, update | 7692-7699 | owner page | owner.authorize | takeGame: fetch from args.from, plugins dir, hosted | yes (owner-chosen URL) |
| POST /owner/apps/split | 7700-7710 | owner page | owner.authorize + developer signature / key installed | hosted split, plugin files | yes |
| POST /owner/apps/dev-key | 7712-7721 | owner page | owner.authorize | appDevKeys file (secret key) | yes |
| POST /owner/plugins/remove | 7722-7727 | owner page | owner.authorize | plugins dir, hosted | yes |
| POST /owner/network/install, update, remove | 7730-7745 | owner page | owner.authorize + network-check | networksHeld, network package files | yes |
| POST /owner/musig/nonce, partial | 7748-7772 | owner page (cooperative bond spend) | owner.authorize (action 'musig' for both) | musigNodeSessions memory (660): secnonce, random (musig2.js 80-93), deleted before signing; never pruned | yes (one use); sessions never expire (owner-only) |
| POST /owner/reach | 7779-7807 | owner page | owner.authorize | reach-switch.req (cfToken, 0600) + reach-switch.json + spawns bin/reach-switch.mjs (installer reach and service steps, restarts the seat) | yes (sync check-and-write, 15-min stale) |
| POST /owner/services | 7809-7857 | owner page | owner.authorize | none (probes, node-services.js overview) | n/a |
| POST /owner/service | 7861-7901 | owner page | owner.authorize | start/stop/restart/boot on/off of installer services (node-services.js control/setBoot: systemd/launchd), own toggles (svcSettings), detached seat restart | yes |
| POST /owner/add-bond | 7904-7934 | owner page | owner.authorize | installed: addBondOnNode -> onchainAction (state.json onchain BUILT/SENT/DONE, idempotency `key`); hand-set: addBondFromWallet sends funding + bond (+ presig) from ARENA_BOND_CLI | installed yes (#1165); hand-set no: doorsA-5 |
| POST /owner/first-bond | 7938-7951 | owner page | owner.authorize | firstBondOnNode -> onchainAction once (add-bond.js 160-175) | yes |
| POST /owner/key-from-words | 7957-7978 | owner page | owner.authorize | identity-switch onchainAction once + key-switch effect (onchain-action.js EFFECTS) + detached seat restart | yes |
| POST /owner/roles | 7980-8004 | owner page | owner.authorize | installed: changeRolesOnNode onchainAction (change-roles.js 64); hand-set: changeRolesFromWallet sends 2 txs (add-bond-wallet.js 122-176) | installed yes; hand-set partly ("same roles" check only): doorsA-5 |
| POST /owner/bond-wallet/address | 8007-8014 | owner page | owner.authorize | getnewaddress (wallet keypool) | yes |
| POST /owner/liquidity/become | 8019-8030 | owner page | owner.authorize | add-liquidity.js 23-87: LND install (setUpOwnLnd), installProgram liquidity + custody agent, liquidity.key, state.json roles, arena.conf | partly: no serialisation (doorsA-9) |
| POST /owner/federation/retire | 8038-8061 | owner page (typed RETIRE) | owner.authorize + guardian audit holdsNothing at consent | retire.json consent (federation-retire.js 47-56); later the seat builds the record CLOSED and sets the guardian aside (5809-5823, node-start.js 110-120) | partly: doorsA-7 |
| POST /owner/custody/add | 8063-8078 | owner page (typed I UNDERSTAND) | owner.authorize | custody-add.req/json, spawns bin/custody-add.mjs (LND, guardian, bond advert update, peg-in) (add-custody.js 94-106) | yes (sync check-and-write; STALE_MS) |
| POST /owner/gateway/setup | 8081-8092 | owner page | owner.authorize | same runner, gatewayOnly (add-custody.js 74-88) | yes |
| POST /owner/liquidity/new-address | 8094-8102 | owner page | owner.authorize | provider service POST /new-address (LND address, claim re-signed) | yes |
| POST /owner/referrer/setup, name | 8106-8132 | owner page | owner.authorize | new referrer dev client + key (devClients.setup), referral_names row, POST /referral-name to every seat | yes (#1190 covers names) |
| POST /owner/market-test | 8134-8145 | owner page | owner.authorize | outbound example reads only | n/a |
| POST /owner/source-proposal | 8147-8176 | owner page (Add a source) | owner.authorize | without txid: payDeposit sends the deposit from the bond wallet (source-ballot.js 29-33); with txid: proposals.add + POST /proposal to every seat | no for the deposit: doorsA-6 |
| POST /owner/source-vote | 8178-8194 | owner page | owner.authorize + kept proposal | node key signs the vote; bond wallet `send` OP_RETURN per call | partly (a repeat costs a fee; the later vote counts) |
| POST /owner/dev/setup, withdraw, remove | 8196-8206 | owner page | owner.authorize | dev client dirs; withdraw-request.json picked up by the client (dev-clients.js 252-264) | yes (request-file guard, sync) |
| POST /owner/dev/propose, vote | 8211-8249 | owner page | owner.authorize + dev key a recipient | donationBallots row + forwardBallot | yes |
| POST /owner/dev/fee-answer | 8252-8265 | owner page | owner.authorize | fundingBook fee-approval + forward | yes |
| POST /owner/settings, /owner/stay | 8267-8268 | owner page | owner.authorize | owner file (settings / leaving removed) | yes |
| POST /owner/bond-withdraw | 8271-8329 | owner page | owner.authorize; template 3 and hold return need the owner key's signature over a digest prepared here | ownerSigns memory (4391-4392, 30 min), chainSend / holdWatch.submit | yes (same input: second spend conflicts) |
| POST /owner/old-bond-withdraw | 8331-8348 | owner page | owner.authorize + key in identity_old + maturity | chainSend with the old key | yes |
| POST /owner/login | 8350-8355 | owner page | owner.authorize | `used` map only | yes |

48 rows (door groups that share one handler are one row); read-only GETs (/guardian, /gateway-claim, /held-proof, /expected GET, /duty, seatings, /identity, pages and bundles, /owner, /owner/seatings, /owner/standing, /owner/app-devs, /owner/plugins, /owner/network, /owner/donations, /operator/status) omitted.

##### SM-D2. Doors (8360-10290)

Line numbers: 2.0 (worktree-health-199 6e84fed99), packages/arena-node/src/server.js unless named. 1.9 = interim-2026.1.9.17 6243790a3.

| door | server.js line | caller (who is meant to call it) | auth / proof checked | state it moves (where persisted: DB table / file / memory) | guarded? (yes / partly / no + why) |
|---|---|---|---|---|---|
| GET /setup-status | 8361 | the installer's status page | none | memory `setupStatusKept` (60 s cache), calls setup-status.js + foundingSeat.readiness | yes - one cache slot, rebuilt at most once a minute |
| GET /uptime, GET /dashboard.json | 8381, 8387 | dashboard, health page | none | memory `uptimeKept` / `dashboardKept` (30 s) | yes - one slot each, 30 s |
| POST /proposal | 8462 | proposer / any seat handing on a ballot proposal | proposer signature + deposit tx confirmed in the named block of this seat's chain (proposals.js add, `confirmedTx`, `depositOf`, `proposalStands`) | DB ballot_proposals via `commit`; ORPHANED->COUNTING `transition`; memory `held` | yes - costs an on-chain deposit; re-check after the await (`held.has(id)`) |
| POST /round | 8516 | the opener / a page's PLAY posting a round | contract decode; creator BIP-340 sig over round id when it names a creator (8527-8538); rules, config, committees, bond_min, hosted game, leaving, offerRefusal, funded() (8569), custody, gateways, bonded | DB round_creators (8538, BEFORE funded/other checks), rounds (`round.open` 8652), signer_nodes (`roster.assignSignerNodes` 8672), funding floor (`settlements.noteFundingFloor` 8654), kept beacon (`randomnessFor`), memory `awaitingBeacon` (8677), DKG claim-key run (`makeClaimKey`, outgoing /dkg fan-out) | partly - round_creators row written for rounds refused later (doorsB-5); round stored before the census assignment refuses it (8680, doorsB-5) |
| POST /first-mark | 8692 | another signer node forwarding a player's first mark | mark signed by the entry's session key (`round.checkpoint`, `onTimeFirstMark`), late evidence = player's own signed mark or a verified receipt (`lateEvidenceHere` 2207), Void receipts checked (`receiptSigners`) | DB refused_first_marks (`putRefusedFirstMark` round.js 2755, INSERT OR IGNORE), entry_voids (`voidHere` 2229), checkpoints + receipts, batches, evidence blocks; memory `gathering` + outgoing /proof-pull spread (`gatherOnProof` 1624) | yes - every stored item carries the player's signature; spread single-flighted per entry |
| POST /name | 8765 | a joined player's page | BIP-340 sig of the record by `rec.playerPubkey`; that key must be an entry of the round here | DB lobby_names upsert, newest at_ms wins (round.js 2822); memory listingKept small entries dropped | yes - only the player's own key can write its row (a far-future at_ms only freezes the player's own name) |
| GET /network-games?fresh=1 | 8869 | the plugin store page | none | memory `networkApps`; outgoing GET /games to every seat (`readNetworkApps` 1257) | partly - single-flighted, but `fresh=1` restarts the fan-out as soon as the last one ends (doorsB-6) |
| GET /rounds | 8892 | every lobby, every few seconds | none | memory `listingKept` (16 slots, key = raw `url.search` 8897), `listingBuilding`, gzip kept | partly - any extra query param is a new key: a fresh full build per request and the lobby's kept listing evicted (doorsB-4) |
| GET /season, GET /season-rounds | 9062, 9091 | season board, other seats' network season | none | memory `seasonKept` / `seasonNetKept` (32 slots, key = ids + days); scope=network fans out to every seat's /season-rounds; /season-rounds signs every round's account (`signSeason`) | partly - any 64-hex id (hosted or not) x days 1..90 is a new key (doorsB-4) |
| POST /series | 9145 | the operator's grid keeper / a page posting a grid | grid validity, lead, creator sig (`seriesCreatorStands`), bond_min, hosted game + donation set, funded() named OR its publication confirmed on this seat's chain (`publishedHere` 5436) | memory series/writers/postedSeries, file `gridSeriesFile` append (5425), rounds written by the series writer | yes - an unnamed series needs a confirmed on-chain publication; re-check of `writers` inside takeGridSeries after the await |
| POST /item-purchase | 9166 | buyer's page, then every seat that kept it | buyer sig, manifest/donation set/served list (`purchaseStands`), federation output by output with the item-bound image | DB item_purchases PENDING->KEPT in IMMEDIATE txns (item-purchase-seat.js 82-118), donation_outputs + reserve row (INSERT OR REPLACE), fan-out POST to all seats when kept 'new' | yes - #1180 fix holds (claim before the await, CAS to KEPT) |
| POST /donation-gift | 9220 | donor's page, then every seat that kept it | donor sig + set shares (`giftStands`), federation outputs with image = donor key | DB donation_gifts (INSERT OR IGNORE, donation-gift-seat.js 42), donation_outputs INSERT OR REPLACE (round.js 3369), fan-out POST to all seats | partly - the #1180 race is still open on this path (doorsB-3) |
| POST /reach-check | 9285 | a seat checking a new node's reachability (installer) | none; rate limit 6/min per asker IP, 60/min total (reach-check.js 53-80) | memory `asks` map (pruned at 10 000), one outgoing HTTP GET ip:port/reach-nonce | partly - asker IP taken from x-forwarded-for when the socket is localhost (doorsB-7) |
| POST /handout | 9370 | the player's page, one sealed share per signer node | round's threshold, own share on the published polynomial (`takeHandout`) | DB handouts (sealed bytes only), tx_steps (named only on success) | yes - per the door's checks; a node dealt nothing keeps nothing |
| POST /census-objection | 9393 | a client that found the census block disagreeing with an explorer | none on the asker; the seat asks the explorer URL THE CLIENT NAMES (9396-9403) | memory `censusObjections` (512, 9406-9407): the round then refuses every new entry (9422-9423) and lists `census_objected` | no - the "independent" explorer is the attacker's own URL (doorsB-1) |
| POST /entry | 9412 | player's page; seats relaying a client's copy (`x-arena-relayed`) | entry contract decode, round held, censusObjection, seating, funded(), stake ceiling, federation port/gateways/fee rule/bonded, donation/reserve outputs | DB entries (`round.enter`), tx_steps; outgoing relay to the seats the client missed (entry-relay.js, skipped when the header is set) | yes - the relay header only suppresses the relay of the caller's own entry |
| GET /federation-invoice | 9617 | player's page before entry (old invoice-first path) | none | federation.receive (an LNv2 invoice at the federation) | yes in practice - main.js passes no `federation`, so it answers 409 (dormant) |
| POST /tx-timing | 9788 | the page holding the order's session key | Ed25519 sig by the entry's session key over timingMessage | DB tx_client_timing upsert, size-capped (tx-record.js 94) | yes |
| POST /proof-pull | 9865 | another signer node that formed a two-first-marks proof | none (entry must be held here) | outgoing /late-first-mark, /entry-void, /equivocation to every peer of the round (verify.js 1028-1075); a verified pair is kept (round equivocation table) | partly - what is kept is verified, but every request starts a fresh 3-per-peer fan-out, not single-flighted (doorsB-6) |
| GET /share | 10016 | another signer node collecting stake shares | asker named in `?signer node=`; answer sealed to that key; released only when final + lock claimable (stakeSecrets.answer) | with `proof=1` or no result: proof pull fan-out (verify.js 1028); `gatherOnProof` spread | partly - GET that fans out on demand (doorsB-6) |
| POST /outcome | 10096 | attestors / anyone handing on a signed attestation | `attestationStands` / `valueAttestationStands` (threshold of named or drawn attestors), `attestationTimely` (deadline, #1151) | DB outcome_attestations (`putOutcomeAttestation`), timer `settleAttestedSoon` | yes |
| POST /game-outcome | 10118 | anyone handing a source round's signed result | source committee signatures by the source's threshold (game-market.js `hold`), sigs capped at 64 | DB held market outcome / VOID, timer `settleAttestedSoon` | yes (markets area) |
| POST /h2h-want | 10164 | a lobby page that found no open head-to-head table | none | memory `round.__h2hWants` (one ms per hosted h2h game); read by the operator's grid keeper, which publishes a grid tx (run-testnet4-paid.mjs 531-535) | partly - by design any page may ask; at worst the keeper keeps publishing a grid every ~30 min as with RPS_GRID_ALWAYS=1 (not reported) |
| POST /here | 10177 | a tab sitting at a head-to-head table | BIP-340 sig of any identity key over (round, key) | memory presence tables (256 tables x 32 keys) | partly - any fresh key fills a table / the 256 tables; presence decides nothing (cosmetic, not reported) |
| POST /reveal | 10211 | the player's page, to every seat of the round | move+salt hash to the entry's commitment (`revealStands`); identity: sig of ANY key over (round, entry, key) - not bound to the entry's player | DB h2h_identities (INSERT OR IGNORE, round.js 3478), head_to_head_reveals (INSERT OR IGNORE 3495), may close the round (`round.close` + `afterClose`) | partly - the identity is first-writer-wins and unbound (doorsB-2) |
| all POST doors above | 323 (`read`) | - | - | whole request body buffered in memory, no size cap | no (doorsB-8) |

Doors in the range that only read (no row): /headers, /bond, /proposals, /market-sources, /config, /roles, /census, /guardian-bonds, /entry-void, /names, /refused-first-mark, /evidence-blocks, /start-forfeit, /game-icon, /network, /plugin, /games, /api/rounds (reads, but builds the full listing uncached - see doorsB-4), /api/round-result, /nostr-results, /badge-*, /donation-gifts, /items, /reach-nonce, /served, /block-random, /series-template, GET /series, GET /round, GET /handout, /stake, /settlement, /tx, /txs, /payments, /order-locks, GET /entry, /foreign-receipts, /equivocation, /late-first-mark, /canonical, /replay*, /transcript, /closing, /results, /postings, /attestation-word, GET /outcome, /polymarket (router), /price-samples, /round-result.

Read only. Every path below is under `packages/arena-node/` unless it says otherwise. `read()` (server.js 323) has no body cap and applies to every POST row (doorsC-9).

##### SM-D3. Doors (10290-12876)

| door | server.js line | caller (who is meant to call it) | auth / proof checked | state it moves (where persisted) | guarded? |
|---|---|---|---|---|---|
| POST /price-sign | 10290 | leader seat of sample k (legacy, protocol < 5) | leader's BIP-340 `leaderSig` (price-feed.js `#signAsk` 271-317) | one price per (round, slot): `price_signed` (CAS `#stepSign` 260) + `signed` map | yes (#1181 fix) |
| POST /price-attested | 10290 | any seat (fetchEnds) | threshold of committee sigs (`hold` 319-357) | `samples`/`tapes` memory, ends in `price_ends` INSERT OR IGNORE | yes; mid-samples first-wins lives in memory only (lost on restart, low) |
| POST /price-reading | 10290 | committee seat (protocol 5) | committee key signature (`reading` 614-644) | `heard` memory; ends rewritten in `price_ends` (INSERT OR REPLACE of the whole reading set) | partly: no time window on a committee seat's reading (median absorbs one) |
| POST /batch | 10326 | batch leader seat | order-batch.js `accept` 379-405 → `#check`/`#signGuard` | `market_batches` + order/event rows (`#store` 407-423, conflicts refuse) | yes (#1150 fix) |
| POST /batch-certificate | 10326 | any seat | threshold seat sigs (`certify` 439-469) | `market_batches.certificate`, rows moved | yes (#1150 fix) |
| POST /batch-void-ask, /batch-void | 10326 | round seat | `voidAsk` 520 / `applyVoid` 542 (signed ask) | `market_batch_declines`, VOID | yes (#1167 fix) |
| POST /sell | 10326 | player (any seat relays) | entry session key over sellId (`#sellStands` 242-255) | `market_book_events` INSERT OR IGNORE (`ask` 257-267) | partly: one entry can add unbounded sells (free nonce) until close |
| POST /cancel | 10351 | player | session key over cancelId; entry close | `cancels` (round.putCancel) or a book event | yes |
| POST /donations/read | 10417 | dev client | recipient key ECDSA + 10 min window | deletes `donation_outputs` rows of that key | yes (replay only re-deletes) |
| POST /exchange | 10446 | page holding e-cash of `from` | none (bearer e-cash); id = sha256(string) (ecash-exchange.js 78) | `ecash_exchanges` row + seat's e-cash of `to` paid out | **no: doorsC-2** |
| POST /lock | 10457 | page / relaying seat | takeStakeLock 5074 → verifyStakeLock stake-lock-signer-node.js 269-332 (federation holds the entry's own outpoint, contract id) | `stake_locks` INSERT OR REPLACE (round.js 2380) | yes (outpoint fixed by the entry; repeat is idempotent) |
| POST /fee-lock | 10486 | page | verifyFeeLock (same file, ~340-375) | `fee_locks` | yes |
| POST /refused-lock | 10514 | page of a refused round | handout A0/refund key + federation status | `refused_locks` INSERT OR REPLACE (round.js 2360) | yes |
| POST /forfeit-commit | 10587 | a round seat gathering a forfeit | none (forfeit.js `commit` 436-460 needs only that the forfeit is due) | nonce pair in memory `pairs` | **partly: doorsC-5** |
| POST /forfeit-share | 10587 | same | own commitment is in the list (`share` 462-482) | pair.list/share in memory (one list per pair) | **partly: doorsC-5** |
| POST /forfeit-signature | 10587 | same | verifies under claim key / KeyAgg (`take` 508-533) | `forfeits` (putForfeit) | yes |
| POST /settle-ack | 10636 | round seat | none; signs only the table it computed (settlement.js `ack`) | ack signature | yes |
| POST /settle-commit, /settle-share | 10645, 10655 | round seat | `x-settlement-ask` node-key signature (#1075) | nonces in memory | yes on 2.0; open on 1.9 (see doorsC-5) |
| POST /settle-signature | 10621 | round seat | verifies over own rebuilt txid (`take`) | `lock_settlements` | yes (#1170/#1171 scope) |
| POST /payout-address | 10707 | player | session key; first address stands | `payout_addresses` | yes |
| POST /settle-sends | 10752 | coordinator seat | sendPlanAskOf (node key, #1154) | `send_plans` | yes |
| POST /settle-taken | 10777 | asker | threshold of signed acceptances (`takeCertificate`) | plan certificate | yes |
| POST /send-commit | 10814 | sending seat | none (winnings-send.js `commit` 506-530: needs a plan row; `hash` only filters) | nonce pair in memory | **partly: doorsC-5** |
| POST /send-share | 10814 | sending seat | own commitment in the list (`share` 532-549) | pair.list/share in memory | **partly: doorsC-5** |
| POST /winnings-paid | 10826 | seat that asked the gateway | PLAN_ASK.PAID signature (#1185) | send PAID | yes |
| POST /resend-sends | 10858 | round seat | sendPlanAskOf RESEND (#1154) | attempt N+1 plan | yes |
| POST /series-publication | 10973 | anyone | tx is the chain's first publication; parents prove fee (publisher-payout.js 24-44) | `series_publications` INSERT OR IGNORE (round.js 3091) | yes |
| POST /referral-name | 11184 | site owner | site key signature (referral-names.js) | `referral_names` + fan-out once | yes (#1190) |
| POST /reserve-payout/commit\|share\|record | 11210 | guardian seats | signed asks (reserve-payout.js `askStands` 488, record 681) | FROST nonces / payout rows | yes (#1156/#1159) |
| POST /funding | 11249 | anyone, forwarded once | object signature by any key (funding-book.js `add` 317-389) | `funding_items` + forward to every seat (header `x-arena-forwarded` only suppresses the forward) | **partly: doorsC-6** |
| POST /donation-ballot | 11257 | anyone, forwarded once | proposer/approver signature, any key (donation-ballots.js `add` 62-77) | `donation_ballots` + `retally()` + forward | **partly: doorsC-6** |
| POST /address-announcement | 11548 | any node | node key signature, any key (address-book.js `take` 17-27) | `address_announcements` + memory `map` (loaded at boot), pulled by every seat | **partly: doorsC-6** |
| POST /founding | 11554 | drawn node | signed setup code (founding-seat.js `take`) | founding memory | per #1161 |
| POST /absence | 11567 | guardian seats | attester's own signature, any key (absences.js `offer` 64-74) | `held` map (cap 4096) + absences file | **no: doorsC-4** |
| POST /emergency-departure | 11580 | owner page | census advert names the emergency key (takeEmergency 2831-2848) | `emergencies` + file + forward | yes |
| POST /departure | 11607 | leaving guardian's node | signature by the node key the notice names, any key (`offerDeparture` 78-86) | `notices` map keyed (fid, peer) (cap 4096) + file | **no: doorsC-4** |
| POST /seating | 11614 | seats | certificate against own draw (`keepCert`) | `seat_certs` / equivocation | yes |
| POST /present, /presents | 11621, 11700 | drawn nodes | drawn for the round (seating-agent.js `takePresent` 333-365) | `seat_presents` | yes |
| POST /presence | 11638 | seats | PRESENT signature by the key it names, round held (presence-book.js `takeProof` 309-318) | `presence_proofs` INSERT OR IGNORE | partly: any fresh key adds rows (doorsC-6) |
| POST /absent | 11664 | posting (duty) node | **none**; shape only (presence-book.js `keepClaim` 386-419) | `absent_claims` INSERT OR REPLACE (418) | **no: doorsC-3** |
| POST /stall-notes | 11676 | seats | seat signature, round held (stall-book.js `take` 56) | stall notes | yes |
| POST /heartbeats, /heard | 11684, 11688 | members | committee member signature (heartbeat-agent.js) | heartbeat rows | yes |
| POST /node-facts | 11759 | any node | node key; bonded unless the census is unknown (node-facts.js `offer` 90-104) | `node_facts` + fan-out to every seat | partly (unknown census takes any key) |
| POST /halt-observations | 11814 | census seats | census seat signature (halts.js `take` 127-134) | halt observations + persist | yes (#1158) |
| POST /liquidations/events | 11836 | arbitration set | k-of-set signatures (arbitration-events.js `offer` 42-56), capped | events + file + fan-out | yes |
| POST /liquidations/spent-set | 11844 | guardians of a halted fed | record guardian + halt proof (liquidations.js `offer` 28-42) | `copies` memory | yes |
| POST /slash/&lt;id&gt;/carriers | 11865 | carrier node | carrier node key + carrier rule (`takeCarrierPegIn`) | carriers | yes |
| PUT /slash/&lt;id&gt; | 11871 | anyone | hash = id; abandoned/theft: threshold record; double: judged | `relayed` (forever) + `slashStarter.handed` | partly: any parseable proof is kept forever and handed to the starter (doorsC-7) |
| PUT /transcript/&lt;hash&gt; | 11909 | publisher of a run | only taggedHash(bytes) = path | `relayed` INSERT OR IGNORE, never pruned (round.js 3605) | **no: doorsC-7** |
| POST /final-sig | 11947 | committee seats | committee signature + timing (takeFinalSig 3640, final-sig.js 80-98) | `final_sigs` / `final_sig_evidence` (round.js 2145-2157) | partly: doorsC-8 |
| POST /audit | 11961 | auditor or forwarding seat | VRF/eligibility (`auditDesk.take`); forward needs seat signature | audits + forward + relays | yes |
| POST /objection | 12013 | anyone | receipts on every checkpoint + replay (verify.js `checkObjection` 1460, deduped by bytes) | `pending_objections` (withPendingObjection 410) then objection | yes (#1173) |
| POST /dkg | 12175 | committee seats | contribution checks (`dkg.accept`) | epochs; `peerMakesEpoch` 3561 | yes |
| POST /census-sign/commit\|share | 12231 | census-key holders | census-sign.js | nonce sessions | known: #1155, #1187 |
| POST /census-dkg/ready\|deal\|complaint\|statement | 12257-12278 | holders of the run | holder signatures / proven complaint (census-key-run.js 178-226) | run state | yes |
| GET /forfeit (writes) | 11049 | player / anyone | forfeit due on own record (forfeit.js `forfeit` 536) | fan-out to peers, `forfeits` | yes (public return door by design) |
| GET /claim-key (writes) | 11295 | page | this node assigned | `wantedTables`, `makeClaimKey` 3586 (DKG fan-out) | yes (once per committee) |
| GET /dkg (writes) | 12184 | seat that missed a deal | none | `peerMakesEpoch` scan, `epochMissedAt` (cap 4096) | yes (CPU per unknown id) |
| GET /federations?fresh=1 (writes) | 11803 | health page | none | `fedRecords.gatherAll` fan-out to every guardian, mirrors | partly: doorsC-10 |
| GET /founding?members=1 | 11560 | health page | none | asks every drawable node | partly: doorsC-10 |
| GET /federation-record (signs) | 11515 | gathering seat | `left`/proof params | a signature | per #1157 |
| GET /reruns, /final-sig (sign) | 11330, 11926 | holders | none | fresh signatures, no state | yes |
| GET /settled, /lock-settlement | 11030, 11005 | pages | none | `summaries` cache (cap 4096) | yes |
| GET /reserves, /capacity | 11116, 11766 | pages | none | `reservesKept` (2 keys), `capacityWas` (per fed) | yes |
| GET /settle-sends (signs) | 10735 | asker | none | signed headers | yes |
| GET /slash-pegin (writes) | 12250 | escrow signers | start read here | `slash_pegins` + a client peg-in address (slash-release-run.js 205-218) | yes |
| ws /play `close <round>` | 12617 | (test harness only) | **none** | `rounds.state = CLOSED` (round.js `close` 1649) + `afterClose` 3987 (replay, sign, settle) | **no: doorsC-1** |
| ws /play `watch`, receipts, marks | 12566, 12650-12670 | players / peers | session key / receipt signatures | `watching` per socket, receipts | yes |

Doors in the table: 68 rows (80 doors counting the grouped ones).

## 7. Money paths, end to end

*From #1210, `money.md`.*

Only what audit 2 does not describe, or where audit 2 is now wrong (audit 2 reserves.md SM-5 still says the exchange key is sha256 of the string; see D / SM-D1).

#### Part A: deposit, wallet, withdraw, zap

Only what audit 2 does not describe.

##### SM-MA1 Where the page's balance and "held federations" come from (the seam every inflow writes into)
Every inflow has to leave one of two marks, or its federation's wallet is never opened again on a later page:
- a history row `arena.ledger.<fed>.<id>`;
- a pending deposit key `arena.deposit.pending.<fed>.<op>`.
- Read by: ledgerFederations (page-lock.js 3399-3413), the open list of ARENA_SUM_BALANCES (index.html 8146-8153), withdrawFederation (federations.js 303; it picks only from summed parts), and the join's `have` (index.html 3757, read from ARENA_WALLETS only).
- Writers per inflow:
  - deposit: pending key at the invoice, row at Claimed;
  - swap / move / evacuate: row after Claimed (CLIENT-7);
  - collect: row 'winnings'/'refund' (3088);
  - zap / referral: row 'zap-in' / 'referral' after the collect (index.html 6710);
  - **e-cash exchange: no row and no key, ever** (ecash-transfer.js 290-319; ARENA_EXCHANGE_INTO index.html 5122-5152).
- The in-flight part of the sum scans only `arena.ecash.pending.*` (index.html 8193). It never scans `arena.ecash.exchange.*`, although `ecashTransferMsatInFlight` (ecash-transfer.js 86-93) is written to count answered/handed exchange records.

| inflow | mark before money moves | mark after | counted while in flight |
|---|---|---|---|
| LN deposit | pending key (pendingAdd 1033) | row dep-<hash> (depositRowOnce 1067) | yes (wallet issuing) |
| merge | `arena.ecash.pending.*` record | none needed (same federation) | yes |
| exchange in | `arena.ecash.exchange.*` record | **none** | **no** |
| zap / referral collect | none (seat listing) | row zap-in / referral | n/a |

##### SM-MA2 Zap and referral collect (identity.js collectZaps 254-289), per outpoint, browser-wide
- `found`: one listing per outpoint, from the first seat that answers (262-268). Each later seat's version is ignored.
- Per pass, each outpoint not yet seen moves to one of four states:
  - `waiting`: no open wallet client for `d.federationId` (272-273). Retried; no wallet is ever opened for it.
  - `failed`: the refund threw, or the federation refused (279, 282). Retried.
  - `collected`: `accepted` (280). Added to seen.
  - `spent`: `stored_before` null in the named federation (281). Added to seen and final.
- Persisted: `arena.zaps.collected` (the last 500 seen outpoints, in browser storage, not per phrase), 285. Memory: ARENA_ZAPS_IN.
- Driver: index.html 6698-6716 (20 s after load, then every 60 s; `clients` = ARENA_WALLETS only, 6701).

##### SM-MA3 Withdraw (page-lock.js withdrawCollected 2758-2789, withdrawPlayerWallet 2791-2801; lock client lib.rs withdraw 583-640)
- States: asked -> invoice (pasted, or made by NWC) -> `ln.send` (fedimint persists the send state machine) -> Success | Refunded | Failure.
- Nothing is written by the page before or during the send. The 'withdrawal' row is written only on Success while the page is still open (2799, 3121).
- Duplicate guard: only fedimint's, per wallet database. The operation id is `(invoice, attempt)` (fedimint-fork modules/fedimint-lnv2-client/src/lib.rs 563, 698): a second send of a paid invoice from the SAME wallet is refused. No guard spans wallets: the player wallets of other federations, other phrases, or a round's tab wallet (tabLockWallet).

##### SM-MA4 Seat-side index of settlement payouts to keys (settlement.js indexDonationKeys 2750-2770)
- `donation_outputs` rows for 'donation key', 'reserve' and 'frontend' (website/referral) payouts. These rows are what GET /donations serves: to dev clients, to the page's collectZaps and to the reserves' book.
- Written at: the single-federation ACCEPTED path (2653-2660), indexRecovered (2776-2805), the backfills (2825-2865, which read only `lock_settlements`).
- **Never written** for an any-federation round's per-federation rows (#settleFederations 2671-2742). Even if it were, `federationId` would be taken from the round contract (2753), which is 32 zero bytes for such a round (constants.js 144-145).

#### Part B: stake/fee lock, entry, fees in force

Only what audit 2 does not describe.

##### SMB-1 An entry's stake at one seat (implicit; the seam the settlement reads)
Tables: `entries` (entry_id PK), `stake_locks` / `fee_locks` (entry_id PK, `outpoint` TEXT, **no UNIQUE on outpoint**, store.js:956-982),
`stake_seen` (INSERT OR IGNORE), `donation_outputs`.

| from | event | guard | to |
|---|---|---|---|
| none | POST /entry -> `round.enter` (round.js:535-762) | round open, fee/donation by **constants** (714-722), handout A0 = stake point; **no check that another entry of the round uses the same playerPubkey, stake point or lock outpoints** | entry stored |
| entry | POST /lock -> takeStakeLock -> verifyStakeLock (stake-lock-signer-node.js:270-331) | `stakeLockAt(outpoint)` read at 285, then 1-3 awaited federation calls, then `putStakeLock` INSERT OR REPLACE (322): check-then-act, not atomic | stake lock kept (+ stake_seen, or waits for fee lock) |
| entry | POST /fee-lock -> verifyFeeLock (341-379) | **no outpoint-in-use check at all** | fee lock kept (+ stake_seen if stake waits) |
| stake_seen | planOf / #attestedPlan / #bookPlan (settlement.js:1036-1059, 651-667) | locks put in a `Map` **keyed by playerPubkey hex**; a second entry of the same key overwrites the first | plan (claims looked up by key, lock-settlement.js:126/264/289/559/720) |

Invariant the settlement assumes but no door enforces: one stake lock, one fee lock and one entry per player key per round.

##### SMB-2 The fees in force for one round (derived; three readers)
Source: `feesFor(contract)` = funding book `feesAt(censusHeight)` (server.js:1993-1994), FEES_TODAY until a fee proposal is accepted
(fee-proposal.js:28-44, 164-180; `roundNodeBps`, `roundReserveBps`, `marketNodeBps`, `marketReserveBps` change by vote alone, no developer approval).

| reader | uses | where |
|---|---|---|
| page (entry it builds and locks) | the set its seats name, `round.feeSet` / `round.feeBps` | index.html:3591-3600; join.js:52-53; reserves-page.js:103 |
| /entry door, gifts at /lock | the set in force (`roundSplitBps(feesFor(rc))`) | server.js:9502, 5085 |
| `round.enter` (the same door, a few lines later; also the relay path) | **constants**: RESERVES_NODE_FEE_BPS, `roundSplit()` default, manifest `entryFeeBpsOf` | round.js:714-722 |
| settlement fee table | the set in force (`roundFees` -> feeBps nodes; markets `marketRates(manifest, fees)`) | settlement.js:622-626; order-batch.js:53-60 |

No state is persisted; the disagreement appears the moment an accepted proposal activates.

#### Part C: settlement payout, re-sends, donation index

Only what audit 2 does not describe.

##### SM-C-1 A send's next attempt (attempt N+1), and who owns it (implicit)
Rows: `winnings_sends` / `donation_sends` / `late_winnings_sends`, one row per (entry or send id, attempt). round.js:2466-2475 `putSendPlan` is INSERT ... ON CONFLICT(entry_id, attempt) DO NOTHING.
- none -> PLANNED(N+1, own invoice): `proposeResend` winnings-send.js:418-441. Called by `sendAll` for a HELD attempt-0 share (763-770) and for an expired attempt (834). It writes its own row at 437 first, then offers it (`offerResend` 448).
- none -> PLANNED(N+1, peer's invoice): `checkResend` 465-496, door POST /resend-sends server.js:10858. It refuses when this seat already holds any other attempt N+1 (470-473, 493-494).
- PLANNED(N+1) -> FUNDING -> SENDING -> PAID / expired -> N+2: `sendAll` 772-835.
- PLANNED(N+1) -> deleted: **no such edge**. `dropPlannedSends` (round.js:2512-2519) deletes attempt 0 only.
- Who may run `sendAll`: every seat where `turn().mine` (settlement.js:3030-3050). That is every seat of the round once the chain is (n-1) x 2 blocks past the beacon (payout.js:121-146), and the sweep runs on every seat every 60 s (server.js:4719-4732).
- Attempt 0 has a convergence rule (`check`: a lower `planKey` from a seat replaces the kept plan while `replaceable`). Attempt N+1 has none. See MONEY-C2.
- 1.9: winnings-send.js:398, 412, 440-469, 616-686; round.js:2352-2357, 2398; settlement.js:2103-2121; server.js:3785. Same.

##### SM-C-2 Settlement-paid key outputs in the donations index (`donation_outputs`, implicit)
Rows of kind 'donation key' (developers), 'frontend' (the website that brought an entry) and 'reserve' (a market's protocol reserve) of a landed settlement, keyed by outpoint `txid:idx`.
- none -> indexed: `indexDonationKeys` settlement.js:2750-2765. It is reached only from the ROUND's own row: 2548, 2558 (`indexRecovered`), 2653, 2656, and the backfills 2824-2846 and 2848-2885, which read `lockSettlement` / `lockSettlementsIn` (round rows only).
- indexed -> deleted: POST /donations/read (the recipient's read receipt).
- Readers: GET /donations server.js:10406-10409 (arena-donor `gatherDonations`, packages/arena-donor/src/donor.js:90-112, reads nothing else); the reserves book and reserve payouts `reserveRows` server.js:1967-1968; website totals server.js:11173.
- Never written for: a federation row of a round that takes any federation (`#settleFederations` 2671-2743), and a late settlement (`settleLate` 815-873). See MONEY-C1.

##### SM-C-3 Where a winner's page learns what it is paid (implicit)
- GET /lock-settlement (server.js:11005-11021) answers the round's own row, or each federation row (`fedSummary`).
- GET /settled (11030-11045) lists the qualifier keys of round settlements.
- The page collects from these only: page-lock.js `settlementOf` 2203-2230, `redeemPayout` 2280-2317, `redeemPayoutsAcross` 2348-2378.
- A late settlement's row (`late_lock_settlements`), its txid and what it pays are served by no door. See MONEY-C3.

#### Part D: exchange after #1207, liquidation payers, reserve move

Only what audit 2 does not have, or has wrong after the fixes.

##### SM-D1 E-cash exchange after #1207 (corrects audit 2 reserves.md SM-5, which still says "key: sha256 of the string")
ecash-exchange.js (same file on both lines). Key = `noteKey` (:47-50): sha256 of the decoded base32 bytes (lowercased, prefix stripped, trailing bits dropped, as fedimint `decode_prefixed_bytes`), or the legacy sha256(trimmed string) when a row with that key already exists (:109-110).

| from | event | to | guard / write |
|---|---|---|---|
| none | first POST, hour cap and B balance ok | RECEIVING, receive_asked=0 | INSERT OR IGNORE (:133) |
| RECEIVING | before each reissue ask | (same), receive_asked=1 | `markAsked` (:141) written BEFORE the tool runs |
| RECEIVING | tool throws (timeout, lock busy, WrongFederation) | RECEIVING (asked=1) | 503, nothing else (:144) |
| RECEIVING | Success | TAKEN, in_msat = **the client's balance rise** (tool main.rs 2.0 1296-1306, 1.9 1123-1133) | :146, :166 |
| RECEIVING | AlreadyReceived and the row had not asked before | REFUSED | :147-151 (the #1207 guard) |
| RECEIVING | AlreadyReceived, asked before, earlier Success, carriedMsat | TAKEN, in_msat = carriedMsat (face of the notes) | :152-166 |
| TAKEN | in_msat > 0 | SENDING (pay_msat = min(in, want)) | :171-178 |
| TAKEN | in_msat = 0 | **TAKEN, 409 "carried nothing" - no transition exists** | :173 |
| SENDING | keyed send read back / made | PAID | :185-209 |

Checked against variants: re-cased, mixed case, Unicode case-folding (Rust and JS both map U+212A to `k`), whitespace (both trim the same JS-trimmed string), changed trailing bits: one noteKey. Re-wrapped notes (an ECash with an extra Invite/Default field or another field order) decode to other bytes and so another key, but also to another `OperationId::from_encodable(&ecash)` (mintv2 lib.rs 978), so the second reissue is a real double spend the federation rejects (Rejected -> REFUSED), not an AlreadyReceived. fedimint's decoders are canonical (BigSize, `consensus_decode_whole`, enum length checks), so I found no two byte strings for one ECash. The RES-3 fix holds for the variants I tried. The one gap left is narrow: a legacy row (keyed by string, receive_asked NULL so "asked") left in RECEIVING before the upgrade, whose reissue never reached the federation. A re-cased copy is then a new row that receives Success and is paid, and the legacy row's retry then gets AlreadyReceived/Success and is paid as well. That needs a pre-upgrade RECEIVING row whose receive failed before it was submitted, so I do not report it as a finding (fix: when a legacy key is hit, also check the noteKey and treat both keys as one row).

##### SM-D2 Who pays a liquidation claim (seam between SM-10 and SM-13 of audit 2), 2.0 only
One claims ledger (the arbitration set's door, liquidation-claims.js `claims` Map, which keeps nonce, amount, payoutPk and height only, :58) and two payers:
- the arbitration set's escrow: payOutLiquidation (liquidation-claims.js 144-235). escrowTxid (the on-chain escrow moved into a safe federation at the window's opening, :156-165), then claimedMsat, then note batches. It pays `plan(fid, { escrowMsat: v.claimedMsat })` (:179) and records what it paid in `v.paidNonces` / `v.payouts` (the arbiter's state file).
- the census-key liquidation escrows (liquidation-escrow-run.js `buildAt` 259-265): owed = `claimsOwed(accepted, coveredMsat)` (arena-protocol liquidation-escrow.js 120-124). coveredMsat comes from GET /liquidation-claims `paidNotes` (server.js `liquidationLedger` 4614-4623), and the door computes that over `escrowMsatOf(fid)`, the on-chain escrow UTXO (tools/arbiter.mjs 443-448, `gettxout`).

Intended invariant: for each nonce, arbiter paid + census-key paid <= face, paid once. Persisted in two places (the arbiter's state file and the seats' liq_claim_locks / liq_carried), and the coverage that links them is recomputed on every read rather than taken from what was paid (MONEY-D3).

##### SM-D3 Drained-federation reserve move id
reserve-move.js 17 `moveIdOf(from, to)` = one id per (drained X, destination). reserve-payout.js `moveRound` 983-1050: every pass `moveTargets` lists the move while X holds anything unspent. A record PAID or terminal (CLAIMED, REFUNDED, SHORT) is skipped for good (:1007). States: none -> PLANNED -> ... -> PAID -> CLAIMED (terminal). Nothing makes a second move for the same pair (MONEY-D5).

## 8. Effects and their records (crash/restart)

*From #1210, `crash.md`.*

These are only the ones audit 2 did not describe, or described without the crash edge.

#### SM-A Arbiter slash posting (`state.handled[proof]`, tools/arbiter.mjs)
Persisted in `ARENA_ARBITER_STATE` by `keep()` 75: one whole-file `writeFileSync`, no temp file, no fsync. It is loaded at start with
an unguarded `JSON.parse` (74).

| from | event | to | guard |
|---|---|---|---|
| absent | handle(): judged, bond unspent (`gettxout` 205), built, `post()` ok | `{ done, posted, players, escrowSats, ... }` | written by pass() 396 AFTER `post` returned |
| absent | `gettxout(bond)` null | `{ done: true, why: 'the bond is spent already' }` (no `posted`) | 206 |
| absent | handleAbandoned(): `gettxout(out, true)` null | `{ done: true, why: 'that output is spent already' }` | 120 |
| handled with `posted`+`escrowSats` | payOut | stages ... settled | 399 |
| handled without `posted` | - | final: no payout, no event (arbiterEvents 347) | |

Invariant intended: every bond this set spent by path B has a handled row carrying `posted`. It does not hold (CRASH-1).

#### SM-B Arbiter escrow split (`v.stages[]`, arbiter.js payOutSlash 419-497)
none -> stage `{ txid, pegIns[{ address, sats, vout }], kept }` (pushed 455 AFTER `post` 451) -> per peg-in `claimedMsat` -> `pay`
(keyed, #1174) -> `paidTxid` -> `stage.done` -> next stage from `kept`, or `settled`. Each pass asks the fed client for fresh peg-in
addresses (440) before it builds. On a legacy wallet module that is a new address per call; on walletv2 it is the same address.

#### SM-C Liquidation escrow into the safe federation (`state.liquidations[fid]`, liquidation-claims.js 143-221)
none -> `escrowTxid + pegInAddress` (written 163 AFTER `spendEscrow` 160 posts) -> `claimedMsat` -> note batches (keyed) ->
remainder (keyed). `spendEscrow` (tools/arbiter.mjs 296-308) answers "spent or unknown" when `gettxout` of the escrow is null.
The claims book (`claimsFile`, 450-451) is a whole-file `writeFileSync`. Its `load` turns any read error into `[]`.

#### SM-D Gateway held proof journal (held-proof-run.js 20-101)
wait -> sending (`sendAsked` written before gatewayd's send) -> funding (the notes kept) -> locking -> reading -> expiring -> refunding
-> sendback -> homing (the notes kept) -> done. The journal is written tmp + rename (gateway-held-proof.mjs 59). Every send has a
write-ahead guard except one: the client's send of the money home at 94 is unkeyed, and the notes are written only after it answers.

#### SM-E Protocol-5 own reading (price-feed.js 158, 577-606, 751-766)
Per `(round, k)` and `(round, 'tape')`: none -> signed (`this.mine`, MEMORY ONLY) -> posted to the committee. The legacy path
writes `price_signed` before its signature leaves (175-178, #1181). This path does not. Receivers (`reading` 614-646): one key with
two different readings of one sample counts for neither.

#### SM-F Census-key anchor post (census-key-anchor.js 87-108)
none -> commit tx to `carrier(secret)` sent -> reveal tx sent. `secret` is `randomSecretKey()`, kept in a local variable only. Any
throw between the two sends returns `{ ok: false }`. Nothing records the commit.

#### SM-G Durability under every SQLite write-ahead record (store.js 64-76)
`journal_mode = WAL`, `synchronous = NORMAL` (both lines, 1.9 store.js 69). A commit is durable across a crash of the PROCESS. It is
not durable across a power loss, an OS crash or a VM hard stop: the WAL is fsynced only at checkpoints (`wal_autocheckpoint = 10000`
pages). The SQLite documentation says so: "a transaction committed in WAL mode with synchronous=NORMAL might roll back following a
power loss or system crash". Every "written before the effect" step on a seat (#1160, #1171, #1181, #1186, `keepDeal`, `putEpoch`,
`putResult`, `receive_asked`) stands on this.

## 9. Interleavings inside one process

*From #1210, `concurrency.md`.*

Only what audit 2 does not describe, or describes only for one writer.

#### K1 Who may run a round's winnings sends (in-memory serializers)
Two serializers guard one action, `WinningsSender.sendAll(round)`:
- `settle()` keeps one promise per round in `#settling` (settlement.js 2.0 2510-2521, 1.9 1616-1627). `#settleOnce` calls
  `sendWinnings` -> `sendAll` when the row is already ACCEPTED (2.0 2532-2535) and right after a submit lands ACCEPTED (2.0 2661).
- The winnings sweep keeps one boolean, `sweepingWinnings` (server.js 2.0 4716-4733, 1.9 3782-3799). It calls
  `settlements.sendWinnings(rid)` (settlement.js 2.0 3124-3139, 1.9 2197-2212). For a row that is not ACCEPTED, that goes through `settle()`.
  For an ACCEPTED row it calls `winnings.sendAll` directly, outside `#settling`.
- Invariant the code assumes (send-state.js header): one proposer at a time moves a send row. Nothing enforces it across the two serializers.
- Late sends (`sendLate`/`settleLate`) have only the late timer as caller (`sweepingLate`, server.js 2.0 4739). That is a single serializer, so no finding.

#### K2 Stake lock binding (`stake_locks`)
- Row: entry_id (PK) -> outpoint, fields, contract_id (store.js 2.0 956-963, 1.9 879-886). Written only by `verifyStakeLock`
  (stake-lock-signer-node.js 2.0 322, 1.9 196) via `putStakeLock` (round.js 2.0 2380, INSERT OR REPLACE).
- Invariant, as the code comments it: "ONE LOCK IS ONE ENTRY" (stake-lock-signer-node.js 2.0 283-287, 1.9 167-171).
- Guard: `round.stakeLockAt(outpoint)` is read once, before 3-5 awaits (arenaLockStands 291, status/contractId 300, verifyEntryGifts 316,
  roundMintsFees 326). There is no UNIQUE on `outpoint` and no check again at the write.
- Writers that can run at once for the same outpoint: POST /lock (server.js 2.0 10457), POST /order-locks from a peer via `takeEntryParts`
  (server.js 2.0 ~5151, which calls takeStakeLock), and the seat's own retries.
- Settlement reads the locks into a Map keyed by player key, not by entry (settlement.js 2.0 659, 775, 1042).

#### K3 Reserve payout row: plan identity under compare-and-set
- `transition(pid, from, to)` (reserve-payout.js 2.0/1.9 233-261) does `UPDATE ... WHERE proposal = ? AND state = @from`. It checks the
  state only, never `plan_id`.
- The row's plan can change while it stays in PLANNED: PLANNED(N) -> EXPIRED -> PLANNED(N+1). This happens through `expireIfDue` plus
  the re-plan in `round()` (2.0 863-930), or through `learn` -> `mayReplace` -> `expireIfDue` (2.0 842-858).
- `submit()` reads the plan at the start of the pass and awaits `sign(plan,'tx')` and `txidOfPlan` (a tool spawn). It then moves
  PLANNED -> SUBMITTING with that plan's txid and signature (2.0 1073-1083, 1.9 1075-1080).
- Driver: the funding chain `setInterval(..., 120000)` (server.js 2.0 1995-2002, 1.9 1877-1884) runs
  `decide -> voteRound -> decideFees -> reservePayouts.round`. It has no busy flag, so a pass longer than 120 s overlaps the next one.

#### K4 Background loops and their overlap guards (checked list)
| loop | file:line (2.0) | guard |
|---|---|---|
| winnings sweep | server.js 4719 | `sweepingWinnings` (see K1: not shared with settle) |
| late sweep | server.js 4740 | `sweepingLate` |
| attested settle sweep | server.js 856-890 | `sweeping` |
| settle recover / retryUnsettled | server.js 4198-4217, settlement.js 2451 | `recoveringNow`, `#retrying` |
| founding | server.js 5973-5975 | self-rescheduling setTimeout |
| arbiter pass | tools/arbiter.mjs 474-478 | `passing` |
| funding + reserve payouts + moves | server.js 1995 | **none** (K3, CONC-3) |
| reserve DKG | server.js 1722-1736 | **none**; DKG fetches have no timeout (CONC-4) |
| claim-key DKG | server.js 3600-3640 | `claimKeyRuns` per epoch; DKG fetches have no timeout |

## 10. Decisions several seats must share

*From #1210, `consensus.md`.*

Only those not already in sections 1-6 above, or where that description is incomplete.

- **SM-1 Donation ballot (developers' set vote, §27A.4.1).** Table `donation_ballots(id PK, kind, proposal, hex, at_ms)`
  (donation-ballots.js 20). Per proposal, derived on every `retally`: open -> approved (validFrom = the approval's at_height + 1)
  | refused (proto/donation-vote.js 97-135).
  - Guards: the signer's signature, an approval only for a proposal held here (else 404, 68), and each recipient counted once by
    lowest at_height (124).
  - Not guarded: at_height is a number the signer picks (it is never checked against any chain). Approvals arrive only by POST,
    plus one fire-and-forget forward (server.js 1417-1420). There is no pull, and a POST carrying `x-arena-forwarded` is not
    forwarded at all (11262).
  - Consumers: `approvedSets()` -> `donationSetInForce` -> `donationSetFor` / `ballotRecipients` / `donationInForceRefusal`.
    The last one is memoised in `inForceKept` (1538-1543), which is cleared only on a network package change (6506, 6574),
    never when a ballot approves a set.
- **SM-2 Config proposal intake (proposals.js).** audit 2 B1 has the states. Missing there: intake fixes `votingFrom`,
  `votingUntil` and `repeal` ONCE, from `historyFor(net, publishedAt)` (99-111). That history is built only from proposals this
  seat already holds and has decided. The peer pull walks each peer's list newest first (133), takes at most 256 (156), and never
  re-checks a kept record.
- **SM-3 Ballot census per proposal (ballot-tally.js 204-209).** Memory only: none -> read (`o.census`), kept until the proposal
  is decided, its count is reset by a reorg, or the seat restarts. The read is main.js `chainRead` -> `chainCensusKept` (399-430).
  Its cache key carries the block hash and `standingKeysName(censusKeyScan.standing())`, but no read waits for
  `censusKeyScan.scannedTo() >= height`.
- **SM-4 Census view (main.js 599-647).** Memory: absent -> reading -> held short of the beacon (re-read every 10 s) -> held
  complete. "Held complete" is terminal: it is never checked against the chain again, and the `views` map does not evict (341).
- **SM-5 Round beacon.** none -> held (beacon-source.js 103) -> dropped when the 400-header window shows another block at its
  height (121-127). Each beacon is also written to `round_beacons` (round.js 2899-2904), and that stored row is served whenever
  beacon-source holds nothing (server.js 1567).
- **SM-6 Signer nodes (`signer_nodes`).** none -> assigned. INSERT OR IGNORE (round.js 159-168). Assigned once by POST /round
  (server.js 8672), the posted-ahead sweep (5274-5281) or the series writer (5379-5381), and never re-derived. Only v2 rounds are
  rewritten, by a seating certificate (round.js 178-200).
- **SM-7 Window presence evidence.** `seat_presents` (seating-agent.js 358), `presence_proofs` (presence-book.js 316), `hb_beats`:
  all INSERT OR IGNORE, with no receive time. The only time gate is the seating close held in the in-memory `starts`, which drops a
  round 10 min after its start (seating-agent.js 258, 486-487).
- **SM-8 Seating certificate as one seat knows it.** none -> one certificate (the seat stops reading peers, seating-agent.js 501)
  -> equivocation (`seat_equivocations`, 192-200). A second certificate can arrive only by POST /seating.
- **SM-9 Who is in a round, per seat.** `entries` INSERT OR IGNORE (round.js 768).
  - Paths in: the door, the relay (head-to-head only, server.js 9513 and 10475), `importEntry`, `takeAcceptedEntry`.
  - Time limits at the door: CLOSED; start + 37 s for a late-join entry new here (round.js 590); entry close only for attested
    and head-to-head rounds (621, 661).
  - `stake_seen` / `stake_seen_tick` are written once, when this seat's lock verification finishes (round.js 1873-1894).
- **SM-10 First mark, per seat and entry.** none -> held | `start_forfeits` (round.js 1063-1081) | `refused_first_marks` |
  ENTRY_VOID.
  - Forward answers per peer (`first_mark_offers`, server.js 2052-2074): receipted / refused (any 404 or 409) / late / unanswered.
  - Two start lines: the door uses `max(joinTick, stakeSeenTick) + 900`; `startLine` (§13C/§16) uses `joinTick + 900`
    (round.js 2918-2925).
- **SM-11 Head-to-head reveal.** Taken once at the door, timed by this seat's clock (proto head-to-head.js 50; server.js
  10206-10230). At the close, peers' reveals are carried in once, with no time check (verify.js 743-772).
- **SM-12 Fee proposal outcome.** Table `fee_outcomes`: none -> accepted | refused. INSERT OR IGNORE (funding-book.js 270), with
  no transition out, and it is not reopened when its vote is (130-139).
  - Developer approvals: `funding_items` kind `fee-approval`. Any number per developer, no deadline; read `ORDER BY at_ms`, and
    the last one counts (proto/fee-proposal.js 145-158).
- **SM-13 Halt height.** Derived and never persisted (halt-proof.js 57-87): recomputed on every call from the observations kept
  now and the census now. The arbiter freezes its own `v.halt` once, from the first seat that lists the halt
  (tools/arbiter.mjs 317), so two views exist.
- **SM-14 Proof-judge verdict cache.** proof-judge.js 139-165, memory: absent -> judging -> true | false, kept until 256 others
  push it out. Nothing revisits a kept verdict when its inputs (reserve key, entries held) change.
- **SM-15 Reserve key, for payees and plans.** server.js 1698-1722, reserve-key-cache.js: one key per federation, the current
  epoch only, no history.

## 11. State the 2026-11-06 fixes introduced or changed

*From #1210, `fixes.md`.*

Only what audit 2 does not describe, or describes wrongly. Every entry is persisted unless it says memory.

- **Liquidation pending-outputs claim** (client; missing from client.md SM-C3). Key `arena-liquidation-pending-<fid>`, written with putRoomy.
  The code is in arena-client/src/liquidation-claim.js:114-133.
  - Moves: none -> kept (in the window and pendingOutputs is not empty); kept -> posted (the door answers ok); posted -> posted (posted again after 1 h).
  - kept|posted -> none on `taken`, which is true when **any** accepted claim under the payout key is listed.
  - The same `taken` drops a notes record that is only `kept` (line 72), not just a posted one. SM-C3 says only posted records are dropped.
- **Pending deposit** `arena.deposit.pending.<fed>.<op>` (correction to client.md SM-L4). The code is in arena-client/src/page-lock.js:1019-1135.
  - pending -> gone on depositEnded (Claimed writes its row first, or Expired, or Failure).
  - pending -> gone also when the entry is in `lost` and **any** wallet's scan read the stream to the end (line 1133). That wallet may be another phrase's, and the receive it found may still be running.
  - Entries name no phrase.
- **Re-send slot, attempt N >= 1** (addition to settlement.md SM-7/SM-8). winnings-send.js:418-497.
  - Written by putSendPlan with ON CONFLICT DO NOTHING. There is no replace edge, no drop edge and no tie-break; dropPlannedSends (round.js:2512) clears attempt 0 only.
  - HELD's only edge is HELD -> HELD (send-state.js NEXT).
  - A round whose latest row is REFUNDED stays in roundsWithUnpaidSends (round.js:2523-2531) and is visited every minute.
- **Reserve payout** (corrections to reserves.md SM-1). reserve-payout.js:88-96.
  - SUBMITTING has no edge to EXPIRED (line 91). Its kept `submit_sig` is handed in on every pass with no height check (1073-1088).
  - EXPIRED is reached only when every input is unspent (548-555). A plan with one spent input that this seat holds no record for stays PLANNED for good.
  - SHORT is terminal and is written from transient reads (694-707, 887-893).
- **E-cash exchange** (update of reserves.md SM-5, after #1207). ecash-exchange.js.
  - Key: noteKey, the sha256 of "notes:" plus the decoded bytes. A string that does not decode is lowercased instead. A legacy row keeps the sha256 of the trimmed string (108-110).
  - `receive_asked` is 0 on a new row, set to 1 before each ask, and NULL on a legacy row (NULL counts as asked, line 140).
  - On RECEIVING with AlreadyReceived: a row that asked before goes to TAKEN; a first ask goes to REFUSED (147-161).
- **Funding payment row** (reserves.md SM-6). funding-book.js:187-216.
  - null -> FIXED -> CANCELLED, plus FIXED -> FIXED (refix).
  - A refix is allowed while no part is payable at the tip, and the "payable" test is false when the tip is unknown (213-216).
- **Funding/leaderboard vote** (correction to reserves.md SM-7). The "blocks by hash" are null after an RPC error:
  - main.js:482 blockHashAt returns null on any error;
  - funding-book.js:127 swallows it again;
  - 177-179 then write the outcome with last_hash NULL, and 137 never checks that outcome for a reorg again.
- **Order batch** (gap in markets.md SM-1). A seat that signed another set of batch k answers a void ask with that signature (order-batch.js:536-537).
  - That signature is neither a decline nor a vote for the asked set.
  - With two leader-signed sets of k, nothing leaves SIGNED (FIXES-22).
- **Update stage** (addition to federation SM5). update-stage.js 38-100; server.js 1675-1687.
  - `members` is every census guardian_of entry, including gone, departed and dead ones; members with no endpoint drop out of `peers`.
  - Both kinds read SILENT, which holds a place on trial with no expiry.
- **Slash carrier margin** (gap in reserves.md SM-12). slash_margin_owed is shared by every output of one federation.
  - payOn reads it fresh (slash-release-run.js:638) and is not part of the keyed payout's ASKED record.
  - On a read-back it is still cleared by its current value (670, 681).
- **Liquidation claim lock** (gap in reserves.md SM-13).
  - held -> free only when the chain shows the held escrow output spent without the claim (liquidation-escrow-run.js:111-117). There is no timeout and no release when a signing fails.
  - The owed set a holder builds depends on its own locks (265), so two holders can build different outputs for one start.
- **Release send** (gap in reserves.md SM-14). slash-release-run.js:337-347.
  - SENT is terminal even if the transaction later leaves the mempool.
  - A send refused because the same txid with another witness is in the mempool ("txn-same-nonwitness-data-in-mempool", which the ALREADY regex at line 42 does not match) moves sending -> proposed. The next pass rebuilds and re-gathers.
- **Slash fee coin** (gap in reserves.md SM-14). slash-start-run.js:151-160.
  - filing -> funded on any send error that ALREADY does not match. That includes a lost answer, and the signed bytes are cleared.
- **Census-key shares held** (census-key-store.js:75-88). After #1188 a holder keeps two epochs of one key for 288 blocks; a new epoch's shares are written at local completion, before its record stands.
  - held(publicKey) with no epoch answers the **newest** epoch.
  - census-key-run asks by the standing generation's epoch (137, 394). The slash signer does not (slash-start-run.js:77, 186; server.js:4638 heldKey).

## 12. The page, its storage and its frames

*From #1210, `page.md`.*

Only what audit 2 does not describe, or describes wrongly.

#### SM-P1 Game catalogue -> tile -> chosen game -> lobby filter (memory, address bar)
- `fetchGames` (games.js 25-75): every node's `GET /games`. A game is kept when `gameIdOf(manifest) === id`. The developer's signature is never checked: `manifestStands` has no caller in arena-client or index.html.
- `oneTilePerGame` (games.js 79-100): groups by `${manifest.gameDevPubkey}:${gameName}` and shows the highest `manifest.version`.
- Chosen (index.html 6923-6925): the address's `game=` (an id, else `tiles.find(name)`), else the tile pressed. #1132 swaps an id with no live rounds for its tile (6930-6940).
- After the choice:
  - `ARENA_GAME_ID` / `ARENA_GAME_IDS` (7004-7009): every version for nextblock, otherwise the shown version only.
  - `ARENA_UNITY = game.known && name==='nextblock'` (8507).
  - The lobby keeps only rows whose contract game id is in `ARENA_GAME_IDS` (8614-8618).
- Persisted: `?game=` and `arena.game-name.<id>` (6977). Nothing else.

| from | event | guard | to |
|---|---|---|---|
| none | /games answers | id = H(manifest) | listed |
| listed | grouped | claimed dev key + name | version in a tile |
| version | highest `version` in its group | none (no signature, no parent check) | shown version (the tile) |
| shown | `?game=name` or a press | - | chosen; lobby rows = rows of the shown id |

#### SM-P2 Shop catalogue (memory)
`shopOf` (item-buy.js 158-164) picks the newest manifest of a game NAME that sells items, whatever its developer key, and nothing checks its signature. `buyShopItem` (index.html 9342-9371):
1. Takes the donation sets from a paid row of any version with that name.
2. Pays.
3. Posts the record to `shop.game.nodes`, the nodes that served the chosen manifest.

`ownedItems` (item-buy.js 127-135) uses the first seat that answers 2xx. Recording and retry are covered by CLIENT-8.

#### SM-L2 correction: payout and stake notes are per round, not per phrase
Audit 2's SM-L2 lists the notes `arena.payout.*` / `arena.stakeback.*` next to the per-seed record `arena.collect.<round>.<seed16>`. The notes are keyed by round and order only:
- `${PAYOUT_NOTE}${round}${orderTag(order)}` (page-lock.js 2286, 2944)
- `${STAKE_NOTE}${round}${orderTag(order)}` (2457, 2955)
- `arena.slash-payout.<round>` (2390, 2429)
- `orderTag` (2517): '' for order 0.

Storage is localStorage (`roundAsk` index.html 4351-4354, `vault()` 2756). A note is final:
- redeemPayout and returnStake return `{ok, final, kept}` from it (2287-2289, 2458-2460).
- lookOwed reads it as `collected` (2945, 2956).
- collectState makes `collected` terminal (2633-2645).

#### SM-P3 Head-to-head move (sessionStorage `HIDDEN_KEY`, index.html 3257; RPS client memory)
1. hidden (entry with a commit)
2. The reveal is sent when the local clock passes `entryCloseMs`:
   - the page's timer at close + 120 ms (7114-7117);
   - the RPS client's refresh at `Date.now() >= entryCloseMs` (RPS index.html 977-978).
3. revealed: `ARENA_GAME.reveal` answers `ok` when any one seat answers 200/201 (7133). The RPS client stops retrying on `ok` (978: `revealing.delete` only if `!x.ok`).
4. Seats carry reveals from peers without the window check (verify.js 738-775, "a peer's door already was").
5. The result is read from the fullest single seat (7163-7198).

Persisted: the hidden move and salt in sessionStorage. The rest is memory.

#### SM-P4 Round link at load (address bar)
The boot (9609-9611): `showTheLobbyIfOneWasNamed()` is false for any address with `round=`. `lobbyQuery` returns null when a round is named (lobby.js 90), and `dailySearch` returns null for any query (index.html dailySearch). Then `joinOrBackToTheLobby` (9206):
- `play=1` and the start more than 5 s ahead: heldRoundLink joins from the lobby with `{ link: true }` (9192), no press.
- Otherwise: `joinTheRoundIfOneWasNamed` (3278). It reads the round from the link's own `node=` list (join.js 97-140, 838) and goes straight to the stake (3443 `pays`; 3676 `use === 'new'` makes a new lock).

The only prompts on that path:
- an unknown federation (5056-5082);
- the contract warnings (5103), shown only when a warning code exists;
- the swap confirm.

#### SM-P5 Market order placement (memory; lock record SM-L1)
States: entry 201 at a seat, then `accepted`, then placed.
- `accepted` resolves on the lock client's acceptance, or on any one seat's 201 for `/lock` (`seatSaw`, market.js 155-170, 176).
- placed (`first`, 201-213) is the first seat that holds the entry and the locks.
- committed (`onCommitted`) needs `sharesNeededFor` seats (178-181; index.html 3982, 4026).

#### SM-P6 App client frame (no state, a trust boundary)
`gameClientFile` (games.js 107-127) accepts only bytes whose SHA-256 a manifest of that developer key and name pins, fetched from this page's own origin, `games/<name>/index.html`.

The frame is a blob of those bytes (index.html 7316): same origin, so it gets `localStorage` and `window.parent`. The seeds in plain hex are `arena.seeds` (2514) and sessionStorage `arena.player.seed`. `window.parent.ARENA_WALLETS` holds the live lock clients. Under arena-embed.js the client and engine run in the host site's window (arena-embed.js 24-27).

## 13. State the 2026-11-10 audits (5, 6) introduced or changed

Audit 5 (#1399, base 1502786b) and audit 6 (#1415, base eb7fd30fc) for release 2026.1.9.27. Each machine as it stands after its fix; the ticket that fixed it in brackets.

#### SM-11 (add) Entry finality: the head-to-head window
- The objection window is the contract's W: 600 s, or 60 s for a head-to-head game (5 s on regtest), §13A as ruled 2026-11-10 (#1398). `Round.open` refuses a W that does not fit the game kind and network (`objectionWindowFits`); windows, standing, lock expiry and the price feed read W from the contract.
- The duty poster names 60 s for RPS only with `ARENA_H2H_WINDOW=1` until §13A.1's audit exists (#1400, build #1412).

#### SM-F1 (change) Funding signal period end
- The cutoff is the end block's header time (`endTimeAt`, the launcher's `blockHeaderTimeAt`), the same on every seat; a signal counts when some seat held it by then. `funding_signal_ends.seen_ms` is only the fallback without a chain (#1410).

#### SM-M1 (change) Book or pool
- A two-outcome round is a book iff a threshold-certified batch holds an order (`order-batch.js isBook`); batches take only orders whose locks their signers verified. Settlement reads the other seats' batches before deciding; a pool settles over plain picks only (#1411, spec §0A.7b ruled #1417).
- The door refuses a plain pick once the round is a book; an order is not refused for picks. A plain pick in a book is no entry of it: its stake secret stays sealed (stake-secret.js) and its lock is returned at once (forfeit.js, as §23.2 REFUSED).

#### SM-21 Feedback report (`reports.state`, feedback-store.js)
| from | to | by | guard |
|---|---|---|---|
| none | new | POST /feedback `{event}` (`take`) | kind 27842, signed within a day, bug or improvement, >= 50 characters, a node report names its node, a named screenshot exists; one row per event id; `number` = MAX + 1, unique (#1413) |
| new | accepted | admin `approve` | not ours; a player (finished a round), except level node; <= 3 per key in 7 days; weekly budget 100,000 sat except critical and node; level node: a node report, one per key, one per node, the first 10, and the node checklist (SM-23) read fresh at the approve; the level stored normalised (#1422) |
| new | rejected / duplicate | admin `move` | a reason; a duplicate names an earlier report by id or number |
| accepted | rejected | admin `move` | its reward link voided by compare-and-set; refused while paying or paid (#1402) |
| accepted | paid | `claim` / `settle` | its reward paid |
- `note` changes the ticket in any state and the level only while a report is new (#1422). A report is counted toward the limits when kept, per address by `ipKey` (#1424). The page signs from the tab's own seed, so a report from the games screen is kept too.

#### SM-22 Feedback reward link (`rewards.state`)
- open -> paying (claim, compare-and-set, the invoice for exactly the amount) -> paid; paying -> open on a sure failure or a `settle` read failed >= 180 s after the try; open -> void when the report is rejected (#1402).

#### SM-19 (change) Faucet book
- Player grants and refills run in one queue (`one()`), admin actions in their own (`oneAdmin`) (#1419). A queued request whose connection closed takes nothing.
- Invoice grant: the row is booked before paying; a verdict that is not final is booked as `pending` with its payers, a removed row whose payer may still pay is kept in `unsure` (at most 500); a sweep outside the queue (`sweepPayments`, every `FAUCET_SWEEP_MS`, 2 min; one pass at a time) reads each payer's `trackpayment <hash>` and then applies only its own decisions to a freshly read book in one synchronous step: pending + any SUCCEEDED -> booked; pending + every payer FAILED or "not initiated" -> row removed; unsure + any SUCCEEDED -> booked again unless a row with that hash exists; unsure + all FAILED/none, or no IN_FLIGHT after 24 h -> forgotten (#1421, #1426). See SM-19b for what the sweep reads.
- E-cash welcome: a note is taken by rename into `taken/`; the row keeps its file; the same caller (`ipKey`) asking again within 15 min gets the same note (#1419).
- Limits: per address by `ipKey` (an IPv6 /64 is one), 2,000,000 sat an hour, 10,000,000 a day; screenshots by `ipKey`, a day byte cap and a free-disk floor (#1405).

#### SM-C8 (change) Owner actions and the owner statement
- Add-bond and roles changes are kept in `owner_actions` before the broadcast (#1374); the same ask again is answered "already" only while its transaction is in the mempool or mined, else built again (#1423).
- GET /owner carries a statement signed by the node key over [node, owner, atMs]; the node bounty's checklist reads the owner only from such a statement, at most a day old, the newest (#1418). Since 2026-11-10 the owner is no condition of the bounty (SM-23).

#### SM-X1 Explorer admin marks (`marked`, `admin_ips`)
- POST /api/mark with the admin code marks keys and, for kind owner, keeps the caller's address (`admin_ips`, IPv6 by /64) (#1414).
- An address is the admin's for 48 h after its last code mark. POST /api/mark-ip marks only entry ids the explorer holds, never over an existing mark, the row naming the address (`by_ip`) (#1420).

#### Absences, spent set, arbiter, reserves (changed rules)
- Absences: the store is read back whole at start, each signature verified again, capped per federation at `max` (#1404).
- Spent set: the newest session where one content has n - t + 1 distinct guardian signers (#1408).
- Arbiter slash intent: an RPC error is "wait", never "posted" (#1403).
- Reserve payout: rows whose round this seat cannot read are `unknown` - taken as a co-signer, never picked as coordinator, never a SHORT while they could cover it (#1409).
- Donation sets: a network's first set is its founding serial; a set's parent is the last set in force below it (#1407).

## 14. State the 2026-11-10 evening range introduced or changed (audit 7, base eb7fd30fc, head c41b4ac4d)

#### SM-23 Node bounty checklist (node-bounty-check.js, faucet.mjs `nodeCheckNow`, GET /feedback/node-check, admin approve at level node)
Implicit, recomputed on every read; nothing is kept but the 10-minute answer cache `NODE_CHECKS` (memory, by `node:npub`, at most 200) for the public door. The admin approve reads it fresh.
- Inputs: the seats (`FAUCET_SEASON_SEATS` plus every seat their `/network-games` lists), each seat's `GET /owner`, each seat's `GET /served?from&to&finals=1` for the last `NODE_BOUNTY_WINDOW` (7) UTC days, today included.
- owner: the newest statement the node key signed (schnorr over `ownerStatementMessage`), at most 24 h from now; `servedAt` = every seat URL that served such a statement.
- Checks (all must hold for `passes`):
  | key | holds when |
  |---|---|
  | census | the node sat on at least one committee in the window |
  | online | it sat on a committee on at least `NODE_BOUNTY_DAYS` (1) day of the window |
  | committees | at least one committee and one round it signed FINAL |
  | outside | the node key (and the owner key, if given) is not in `FAUCET_FEEDBACK_EXCLUDED`, and no URL in `servedAt` is on a team host (`FAUCET_TEAM_HOSTS`) |
- `owner` (the answer's hint, no condition, Daniel 2026-11-10 "npub muss nicht sein"): the reporter's key = the signed owner / another owner / none named.
- Approve at level node: checklist `passes` -> `FEEDBACK.approve` (SM-21: one per key, one per node, the first `NODE_BOUNTY_MOST` = 10; `NODE_BOUNTY_BASE_SATS` = 10,000, outside the weekly budget).
- Known gaps (audit 7): `outside` is only as good as `servedAt`, which is empty for a node that does not sign the statement (every release up to 2026.1.9.26, most team seats) - finding A7-1; nothing ties the reporter to the node - finding A7-2.

#### SM-19b Faucet payment's final word (faucet.mjs `paymentFinal`)
- One `lncli trackpayment <hash>` per payer, 10 s: "isn't initiated" -> NONE; a final status SUCCEEDED / FAILED -> that; no answer in time -> IN_FLIGHT; anything else -> null (no decision).
- The status is read from JSON (`"status": "..."`): lncli prints JSON only with `--json` (finding A7-3).

#### SM-21 (add) Feedback report content
- A signed report may carry `debug` (the page's state and console tail, at most 60,000 characters) in its content; the faucet reads a report post up to 96 KB, and `row()` answers the debug scrubbed as the words are. No state of its own.
- Level amounts: critical 10,000 (outside the budget), node 10,000.
- GET /feedback/lnaddress: the bounty address check (`lnAddressWorks`) for the page's own origin, at most 30 per address in 10 min (`LN_ASKS`, memory, at most 5,000 addresses). No state moves.

#### SM-I3 (add) Node update: the settings step
- Between BACKED_UP and UNITS_WRITTEN, arena.conf (when it exists) is rewritten once: release paths moved, keys renamed, stake lock paths, and `withNewAppVersions`: every registration of the new release (`appsSetting(state, newRelease)`) whose folder `apps=` already names is appended after the listed ones. An app with no path in `apps=` stays out; a listed path is never removed; a second run adds nothing.
- A rollback (ROLLING_BACK, resume) puts arena.conf back from the backup, which holds it (`NODE_FILES`).

#### SM-P3 (change) Head-to-head move: when the move is the tab's
- The move is the tab's once as many seats as the round's `settlementSlots` (or `gameVerifySlots`) answered 201 (`submitPick` `onEntry`, kanban #1391), or when all seats answered; the slower seats are still waited on in the background and the name record loops skip the seats that refused the entry.

#### SM-P5 (change) Market order and paid join at the tap
- A paid round whose federation cannot cover the stake from this wallet's part there (`joinFundingPlan` answers swap or merge) is refused at the tap (`not-funded-here`) and says where the sats are; the order never starts.
- A paid join waits for a pending welcome only when the round's own federation cannot pay the stake without it; the wait is a named stage.
- The strip names the open step after 3 s (`ARENA_TX_STEPS`: the last `->` with no `<-`); a tap while another order is locking is noted (`busyTapAt`) and not taken.

#### SM-T5 (change) Welcome on the page
- The welcome ask is sent once more when the first gets no answer (#1426). The faucet answers the same e-cash note to the same caller within 15 min (SM-19); an invoice ask whose first request is still being paid is answered "already has its welcome".

## 15. State audit 2026-11-12

#### SM-L4 (change) Liquidation claim on the page and the claims book (liquidation-claim.js `claimStep`, liquidation-claims.js) - kanban #1849
- Invariant: notes a player handed to a liquidation are either paid from the escrow or back in the player's wallet.
- New edge: kept | posted --(the signed door answers 409 "not being liquidated" naming no refused note, the set lists no acceptance for this payout key, and the wallet's own `receiveEcash` of the kept notes answers Success / AlreadyReceived)--> none. Any other receive answer (an error, Rejected, a federation still halted) keeps the record as it was.
- The return is noted under `arena-liquidation-returned-<federation>` with the signed halt height; while the same halt's event stands, the page hands no notes over again for that federation (one return per halt, not a send and a reissue on every pass).
- The book keeps nonces, amounts and payout keys only, not the e-cash: a federation that comes back before the payout (no seat lists it HALTED: `liquidationOf` null, `plan` 404) pays nothing from it. The notes reissued into the wallet are spent, so a later halt's spent set refuses the book's stale rows of them.
