// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SIGNER NODES' ONE SETTLEMENT OF A LOCK ROUND (W4; FEDERATION.md money flow step
// 5). 2026-09-14 07:22: "a loser loses the stake. The lock is claimed into
// the pool. Winners are paid from that."
//
// "Each signer node then rebuilds one settlement transaction from the public payout
// table. Inputs: every loser's stake lock (`Claim(P)`) ... Outputs: one payout
// contract per qualifier (a pre-expired lock, `refund_pk` = the qualifier's
// key). A signer node signs only the txid it rebuilt itself; one FROST signing covers
// every input."
//
// FROM THIS SIGNER NODE'S OWN RECORD, as the forfeit is: its own signed result for every
// entry, its own no-quorum and ENTRY_VOID records, its own finality - nothing
// waiting inside its window, nothing suspended - and the locks IT verified. The
// decision is protocol's `lockSettlement` (the hold path's own verdict over one
// payout table). Each loser's P is opened by the signer nodes' share conversation and
// must be the scalar of the point that loser's lock names. The transaction is
// rebuilt by the stock client (arena-stake-lock --mode settle, dry), and the signer node
// signs only the 32 bytes it got back.
//
// FEES ARE NOT IN IT. The fee locks' claim hash and §22A's node slots are not
// decided (FEDERATION.md F5); the fee lock expires back to its player as before.
import { feeBpsOf, donationBpsOf, donationInFee } from '../../arena-protocol/src/fee.js';
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { decodeRoundContract, decodeEntryContract, entryFederation, entryId as entryIdOf } from '../../arena-protocol/src/contracts.js';
import { takesAnyFederation, acksSettlement } from '../../arena-protocol/src/constants.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { stallsOut, silentSeats } from '../../arena-protocol/src/stall.js';
import { signSettlementCommit, checkSettlementCommit, signSettlementAsk, checkSettlementAsk, asksBySeat, ASK_COMMIT, ASK_SHARE, signSettlementAck, settlementAckId, countAcks, joinAcks, splitAcks, splitSignedAck, encodeSettlementTable, decodeSettlementTable, settlementTableId, planTableRows, planTableBuild } from '../../arena-protocol/src/settlement-ack.js';
import { tableBuild } from '../../arena-protocol/src/settlement-rebuild.js';
import { slashHoldsOnTable, encodeSlashProof, joinTableSlashEvidence } from '../../arena-protocol/src/slash.js';
import { joinNamedClaimEvidence, splitNamedClaimEvidence, namedClaimProofBody, claimReadInput, namedOutpointText, NAMED_ROW_OFF_TABLE, NAMED_ROW_FORFEIT, NAMED_ROW_PAYEE } from '../../arena-protocol/src/named-claim-proof.js';
import { offTableClaims, forfeitsOfLostEntries } from '../../arena-protocol/src/named-claim-offence.js';
import { unpayableClaims } from '../../arena-protocol/src/named-claim-payees.js';
import { inSessionLane } from './stake-lock-signer-node.js';
import { splitByFederation } from '../../arena-protocol/src/federation-settlement.js';
import { pluginForRound, payoutRuleOfRound } from './plugins.js';
import { heldOutcomes, marketFinalityOf, attestedTable } from './game-market.js';
import { lockSettlement, lateLockSettlement, attestedLockSettlement, bookLockSettlement, RESERVE_LATER_PK } from '../../arena-protocol/src/lock-settlement.js';
import { roundSplitBps } from '../../arena-protocol/src/fee-proposal.js';
import { paysReserves } from '../../arena-protocol/src/reserves.js';
import { bookSettlement } from '../../arena-protocol/src/book-ledger.js';
import { isScalar, marketOfRound } from '../../arena-protocol/src/manifest.js';
import { FORFEIT, VOID, ENTRY_VOID, isQualifier, computePayoutTable, withGoneStakes } from '../../arena-protocol/src/payout.js';
import { lockActions, CLAIM } from '../../arena-protocol/src/lock-action.js';
import { signShare340, aggregate340, nonceGenerate340, verifyShare340 } from '../../arena-protocol/src/frost-bip340.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { lockFieldsFromJson } from '../../arena-protocol/src/stake-lock.js';
import { scalarFrom32, FIELD } from '../../arena-protocol/src/shares.js';
import { FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { resultFinality, settledResult } from './finality.js';
import { encodeCommitments, decodeCommitments, encodeShare, decodeShare } from './pool-wire.js';
import { sendPlanToJson, planKey } from './winnings-send.js';
import { askerOrder, eligibleAsker } from './payout.js';
import { REFUSAL } from './settle-backoff.js';
import { RETRY, retryStep, retryBlocks, locksExpired, isFinalRetry } from './settle-retry.js';
import { planTakenId, signPlanTaken, countPlanTaken, joinCertificate, splitCertificate, splitPlanTaken } from './plan-taken.js';
import { PLAN_ASK, SEND_PLAN_ASK_HEADER, sendPlanAskHeaders, checkSendPlanAsk } from './send-plan-ask.js';
import { askPeers, PEER_ASK_MS, PEER_READ_MS, PEER_GRACE_MS } from './peer-ask.js';
import { namedClaims, namedClaimKeys, namedSignerSet, zKey } from '../../arena-protocol/src/arena-lock.js';
import { offTableOn, offTablePayouts, swapRefundOn, swappedRefundPayouts, settleHoldOn } from './test-named-offence.js';
import { lostForfeitAllowed, LOCK_FATE, lockFateStep, lockFateOf, markLockFate } from './forfeit.js';
import { namedSlots, NamedNonces, aggregateBatch, signerSetKey, encodeNamedCommitment, decodeNamedCommitment, encodeNamedList, decodeNamedList,
  encodeNamedPartials, decodeNamedPartials, encodeNamedBatch, decodeNamedBatch } from './named-settlement.js';
// the payouts of an accepted settlement kept as rows (GET /donations, GET /reserves): a walk-away's donation keys and a market's reserve
// AND THE WEBSITE THAT BROUGHT AN ENTRY (kanban #676: "total referrer fees accumulated" on the explorer's metrics): its 'frontend' payout is a row
// under the website's payout key, listed as 'website', so the seats can say what each website earned (GET /referral-fees)
const SETTLEMENT_ROW_KINDS = new Set(['donation key', 'reserve', 'frontend']);

// WHO THE FEE LOCKS PAID: the signer nodes, and a market's donation keys - named apart
const feeLine = (payouts) => {
  const part = (kind) => { const p = payouts.filter((x) => (x.kind === 'donation key') === kind); return [p.length, p.reduce((t, x) => t + x.msat, 0n)]; };
  const [n, nodes] = part(false); const [d, gifts] = part(true);
  return `${n} signer node(s) ${nodes} msat${d ? ` and ${d} donation key(s) ${gifts} msat` : ''}`;
};

const listKey = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).sort().join('|');
// `code` (settle-backoff.js REFUSAL, kanban #1186): what a sweep decides by - never the text
const refuse = (why, status = 409, code = null, more = {}) => ({ ok: false, status, why, ...(code ? { code } : {}), ...more });
const verifyAck = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
/** A seat that refused by name: its door answered. A 5xx is nobody's word, a tunnel's as likely as the seat's, and reads as no answer. */
const refusedByName = (r) => !(r.status >= 500);
// F OVER THE ENTRIES THIS SEAT SETTLES, each row naming its entry: the table a seat's SettlementAck is about (§5A.3, kanban #1040)
const entryRows = (roundId, entries, minScore, payoutShares) => {
  const f = computePayoutTable({ roundId, entries, minScore, payoutShares });
  return f.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: f.table[i].amountMsat, outcome: e.outcome, score: e.score, ...(e.atTheDoor ? { atTheDoor: true } : {}) }));
};
// THE WHOLE OF WHAT A SEAT ACKS (§5A.3, kanban #1043): the rows and the transaction they rebuild to, each claim by the entry whose lock it spends
const ackTableOf = (base, plan, claimPk, rows, entryOf) => ({ ...base, claimPk, rows, ...planTableBuild(plan, entryOf) });
const byLockKey = (lockEntry) => (c) => (lockEntry ? lockEntry.get(toHex(c.pubkey)) : null);
// A LOCK OF THIS ROUND'S KEY: below protocol 27 the round's FROST claim_pk; from it (arena-lock.js namedClaims, kanban #1044 B1) an Arena lock naming
// this round and its settlement seats' node keys in seat order, with the round's threshold - checked in full when it was taken (arenaLockStands)
const lockKeyStands = (fields, claimPk, contract) => {
  if (!namedClaims(contract)) return !fields.arena && toHex(fields.claimPk) === toHex(claimPk);
  const { seatKeys, threshold } = namedClaimKeys(contract);
  return !!fields.arena && fields.threshold === threshold && fields.claimKeys.length === seatKeys.length && fields.claimKeys.every((k, i) => toHex(k) === toHex(seatKeys[i]));
};
// THE CLAIM KEY A PLAN PAYS TO: a protocol-27 round has none - its sends and held shares refund to KeyAgg(S), written Z in the body (ruling #1135 1)
const roundKeyOf = (dkg, contract) => (namedClaims(contract) ? { ok: true, signerNode: null, pool: { groupPublicKey: zKey() } } : dkg.signerNodeFor(contract.nodes));
const outpointOf = (s) => { const [txid, idx] = String(s).split(':'); return { txid: fromHex(txid), outIdx: BigInt(idx) }; };


/** How often the backfill tries a recovered round it could not rebuild before it marks it checked. */
export const BACKFILL_TRIES = 4;
/** ...counted at most once per this many ms, whatever the seat restarts: 6 h, the backfill's own clock. */
export const BACKFILL_TRY_GAP_MS = 6 * 3600 * 1000;
export const SUBMITTING = 'SUBMITTING';
/** The txid a round that takes any federation keeps its moves under: it has one transaction per federation (2026.0.3). */
export const FEDERATIONS_TXID = 'federations';
export const ACCEPTED = 'ACCEPTED';
export const REFUSED = 'REFUSED';

/**
 * THE ROUND'S SETTLEMENT ROW, ONE TRANSITION FUNCTION (kanban #1171, the 2026-11-06 state-machine audit): none -> SUBMITTING -> ACCEPTED | REFUSED,
 * REFUSED -> SUBMITTING (signed again) | ACCEPTED (found landed). ACCEPTED is final. ACCEPTED only on what the guardians hold (`verified`: the payouts
 * stored and the claimed locks gone, or the federation found it in) - a submit the guardians pre-validated is not a landed one (two askers, F and F',
 * both got Ok and only one landed). REFUSED only once every txid this seat signed or was handed was asked (`checkedAll`). Answers { ok, why }.
 */
const ROW_EDGES = Object.freeze({ none: [SUBMITTING], SUBMITTING: [SUBMITTING, ACCEPTED, REFUSED], REFUSED: [SUBMITTING, ACCEPTED, REFUSED], ACCEPTED: [] });
export function settlementRowStep(held, next) {
  const from = held && held.state ? held.state : 'none';
  if (!(ROW_EDGES[from] || []).includes(next.state)) return { ok: false, why: `a settlement row goes ${from} -> ${(ROW_EDGES[from] || []).join(' | ') || 'nowhere (final)'}, not -> ${next.state}` };
  if (next.state === ACCEPTED && !next.verified) return { ok: false, why: 'ACCEPTED only on what the guardians hold, not on a pre-validated submit' };
  if (next.state === REFUSED && !next.checkedAll) return { ok: false, why: 'REFUSED only after every txid this seat signed or was handed was asked' };
  return { ok: true };
}

/**
 * WHICH BATCH A PROTOCOL-27 SCOPE STANDS ON, ONE TRANSITION FUNCTION (kanban #1170, the 2026-11-06 state-machine audit): every verified batch is kept by
 * its txid (two signer sets over one body are two txids, both valid); the scope stands on one. none -> standing(T); standing(T) -> standing(T') only
 * while the scope's row is not SUBMITTING or ACCEPTED on another txid - a row that submitted T, or found T in, freezes T's batch: its sends, auths,
 * refunds (c) and the refund key KeyAgg(S) are T's, and a later batch of S' is kept beside it, never in its place. A row that moves onto T' (found in,
 * or submitted after the federation said T is out) carries the standing batch with it. Answers { ok, why }.
 */
export function namedBatchStep(standing, next, row) {
  if (!next || !next.txid) return { ok: false, why: 'a batch without a txid' };
  if (standing && standing.txid === next.txid) return { ok: true };
  const on = row && (row.state === SUBMITTING || row.state === ACCEPTED) ? String(row.txid) : null;
  if (on && on !== String(next.txid)) return { ok: false, why: `the row is ${row.state} on ${on.slice(0, 12)}: its batch is frozen, and ${String(next.txid).slice(0, 12)} is kept beside it, never in its place` };
  return { ok: true };
}

/** Whether a round's stake is a federation stake lock (and so settled here). */
export const locksStake = (contract) => contract.federationId instanceof Uint8Array
  && (contract.federationId.some((b) => b !== 0) || takesAnyFederation(contract)) && contract.stakeMsat > 0n;

const NO_FEES = { ppm: 0n, baseMsat: 0n };
// A BUILD THAT NAMES A LOCK THE GUARDIANS DO NOT HOLD (stake-lock arena.rs: "the guardians hold no Arena lock at ...")
const NO_LOCK_HELD = /hold(s)? no (Arena )?lock/i;
export const GONE_MARGIN_BLOCKS = 3;   // kanban #1183: a stake lock this close to its expiration is not claimed (the claim would land after it)
/**
 * A ROUND THAT TAKES ANY FEDERATION, SETTLED (2026.0.3): its plan decided once - lockSettlement with no fee, since
 * every federation prices its own (splitByFederation) - and split into one balanced transaction per federation. `args`:
 * lockSettlement's; `federationOf(outpoint)` -> the federation hex a claimed lock is in; `feesOf(fidHex)` -> its fee rule.
 */
export function federationPlans(args, { federationOf, feesOf }) {
  const plan = lockSettlement({ ...args, fees: NO_FEES });
  if (!plan.ok) return { ok: false, why: plan.why };
  if (plan.nothing) return { ok: false, why: plan.why, ...(plan.noFill ? { code: REFUSAL.NOTHING_CLAIMED } : {}) };
  const split = splitByFederation(plan, { roundId: args.roundId, federationOf, feesOf });
  if (!split.ok) return { ok: false, why: split.why };
  return { ok: true, plan, split };
}

// A PLAN NAMED BY EVERYTHING IN IT (NODE-OPT-1648): claims, payouts, nonce, the claim key and the seat it names - bigints
// as decimal, bytes as hex - so an identical plan has the identical name and any change in it a different one.
const planFingerprint = (plan, claimPk, signerNode) => JSON.stringify({ c: plan.claims, p: plan.payouts, n: plan.nonce, k: claimPk, s: signerNode },
  (k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? toHex(v) : v));

/** What a settlement plan moved, as /lock-settlement and /settled answer it (W6). */
function planSummary(txid, p) {
  return {
    txid,
    claims: p.claims.map((c) => ({ kind: c.kind || 'stake', msat: String(c.amountMsat) })),
    payouts: p.payouts.map((x) => ({ kind: x.kind || 'qualifier', pk: toHex(x.payoutPk), msat: String(x.msat), feeMsat: String(x.feeMsat),
      ...(x.donation ? { donation: x.donation.lnurl || x.donation.label || "a key" } : {}) })),
    // A WALK-AWAY'S REMAINDER (RULED 2026-09-30): what went 75% to the sitting signer nodes and 25% to the donation set.
    remainder: p.remainder ? { nodesMsat: String(p.remainder.nodesMsat), donationMsat: String(p.remainder.donationMsat),
      signerNodes: p.remainder.sitting, recipients: p.remainder.recipients, heldMsat: String(p.remainder.heldMsat || 0n) } : null,
    poolMsat: String(p.poolMsat), inputFeesMsat: String(p.inputFeesMsat), paidMsat: String(p.paidMsat),
    outputFeesMsat: String(p.outputFeesMsat || 0n), unspentMsat: String(p.unspentMsat || 0n), stakeWhy: p.stakeWhy || null,
    // THE POOL: qualifiers not paid, each with why (no address - its share split over those who named one).
    pooled: (p.unpaid || []).filter((u) => !/fee share/.test(u.why)).map((u) => ({ pk: toHex(u.pubkey), owedMsat: String(u.owedMsat), why: u.why })),
    feePoolMsat: String(p.feePoolMsat || 0n), feeInputFeesMsat: String(p.feeInputFeesMsat || 0n), feePaidMsat: String(p.feePaidMsat || 0n),
    feeHole: p.feeHole ? p.feeHole.why : null,
  };
}

// HOW OFTEN A SEAT PULLS THE OTHER SEATS' CANCELS (kanban #576): only for a round it holds an entry of - a cancel is kept only for an
// entry this seat holds - and at most once per CANCEL_CARRY_MS for each round. Pulled from every peer on every plan, the attested rounds
// cost each test host seat ~100 GET /cancels a second (measured 2026-10-22 10:5xZ on seat 1: 2,985 in 30 s).
export const CANCEL_CARRY_MS = 30000;
export function cancelCarryDue(carried, key, nowMs, entries, everyMs = CANCEL_CARRY_MS) {
  if (!entries) return false;
  const last = carried.get(key);
  if (last !== undefined && nowMs - last < everyMs) return false;
  carried.set(key, nowMs);
  if (carried.size > 4096) for (const [k, t] of carried) if (nowMs - t >= everyMs) carried.delete(k);
  return true;
}

// A PLAN THAT CANNOT REACH ITS SIGNATURES (kanban #970): seats that hold no such series refuse for as long as the series is gone, and a
// round of a dropped posting was offered 120 times a restart, on every seat (24,271 lines in one seat's log). A seat just restarted
// may still be reading the series, so a few offers stay: 16 are about 11 minutes. A restart asks again, so no round is given up for good.
export const PLAN_OUT_OF_REACH_OFFERS = 16;
export function planOutOfReach({ agreed, needed, refused = [] }) {
  const gone = refused.filter((r) => /holds no such series/.test(String(r))).length;
  return gone > 0 && agreed + refused.length - gone < needed;
}

/**
 * THE LOCKS A ROUND'S OWN SETTLEMENT CLAIMS (kanban #1183): spent because that settlement landed, never read as refunded. A round in one
 * federation: its signed settlement's claims, unless REFUSED. A ROUND THAT TAKES ANY FEDERATION (kanban #1239, audit 3 FIXES-8) has no round
 * row - its moves are kept under "federations" - so the set was always empty there, and once a refused federation made the round suspect,
 * a landed federation's paid losers were written to gone_stakes as refunded: each federation row that is not REFUSED, with the claims of its
 * own transaction (scope fed:<fid>, at the row's txid).
 */
export function ownClaimsOf(round, roundIdBytes) {
  const m = typeof round.lockSettlementMoves === 'function' ? round.lockSettlementMoves(roundIdBytes) : null;
  const row = typeof round.lockSettlement === 'function' ? round.lockSettlement(roundIdBytes) : null;
  if (row) return m && row.txid === m.txid && row.state !== 'REFUSED' ? new Set((m.claims || []).map(String)) : new Set();
  const out = new Set();
  if (typeof round.fedLockSettlementsOf !== 'function' || typeof round.scopedSettlementTxidsOf !== 'function') return out;
  for (const r of round.fedLockSettlementsOf(roundIdBytes)) {
    if (r.state === 'REFUSED') continue;
    const moves = round.scopedSettlementTxidsOf(roundIdBytes, `fed:${String(r.federation).toLowerCase()}`).find((x) => x.txid === r.txid);
    for (const c of (moves && moves.claims) || []) out.add(String(c));
  }
  return out;
}

export class LockSettlement {
  /**
   * `dkg` holds this signer node's share of the round's claim key; `port` is the
   * federation (arena-stake-lock); `stakeSecrets` opens a loser's P with the other
   * signer nodes; `peersFor(rid)` names the other settlement signer nodes' bases.
   */
  constructor(round, { dkg, port, curve, random, stakeSecrets, peersFor = () => [], fetcher = (u, o) => fetch(u, o),
    signerNodesFor = (rid, contract) => ({ gameVerify: contract.nodes, settlement: contract.nodes }), winnings = null,
    turnClock = null, donationSetFor = null, donationTargetFor = null, orderBook = null, now = () => Date.now(), conflictsFor = null,
    reserveKeyFor = null, payeesFor = null, feesFor = null, peerKeyOf = () => null, peerAskMs = PEER_ASK_MS, peerReadMs = PEER_READ_MS, peerGraceMs = PEER_GRACE_MS, askPointOf = undefined, finalityOf = resultFinality, settledOf = settledResult } = {}) {
    this.round = round;
    // WHERE A NETWORK'S SETTLEMENT_ASK_HEIGHT LIES (kanban #1075): constants.js settlementAskPoint; a harness's own to read a round below it
    this.askPointOf = askPointOf;
    // HOW LONG A SEAT IS WAITED FOR (peer-ask.js, kanban #1061)
    this.peerAskMs = peerAskMs;
    this.peerReadMs = peerReadMs;
    this.peerGraceMs = peerGraceMs;
    // WHOSE DOOR A BASE IS (§5A.3 "Stalled in its rounds"): `peerKeyOf(rid, base)` a seat's node key, hex, or null. A refusal is not signed, so the address says who refused
    this.peerKeyOf = peerKeyOf;
    // THE FEES IN FORCE AT A ROUND (funding-book.js feesAt): `feesFor(contract)` -> the fee set at its census height. A
    // version-11 round's node fee and every round's website share are settled from it; unset, today's
    this.feesFor = feesFor;
    // A FEDERATION'S RESERVE KEY (server.js `reserveKeyFor(fedHex)`, async): where a market's protocol reserve is paid
    this.reserveKeyFor = reserveKeyFor;
    // WHO A ROUND MAY PAY (level 2 of proof (a), rulings #1138 2, #1140; server.js `namedPayeesFor(contract, rid)`, async): { nodeKeys, donationKeys,
    // reserveKeys } from this seat's own bytes, null where unread - the filer reads every claim of the round against it
    this.payeesFor = payeesFor;
    // `conflictsFor` is no longer consulted (§5A.13, ruled 2026-10-14): no player declares an operator
    this.conflictsFor = conflictsFor;
    this.now = now;
    // THE ROUND'S SIGNED DONATION SET (server.js `donationSetFor`): where a walk-away's claimed lock sends its 25%.
    this.donationSetFor = donationSetFor;
    // A ROUND'S DONATION TARGET (server.js `donationTargetFor`: the network's set and its game's): where a market's donation,
    // held in its fee locks until the market resolves, is paid
    this.donationTargetFor = donationTargetFor;
    // THE MARKET ORDER BOOK (comment 1127): a round whose entries are orders settles from its certified batches
    this.orderBook = orderBook;
    // HOW THIS SIGNER NODE READS A RUN'S FINALITY - `resultFinality`; a test may hand another view (a test aid, as
    // `finality.rerunMs` is), since two signer nodes that agree on a run cannot hold a valid objection against it.
    this.finalityOf = finalityOf;
    this.settledOf = settledOf;   // a settled result, as finality.js reads it (lostForfeitAllowed); injected by tests
    // WHOSE TURN IT IS TO COMBINE (M3.3-19's clock): the round's beacon height and this node's chain tip, or null.
    this.turnClock = turnClock;
    // WINNINGS ALWAYS SENT (winnings-send.js): when given, a qualifier who named an address is paid by send, not collect.
    this.winnings = winnings;
    // THE ROUND'S SITTING SIGNER NODES BY POOL (Pick A): who the fee locks pay, §22A's weights.
    this.signerNodesFor = signerNodesFor;
    this.dkg = dkg;
    this.port = port;

    this.curve = curve;
    this.random = random;
    this.stakeSecrets = stakeSecrets;
    this.peersFor = peersFor;
    this.fetcher = fetcher;
    this.built = new Map();          // round id hex -> the settlement this signer node rebuilt
    this.summaries = new Map();      // round id hex -> what its settlement moved, rebuilt after a restart
    this.byPlan = new Map();         // round id hex -> { fp, built }: the last build and the plan it was built for
    this.planCertificates = new Map(); // round id hex [:late entry hex] -> { planId, certificate } the seats signed
    this.planRetries = new Map();    // round id hex -> how often a peer refused the send plan
    this.retryTimers = new Set();
    this.pairs = new Map();          // round id hex -> { hiding, binding, commitment, list, share }
    this.fees = new Map();           // round id hex -> the guardians' fee rule, read once
  }

  /** EVERY ENTRY OF THE ROUND, AS THIS SIGNER NODE HOLDS IT - or why the round still waits. */
  entriesOnRecord(roundIdBytes, contract) {
    const entries = [];
    const leftOut = [];
    for (const { entryId, entry } of this.round.entriesOf(roundIdBytes)) {
      // A STAKE THIS SIGNER NODE NEVER SAW COMMITTED IS NOT IN THE ROUND (§23.1 step 5: play begins
      // only after it). With pick (a), a round whose gate mints counts a stake only with its
      // fee lock, so an entry that brought none never reaches this set.
      if (this.round.stakeSeen && !this.round.stakeSeen(entryId)) continue;
      const base = { entryId, pubkey: entry.playerPubkey, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat,
        feePreimage: entry.feePreimage, ...(entry.frontendPk ? { frontendPk: entry.frontendPk } : {}) };   // the website that brought it (item 7)
      if (this.round.entryVoid && this.round.entryVoid(entryId)) { entries.push({ ...base, outcome: ENTRY_VOID, score: 0 }); continue; }
      const nq = this.round.noQuorum ? this.round.noQuorum(entryId) : null;
      // §13C's FORFEIT is proven equivocation (§13B): claimed like a walk-away's when nobody qualifies ((b))
      const proven = () => typeof this.round.provenEquivocation === 'function' && this.round.provenEquivocation(roundIdBytes, entryId);
      if (nq && nq.outcome === FORFEIT) { entries.push({ ...base, outcome: FORFEIT, score: 0, ...(proven() ? { atTheDoor: true } : {}) }); continue; }
      if (nq && nq.outcome === VOID) { entries.push({ ...base, outcome: VOID, score: 0 }); continue; }
      const standing = this.finalityOf(this.round, roundIdBytes, entryId);
      // AN ENTRY WITH NO QUORUM HOLDS THE ROUND (§13A, RULED 2026-11-02, kanban #1047): F depends on every result, so left out, a rescued winner is paid nothing. Bounded: the
      // re-run window's end, or the end of a quorum's one objection window, and past it the entry is left out as below. An entry suspended by an objection does not hold it.
      if (standing.holdsRound) return refuse(`no lock is claimed while an entry with no quorum is being decided: ${toHex(entryId).slice(0, 16)} (${standing.why})`);
      if (standing.state === VOID) { entries.push({ ...base, outcome: VOID, score: 0 }); continue; }
      // A RE-RUN WINDOW THAT CLOSED ON PROVEN EQUIVOCATION (§13A, §13C, RULED 2026-09-24): FORFEIT on the finality
      // itself, as VOID is above - no stored no-quorum record needed. A stored one was already taken, once, above.
      if (standing.state === FORFEIT) { entries.push({ ...base, outcome: FORFEIT, score: 0, ...(proven() ? { atTheDoor: true } : {}) }); continue; }
      // AN ENTRY STILL IN ITS RE-RUN WINDOW IS LEFT OUT, AND THE ROUND SETTLES WITHOUT IT (§13A, RULED 2026-09-24,
      // slice C3a): SUSPENDED, or PROVISIONALLY_FINAL on a re-run. It is not in the payout table, and its lock is neither
      // claimed nor forfeited here; what becomes of it after is `lockAfterSettlement`'s to say.
      if (standing.state === SUSPENDED || (standing.state === PROVISIONALLY_FINAL && standing.rerun)) {
        leftOut.push({ entryId, why: 'left out of the round\'s settlement: still in its re-run window' });
        continue;
      }
      if (standing.state !== FINAL)
        return refuse(`nothing is claimed while a run is not final with its window closed: ${toHex(entryId).slice(0, 16)} is `
          + `${standing.state || 'without a result'}${standing.why ? ` (${standing.why})` : ''}`);
      const r = settledResult(this.round, roundIdBytes, entryId, standing);
      if (!r) return refuse(`this signer node signed no result for ${toHex(entryId).slice(0, 16)}, so it settles nothing`);
      // A WALK-AWAY, AS ONLY THIS STORE KNOWS IT (RULED 2026-09-30): FORFEIT at the §15 door - no first mark held
      // here, or a first mark past the line already recorded FORFEIT. Its lock is never a refund (lock-action.js). The
      // other FORFEITs above - no quorum, proven equivocation - are left unmarked and keep the no-qualifier expiry.
      // AND A PROVEN EQUIVOCATOR (§13B at any tickRULED 2026-10-04 (b): "Claim the proven
      // equivocator's lock like a walk-away's, 75% to the sitting seats and 25% to the donation set. Do not leave it
      // unclaimed for return at the 144-block expiry"): marked as the walk-away is, so with a qualifier its lock is
      // claimed into the pool like any loser's, and with nobody qualified it is claimed into the remainder split.
      const equivocated = r.outcome === FORFEIT && typeof this.round.provenEquivocation === 'function'
        && this.round.provenEquivocation(roundIdBytes, entryId);
      const atTheDoor = equivocated || (r.outcome === FORFEIT
        && (!this.round.firstMarkHeld(roundIdBytes, entryId) || !!(this.round.startForfeit && this.round.startForfeit(entryId))));
      entries.push({ ...base, outcome: r.outcome, score: r.score, ...(atTheDoor ? { atTheDoor } : {}) });
    }
    void contract;
    return { ok: true, entries, leftOut };
  }

  /**
   * WHAT BECOMES OF ONE ENTRY'S LOCK ONCE THE ROUND HAS SETTLED (slice C3a), from what is kept: the outpoints the round's
   * settlement claimed, and the entry's finality now. Claimed there, it was a loser at the close. Left out, it was still
   * in its re-run window, and: VOID returns to the player at its expiry - nobody acts; FORFEIT, or FINAL and not a
   * qualifier, is claimed in the round's second settlement (C3b, not built); a qualifier gets its stake back by its own
   * forfeit - stake back only, no share of the pool (RULED 2026-09-24).
   */
  lockAfterSettlement(roundIdBytes, entryIdBytes) {
    const moves = this.round.lockSettlementMoves(roundIdBytes);
    if (!moves) return { claimed: false, why: 'the round has not settled its locks yet' };
    const lock = this.round.stakeLock(entryIdBytes);
    if (!lock) return { claimed: false, why: 'this signer node verified no stake lock for that entry' };
    if ((moves.claims || []).includes(String(lock.outpoint))) return { claimed: true, why: 'claimed in the round\'s settlement' };
    const late = this.round.lateLockSettlement ? this.round.lateLockSettlement(roundIdBytes, entryIdBytes) : null;
    if (late && late.state === ACCEPTED) return { claimed: true, why: 'claimed in the round\'s second settlement' };
    const standing = this.finalityOf(this.round, roundIdBytes, entryIdBytes);
    if (standing.state === SUSPENDED || (standing.state === PROVISIONALLY_FINAL && standing.rerun))
      return { claimed: false, why: 'left out of the round\'s settlement: still in its re-run window' };
    if (standing.state === VOID || standing.state === ENTRY_VOID)
      return { claimed: false, why: 'VOID: nothing acts, and the lock returns to the player at its expiry' };
    if (standing.state === FORFEIT) return { claimed: false, why: 'claimed in the round\'s second settlement, not built yet' };
    if (standing.state === FINAL) {
      const row = this.round.get(roundIdBytes);
      const r = settledResult(this.round, roundIdBytes, entryIdBytes, standing);
      const minScore = row ? decodeRoundContract(new Uint8Array(row.contract)).minScore : Infinity;
      if (r && isQualifier(r, minScore))
        return { claimed: false, why: 'a qualifier: its stake comes back by its own forfeit - stake back only, no share' };
      return { claimed: false, why: 'claimed in the round\'s second settlement, not built yet' };
    }
    return { claimed: false, why: `not decided: ${standing.state || 'without a result'}` };
  }

  /**
   * A LATE LOSER'S SECOND SETTLEMENT, AS THIS SIGNER NODE REBUILDS IT (§13A; RULED 2026-09-24, slice C3b-1): only
   * after the round's own settlement is ACCEPTED, for an entry it did not claim that has since ended FINAL and FAILED, or
   * FORFEIT - never while it is still in its re-run window. The plan is `lateLockSettlement` over the shares that
   * settlement kept; the P opened as for any loser; one transaction per (round, entry), its own nonce.
   */
  /**
   * THE PORT OF THIS ROUND'S FEDERATION (RULED 2026-10-13: "Every node serves every federation"): a
   * router's own port for the round's federation, else the one port this node has, as before.
   */
  async portFor(roundIdBytes) {
    const p = this.port;
    if (!p || typeof p.forFederation !== 'function') return p;
    const row = this.round.get(roundIdBytes);
    if (!row) return p;
    const c = decodeRoundContract(new Uint8Array(row.contract));
    return (await p.forFederation(toHex(c.federationId))) || p;
  }

  /** THE PORT OF ONE FEDERATION by its id hex (2026.0.3): a router's port for it, else the one port this node has. */
  async portForFederation(fid) {
    const p = this.port;
    if (!p || typeof p.forFederation !== 'function') return p;
    return (await p.forFederation(String(fid).toLowerCase())) || null;
  }

  /**
   * ONE FEDERATION'S SETTLEMENT BYTES of a round that takes any federation (2026.0.3): that federation's part of the split -
   * its claimed locks (each loser's P opened as message() opens it), its payouts, its nonce - built by that federation's port.
   */
  async fedMessage(roundIdBytes, fid) {
    const key = `${toHex(roundIdBytes)}:fed:${String(fid).toLowerCase()}`;
    const kept = this.built.get(key);
    if (kept) return kept;
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    if (!got.anyFed) return refuse('that round settles in its one federation: it has no per-federation settlement');
    const s = got.split.settlements.find((x) => x.federation === String(fid).toLowerCase());
    if (!s) return refuse(`that round's settlement moves nothing in federation ${String(fid).slice(0, 16)}`, 404);
    const claims = [];
    for (const c of s.claims) {
      if (c.kind === 'fee') { claims.push(c); continue; }
      const entryId = got.lockEntry.get(toHex(c.pubkey));
      const opened = await this.stakeSecrets.open({ roundId: roundIdBytes, entryId, needed: receiptsNeeded(got.contract.settlementSlots) });
      if (!opened.ok) return refuse(`a loser's P could not be opened: ${opened.why}`);
      claims.push({ ...c, preimage: opened.preimage });
    }
    const port = await this.portForFederation(fid);
    if (!port || typeof port.settle !== 'function') return refuse(`this signer node cannot reach federation ${String(fid).slice(0, 16)}, so it builds nothing there`);
    let tx;
    try { tx = await this.#build(port, got.contract, { claimPk: got.claimPk, claims, payouts: s.payouts, nonce: s.nonce }); }
    catch (e) {
      // A LOCK THE GUARDIANS NO LONGER HOLD (kanban #1146 A, and #1172 for a round that takes any federation): the next plan reads the losers' locks at
      // their federations and leaves the gone ones out
      if (NO_LOCK_HELD.test(String(e && e.message))) { this.#suspectGone.add(toHex(roundIdBytes)); this.#dropFedBuilds(roundIdBytes); console.log(`#1172 [settle] ${key.slice(0, 16)}: ${String(e.message).slice(0, 120)} - its losers' locks are read at the federation next`); }
      throw e;
    }
    const built = { ok: true, ...tx, settlement: s, plan: got.plan, claims, claimPk: got.claimPk,
      signerNode: got.held.signerNode, needed: receiptsNeeded(got.contract.settlementSlots), federation: String(fid).toLowerCase(), contract: got.contract,
      ackTable: ackTableOf({ roundId: roundIdBytes, federationId: fromHex(String(fid).toLowerCase()) }, s, got.claimPk, got.ackRows || planTableRows(s), byLockKey(got.lockEntry)) };
    this.built.set(key, built);
    return built;
  }

  /**
   * What each federation's settlement of a round that takes any federation moved, as this node holds it (GET /lock-settlement):
   * each row, and with `moved` its transaction's payouts in their order (the out_idx a winner redeems by, 2026.0.3 step 7),
   * rebuilt from the round's plan once a row is ACCEPTED - the same plan every signer node signed.
   */
  async fedSummary(roundIdBytes, { moved = false } = {}) {
    const rows = this.round.fedLockSettlementsOf ? this.round.fedLockSettlementsOf(roundIdBytes) : [];
    if (!moved || !rows.some((r) => r.state === ACCEPTED)) return rows;
    let got = null;
    try { got = await this.planOf(roundIdBytes); } catch { got = null; }
    const split = got && got.ok && got.split ? got.split.settlements : [];
    return rows.map((r) => {
      const s = split.find((x) => x.federation === r.federation);
      return s ? { ...r, moved: { payouts: s.payouts.map((p) => ({ kind: p.kind || 'qualifier', pk: toHex(p.payoutPk), msat: String(p.msat) })) } } : r;
    });
  }

  async lateMessage(roundIdBytes, entryIdBytes, { onlyBase = false } = {}) {
    if (this.#attestedOf(roundIdBytes)) return refuse('an attested round has no late entry: its picks are all in its one settlement');
    const key = `${toHex(roundIdBytes)}:${toHex(entryIdBytes)}`;
    const kept = onlyBase ? null : this.built.get(key);
    if (kept) return kept;
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    if (!locksStake(contract)) return refuse('that round\'s stake is not a federation lock, so there is no lock to claim');
    if (!this.port || typeof this.port.settle !== 'function') return refuse('this signer node reaches no federation, so it settles nothing');
    // A ROUND THAT TAKES ANY FEDERATION HAS NO ROW OF ITS OWN (kanban #1172): its settlement is ACCEPTED once every federation's row is
    const first = this.round.settlementState ? this.round.settlementState(roundIdBytes) : (this.round.lockSettlement(roundIdBytes) || {}).state;
    if (first !== ACCEPTED) return refuse('the round\'s own settlement is not accepted here yet, so no entry is late');
    const shares = this.round.lockSettlementShares ? this.round.lockSettlementShares(roundIdBytes) : null;
    if (!shares) return refuse('this signer node kept no shares of the round\'s settlement, so it cannot split a late stake');
    const lockRow = this.round.stakeLock(entryIdBytes);
    if (!lockRow) return refuse('this signer node verified no stake lock for that entry');
    const moves = this.round.lockSettlementMoves(roundIdBytes);
    if (moves && (moves.claims || []).includes(String(lockRow.outpoint))) return refuse('that lock was claimed in the round\'s settlement');
    const standing = this.finalityOf(this.round, roundIdBytes, entryIdBytes);
    if (standing.state === SUSPENDED || (standing.state === PROVISIONALLY_FINAL && standing.rerun))
      return refuse('that entry is still in its re-run window: no second settlement yet');
    const found = this.round.entriesOf(roundIdBytes).find((x) => toHex(x.entryId) === toHex(entryIdBytes));
    if (!found) return refuse('no such entry in that round', 404);
    let outcome = standing.state; let score = 0;
    if (standing.state === FINAL) {
      const r = settledResult(this.round, roundIdBytes, entryIdBytes, standing);
      if (!r) return refuse('this signer node signed no result for that entry, so it settles nothing');
      outcome = r.outcome; score = r.score;
    } else if (standing.state !== FORFEIT && standing.state !== VOID) {
      return refuse(`that entry is not decided: ${standing.state || 'without a result'}`);
    }
    const held = roundKeyOf(this.dkg, contract);
    if (!held.ok) return refuse(`this signer node holds no share of the round's claim key: ${held.why}`);
    const claimPk = held.pool.groupPublicKey;
    const e = found.entry;
    const entry = { pubkey: e.playerPubkey, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat, outcome, score };
    const fields = lockFieldsFromJson(lockRow.fields);
    if (!lockKeyStands(fields, claimPk, contract)) return refuse('that lock names another claim key than the round\'s');
    const lock = { outpoint: outpointOf(lockRow.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk };
    const byPlayer = new Map(this.round.entriesOf(roundIdBytes).map((x) => [toHex(x.entry.playerPubkey), x.entryId]));
    const winnerLocks = new Map();
    const entryOf = new Map();
    for (const x of shares) {
      const eid = byPlayer.get(toHex(x.pubkey));
      if (eid) entryOf.set(toHex(x.pubkey), eid);
      const wl = eid ? this.round.stakeLock(eid) : null;
      if (wl) winnerLocks.set(toHex(x.pubkey), { refundPk: lockFieldsFromJson(wl.fields).refundPk });
    }
    const fl = this.round.feeLock ? this.round.feeLock(entryIdBytes) : null;
    const feeLock = fl ? { outpoint: outpointOf(fl.outpoint), amountMsat: lockFieldsFromJson(fl.fields).amountMsat, preimage: e.feePreimage } : null;
    // THE LATE LOSER'S FEDERATION'S PORT AND FEE RULE (kanban #1172): its lock is there; for a round in one federation, the round's
    const port = await this.latePort(roundIdBytes, entryIdBytes);
    if (!port || typeof port.settle !== 'function') return refuse('this signer node reaches no federation of that late loser\'s lock, so it builds nothing');
    const anyFed = takesAnyFederation(contract);
    const feeKey = anyFed ? `${toHex(roundIdBytes)}:late:${toHex(entryIdBytes)}` : toHex(roundIdBytes);
    let fees = this.fees.get(feeKey);
    if (!fees) { fees = await port.fees(); this.fees.set(feeKey, fees); }
    const args = { roundId: roundIdBytes, entryId: entryIdBytes, entry, lock, feeLock, shares, fees,
      signerNodes: feeLock ? this.signerNodesFor(roundIdBytes, contract) : null, contract, ...this.roundFees(contract) };
    // THE BASE PLAN the late sends are sized from (C3b-2a). With a winnings sender it is never signed, so a winner whose
    // lock row is missing here does not block it: its payout goes by send, refunding to the committee key.
    // WINNINGS-AUTO (RULED 2026-10-01): the late shares are paid by payout contracts to the winners' own lock keys
    // (C3b-1), never by a send - so the base plan is the plan, and a winner's lock row is required.
    const basePlan = lateLockSettlement({ ...args, winnerLocks });
    if (!basePlan.ok) return refuse(`no late lock is claimed: ${basePlan.why}`);
    const base = { plan: basePlan, entryOf };
    if (onlyBase) return { ok: true, base, contract, claimPk };
    // THE PLAN THAT IS SIGNED pays every winner by its accepted late send (slice C3b-2a): a winner the first settlement
    // paid with no address or no accepted send is refused by name - never paid by a contract only its key can move.
    const plan = basePlan;
    if (!plan.ok) return refuse(`no late lock is claimed: ${plan.why}`);
    const claims = [];
    for (const c of plan.claims) {
      if (c.kind === 'fee') { claims.push(c); continue; }
      const opened = await this.stakeSecrets.open({ roundId: roundIdBytes, entryId: entryIdBytes, needed: receiptsNeeded(contract.settlementSlots) });
      if (!opened.ok) return refuse(`the late loser's P could not be opened: ${opened.why}`);
      if (fields.paymentImage.kind === 'point') {
        const point = this.curve.pointFromScalar(scalarFrom32(opened.preimage) % FIELD);
        if (toHex(point) !== toHex(fields.paymentImage.bytes)) return refuse('the P the signer nodes opened is not the scalar of the point the late lock names');
      }
      claims.push({ ...c, preimage: opened.preimage });
    }
    const tx = await this.#build(port, contract, { claimPk, claims, payouts: plan.payouts, nonce: plan.nonce });
    const built = { ok: true, ...tx, plan, claims, claimPk,
      signerNode: held.signerNode, needed: receiptsNeeded(contract.settlementSlots), contract,
      ackTable: ackTableOf({ roundId: roundIdBytes, lateEntryId: entryIdBytes }, plan, claimPk, planTableRows(plan), () => entryIdBytes) };
    this.built.set(key, built);
    return built;
  }

  /**
   * AN ATTESTED ROUND SETTLES ONLY ON A FINAL OUTCOME (§0A.7a2026-10-07): held while it has
   * no attestation (OPEN), while its first standing attestation is inside the objection window, and when two contradict
   * (DISPUTED) - nothing of it moves then, and with no outcome ever every lock expires back to its player. A settlement
   * already ACCEPTED is not held again: a contradiction after it is kept as proof and undoes nothing. null for any other
   * round, or for an attested one whose outcome is final.
   */
  #attestedHold(roundIdBytes) {
    const a = this.#attestedOf(roundIdBytes);
    if (!a) return null;
    const kept = this.round.lockSettlement(roundIdBytes);
    if (kept && kept.state === ACCEPTED) return null;
    // a round that takes any federation keeps one row per federation: one ACCEPTED is a settlement that went in
    if (this.round.fedLockSettlementsOf && (this.round.fedLockSettlementsOf(roundIdBytes) || []).some((r) => r.state === ACCEPTED)) return null;
    // REFUND AT THE DEADLINE: a market round with no standing outcome by its deadline, or whose attestors
    // contradicted themselves, is VOID - nothing is claimed, every stake comes back by the return door (forfeit.js)
    // AND A MARKET ON A GAME WHOSE SOURCE RESULT REFUNDS IT, OR WHOSE SOURCE CAN NEVER FIT IT (feature 6): VOID at once,
    // not at its deadline (game-market.js marketVoidOf)
    // ON THE ROUND'S PERSISTED STATE (kanban #1151): VOID and FINAL are terminal, so a round VOID here never settles, and one FINAL
    // here is never voided by what comes after - a late contradiction is evidence only
    if (a.finality.voided) return { ok: false, state: 'VOID', why: `a market round that is not settled on any outcome: ${a.finality.why}`, outcome: 'VOID' };
    if (a.finality.final) return null;
    const f = a.finality;
    const why = f.state === 'OPEN' ? 'an attested round with no outcome attested: nothing is settled, and its locks expire back to their players'
      : f.state === 'DISPUTED' ? `an attested round whose attestors contradicted themselves: ${f.why}`
        : `an attested round inside its objection window: its outcome is final at ${new Date(f.finalAtMs).toISOString()}, and a contradiction before then settles nothing`;
    return { ok: false, state: 'HELD', why, outcome: f.state };
  }

  /** The round's attested game and the finality of its outcome on this seat's clock - or null for a replayed round. */
  #attestedOf(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row || !this.round.plugins) return null;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = pluginForRound(contract, this.round.plugins);
    if (!found.ok || !found.attested) return null;
    // EVERY STANDING OUTCOME: the attestations, and a market on a game's held source result in an attestation's shape (kanban
    // feature 6, game-market.js heldOutcomes) - final, held, disputed and paid by the same rules
    // THE FINALITY IS THE ROUND'S PERSISTED STATE (kanban #1151, game-market.js marketFinalityOf): final only once FINAL is stored
    // here, so no lock is claimed before that state is persisted
    const held = heldOutcomes(this.round, roundIdBytes);
    return { contract, plugin: found.plugin, held,
      finality: marketFinalityOf(this.round, roundIdBytes, { contract, manifest: found.plugin.manifest, nowMs: this.round.now ? this.round.now() : Date.now() }) };
  }

  /**
   * THE PLAN OF AN ATTESTED ROUND WHOSE OUTCOME IS FINAL (§0A.7a slice 2): its counted entries (a stake this seat saw), the
   * pari-mutuel table over them and the outcome, and `attestedLockSettlement` - the losers' stake locks and every fee lock
   * claimed, the winners paid their shares of the losing pool, the seats their §22A fee.
   */
  // THE CANCELS THE OTHER SEATS HOLD, pulled before a market is settled so every seat builds its table from
  // the same entries: each kept only if its player's session key signed it - a seat cannot forge one for anybody
  async #carryCancels(roundIdBytes) {
    if (!cancelCarryDue(this.#cancelsCarried, toHex(roundIdBytes), this.now(), this.round.entriesOf(roundIdBytes).length)) return;
    // EVERY SEAT IS READ, there is no threshold to a cancel; a seat that does not answer in time is as one that is down
    const asked = await askPeers(this.peersFor(roundIdBytes), async (peer, signal) => {
      const answer = await this.fetcher(`${peer}/cancels?round=${toHex(roundIdBytes)}`, { signal });
      return answer.ok ? answer.json() : null;
    }, { boundMs: this.peerReadMs });
    for (const { value: body } of asked) {
      for (const c of (body && Array.isArray(body.cancels) ? body.cancels : [])) {
        if (!/^[0-9a-f]{64}$/.test(String(c.entry)) || !/^[0-9a-f]{128}$/.test(String(c.signature))) continue;
        const entryId = fromHex(c.entry);
        if (this.round.cancelled(entryId)) continue;
        const raw = this.round.entry(entryId);
        if (!raw) continue;
        const entry = decodeEntryContract(raw);
        if (toHex(entry.roundId) !== toHex(roundIdBytes)) continue;
        let good = false;
        try { good = ed25519.verify(fromHex(c.signature), cancelId({ roundId: roundIdBytes, entryId }), entry.sessionPubkey); } catch { good = false; }
        if (good) this.round.putCancel({ roundId: roundIdBytes, entryId, signature: fromHex(c.signature), receivedMs: this.now() });
      }
    }
  }

  /**
   * AN ORDER BOOK'S PLAN (comment 1127; 2026-10-09 "(a)"): every certified batch this seat or another
   * holds (carried first), none pending, through the ledger (book-ledger.js) to the settlement table on the final outcome,
   * and `bookLockSettlement`: each filled order's stake lock and fee lock claimed whole and paid out of in this one
   * transaction - winnings, sellers' proceeds, every unfilled rest, the fees due to the nodes and the donation. An order
   * with no fill is not claimed: its locks come back whole by the return door.
   */
  /** The fees in force at this round as the lock settlements take them: a version-11 round's node fee, the website share. */
  roundFees(contract) {
    const set = typeof this.feesFor === 'function' && contract ? this.feesFor(contract) : null;
    if (!set) return {};
    return { websitePct: set.websitePct, ...(paysReserves(contract) ? { feeBps: roundSplitBps(set).nodes } : {}) };
  }

  async #bookPlan(roundIdBytes, a, claimPk, held) {
    const { contract } = a;
    // THE BOOK AS A THRESHOLD OF THE ROUND'S SEATS HOLD IT FIRST (kanban #740, round 5d4cbd41: two seats that never received batch
    // 3586289144 cleared batch 3586289193 alone and answered "no order filled" while the five others filled it at 40c): every certified
    // batch the other seats list is taken here, once per round (order-batch.js sync). Until a threshold of seats answered, this seat
    // says "not yet" - the combiner asks again - and never plans a book it may hold short, least of all one that claims nothing.
    const synced = await this.orderBook.sync(roundIdBytes);
    if (!synced.ok) return refuse(`not yet: reading the other seats' batches - ${synced.why}`, 409);
    const pending = this.orderBook.pending(roundIdBytes);
    if (pending.length) return refuse(`no lock is claimed: batch ${pending[0]} of the book is not decided at this seat`);
    const L = this.orderBook.ledger(roundIdBytes);
    if (!L.ok) return refuse(`no lock is claimed: ${L.why}`);
    let table;
    // a scalar market's book (§0A.7e) settles on the signed value between THIS round's bounds (marketOfRound)
    const scalar = isScalar(a.plugin.manifest) ? { value: a.finality.value, bounds: marketOfRound(a.plugin.manifest, contract).scalar } : null;
    try { table = bookSettlement({ positions: L.positions, outcome: a.finality.outcome, scalar }); } catch (e) { return refuse(`no lock is claimed: ${e.message}`); }
    const entries = [];
    const locks = new Map();
    const lockEntry = new Map();
    const feeLocks = new Map();
    for (const r of table.claimed) {
      const entryId = fromHex(r.entry);
      const raw = this.round.entry(entryId);
      if (!raw) return refuse(`no lock is claimed: this seat holds no entry ${r.entry.slice(0, 16)}`);
      const e = decodeEntryContract(raw);
      // the website that brought this order (comment 2295): bookLockSettlement pays it 20% of the nodes' part of its fee
      entries.push({ entryId: r.entry, pubkey: e.playerPubkey, ...(e.frontendPk ? { frontendPk: e.frontendPk } : {}) });
      const lock = this.round.stakeLock(entryId);
      if (lock) {
        const fields = lockFieldsFromJson(lock.fields);
        if (!lockKeyStands(fields, claimPk, contract)) return refuse('a lock of this round names another claim key than the round\'s');
        locks.set(toHex(e.playerPubkey), { outpoint: outpointOf(lock.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk, fields });
        lockEntry.set(toHex(e.playerPubkey), entryId);
      }
      const fl = this.round.feeLock ? this.round.feeLock(entryId) : null;
      if (fl) {
        const fields = lockFieldsFromJson(fl.fields);
        if (!lockKeyStands(fields, claimPk, contract)) return refuse('a fee lock of this round names another claim key than the round\'s');
        feeLocks.set(toHex(e.playerPubkey), { outpoint: outpointOf(fl.outpoint), amountMsat: fields.amountMsat, preimage: e.feePreimage });
      }
    }
    const key = toHex(roundIdBytes);
    let fees = this.fees.get(key);
    if (!fees && !takesAnyFederation(contract)) { fees = await (await this.portFor(roundIdBytes)).fees(); this.fees.set(key, fees); }
    let donation = null;
    if (L.market.donationBps > 0 && table.feesDueMsat > 0n) {
      const t = this.donationTargetFor ? this.donationTargetFor(contract) : { ok: false, why: 'this signer node names no donation target' };
      if (!t.ok) return refuse(`no lock is claimed: the book's fees carry a donation, and ${t.why}`);
      donation = { recipients: t.target };
    }
    // THE PROTOCOL RESERVE: a market whose terms name one pays it to its federation's reserve key - each federation's
    // part to its own when the round takes any federation
    const reserveBps = L.market.reserveBps || 0;
    const anyFed = takesAnyFederation(contract);
    let reserveKey = null;
    if (reserveBps > 0 && table.feesDueMsat > 0n) {
      if (anyFed) reserveKey = RESERVE_LATER_PK;
      else {
        reserveKey = this.reserveKeyFor ? await this.reserveKeyFor(toHex(contract.federationId)).catch(() => null) : null;
        if (!reserveKey) return refuse('no lock is claimed: this market pays the protocol reserve, and no reserve key is known for its federation');
      }
    }
    const book = (f) => bookLockSettlement({ roundId: roundIdBytes, table, entries, locks, feeLocks, fees: f, contract,
      nodeBps: L.market.nodeBps, donationBps: L.market.donationBps, donation, reserveBps, reserveKey,
      ...(L.market.websitePct !== undefined ? { websitePct: L.market.websitePct } : {}) });
    if (anyFed)
      return this.#anyFederationPlan(roundIdBytes, contract, entries.map((e) => ({ entryId: fromHex(e.entryId), pubkey: e.pubkey })), locks, feeLocks,
        book, { claimPk, held, lockEntry, table }, reserveBps > 0);
    const plan = book(fees);
    if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`, 409, plan.noFill ? REFUSAL.NOTHING_CLAIMED : null);
    return { ok: true, plan, base: { plan, entryOf: lockEntry }, contract, claimPk, held, locks, lockEntry, table };
  }

  /**
   * WHERE A ROUND THAT TAKES ANY FEDERATION HOLDS EACH CLAIMED LOCK (2026.0.3): each lock's federation is its
   * entry's (entryFederation), each federation's fee rule its own port's, read once per round. `entries` [{ entryId (bytes),
   * pubkey }]; answers { ok, federationOf(outpoint), feesOf(fidHex) } for splitByFederation, or a refusal.
   */
  async #federationsOf(roundIdBytes, contract, entries, locks, feeLocks) {
    const key = toHex(roundIdBytes);
    const fedOf = new Map();
    for (const e of entries) {
      const raw = this.round.entry ? this.round.entry(e.entryId) : null;
      if (!raw) continue;
      const ef = entryFederation(contract, decodeEntryContract(raw));
      if (!ef.ok) return refuse(`no lock is claimed: ${ef.why}`);
      const fid = toHex(ef.federationId);
      const sl = locks.get(toHex(e.pubkey)); if (sl) fedOf.set(`${toHex(sl.outpoint.txid)}:${sl.outpoint.outIdx}`, fid);
      const fl = feeLocks.get(toHex(e.pubkey)); if (fl) fedOf.set(`${toHex(fl.outpoint.txid)}:${fl.outpoint.outIdx}`, fid);
    }
    const feesByFed = new Map();
    for (const fid of new Set(fedOf.values())) {
      const fk = `${key}:fed:${fid}`;
      let f = this.fees.get(fk);
      if (!f) {
        const port = await this.portForFederation(fid);
        if (!port || typeof port.fees !== 'function') return refuse(`this signer node cannot reach federation ${fid.slice(0, 16)}, so it settles nothing there`);
        f = await port.fees(); this.fees.set(fk, f);
      }
      feesByFed.set(fid, f);
    }
    return { ok: true, federationOf: (o) => fedOf.get(`${toHex(o.txid)}:${o.outIdx}`) || null, feesOf: (fid) => feesByFed.get(fid) || null,
      federationIds: [...feesByFed.keys()] };
  }

  /**
   * AN ATTESTED OR BOOK ROUND THAT TAKES ANY FEDERATION (2026.0.3 step 5c): its plan decided once with no fee - `planWith(fees)`
   * is the round's own settlement (attestedLockSettlement, bookLockSettlement) - then split into one transaction per federation,
   * each priced by its own guardians' rule; answered in the shape the lock rounds' per-federation settlement takes.
   */
  async #anyFederationPlan(roundIdBytes, contract, entries, locks, feeLocks, planWith, rest, paysReserve = false) {
    const fed = await this.#federationsOf(roundIdBytes, contract, entries, locks, feeLocks);
    if (!fed.ok) return fed;
    const plan = planWith(NO_FEES);
    if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`, 409, plan.noFill ? REFUSAL.NOTHING_CLAIMED : null);
    // each federation's reserve key, read before the split: the split itself is not async
    const reserveKeys = new Map();
    if (paysReserve && plan.payouts.some((p) => p.reserve)) {
      for (const fid of fed.federationIds) reserveKeys.set(fid, this.reserveKeyFor ? await this.reserveKeyFor(fid).catch(() => null) : null);
    }
    const split = splitByFederation(plan, { roundId: roundIdBytes, ...fed, reserveKeyOf: (fid) => reserveKeys.get(fid) || null });
    if (!split.ok) return refuse(`no lock is claimed: ${split.why}`);
    return { ok: true, anyFed: true, plan, split, base: { plan, entryOf: rest.lockEntry }, contract, locks, ...rest };
  }

  async #attestedPlan(roundIdBytes, a, claimPk, held) {
    const { contract } = a;
    if (this.orderBook && this.orderBook.isBook(roundIdBytes)) return this.#bookPlan(roundIdBytes, a, claimPk, held);
    if (this.round.cancelsOf) await this.#carryCancels(roundIdBytes);
    const entries = this.round.entriesOf(roundIdBytes).filter(({ entryId }) => !this.round.stakeSeen || !!this.round.stakeSeen(entryId))
      .map(({ entryId, entry }) => ({ entryId: toHex(entryId), pubkey: entry.playerPubkey, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat,
        donationMsat: entry.donationMsat, pick: entry.pick, feePreimage: entry.feePreimage, entryIdBytes: entryId,
        ...(entry.frontendPk ? { frontendPk: entry.frontendPk } : {}) }));
    if (!entries.length) return refuse('an attested round with no counted entry: nothing is claimed', 409, REFUSAL.NO_COUNTED_ENTRY);
    // THE TABLE BY THE GAME'S RULE: pari-mutuel on the outcome, or a scalar market's split by its signed value (feature 8)
    let table;
    try { table = attestedTable(a.plugin.manifest, entries, a.finality, a.contract); } catch (e) { return refuse(e.message); }
    const locks = new Map();
    const lockEntry = new Map();
    const feeLocks = new Map();
    for (const e of entries) {
      const lock = this.round.stakeLock(e.entryIdBytes);
      if (lock) {
        const fields = lockFieldsFromJson(lock.fields);
        if (!lockKeyStands(fields, claimPk, contract)) return refuse('a lock of this round names another claim key than the round\'s');
        locks.set(toHex(e.pubkey), { outpoint: outpointOf(lock.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk, fields });
        lockEntry.set(toHex(e.pubkey), e.entryIdBytes);
      }
      const fl = this.round.feeLock ? this.round.feeLock(e.entryIdBytes) : null;
      if (fl) {
        const fields = lockFieldsFromJson(fl.fields);
        if (!lockKeyStands(fields, claimPk, contract)) return refuse('a fee lock of this round names another claim key than the round\'s');
        feeLocks.set(toHex(e.pubkey), { outpoint: outpointOf(fl.outpoint), amountMsat: fields.amountMsat, preimage: e.feePreimage });
      }
    }
    const key = toHex(roundIdBytes);
    let fees = this.fees.get(key);
    if (!fees && !takesAnyFederation(contract)) { fees = await (await this.portFor(roundIdBytes)).fees(); this.fees.set(key, fees); }
    // THE MARKET'S OWN NODE FEE, 0.5 % by default - and its donation, which its entries' fee locks hold with
    // it (entryFeeBpsOf): due now, at resolution, to the round's donation target
    const ofGame = this.round.plugins ? pluginForRound(contract, this.round.plugins) : null;
    const manifest = ofGame && ofGame.ok ? ofGame.plugin.manifest : null;
    let donation = null;
    if (manifest && donationInFee(manifest) && donationBpsOf(manifest) > 0 && feeLocks.size) {
      const t = this.donationTargetFor ? this.donationTargetFor(contract) : { ok: false, why: 'this signer node names no donation target' };
      if (!t.ok) return refuse(`no lock is claimed: a market's fee locks hold its donation, and ${t.why}`);
      donation = { recipients: t.target };
    }
    const attested = (f) => attestedLockSettlement({ roundId: roundIdBytes, table, entries, locks, fees: f, feeLocks,
      signerNodes: feeLocks.size ? this.signerNodesFor(roundIdBytes, contract) : null, contract,
      feeBps: manifest ? feeBpsOf(manifest) : undefined, donation });
    if (takesAnyFederation(contract))
      return this.#anyFederationPlan(roundIdBytes, contract, entries.map((e) => ({ entryId: e.entryIdBytes, pubkey: e.pubkey })), locks, feeLocks,
        attested, { claimPk, held, lockEntry, table });
    const plan = attested(fees);
    if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`, 409, plan.noFill ? REFUSAL.NOTHING_CLAIMED : null);
    return { ok: true, plan, base: { plan, entryOf: lockEntry }, contract, claimPk, held, locks, lockEntry, table };
  }

  /**
   * SETTLE A LATE LOSER (slice C3b-1): the round's asker combines and submits, as for the round's own settlement; a
   * second attempt on an ACCEPTED one builds nothing. A signer node whose turn it is not, holding a signature it was
   * handed, asks the federation whether it went in: every claimed lock gone and a payout of that txid stored.
   */
  async settleLate(roundIdBytes, entryIdBytes) {
    if (this.#attestedOf(roundIdBytes)) return { ok: false, state: 'HELD', why: 'an attested round has no late entry: its picks are all in its one settlement' };
    const where = { entry: entryIdBytes };
    let kept = this.round.lateLockSettlement(roundIdBytes, entryIdBytes);
    if (kept && kept.state === ACCEPTED) return { ok: true, kept: true, ...kept, sent: await this.sendLate(roundIdBytes, entryIdBytes) };
    // A ROW THIS SEAT WAS INSIDE, ASKED OF THE LATE LOSER'S FEDERATION FIRST (kanban #1172), by every seat: every txid it signed or was handed
    if (kept && (kept.state === SUBMITTING || kept.state === REFUSED)) {
      const c = await this.checkScoped(roundIdBytes, where);
      if (c.state === ACCEPTED) return { ok: true, state: ACCEPTED, why: c.why, txid: c.txid, recovered: true, sent: await this.sendLate(roundIdBytes, entryIdBytes) };
      if (kept.state === SUBMITTING && c.verdict === 'mixed') return refuse(`neither in nor out - not settled here, not submitted again: ${c.why}`, 409);
      kept = this.round.lateLockSettlement(roundIdBytes, entryIdBytes);
    }
    const t = await this.turn(roundIdBytes);
    if (!t.mine) return refuse(`not this signer node's turn to combine: ${t.why}`, 409, t.code || REFUSAL.NOT_MY_TURN, Number.isInteger(t.takeoverAt) ? { takeoverAt: t.takeoverAt } : {});
    // THE LATE SEND PLANS FIRST, as for the round's own settlement: proposed here, checked by every peer, or nothing.
    if (this.winnings && !(kept && kept.state === SUBMITTING)) {
      const planned = await this.planLateSends(roundIdBytes, entryIdBytes);
      if (!planned.ok) return planned;
    }
    let m = await this.lateMessage(roundIdBytes, entryIdBytes);
    if (!m.ok) return m;
    let signature = !m.named && kept && kept.signature && kept.txid === m.txid ? kept.signature : null;
    if (m.named) {
      const n = await this.#namedSigned(roundIdBytes, m, `round=${toHex(roundIdBytes)}&entry=${toHex(entryIdBytes)}`, null, { entry: entryIdBytes });
      if (!n.ok) return n;
      ({ m, signature } = n);
    } else if (!signature) {
      const q = `round=${toHex(roundIdBytes)}&entry=${toHex(entryIdBytes)}`;
      const held = await this.#gatherAcks(roundIdBytes, m, q);
      if (!held.ok) return held;
      const own = await this.commit(roundIdBytes, { entry: entryIdBytes, acks: held.acks });
      if (!own.ok) return own;
      const { signers, refused, committed, refusedBy } = await this.#peerCommitments(roundIdBytes, own, q, m, held.acks);
      if (signers.length < m.needed)
        return refuse(`${signers.length} of the ${m.needed} signer nodes the late settlement needs committed to it: ${refused.join('; ')}`);
      const listed = this.#listed(q, signers, m.needed);
      const combined = await this.#gatherShares(roundIdBytes, m, q, listed, null, refusedBy, { entry: entryIdBytes });
      if (!combined.ok) return this.#leaveOut(q, combined, listed, m.needed) ? this.settleLate(roundIdBytes, entryIdBytes) : combined;
      ({ signature } = combined);
      await this.#handSignature(roundIdBytes, q, signature, m);
    }
    // THE INTENT ON DISK FIRST, WITH WHAT IT MOVES (kanban #1172), through the row's one transition function; submitted in the late loser's federation
    this.keepScopedMoves(roundIdBytes, where, m);
    if (!this.#putScoped(roundIdBytes, where, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
      why: 'about to submit; if this signer node dies here, ask the federation for the claimed lock' })) return refuse('this late settlement\'s row is final here: nothing is submitted again', 409);
    const port = await this.latePort(roundIdBytes, entryIdBytes);
    if (!port) return refuse('this signer node reaches no federation of that late loser\'s lock');
    const sent = await this.#submit(port, m, { payouts: m.plan.payouts, nonce: m.plan.nonce, signature });
    const why = sent.accepted
      ? `claimed the late loser's lock, ${m.plan.poolMsat} msat; paid ${m.plan.payouts.filter((p) => p.kind !== 'signer node').length} winner(s) ${m.plan.paidMsat} msat`
        + `${m.plan.feeClaims && m.plan.feeClaims.length ? `; its fee lock ${m.plan.feePoolMsat} msat to ${m.plan.signerNodePayouts.length} signer node(s)` : ''}`
      : `the guardians refused it: ${sent.error}`;
    // ACCEPTED ONLY LANDED, REFUSED ONLY AFTER EVERY TXID WAS ASKED (kanban #1172), as the round's row
    const state = await this.recordScopedSubmit(roundIdBytes, where, m, signature, sent, why);
    if (!sent.accepted) this.built.delete(`${toHex(roundIdBytes)}:${toHex(entryIdBytes)}`);
    const row = this.round.lateLockSettlement(roundIdBytes, entryIdBytes);
    const winnings = state === ACCEPTED ? await this.sendLate(roundIdBytes, entryIdBytes) : null;
    return { ok: state === ACCEPTED, state, why: row ? row.why : why, txid: row ? row.txid : m.txid, signature, plan: m.plan, answer: sent, winnings };
  }

  /** THE LATE SETTLEMENT'S OWN WINNINGS SENDER (slice C3b-2a): the round's sender, over that late (round, entry)'s rows. */
  lateWinningsFor(roundIdBytes, entryIdBytes) {
    if (!this.winnings) return null;
    const key = `${toHex(roundIdBytes)}:${toHex(entryIdBytes)}`;
    if (!this.lateSenders) this.lateSenders = new Map();
    let w = this.lateSenders.get(key);
    if (!w) {
      const o = this.winnings;
      w = new o.constructor({ round: this.round.lateSendScope(entryIdBytes), port: o.port, curve: o.curve, random: o.random,
        peersFor: o.peersFor, fetcher: o.fetcher, lnurlFetch: o.lnurlFetch, network: o.network, scopeParam: `&late=${toHex(entryIdBytes)}`,
        dkg: o.dkg, peerAskMs: o.peerAskMs, peerGraceMs: o.peerGraceMs, lnurlMs: o.lnurlMs });
      this.lateSenders.set(key, w);
    }
    return w;
  }

  /** THE ASKER'S LATE SEND PLANS: proposed from the late base plan and handed to every peer, which checks them itself. */
  async planLateSends(roundIdBytes, entryIdBytes) {
    const got = await this.lateMessage(roundIdBytes, entryIdBytes, { onlyBase: true });
    if (!got.ok) return got;
    const w = this.lateWinningsFor(roundIdBytes, entryIdBytes);
    const proposed = await w.propose(roundIdBytes, got.base);
    if (!proposed.ok) return proposed;
    const body = JSON.stringify(proposed.rows.map(sendPlanToJson));
    const peers = this.peersFor(roundIdBytes);
    if (!peers.length && got.contract.nodes.length > 1) return refuse('this signer node knows no peer to hand the late send plan to yet');
    const agreed = await this.planAgreed(roundIdBytes, entryIdBytes, body, got.contract, peers,
      `${toHex(roundIdBytes)}&late=${toHex(entryIdBytes)}`);
    if (!agreed.final) return refuse(`${agreed.agreed} of the ${agreed.needed} seats the late settlement needs signed its send plan: ${agreed.refused.join('; ')}`);
    this.built.delete(`${toHex(roundIdBytes)}:${toHex(entryIdBytes)}`);
    return { ok: true, rows: proposed.rows };
  }

  /** A PEER'S TAKE of the asker's late send plans, checked against its own late base plan; `from` as `takeSends`. */
  async takeLateSends(roundIdBytes, entryIdBytes, proposed, { from = null } = {}) {
    if (!this.winnings) return refuse('this signer node sends no winnings');
    const got = await this.lateMessage(roundIdBytes, entryIdBytes, { onlyBase: true });
    if (!got.ok) return got;
    const checked = await this.lateWinningsFor(roundIdBytes, entryIdBytes).check(roundIdBytes, got.base, proposed, { from });
    if (checked.ok) this.built.delete(`${toHex(roundIdBytes)}:${toHex(entryIdBytes)}`);
    return checked.ok ? { ...checked, taken: this.planTakenBy(planTakenId({ roundId: roundIdBytes, lateEntryId: entryIdBytes, rows: proposed })) } : checked;
  }

  /** The accepted late settlement's winnings, sent - by the round's asker; the others answer and keep the preimage. */
  async sendLate(roundIdBytes, entryIdBytes) {
    const w = this.lateWinningsFor(roundIdBytes, entryIdBytes);
    if (!w || !w.round.sendPlansOf(roundIdBytes).length) return [];
    if (!(await this.turn(roundIdBytes)).mine) return [];
    const kept = this.round.lateLockSettlement(roundIdBytes, entryIdBytes);
    if (!kept || kept.state !== ACCEPTED) return [];
    const m = this.sendBuilt(roundIdBytes, await this.lateMessage(roundIdBytes, entryIdBytes), { entry: entryIdBytes });
    if (!m.ok) return [{ ok: false, why: m.why }];
    return w.sendAll(roundIdBytes, m);
  }

  /** WHAT THIS SIGNER NODE WILL SIGN, rebuilt from its own store and the stock client - or the refusal. */
  async message(roundIdBytes) {
    { const held = this.#attestedHold(roundIdBytes); if (held) return held; }
    const key = toHex(roundIdBytes);
    const kept = this.built.get(key);
    if (kept) return kept;
    const got = await this.planOf(roundIdBytes, { withSends: true });
    if (!got.ok) return got;
    if (got.anyFed) return refuse('that round takes any federation: it is signed one federation at a time (name the federation)');
    const { plan, contract, claimPk, held, locks, lockEntry, ackRows } = got;
    // THE SAME PLAN IS NOT BUILT TWICE (NODE-OPT-1648): `built` is dropped whenever send plans are checked - the coordinator
    // proposes the same ones every winnings sweep while a send is held - and every drop rebuilt the settlement: the losers'
    // P opened again and a stock-client settle run on the shared client directory, 49 a minute across seven idle testnet4
    // seats. The plan is recomputed from the store as before (no client run); built for an identical plan, it is reused.
    const fp = planFingerprint(plan, claimPk, held.signerNode);
    const prior = this.byPlan.get(key);
    if (prior && prior.fp === fp) { this.built.set(key, prior.built); return prior.built; }

    const claims = [];
    for (const c of plan.claims) {
      if (c.kind === 'fee') { claims.push(c); continue; }
      const entryId = lockEntry.get(toHex(c.pubkey));
      const opened = await this.stakeSecrets.open({ roundId: roundIdBytes, entryId, needed: receiptsNeeded(contract.settlementSlots) });
      if (!opened.ok) return refuse(`a loser's P could not be opened: ${opened.why}`);
      const lock = locks.get(toHex(c.pubkey));
      if (lock.fields.paymentImage.kind === 'point') {
        const point = this.curve.pointFromScalar(scalarFrom32(opened.preimage) % FIELD);
        if (toHex(point) !== toHex(lock.fields.paymentImage.bytes))
          return refuse('the P the signer nodes opened is not the scalar of the point that loser\'s lock names');
      }
      claims.push({ ...c, preimage: opened.preimage });
    }
    let tx;
    try { tx = await this.#build(await this.portFor(roundIdBytes), contract, { claimPk, claims, payouts: plan.payouts, nonce: plan.nonce }); }
    catch (e) {
      // A LOCK THE GUARDIANS NO LONGER HOLD (kanban #1146 A): the next plan reads this round's losers' locks at the federation and leaves the gone ones out
      if (NO_LOCK_HELD.test(String(e && e.message))) { this.#suspectGone.add(key); console.log(`#1044 [settle] ${key.slice(0, 16)}: ${String(e.message).slice(0, 120)} - its losers' locks are read at the federation next`); }
      throw e;
    }
    const built = { ok: true, ...tx, plan, claims, claimPk,
      signerNode: held.signerNode, needed: receiptsNeeded(contract.settlementSlots), contract,
      ackTable: ackTableOf({ roundId: roundIdBytes }, plan, claimPk, ackRows || planTableRows(plan), byLockKey(lockEntry)) };
    this.built.set(key, built);
    this.byPlan.set(key, { fp, built });
    if (this.byPlan.size > 4096) this.byPlan.delete(this.byPlan.keys().next().value);
    return built;
  }

  /**
   * THE ROUND'S PLAN FROM THIS SIGNER NODE'S OWN STORE - no preimage opened, nothing cached. `withSends` pays each
   * qualifier with a kept send plan by its outgoing contract (winnings-send.js); without it, the base plan the send
   * plans are proposed and checked against.
   */
  /**
   * THE WINNERS' SHARES OF ROUNDS SETTLED BEFORE A BOOK KEPT THEM: an order book's settlement kept no shares until
   * bookLockSettlement returned them, so every market round settled before kept [] and a season read its winners as losers. Each
   * round this node signed whose kept shares are empty is planned again from its store (planOf - no preimage opened, no client
   * run), and the shares that plan names are kept when the plan pays as many as the signed one did. Answers how many were filled.
   */
  async backfillShares({ limit = 500 } = {}) {
    let rows = [];
    try { rows = this.round.db.prepare("SELECT round_id FROM lock_settlement_shares WHERE shares = '[]' LIMIT ?").all(limit); } catch { return 0; }
    let filled = 0;
    for (const { round_id: rid } of rows) {
      const id = new Uint8Array(rid);
      const moves = this.round.lockSettlementMoves(id);
      if (!moves) continue;
      let got;
      try { got = await this.planOf(id, { withSends: true }); } catch { continue; }
      if (!got || !got.ok || !got.plan || got.plan.payouts.length !== moves.payouts) continue;
      const shares = got.plan.stakeShares || [];
      if (!shares.length) continue;
      this.round.putLockSettlementShares(id, shares);
      filled++;
    }
    return filled;
  }

  async planOf(roundIdBytes, { withSends = false } = {}) {
    const key = toHex(roundIdBytes);
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    if (!locksStake(contract)) return refuse('that round\'s stake is not a federation lock, so there is no lock to claim');
    if (!this.port || typeof this.port.settle !== 'function') return refuse('this signer node reaches no federation, so it settles nothing');
    const held = roundKeyOf(this.dkg, contract);
    if (!held.ok) return refuse(`this signer node holds no share of the round's claim key: ${held.why}`);
    const claimPk = held.pool.groupPublicKey;
    // NO PLAYER-NODE CONFLICT GATE (§5A.13, RULED 2026-10-14 ~20:01Z): a player declares no operator, and no
    // signer node is kept out of a settlement, nor a round voided, by a declaration; self-dealing is priced by the 5-of-7 bonded
    // slots (§5A.6) and overturnable by replay (§13A)
    const anyFed = takesAnyFederation(contract);
    // AN ATTESTED ROUND (§0A.7a): its plan is its pari-mutuel table's, on a final outcome only
    { const a = this.#attestedOf(roundIdBytes);
      if (a) {
        if (!a.finality.final) return refuse(this.#attestedHold(roundIdBytes)?.why || 'an attested round whose outcome is not final');
        return this.#attestedPlan(roundIdBytes, a, claimPk, held);
      } }

    const onRecord = this.entriesOnRecord(roundIdBytes, contract);
    if (!onRecord.ok) return onRecord;
    // THE GAME'S PAYOUT RULE: §18A's curve or its manifest's top split - the table every seat settles by
    const rule = payoutRuleOfRound(contract, this.round.plugins);
    if (!rule.ok) return refuse(`no lock is claimed: ${rule.why}`);
    const payoutShares = rule.payoutShares;
    const locks = new Map();
    const lockEntry = new Map();
    for (const e of onRecord.entries) {
      const lock = this.round.stakeLock(e.entryId);
      if (!lock) continue;
      const fields = lockFieldsFromJson(lock.fields);
      if (!lockKeyStands(fields, claimPk, contract)) return refuse('a lock of this round names another claim key than the round\'s');
      locks.set(toHex(e.pubkey), { outpoint: outpointOf(lock.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk, fields });
      lockEntry.set(toHex(e.pubkey), e.entryId);
    }
    // A SETTLEMENT CLAIMS ONLY THE LOCKS THE FEDERATION STILL HOLDS (RULED 2026-11-06, kanban #1146 A): a loser's stake lock spent by a forfeit, or run out and
    // refunded, is read as refunded - F′, the same table code over the entries with that stake out (payout.js withGoneStakes) - and its fee lock is left
    // where it is, as a refunded entry's is: a claimed lock with no row is a false table (settlement-rebuild.js tableFalse). Every table this plan makes - the
    // claims, the payouts, the acked rows - is F′'s. Unchanged where every loser's lock stands.
    const gone = await this.#goneStakes(roundIdBytes, contract, onRecord.entries, locks, payoutShares);
    const on = gone.size ? { ...onRecord, entries: withGoneStakes(onRecord.entries, gone), gone } : onRecord;
    // AND EVERY FEE LOCK THIS SIGNER NODE VERIFIED (Pick A), with the F its entry hands over.
    const feeLocks = new Map();
    for (const e of on.entries) {
      const fl = this.round.feeLock ? this.round.feeLock(e.entryId) : null;
      if (!fl) continue;
      const fields = lockFieldsFromJson(fl.fields);
      if (!lockKeyStands(fields, claimPk, contract)) return refuse('a fee lock of this round names another claim key than the round\'s');
      feeLocks.set(toHex(e.pubkey), { outpoint: outpointOf(fl.outpoint), amountMsat: fields.amountMsat, preimage: e.feePreimage });
    }
    // A ROUND THAT TAKES ANY FEDERATION: each claimed lock's federation is its entry's (entryFederation), each federation's fee
    // rule its own port's, read once; the plan decided once and split into one transaction per federation (federationPlans)
    if (anyFed) {
      const ds = on.entries.some((e) => e.atTheDoor) && this.donationSetFor ? this.donationSetFor(contract) : null;
      const fed = await this.#federationsOf(roundIdBytes, contract, on.entries.map((e) => ({ entryId: e.entryId, pubkey: e.pubkey })), locks, feeLocks);
      if (!fed.ok) return fed;
      const got = federationPlans({ roundId: roundIdBytes, entries: on.entries, minScore: contract.minScore, payoutShares, locks, feeLocks,
        signerNodes: feeLocks.size ? this.signerNodesFor(roundIdBytes, contract) : null, contract, donationSet: ds && ds.ok ? ds.set : null }, fed);
      if (!got.ok) return refuse(`no lock is claimed: ${got.why}`);
      return { ok: true, anyFed: true, plan: got.plan, split: got.split, base: { plan: got.plan, entryOf: lockEntry }, contract, claimPk, held, locks, lockEntry,
        ackRows: entryRows(roundIdBytes, on.entries, contract.minScore, payoutShares) };
    }
    let fees = this.fees.get(key);
    if (!fees) { fees = await (await this.portFor(roundIdBytes)).fees(); this.fees.set(key, fees); }
    // THE POOL (RULED 2026-09-23): only a qualifier whose entry named a Lightning address at this signer node is paid;
    // the others' shares are split over them, and with none nothing of the stakes is claimed. Every signer node reads
    // its own rows; a peer holding another set rebuilds other amounts and refuses the proposer's plan by name.
    const addressed = new Set();
    for (const e of on.entries) if (this.round.payoutAddress && this.round.payoutAddress(e.entryId)) addressed.add(toHex(e.pubkey));
    const ds = on.entries.some((e) => e.atTheDoor) && this.donationSetFor ? this.donationSetFor(contract) : null;
    const args = { roundId: roundIdBytes, entries: on.entries, minScore: contract.minScore, payoutShares, locks, fees,
      feeLocks, signerNodes: feeLocks.size ? this.signerNodesFor(roundIdBytes, contract) : null, contract, addressed,
      donationSet: ds && ds.ok ? ds.set : null, ...this.roundFees(contract) };
    let plan = lockSettlement(args);
    if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`, 409, plan.noFill ? REFUSAL.NOTHING_CLAIMED : null);
    const base = { plan, entryOf: lockEntry };
    // THE PLAN THAT IS SIGNED pays every addressed qualifier by its accepted send - never by a contract its key moves.
    if (withSends && plan.payouts.some((p) => p.kind === 'qualifier' || p.kind === 'donation')) {
      if (!this.winnings) return refuse('this signer node sends no winnings, so it builds no payout to a named address');
      plan = lockSettlement({ ...args, sends: this.winnings.sendsFor(roundIdBytes, base, claimPk), requireSends: true });
      if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    }
    return { ok: true, plan, base, contract, claimPk, held, locks, lockEntry, ackRows: entryRows(roundIdBytes, on.entries, contract.minScore, payoutShares) };
  }

  /**
   * WHAT THE SIGNER NODES' SETTLEMENT MOVES, AS THIS SIGNER NODE BUILT IT - for a reader (GET
   * /lock-settlement): every input with its kind and msat, every payout with its
   * kind, key, msat and the federation's fee on it, the input fees, the txid. Null
   * until this signer node has built it.
   */
  summary(roundIdBytes) {
    const m = this.built.get(toHex(roundIdBytes));
    if (m && m.ok) return planSummary(m.txid, m.plan);
    const kept = this.summaries.get(toHex(roundIdBytes));
    return kept || null;
  }

  /**
   * WHAT A SETTLEMENT MOVED, AFTER A RESTART TOO (playtest 2026-10-04: a DELIVERED player's 96 sat read
   * "paying out" for 2 h). `summary` read only the settlement this process built, so every round settled before a
   * restart answered "moved": null - and a page that cannot read the settlement never asks for its stake back. Measured
   * on testnet4: round 3568d136 ACCEPTED with moved null after the seats' 12:30Z and 13:19Z restarts. A round this signer
   * node settled (its moves kept at signing) is answered from its plan rebuilt from the store - no preimage opened, no
   * client run - when that plan claims and pays as many as the signed one did; else null, as before. Kept once found.
   */
  async summaryOf(roundIdBytes) {
    const now = this.summary(roundIdBytes);
    if (now) return now;
    const moves = this.round.lockSettlementMoves(roundIdBytes);
    if (!moves) return null;
    let got;
    try { got = await this.planOf(roundIdBytes, { withSends: true }); } catch { return null; }
    if (!got || !got.ok) return null;
    if (got.plan.claims.length !== moves.claims.length || got.plan.payouts.length !== moves.payouts) return null;
    const s = planSummary(moves.txid, got.plan);
    this.summaries.set(toHex(roundIdBytes), s);
    if (this.summaries.size > 4096) this.summaries.delete(this.summaries.keys().next().value);
    return s;
  }

  /**
   * AN ORDER BOOK'S BATCHES READ AGAIN FROM THE OTHER SEATS (kanban #740), for a settlement whose fills or plan another seat rebuilt
   * otherwise: answers whether a certified batch this seat lacked was taken - and then every settlement built here for the round is
   * dropped, to be built again from the store. Not a book round, or nothing new: false, nothing dropped.
   */
  async bookResync(roundIdBytes) {
    const key = toHex(roundIdBytes);
    // AT MOST ONE READ A ROUND EVERY 30 S: an asker that keeps naming other bytes does not make an overloaded seat read every peer each time
    const last = this.#resyncedAt.get(key) || 0;
    if (Date.now() - last < 30000) return false;
    if (!this.orderBook || !this.orderBook.isBook(roundIdBytes)) return false;
    this.#resyncedAt.set(key, Date.now());
    if (this.#resyncedAt.size > 4096) this.#resyncedAt.delete(this.#resyncedAt.keys().next().value);
    const got = await this.orderBook.sync(roundIdBytes, { force: true });
    if (!got.ok || !got.fresh) return false;
    for (const k of [...this.built.keys()]) if (k === key || k.startsWith(`${key}:fed:`)) this.built.delete(k);
    return true;
  }
  #resyncedAt = new Map();   // round id hex -> when its book was last read again on a mismatch (bookResync)

  /** The settlement a peer is asked about, rebuilt here: only the bytes the asker built, or a refusal by name. */
  async #askedMessage(roundIdBytes, { txid = null, entry = null, federation = null } = {}) {
    const build = () => (federation ? this.fedMessage(roundIdBytes, federation) : entry ? this.lateMessage(roundIdBytes, entry) : this.message(roundIdBytes));
    let m = await build();
    // AN ORDER BOOK REBUILT OTHERWISE THAN THE ASKER'S, OR NOT AT ALL (kanban #740): the asker built bytes this seat did not - the other
    // seats' certified batches are read again (the read kept for the round may be older than a batch this seat missed), and with one
    // taken, the settlement is built again from the store
    if (txid && !entry && (!m.ok || String(txid).toLowerCase() !== String(m.txid).toLowerCase()) && (await this.bookResync(roundIdBytes))) m = await build();
    if (!m.ok) return m;
    // A COMMITMENT ONLY TO THE BYTES THE ASKER BUILT (measured on a 5-of-7): a signer node that rebuilt another
    // settlement - it saw a run end differently - would otherwise commit, and its share over its own bytes spoils the
    // combined signature for everyone. It refuses by name, and the threshold of the others decides.
    if (txid && String(txid).toLowerCase() !== String(m.txid).toLowerCase()) {
      this.#suspect(roundIdBytes);
      return refuse(`this signer node rebuilt settlement ${String(m.txid).slice(0, 16)}, not ${String(txid).slice(0, 16)}: it commits to no other bytes`, 409);
    }
    return m;
  }

  /**
   * WHERE THIS SEAT'S SETTLEMENT PASS STOPPED (§5A.3 "Stalled in its rounds", protocol 26, RULED 2026-11-03, kanban #1066): the seats silent there, kept for its StallNote. Silent is no
   * signed word at the step the pass stopped at (plan, ack, commit or share), or a refusal after signing FINAL. A seat that refused by name and whose FINAL this seat does not hold is
   * not listed: a reason clears nobody who signed FINAL, because that seat held the round's data and agreed on the outcome, and the FINAL stage names a seat that never signed.
   * The step counts, not the commit alone: a pass that stopped at the plan or the acks asks no seat to commit, so a list of commits would name the honest seats beside the silent ones.
   * `refusedBy` the doors that refused by name.
   */
  #stoppedAt(roundIdBytes, contract, scope, step, answered, refusedBy = []) {
    if (scope === null || !stallsOut(contract) || !this.round.putSettlePass) return;
    const signedFinal = new Set(this.round.finalSigners(roundIdBytes));
    const cleared = refusedBy.map((base) => this.peerKeyOf(roundIdBytes, base)).filter((k) => k && !signedFinal.has(k));
    this.round.putSettlePass({ roundId: roundIdBytes, scope, step, silent: silentSeats({ seats: contract.nodes, answered: [...answered, ...cleared, this.round.pubkey], me: this.round.pubkey }) });
  }
  /** Who answered a commit with its signed word, from protocol 26: its node key, or null. */
  #commitWord(roundIdBytes, m, r, commitment) {
    if (!stallsOut(m.contract)) return null;
    const h = r.headers && r.headers.get ? r.headers.get('x-settlement-commit') : null;
    if (!h) return null;
    let bytes; try { bytes = fromHex(h); } catch { return null; }
    const c = checkSettlementCommit(bytes, { seats: m.contract.nodes, commit: { roundId: roundIdBytes, settlementTxid: fromHex(m.txid), hiding: commitment.hiding, binding: commitment.binding }, verify: verifyAck });
    return c.ok ? c.who : null;
  }

  /**
   * THE PEERS' COMMITMENTS, each asked at the same time and within a bound (kanban #1061): the list needs a threshold, not every seat, so a hung seat costs the grace and
   * not the settlement. Answers `signers`, this seat first and the peers in their order, `refused`, each seat that is not among them, named, `committed`, who signed its word,
   * and `refusedBy`, the doors that refused by name.
   */
  async #peerCommitments(roundIdBytes, own, query, m, acks) {
    const ask = this.#askHeaders(roundIdBytes, m, query, ASK_COMMIT, acks);
    const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
      const r = await this.fetcher(`${base}/settle-commit?${query}&txid=${m.txid}`, { method: 'POST', signal, ...(acks ? { body: acks } : {}), ...ask });
      if (!r.ok) return { why: (await r.text()).trim(), byName: refusedByName(r) };
      const commitment = decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0];
      return { commitment, who: this.#commitWord(roundIdBytes, m, r, commitment), leftOut: !!(this.#withheld.get(query) || new Set()).has(base) };
    // A SEAT LEFT OUT FOR A WITHHELD SHARE (kanban #1070) does not count towards the threshold that ends the wait: it will not be on the list
    }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: m.needed - 1, counts: (x) => !!x.commitment && !x.leftOut });
    const signers = [{ base: null, commitment: own.commitment }];
    const refused = [], committed = [], refusedBy = [];
    for (const { peer: base, value, error } of asked) {
      if (value && value.commitment) { signers.push({ base, commitment: value.commitment, who: value.who }); if (value.who) committed.push(value.who); continue; }
      refused.push(`${base}: ${value ? value.why : error.message}`);
      if (value && value.byName) refusedBy.push(base);
    }
    return { signers, refused, committed, refusedBy };
  }

  /**
   * THE COMBINED SIGNATURE, HANDED ON BEFORE THE SUBMIT: to every peer, not only those on the list, since a slow seat left off it committed all the same and keeps the
   * signature if it rebuilt these bytes; one that did not refuses it. A seat that misses it asks again, so the submit waits for no more than the threshold's answers.
   */
  async #handSignature(roundIdBytes, query, signature, m) {
    await askPeers(this.peersFor(roundIdBytes), (base, signal) => this.fetcher(`${base}/settle-signature?${query}`, { method: 'POST', body: signature, signal }),
      { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: m.needed - 1 });
  }

  /**
   * ROUND TWO, AND THE COMBINED SIGNATURE (RULED 2026-11-03, kanban #1066: "the share is a step"). From protocol 26 every seat that committed is asked, whoever refuses first, so the
   * list names all of them and not the first: 3 seats withholding a share would otherwise leave each asker naming one. Shares go to the asker only, so it lists what it received, as
   * for commits. A share that does not combine is no signed word either: the seat's public share says whose it was. `refusedBy` the doors that refused the commit by name.
   * Below 26 the first refusal ends the pass, as it did. Answers { ok, signature } or a refusal, with `withheld` the doors at fault: each that gave no share, or by their public shares
   * (dkg.publicSharesFor) each whose share does not stand (#leaveOut, kanban #1070). `scope` null notes no pass: a late settlement's has no stall note.
   */
  async #gatherShares(roundIdBytes, m, q, signers, scope, refusedBy, own) {
    const commitments = signers.map((s) => s.commitment).sort((a, b) => a.id - b.id);
    const named = stallsOut(m.contract);
    const shares = [], gave = [], failed = [], withheld = [], refusers = [...refusedBy];
    const mine = await this.share(roundIdBytes, commitments, own);
    if (!mine.ok) return mine;
    shares.push(mine.share);
    // EVERY PEER ON THE LIST AT ONCE, WITHIN THE BOUND (kanban #1061): there is no threshold here, the binding factors are over the whole list, and each share is over the one list,
    // whichever answers first. `shares` keeps the list's order, this seat first: `stands` below reads it by index.
    const body = encodeCommitments(commitments);
    const ask = this.#askHeaders(roundIdBytes, m, q, ASK_SHARE, body);
    const peers = signers.filter((s) => s.base !== null);
    const asked = await askPeers(peers.map((s) => s.base), async (base, signal) => {
      const r = await this.fetcher(`${base}/settle-share?${q}`, { method: 'POST', body, signal, ...ask });
      if (!r.ok) return { why: (await r.text()).trim(), byName: refusedByName(r) };
      return { share: decodeShare(new Uint8Array(await r.arrayBuffer())) };
    }, { boundMs: this.peerAskMs });
    asked.forEach(({ peer: base, value, error }, i) => {
      if (value && 'share' in value) { shares.push(value.share); if (peers[i].who) gave.push(peers[i].who); return; }
      failed.push(`${base} gave no share: ${value ? value.why : error.message}`);
      withheld.push(base);
      if (value && value.byName) refusers.push(base);
    });
    if (failed.length && !named) failed.length = 1;
    if (failed.length) { if (scope !== null) this.#stoppedAt(roundIdBytes, m.contract, scope, 'share', gave, refusers); return { ...refuse(failed.join('; ')), withheld }; }
    const { signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve });
    if (schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return { ok: true, signature };
    const held = this.dkg && this.dkg.publicSharesFor ? this.dkg.publicSharesFor(m.contract.nodes) : null;
    if (held && held.ok) {
      const stands = (s, i) => verifyShare340({ id: s.commitment.id, share: shares[i], publicShare: held.shares.get(String(s.commitment.id)), groupPublicKey: m.claimPk, message: m.message, commitments, curve: this.curve });
      withheld.push(...signers.filter((s, i) => s.base !== null && !stands(s, i)).map((s) => s.base));
      if (named && scope !== null) this.#stoppedAt(roundIdBytes, m.contract, scope, 'share', signers.filter((s, i) => s.who && stands(s, i)).map((s) => s.who), refusers);
    }
    return { ...refuse('the combined settlement signature does not verify under the round\'s claim key', 500), withheld };
  }

  /**
   * THIS SEAT'S SIGNED ASK, AS A HEADER (§5A.3, kanban #1075): from SETTLEMENT_ASK_HEIGHT a commit or share door answers only a seat of the round, so the ask names the step,
   * the settlement (the query's late entry or federation), the txid and the body sent, signed by this seat's node key. Below the height: nothing, the request is as it was.
   */
  #askHeaders(roundIdBytes, m, query, step, payload) {
    if (!asksBySeat(m.contract, this.askPointOf)) return {};
    const p = new URLSearchParams(query);
    const entry = p.get('entry') ? fromHex(p.get('entry')) : null;
    const ask = signSettlementAsk({ step, roundId: roundIdBytes, entry, federation: p.get('federation'), settlementTxid: fromHex(m.txid), payload },
      this.round.pubkey, (digest) => schnorr.sign(digest, this.round.identity.secret));
    return { headers: { 'x-settlement-ask': toHex(ask) } };
  }

  /**
   * AN ASK AT THE DOOR (kanban #1075): null when the door answers it, else the refusal. `door` is set by server.js only: this seat's own commit and share are not asked
   * through it. At or above the height an ask must be signed by a seat of this round's seating over this settlement and the very body sent; below it, nothing is read.
   */
  #askRefusal(roundIdBytes, m, { door = false, ask = null, entry = null, federation = null, step, payload }) {
    if (!door || !asksBySeat(m.contract, this.askPointOf)) return null;
    const c = checkSettlementAsk(ask, { seats: m.contract.nodes, ask: { step, roundId: roundIdBytes, entry, federation, settlementTxid: fromHex(m.txid), payload }, verify: verifyAck });
    return c.ok ? null : refuse(`this signer node ${step === ASK_COMMIT ? 'commits' : 'gives a share'} only to a seat of the round: ${c.why}`, 403);
  }

  /**
   * THE SEATS THAT SIGN THIS LIST (kanban #1070): those that committed, less any that gave this asker no share for this settlement while enough others remain. Every seat that
   * commits goes on the list and every seat on a list must give its share, so a seat that commits and withholds would be listed again on every pass. `key` the settlement's query.
   */
  #listed(key, signers, needed) {
    const out = this.#withheld.get(key);
    if (!out) return signers;
    const kept = signers.filter((s) => !out.has(s.base));
    return kept.length >= needed ? kept : signers;
  }

  /**
   * A LIST THAT FAILED AT A SEAT (kanban #1070): true when that seat is now left out and enough others remain, and the settlement asks again at once, each seat on a new nonce
   * pair. It grows by a seat each time, so it ends; short of the threshold the seats are forgotten and the pass ends, and the next pass lists whoever commits then.
   */
  #leaveOut(key, failed, listed, needed) {
    const out = this.#withheld.get(key) || new Set();
    const fresh = (failed.withheld || []).filter((base) => !out.has(base));
    for (const base of fresh) out.add(base);
    if (!fresh.length || listed.filter((s) => !out.has(s.base)).length < needed) { this.#withheld.delete(key); return false; }
    this.#withheld.set(key, out);
    if (this.#withheld.size > 4096) this.#withheld.delete(this.#withheld.keys().next().value);
    return true;
  }
  #withheld = new Map();   // a settlement's query -> the peers that gave this asker no share for it

  // ---- PROTOCOL 27: THE SIGNER SET'S BATCH (kanban #1044 B1, rulings #1131 3, #1134 2, #1135, #1136) ----

  /**
   * WHAT A SEAT BUILDS AND ACKS. Below protocol 27 the stock settle: the txid the FROST claim key signs. From it the BODY (stake-lock arena-settle
   * without signers): its id stands where the txid stood - the ack, the commit, the ask and the `txid=` of every door name it - and `message` is
   * the body id, the bytes a seat's nonces are kept for. The real txid follows S, once S is known (#namedMessages).
   */
  async #build(port, contract, { claimPk, claims, payouts, nonce }) {
    if (!namedClaims(contract)) {
      const tx = await port.settle({ claimPk, claims, payouts, nonce });
      return { message: fromHex(tx.message), txid: tx.txid };
    }
    if (!port || typeof port.arenaSettle !== 'function') throw new Error('this signer node\'s federation tool builds no Arena-lock settlement');
    const body = await port.arenaSettle({ claims, payouts, nonce });
    const bodyId = String(body.bodyId).toLowerCase();
    return { named: true, txid: bodyId, bodyId, message: fromHex(bodyId), payouts, nonce, zSlots: body.zSlots };
  }

  /** The submit: the stock settle with the FROST signature, or the real transaction with S and the MuSig2 signature. */
  async #submit(port, m, { payouts, nonce, signature }) {
    // `landed` (kanban #1171): what the guardians hold afterwards says it went in - the stock tool's payouts stored and claimed locks gone, the Arena
    // tool's claimed lock spent within its wait - not submit_transaction's pre-validation alone
    if (!m.named) {
      const r = await port.settle({ claimPk: m.claimPk, claims: m.claims, payouts, nonce, signature });
      const stored = Array.isArray(r.payoutsStored) && r.payoutsStored.some(Boolean);
      const gone = Array.isArray(r.locksAfter) && r.locksAfter.length > 0 && r.locksAfter.every((x) => !x);
      return { ...r, landed: r.accepted === true && stored && gone };
    }
    const r = await port.arenaSettle({ claims: m.claims, payouts: m.offTable || payouts, nonce, signers: m.signers, signature });
    if (r.txid && String(r.txid) !== String(m.txid)) return { accepted: false, error: `the tool built ${String(r.txid).slice(0, 16)}, not the signed ${String(m.txid).slice(0, 16)}` };
    return { accepted: r.accepted, error: r.error, landed: r.accepted === true && r.locksSpent === true };
  }

  /** The scope's key in the store and in `pairs`: '' the round's own, a late entry's hex, a federation's hex. */
  #scopeOf({ entry = null, federation = null } = {}) { return federation ? String(federation).toLowerCase() : entry ? toHex(entry) : ''; }

  /**
   * EVERY MESSAGE OF THE BATCH FOR SIGNER SET `signers`, rebuilt here (ruling #1135 1): the real txid (S in every claim, KeyAgg(S) for every Z; the
   * tool refuses one that strips to another body), each send's auth over its invoice (its contract refunding to KeyAgg(S)), and each qualifier's
   * refund (c) from the real txid and the table. { ok, txid, message, messages, slots, refundKey, refunds: [{ outIdx, txid }] } or a refusal.
   */
  async #namedMessages(roundIdBytes, m, signers, opts = {}) {
    const memo = `${m.bodyId}:${this.#scopeOf(opts)}:${signers.join(',')}`;
    if (this.#namedBuilt.has(memo)) return this.#namedBuilt.get(memo);
    const { seatKeys, threshold } = namedClaimKeys(m.contract);
    let refundKey;
    try { refundKey = signerSetKey(seatKeys, threshold, signers); } catch (e) { return refuse(`no signer set ${signers.join(',')}: ${e.message}`); }
    const port = opts.federation ? await this.portForFederation(opts.federation) : opts.entry ? await this.latePort(roundIdBytes, opts.entry) : await this.portFor(roundIdBytes);
    // THE REGTEST FAULT (test-named-offence.js, off by default): this seat signs a claim off the table it acked - offence (a)
    // (or a send refunding to another key than KeyAgg(S), ruling #1135 2 - the same offence)
    const offTable = offTableOn(roundIdBytes) ? offTablePayouts(m.payouts) : swapRefundOn(roundIdBytes) ? swappedRefundPayouts(m.payouts) : null;
    const real = await port.arenaSettle({ claims: m.claims, payouts: offTable || m.payouts, nonce: m.nonce, signers });
    if (!offTable && String(real.bodyId).toLowerCase() !== m.bodyId) return refuse('the real transaction strips to another body than the one acked');
    if (String(real.aggKey).toLowerCase() !== toHex(refundKey.subarray(1))) return refuse('the tool\'s KeyAgg of the signer set is not this seat\'s');
    const slots = namedSlots(m.payouts);
    const sender = opts.entry ? this.lateWinningsFor(roundIdBytes, opts.entry) : this.winnings;
    const messages = [fromHex(real.message)];
    const refunds = [];
    for (const slot of slots.slice(1)) {
      if (slot.kind === 'auth') {
        const row = sender ? sender.round.sendAttemptsOf(roundIdBytes).find((r) => r.attempt === 0 && String(r.paymentHash).toLowerCase() === slot.paymentHash) : null;
        if (!row) return refuse(`this signer node keeps no send plan for payment ${slot.paymentHash.slice(0, 16)}`);
        const said = await port.send({ paymentHash: row.paymentHash, amountMsat: row.payoutMsat, expiration: row.expiration, claimPk: row.gatewayPk, refundPk: refundKey, invoice: row.invoice });
        messages.push(said.message);
      } else {
        const c = await port.arenaSendRefund({ send: { txid: fromHex(real.txid), outIdx: BigInt(slot.outIdx) }, amountMsat: slot.msat, refundPk: refundKey, qualifierPk: slot.qualifierPk });
        messages.push(fromHex(c.message));
        refunds.push({ outIdx: slot.outIdx, txid: c.txid, qualifierPk: toHex(slot.qualifierPk), msat: String(slot.msat), ...(c.payoutMsat !== null && c.payoutMsat !== undefined ? { payoutMsat: String(c.payoutMsat) } : {}) });
      }
    }
    const out = { ok: true, txid: String(real.txid), message: fromHex(real.message), messages, slots, refundKey, refunds, ...(offTable ? { offTable } : {}) };
    if (offTable) console.log(`[settle] ${toHex(roundIdBytes).slice(0, 16)} TEST FAULT: signs claim ${String(real.txid).slice(0, 16)} off its table (ARENA_TEST_NAMED_OFFENCE_FILE)`);
    this.#namedBuilt.set(memo, out);
    if (this.#namedBuilt.size > 1024) this.#namedBuilt.delete(this.#namedBuilt.keys().next().value);
    return out;
  }
  #namedBuilt = new Map();
  #level2Said = new Set();
  #namedReadAt = new Map();
  #suspectGone = new Set();     // round id hex: a build named a lock the guardians do not hold (kanban #1146 A)
  #goneLocks = new Set();       // outpoint text of a stake lock read gone: a spent or refunded lock never comes back

  /**
   * THE LOSERS' STAKE LOCKS THE FEDERATION NO LONGER HOLDS (RULED 2026-11-06, kanban #1146 A): of the locks F claims, those whose outpoint the guardians hold
   * nothing at, or hold run out (no block left). Read only for a round whose build named a lock the guardians do not hold - or one already read gone here -
   * so a round whose locks stand costs no federation read. Answers a Set of player key hex.
   */
  async #goneStakes(roundIdBytes, contract, entries, locks, payoutShares) {
    const key = toHex(roundIdBytes), gone = new Set();
    let h;
    try { h = lockActions({ roundId: roundIdBytes, entries, minScore: contract.minScore, payoutShares }); } catch { return gone; }
    const suspect = this.#suspectGone.has(key);
    // READ GONE BEFORE, KEPT (kanban #1183): a restarted seat builds F' again from its store, not F
    const kept = new Set(typeof this.round.goneStakesOf === 'function' ? this.round.goneStakesOf(roundIdBytes) : []);
    // THIS ROUND'S OWN CLAIM IS NO REFUND (kanban #1183): a lock this round's signed settlement claims is gone because that settlement landed, not because
    // its player took it back - read it as refunded and the seat would rebuild a table without the loser it was paid by
    const own = ownClaimsOf(this.round, roundIdBytes);
    for (const a of h.actions) {
      if (a.action !== CLAIM) continue;
      const k = toHex(a.entry.pubkey), lock = locks.get(k);
      if (!lock) continue;
      const at = `${toHex(lock.outpoint.txid)}:${String(lock.outpoint.outIdx)}`;
      if (this.#goneLocks.has(at) || kept.has(at)) { gone.add(k); continue; }
      if (!suspect) continue;
      let port = null;
      try {
        const ef = takesAnyFederation(contract) ? entryFederation(contract, decodeEntryContract(new Uint8Array(this.round.entry(a.entry.entryId)))) : null;
        port = ef && ef.ok ? await this.portForFederation(toHex(ef.federationId)) : await this.portFor(roundIdBytes);
      } catch { port = null; }
      if (!port) continue;
      let st = null;
      try { st = lock.fields && lock.fields.arena && typeof port.arenaStatus === 'function' ? await port.arenaStatus(lock.outpoint) : await port.status(lock.outpoint); } catch { continue; }
      // GONE, OR AS GOOD AS GONE BY THE TIME A CLAIM LANDS (kanban #1183): a lock with GONE_MARGIN_BLOCKS or fewer left is read as run out. Measured
      // 2026-11-06 on s47a round 87da156f: a settlement built on a lock with blocks left was refused by the guardians - "The contracts locktime has
      // passed" - and the seats were left SUBMITTING, neither in nor out. Monotonic (a lock only runs out), so two seats reading it a block apart meet
      // on the next read (peerSaysGone)
      if (!st || !st.stored || !(Number(st.stored.blocksLeft) > GONE_MARGIN_BLOCKS)) {
        if (own.has(at)) { console.log(`#1183 [settle] ${key.slice(0, 16)}: the stake lock at ${at.slice(0, 20)} is spent by this round's own settlement - not read as refunded`); continue; }
        this.#goneLocks.add(at);
        gone.add(k);
        try { if (typeof this.round.putGoneStake === 'function') this.round.putGoneStake({ roundId: roundIdBytes, outpoint: at, why: st && st.stored ? 'run out' : 'gone' }); } catch { /* read again next time */ }
        console.log(`#1044 [settle] ${key.slice(0, 16)}: the stake lock at ${at.slice(0, 20)} is ${st && st.stored ? 'run out' : 'gone'} - its entry is read as refunded (F′)`);
      }
    }
    if (this.#goneLocks.size > 8192) this.#goneLocks.delete(this.#goneLocks.values().next().value);
    return gone;
  }

  /** ROUND ONE AT A PROTOCOL-27 SEAT: one fresh nonce pair per message of the body's batch, made before S is known; a pair that signed a list is spent. */
  #commitNamed(roundIdBytes, m, key) {
    const { seatKeys } = namedClaimKeys(m.contract);
    const seat = seatKeys.findIndex((k) => toHex(k) === toHex(this.round.pubkey));
    if (seat < 0) return refuse('this node is not one of the round\'s settlement seats');
    let pair = this.pairs.get(key);
    if (!pair || !pair.named || toHex(pair.message) !== toHex(m.message) || pair.list) {
      pair = { named: true, message: m.message, list: null, nonces: new NamedNonces({ count: namedSlots(m.payouts).length, secret: this.round.identity.secret, myKey: this.round.pubkey, rand: this.random }) };
      this.pairs.set(key, pair);
    }
    const pubnonces = pair.nonces.pubnonces;
    const word = signSettlementCommit({ roundId: roundIdBytes, settlementBodyId: fromHex(m.txid), nonces: pubnonces }, this.round.pubkey, (digest) => schnorr.sign(digest, this.round.identity.secret));
    return { ok: true, named: true, seat, pubnonces, word, wire: encodeNamedCommitment(pubnonces) };
  }

  /** A member's signed commit over this body and exactly these nonces, by the seat it says: its seat index, or null. */
  #namedWord(roundIdBytes, m, word, pubnonces) {
    const { seatKeys } = namedClaimKeys(m.contract);
    const c = checkSettlementCommit(word, { seats: seatKeys, commit: { roundId: roundIdBytes, settlementBodyId: fromHex(m.txid), nonces: pubnonces }, verify: verifyAck });
    if (!c.ok) return null;
    const i = seatKeys.findIndex((k) => toHex(k) === c.who);
    return i >= 0 ? i : null;
  }

  /**
   * ROUND TWO AT A PROTOCOL-27 SEAT: the list names S, ascending, exactly t, each member with its signed commit over this body and its nonces;
   * this seat is in it with its own nonces. Its partials over every message it rebuilt for that S, once: the nonces are spent after.
   */
  async #shareNamed(roundIdBytes, m, bytes, opts) {
    let list;
    try { list = decodeNamedList(bytes); } catch (e) { return refuse(`no signer list: ${e.message}`, 400); }
    const { seatKeys, threshold } = namedClaimKeys(m.contract);
    const signers = list.map((x) => x.seat);
    if (signers.length !== threshold || signers.some((s, i) => i > 0 && s <= signers[i - 1])) return refuse(`a signer list names exactly ${threshold} seats, ascending`);
    for (const x of list) if (this.#namedWord(roundIdBytes, m, x.word, x.pubnonces) !== x.seat) return refuse(`seat ${x.seat}'s signed commit over this body and its nonces does not stand`);
    const me = seatKeys.findIndex((k) => toHex(k) === toHex(this.round.pubkey));
    const mine = list.find((x) => x.seat === me);
    if (!mine) return refuse('this signer node is not in that signer list');
    const key = this.#pairKey(roundIdBytes, opts);
    const pair = this.pairs.get(key);
    if (!pair || !pair.named || toHex(pair.message) !== toHex(m.message)) return refuse('this signer node committed to no settlement of that round');
    if (mine.pubnonces.length !== pair.nonces.pubnonces.length || mine.pubnonces.some((p, k) => toHex(p) !== toHex(pair.nonces.pubnonces[k])))
      return refuse('that list does not carry this signer node\'s own nonces');
    // every member's commit holds one nonce pair per message of this body's batch, checked before a secret nonce is touched (ruling #1137: the
    // member checks the list's form and its own nonce, never that the list is the lowest one)
    const odd = list.find((x) => x.pubnonces.length !== pair.nonces.pubnonces.length);
    if (odd) return refuse(`seat ${odd.seat} committed to ${odd.pubnonces.length} nonce pairs and this body's batch signs ${pair.nonces.pubnonces.length}`);
    const lk = toHex(bytes);
    if (pair.list) return pair.list === lk ? { ok: true, partials: pair.nonces.partials, wire: encodeNamedPartials(pair.nonces.partials) } : refuse('this signer node signed that settlement over another list, and keeps no second pair');
    const built = await this.#namedMessages(roundIdBytes, m, signers, opts);
    if (!built.ok) return built;
    if (pair.list) return refuse('this signer node signed that settlement over another list meanwhile');
    { const c = this.#claiming(roundIdBytes, m, 'a settlement share given'); if (!c.ok) return c; }
    pair.list = lk;
    let partials;
    try { partials = pair.nonces.sign({ claimKeys: seatKeys, threshold, signers, pubnoncesBySigner: list.map((x) => x.pubnonces), messages: built.messages }); }
    catch (e) { return refuse(`no partials: ${e.message}`); }
    return { ok: true, partials, wire: encodeNamedPartials(partials) };
  }
  #pairKey(roundIdBytes, { entry = null, federation = null } = {}) {
    return federation ? `${toHex(roundIdBytes)}:fed:${String(federation).toLowerCase()}` : entry ? `${toHex(roundIdBytes)}:${toHex(entry)}` : toHex(roundIdBytes);
  }

  /**
   * THE ASKER'S BATCH (rulings #1131 3, #1135 1): the acks over the body; every seat's commit; S the t lowest seat indices with a valid signed commit,
   * less any that spoilt an earlier session of this body; each member's partials for every message; each message aggregated and checked. A member
   * that gave no partials or a bad one is left out and the next session runs on new nonces with the next set; short of t seats, the pass ends.
   * Answers { ok, signers, signatures, built } or a refusal.
   */
  async #signNamed(roundIdBytes, m, q, scope, opts) {
    const held = await this.#gatherAcks(roundIdBytes, m, q, scope);
    if (!held.ok) return held;
    const { seatKeys, threshold } = namedClaimKeys(m.contract);
    const dropped = [];
    for (;;) {
      const own = await this.commit(roundIdBytes, { ...opts, acks: held.acks });
      if (!own.ok) return own;
      const ask = this.#askHeaders(roundIdBytes, m, q, ASK_COMMIT, held.acks);
      const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
        const r = await this.fetcher(`${base}/settle-commit?${q}&txid=${m.txid}&named=1`, { method: 'POST', signal, ...(held.acks ? { body: held.acks } : {}), ...ask });
        if (!r.ok) return { why: (await r.text()).trim(), byName: refusedByName(r) };
        const pubnonces = decodeNamedCommitment(new Uint8Array(await r.arrayBuffer()));
        const h = r.headers && r.headers.get ? r.headers.get('x-settlement-commit') : null;
        const word = h ? fromHex(h) : null;
        const seat = word ? this.#namedWord(roundIdBytes, m, word, pubnonces) : null;
        return seat === null ? { why: 'its commit carries no signed word over this body and these nonces', byName: true } : { seat, word, pubnonces };
      }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: threshold - 1, counts: (x) => !!(x && x.word) });
      const members = [{ seat: own.seat, word: own.word, pubnonces: own.pubnonces, base: null }];
      const refused = [], refusedBy = [];
      for (const { peer: base, value, error } of asked) {
        if (value && value.word && value.pubnonces.length === own.pubnonces.length && !members.some((x) => x.seat === value.seat)) { members.push({ ...value, base }); continue; }
        refused.push(`${base}: ${value ? value.why || 'another number of nonces' : error.message}`);
        if (value && value.byName) refusedBy.push(base);
      }
      const signers = namedSignerSet({ committed: members.map((x) => x.seat), threshold, dropped });
      if (!signers) {
        if (scope !== null) this.#stoppedAt(roundIdBytes, m.contract, scope, 'commit', members.filter((x) => x.base !== null).map((x) => toHex(seatKeys[x.seat])), refusedBy);
        return refuse(`${members.filter((x) => !dropped.includes(x.seat)).length} of the ${threshold} signer nodes the settlement needs committed to it${dropped.length ? ` (seat(s) ${dropped.join(', ')} left out)` : ''}: ${refused.join('; ')}`);
      }
      const list = signers.map((i) => members.find((x) => x.seat === i));
      const built = await this.#namedMessages(roundIdBytes, m, signers, opts);
      if (!built.ok) return built;
      const body = encodeNamedList(list);
      const partialsBy = new Map();
      if (signers.includes(own.seat)) {
        const mine = await this.share(roundIdBytes, body, opts);
        if (!mine.ok) return mine;
        partialsBy.set(own.seat, mine.partials);
      }
      const shareAsk = this.#askHeaders(roundIdBytes, m, q, ASK_SHARE, body);
      const peers = list.filter((x) => x.base !== null);
      const got = await askPeers(peers.map((x) => x.base), async (base, signal) => {
        const r = await this.fetcher(`${base}/settle-share?${q}&named=1`, { method: 'POST', body, signal, ...shareAsk });
        if (!r.ok) return { why: (await r.text()).trim() };
        return { partials: decodeNamedPartials(new Uint8Array(await r.arrayBuffer())) };
      }, { boundMs: this.peerAskMs });
      got.forEach(({ value }, i) => { if (value && value.partials && value.partials.length === built.messages.length) partialsBy.set(peers[i].seat, value.partials); });
      const agg = aggregateBatch({ claimKeys: seatKeys, threshold, signers, messages: built.messages, pubnoncesBySigner: list.map((x) => x.pubnonces),
        partialsBySigner: signers.map((i) => partialsBy.get(i) || null) });
      if (agg.ok) return { ok: true, signers, signatures: agg.signatures, built };
      dropped.push(...agg.bad.filter((i) => !dropped.includes(i)));
      console.log(`[settle] ${toHex(roundIdBytes).slice(0, 16)} named signing left out seat(s) ${agg.bad.join(', ')}: ${agg.why}`);
      if (seatKeys.length - dropped.length < threshold) return refuse(`no signer set is left: ${agg.why}`);
    }
  }

  /**
   * THE BATCH FOR THIS BODY: the one kept (signed earlier, by this seat or handed to it) or signed now, kept, and handed to every peer before the
   * submit (#1134 2: nothing is submitted until every signature exists; every seat keeps the auths and refunds). Answers { ok, m: the real
   * transaction's build, signature: the claim's } or a refusal.
   */
  async #namedSigned(roundIdBytes, m, q, scope, opts) {
    const sc = this.#scopeOf(opts);
    // THE BATCH THE SCOPE'S ROW STANDS ON (kanban #1170), else the standing one: a row SUBMITTING or ACCEPTED on T is never signed over with another S
    const kept = this.batchFor(roundIdBytes, opts);
    let signers, signatures, built;
    if (kept && kept.bodyId === m.bodyId) {
      ({ signers, signatures } = kept);
      built = await this.#namedMessages(roundIdBytes, m, signers, opts);
      if (!built.ok) return built;
    } else {
      const got = await this.#signNamed(roundIdBytes, m, q, scope, opts);
      if (!got.ok) return got;
      ({ signers, signatures, built } = got);
      this.#keepBatch(roundIdBytes, opts, m, built, signers, signatures);
      const batch = encodeNamedBatch({ signers, signatures });
      await askPeers(this.peersFor(roundIdBytes), (base, signal) => this.fetcher(`${base}/settle-signature?${q}&named=1`, { method: 'POST', body: batch, signal }),
        { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: m.needed - 1 });
    }
    return { ok: true, m: { ...m, txid: built.txid, message: built.message, signers, refundKey: built.refundKey, ...(built.offTable ? { offTable: built.offTable } : {}) }, signature: signatures[0] };
  }

  /**
   * A VERIFIED BATCH, KEPT BY ITS TXID (kanban #1170): always kept; it becomes the one the scope stands on only through namedBatchStep - never in place
   * of the batch a SUBMITTING or ACCEPTED row names. Answers { standing, why }.
   */
  #keepBatch(roundIdBytes, opts, m, built, signers, signatures) {
    if (!this.round.putNamedBatch) return { standing: false, why: 'this store keeps no batch' };
    const sc = this.#scopeOf(opts);
    const standing = this.round.namedBatch ? this.round.namedBatch(roundIdBytes, sc) : null;
    const st = namedBatchStep(standing, { txid: built.txid }, this.#scopeRow(roundIdBytes, opts));
    if (!st.ok) console.log(`#1170 [settle] ${toHex(roundIdBytes).slice(0, 16)}${sc ? ` ${sc.slice(0, 8)}` : ''} batch ${String(built.txid).slice(0, 12)} of S ${signers.join(',')} kept, not standing: ${st.why}`);
    this.round.putNamedBatch({ roundId: roundIdBytes, scope: sc, bodyId: m.bodyId, txid: built.txid, signers, signatures, standing: st.ok,
      slots: built.slots.map((s, k) => ({ kind: s.kind, outIdx: s.outIdx === undefined ? null : s.outIdx, paymentHash: s.paymentHash || null,
        message: toHex(built.messages[k]), ...(s.kind === 'refund' ? built.refunds.find((r) => r.outIdx === s.outIdx) : {}) })) });
    return { standing: st.ok, why: st.why };
  }

  /** The settlement row of a scope: the round's own, a late entry's, a federation's. */
  #scopeRow(roundIdBytes, { entry = null, federation = null } = {}) {
    if (federation) return this.round.fedLockSettlement ? this.round.fedLockSettlement(roundIdBytes, federation) : null;
    if (entry) return this.round.lateLockSettlement ? this.round.lateLockSettlement(roundIdBytes, entry) : null;
    return this.round.lockSettlement ? this.round.lockSettlement(roundIdBytes) : null;
  }

  /**
   * THE BATCH A PROTOCOL-27 SCOPE'S SENDS AND REFUNDS (c) READ (kanban #1170): the one of the txid its row is SUBMITTING or ACCEPTED on - and none if
   * this seat keeps no batch of that txid - else the standing one. Never another signer set's batch over the same body.
   */
  batchFor(roundIdBytes, { entry = null, federation = null } = {}) {
    const sc = this.#scopeOf({ entry, federation });
    const row = this.#scopeRow(roundIdBytes, { entry, federation });
    if (row && (row.state === SUBMITTING || row.state === ACCEPTED)) {
      const b = this.round.namedBatchOf ? this.round.namedBatchOf(roundIdBytes, sc, row.txid) : this.round.namedBatch ? this.round.namedBatch(roundIdBytes, sc) : null;
      return b && b.txid === String(row.txid) ? b : null;
    }
    return this.round.namedBatch ? this.round.namedBatch(roundIdBytes, sc) : null;
  }

  /** The row moved onto `txid`: the scope stands on that txid's batch, if one is kept (kanban #1170). */
  #standBatch(roundIdBytes, opts, txid) {
    if (!this.round.standNamedBatch) return;
    const sc = this.#scopeOf(opts);
    const cur = this.round.namedBatch ? this.round.namedBatch(roundIdBytes, sc) : null;
    if (cur && cur.txid === String(txid)) return;
    if (this.round.standNamedBatch(roundIdBytes, sc, txid)) console.log(`#1170 [settle] ${toHex(roundIdBytes).slice(0, 16)}${sc ? ` ${sc.slice(0, 8)}` : ''} stands on batch ${String(txid).slice(0, 12)}${cur ? `, not ${cur.txid.slice(0, 12)}` : ''}`);
  }

  /** A batch handed over by the asker: kept only if every signature verifies under KeyAgg(S) over the message THIS seat rebuilds for that S. */
  async #takeNamed(roundIdBytes, m, bytes, opts) {
    let got;
    try { got = decodeNamedBatch(bytes); } catch (e) { return refuse(`no batch: ${e.message}`, 400); }
    const built = await this.#namedMessages(roundIdBytes, m, got.signers, opts);
    if (!built.ok) return built;
    if (got.signatures.length !== built.messages.length) return refuse(`the batch carries ${got.signatures.length} signatures and this seat's body signs ${built.messages.length}`);
    const key = built.refundKey.subarray(1);
    const bad = got.signatures.findIndex((sig, k) => !verifyAck(sig, built.messages[k], key));
    if (bad >= 0) return refuse(`signature ${bad} of the batch (${built.slots[bad].kind}) does not verify under the signer set's key`);
    const kept = this.#keepBatch(roundIdBytes, opts, m, built, got.signers, got.signatures);
    return { ok: true, standing: kept.standing, frozen: kept.standing ? null : kept.why,
      m: { ...m, txid: built.txid, message: built.message, signers: got.signers, refundKey: built.refundKey }, signature: got.signatures[0] };
  }

  /** A seat asked about another transaction or another table than it rebuilt: the round is read again for a false table (fileTableProofs). */
  #suspect(roundIdBytes) { if (this.round.markSettlementSuspect) this.round.markSettlementSuspect(roundIdBytes); }

  /**
   * CLAIMING ON DISK BEFORE THIS SEAT'S WORD ON A SETTLEMENT LEAVES IT (kanban #1184): every lock the settlement claims is checked first - one this
   * seat forfeited back to its player (RETURNING) refuses the ack, share or take by name - then each is written CLAIMING (forfeit.js LOCK_FATE), so
   * a later ENTRY_VOID or qualifier rule at this seat signs no forfeit of the same lock. { ok } or a refusal.
   */
  #claiming(roundIdBytes, m, step) {
    const outpoints = (m.claims || []).map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`);
    for (const o of outpoints) {
      const st = lockFateStep(lockFateOf(this.round, roundIdBytes, o), LOCK_FATE.CLAIMING);
      if (!st.ok) return refuse(`lock ${o.slice(0, 16)}: ${st.why}`);
    }
    for (const o of outpoints) {
      const w = markLockFate(this.round, { roundId: roundIdBytes, outpoint: o, state: LOCK_FATE.CLAIMING, txid: m.txid, why: step });
      if (!w.ok) return refuse(`lock ${o.slice(0, 16)}: ${w.why}`);
    }
    return { ok: true };
  }

  /** This seat's SettlementAck over the table it computed and the transaction it rebuilt, signed by its node key (§5A.3, kanban #1035). */
  #ownAck(roundIdBytes, m) {
    return signSettlementAck({ roundId: roundIdBytes, payoutTableId: settlementTableId(m.ackTable), ...(m.named ? { settlementBodyId: fromHex(m.txid) } : { settlementTxid: fromHex(m.txid) }) },
      this.round.pubkey, (digest) => schnorr.sign(digest, this.round.identity.secret));
  }

  #countAcks(roundIdBytes, m, acks) {
    return countAcks({ acks, seats: m.contract.nodes, slots: m.contract.settlementSlots, roundId: roundIdBytes, payoutTableId: settlementTableId(m.ackTable),
      ...(m.named ? { settlementBodyId: fromHex(m.txid) } : { settlementTxid: fromHex(m.txid) }), verify: verifyAck });
  }

  /**
   * A PEER'S ACK REFUSED OVER A GONE LOCK OR ANOTHER REBUILD (kanban #1044 hole 1, ruling #1146 A). Measured 2026-11-06 on s47a, round a0620247: three seats
   * silent in the settlement (settle-hold) until the loser refunded its locks at expiry, then back. The three built afresh, met the gone lock and rebuilt
   * on F′; the four that had built F during the stall reused that build (byPlan) - they never met the gone lock themselves, and each refused the other's
   * bytes ("rebuilt settlement 260b6a9d…, not 2b769470…"), 3 against 4, neither 5. So a peer that refuses this seat's ack naming a lock the guardians do
   * not hold, or bytes it rebuilt otherwise, drops this seat's build of the round: its next plan reads the losers' locks at the federation (one read; F′
   * leaves out only a lock the federation really does not hold, so a peer saying so falsely costs that read and nothing else). Answers whether it did.
   */
  peerSaysGone(roundIdBytes, whys) {
    if (!(whys || []).some((w) => NO_LOCK_HELD.test(String(w)) || /rebuilt settlement [0-9a-f]+, not [0-9a-f]+/.test(String(w)))) return false;
    const k = toHex(roundIdBytes);
    if (!this.#suspectGone.has(k)) console.log(`#1044 [settle] ${k.slice(0, 16)}: a peer refused the ack over a gone lock or another rebuild - its losers' locks are read at the federation next`);
    this.#suspectGone.add(k);
    this.built.delete(k);
    this.byPlan.delete(k);
    this.#dropFedBuilds(roundIdBytes);
    return true;
  }

  /** Every federation's build of a round dropped (kanban #1172: a gone lock reaches `k:fed:*` as it reaches `k`). */
  #dropFedBuilds(roundIdBytes) {
    const prefix = `${toHex(roundIdBytes)}:fed:`;
    for (const key of [...this.built.keys()]) if (key.startsWith(prefix)) this.built.delete(key);
  }

  /** THE ACK DOOR: this seat's word, only on the bytes it rebuilt itself. Signed before it joins the FROST signing. */
  async ack(roundIdBytes, { txid = null, entry = null, federation = null } = {}) {
    const m = await this.#askedMessage(roundIdBytes, { txid, entry, federation });
    if (!m.ok) return m;
    if (!acksSettlement(m.contract)) return refuse('that round settles with no acks: its version is older than the ack');
    { const c = this.#claiming(roundIdBytes, m, 'acked at the door'); if (!c.ok) return c; }
    return { ok: true, bytes: this.#ownAck(roundIdBytes, m) };
  }

  /**
   * THE ASKER'S ACKS, before anyone commits (§5A.3, RULED 2026-11-02, kanban #1035): this seat's own and each peer's, and only a threshold
   * of verified acks by the round's seats over this table and this transaction goes on. The acks travel with the commit, each seat checks
   * them for itself (`commit`) and each keeps them, so they are published with the settlement. No acks for an older round.
   */
  async #gatherAcks(roundIdBytes, m, query, scope = null) {
    if (!acksSettlement(m.contract)) return { ok: true };
    { const c = this.#claiming(roundIdBytes, m, 'acked as the asker'); if (!c.ok) return c; }
    const acks = [this.#ownAck(roundIdBytes, m)];
    const refused = [], refusedBy = [];
    // EVERY PEER AT ONCE, AND A THRESHOLD GOES ON (kanban #1061): a hung seat costs the grace, and the acks carried on are whoever answered, in the peers' order
    const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
      const r = await this.fetcher(`${base}/settle-ack?${query}&txid=${m.txid}`, { method: 'POST', signal });
      if (!r.ok) return { why: (await r.text()).trim(), byName: refusedByName(r) };
      return { ack: new Uint8Array(await r.arrayBuffer()) };
    }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: receiptsNeeded(m.contract.settlementSlots) - 1, counts: (x) => !!x.ack });
    for (const { peer: base, value, error } of asked) {
      if (value && value.ack) { acks.push(value.ack); continue; }
      refused.push(`${base}: ${value ? value.why : error.message}`);
      if (value && value.byName) refusedBy.push(base);
    }
    const counted = this.#countAcks(roundIdBytes, m, acks);
    if (!counted.final) {
      if (scope !== null) this.#stoppedAt(roundIdBytes, m.contract, scope, 'ack', counted.kept.map((k) => splitSignedAck(k).nodePubkey), refusedBy);
      this.peerSaysGone(roundIdBytes, refused);
      return { ...refuse(`${counted.agreed} of the ${counted.needed} signer nodes the settlement needs acked it: ${[...refused, ...counted.refused].join('; ')}`), refused };
    }
    return { ok: true, acks: joinAcks(counted.kept) };
  }

  /**
   * FILE A PROOF OF EACH FALSE TABLE THIS SEAT CAN SHOW (§5A.3 table row, kanban #1040, #1043): the acks and tables this seat kept and every peer publishes at GET
   * /settlement-acks, each pair not this seat's own judged by slashHoldsOnTable on the bytes a stranger would hold, the txid rebuilt by this seat's stock client, and
   * only a pair that slashes filed: one proof per seat that acked it, kept once by proof id, listed at GET /slashes `tableSlashes`, served at GET /table-slash-proofs and
   * posted to the round's relays. `advertOf(hex)` -> the accused's advertisement; a seat whose advertisement is not held yet stays for the next pass. Money is not touched.
   */
  async fileTableProofs(roundIdBytes, { advertOf = () => null, relays = [] } = {}) {
    const report = { filed: [], refused: [], published: 0 };
    const row = this.round.get(roundIdBytes);
    if (!row) { report.refused.push('no such round'); return report; }
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    if (!acksSettlement(contract)) return report;
    const namedRound = namedClaims(contract);
    const committee = this.round.signerNodes(roundIdBytes);
    const pairKey = (x) => `${toHex(x.tableId)}:${String(x.txid).toLowerCase()}`;
    const own = this.round.settlementAcksOf(roundIdBytes);
    const mine = new Set(own.map(pairKey));
    const pairs = new Map(own.map((r) => [pairKey(r), r]));
    const read = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
      const r = await this.fetcher(`${base}/settlement-acks?round=${toHex(roundIdBytes)}`, { signal });
      return r.ok ? r.json() : null;
    }, { boundMs: this.peerReadMs });
    for (const { peer: base, value, error } of read) {
      if (error) { report.refused.push(`${base}: ${error.message}`); continue; }
      try {
        for (const x of (value && value.settlements) || []) {
          const got = { scope: x.scope, txid: String(x.txid), tableId: fromHex(x.payoutTableId), table: fromHex(x.table), acks: fromHex(x.acks) };
          const had = pairs.get(pairKey(got));
          if (!had || had.acks.length < got.acks.length) pairs.set(pairKey(got), got);
        }
      } catch (e) { report.refused.push(`${base}: ${e.message}`); }
    }
    const found = pluginForRound(contract, this.round.plugins || []);
    const manifest = found && found.ok ? found.plugin.manifest : null;
    const byId = new Map(this.round.entriesOf(roundIdBytes).map((x) => [toHex(x.entryId), x]));
    const fees = new Map();
    const feesFrom = async (fid) => {
      if (!fees.has(fid)) { try { fees.set(fid, await (await this.portForFederation(fid)).fees()); } catch { fees.set(fid, null); } }
      return fees.get(fid);
    };
    for (const [key, pair] of pairs) {
      // A PAIR IS READ ONCE (NODE-OPT-1648's lesson: a rebuild is a stock-client run on the seat's own client directory), unless a seat's advertisement was missing
      if (mine.has(key) || this.#pairsRead.has(key)) continue;
      let table;
      try {
        table = decodeSettlementTable(pair.table);
        if (toHex(settlementTableId(table)) !== toHex(pair.tableId) || toHex(table.roundId) !== toHex(roundIdBytes)) continue;
      } catch { continue; }
      const { entries, finals, preimages } = await this.#tableShown(roundIdBytes, contract, table, byId, report);
      const federationIds = new Set(takesAnyFederation(contract) ? entries.map((e) => toHex(e.federationId || new Uint8Array(32))) : [toHex(contract.federationId)]);
      for (const fid of federationIds) await feesFrom(fid);
      const home = toHex(table.federationId).match(/[^0]/) ? toHex(table.federationId) : toHex(contract.federationId);
      const built = tableBuild({ table, entries: new Map(entries.map((e) => [toHex(entryIdOf(e)), e])), preimages: new Map(preimages.map((p) => [toHex(p.entryId), p.preimage])), pointOf: (x) => this.curve.pointFromScalar(x) });
      let rebuiltTxid = null;
      if (built.ok) {
        // A PROTOCOL-27 ROUND'S ACKS NAME THE BODY (ruling #1135 2): rebuilt by this seat's own tool without signers, compared on the body id
        try {
          const port = await this.portForFederation(home);
          rebuiltTxid = namedRound ? fromHex((await port.arenaSettle({ claims: built.build.claims, payouts: built.build.payouts, nonce: built.build.nonce })).bodyId)
            : fromHex((await port.settle(built.build)).txid);
        } catch (e) { report.refused.push(`no rebuild: ${e.message}`); }
      } else report.refused.push(`no rebuild: ${built.why}`);
      // A TABLE MARKED LATE IS CHECKED AGAINST THE ROUND'S OWN
      const first = [...pairs.values()].find((x) => { try { return toHex(decodeSettlementTable(x.table).lateEntryId) === '00'.repeat(32) && toHex(table.lateEntryId) !== '00'.repeat(32); } catch { return false; } });
      const ownTable = first ? { table: first.table, acks: splitAcks(first.acks) } : null;
      const acks = splitAcks(pair.acks);
      let waits = false;
      for (const signedAck of acks) {
        let got;
        try { got = splitSignedAck(signedAck); } catch { continue; }
        const who = toHex(got.nodePubkey);
        const advert = advertOf(who);
        if (!advert) { waits = true; report.refused.push(`${who.slice(0, 16)}: no advertisement names its bond`); continue; }
        const signedAs = namedRound ? { roundId: got.ack.roundId, payoutTableId: got.ack.payoutTableId, settlementBodyId: got.ack.settlementTxid } : got.ack;
        const proof = { roundId: roundIdBytes, playerPubkey: new Uint8Array(32), nodePubkey: got.nodePubkey, transcriptHash: got.ack.payoutTableId, signedResultId: settlementAckId(signedAs),
          bondTxid: advert.bondTxid, bondVout: advert.bondVout };
        const check = slashHoldsOnTable({ proof, signedAck, acks, table: pair.table, entries, finals, contract, manifest, advert, committee, verify: verifyAck, rebuiltTxid, feesOf: (f) => fees.get(f) || null, own: ownTable });
        if (!check.slashed) { report.refused.push(`${who.slice(0, 16)}: ${check.why}`); continue; }
        const record = joinTableSlashEvidence(encodeSlashProof(proof), { signedAck, acks, table: pair.table, entries, preimages, finals, own: ownTable });
        const { id, bytes: complete } = this.round.fraudProof(roundIdBytes, null, record);
        if (!this.round.fileTableProof(roundIdBytes, got.nodePubkey, id, record)) continue;
        report.filed.push(who);
        console.log(`[slash] ${toHex(roundIdBytes).slice(0, 16)} filed TABLE_IS_NOT_F against ${who.slice(0, 16)}: ${check.why}`);
        const put = await askPeers(relays, (relay, signal) => this.fetcher(`${String(relay).replace(/\/+$/, '')}/slash/${toHex(id)}`, { method: 'PUT', body: complete, signal }), { boundMs: this.peerReadMs });
        for (const { peer: relay, value, error } of put) {
          if (error) report.refused.push(`${relay}: ${error.message}`);
          else if (value.ok) report.published += 1;
          else report.refused.push(`${relay}: kept no proof (${value.status})`);
        }
      }
      if (!waits) { this.#pairsRead.add(key); if (this.#pairsRead.size > 4096) this.#pairsRead.delete(this.#pairsRead.values().next().value); }
    }
    return report;
  }
  #pairsRead = new Set();

  /** What shows a table as the table row reads it: the Entry Contracts it names, this seat's own signed result with the FINAL records of each, and each loser's P. */
  async #tableShown(roundIdBytes, contract, table, byId, report) {
    const named = [...new Set([...table.rows.map((r) => toHex(r.entryId)), ...table.claims.map((c) => toHex(c.entryId))])].filter((id) => byId.has(id));
    const entries = named.map((id) => byId.get(id).entry);
    const finals = [];
    const preimages = [];
    for (const id of named) {
      const eid = fromHex(id);
      const held = this.round.results(roundIdBytes, eid).find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
      const body = held ? decodePlayerResult(splitSignedResult(held.bytes).body) : null;
      if (held) finals.push({ entry: byId.get(id).entry, signedResult: new Uint8Array(held.bytes), finalSigs: this.round.entryFinalSigs(roundIdBytes, eid).map((b) => new Uint8Array(b)) });
      // NEVER A QUALIFIER'S P: a table naming a winner's lock is false without it, and the opening is a thing a winner's stake must never see
      if (!table.claims.some((c) => c.kind === 'stake' && toHex(c.entryId) === id) || (body && body.outcome === 'DELIVERED')) continue;
      const opened = await this.stakeSecrets.open({ roundId: roundIdBytes, entryId: eid, needed: receiptsNeeded(contract.settlementSlots) }).catch((e) => ({ ok: false, why: e.message }));
      if (opened.ok) preimages.push({ entryId: eid, preimage: opened.preimage });
      else report.refused.push(`${id.slice(0, 16)}: ${opened.why}`);
    }
    return { entries, finals, preimages };
  }

  /**
   * WHERE THIS ROUND'S LOCKS CAN FIRST BE FUNDED (kanban #1044 B1): each federation's finished-session count, read when the seat takes the round in -
   * before any lock of it exists - and kept; a named claim's proof carries that federation's sessions from there.
   */
  async noteFundingFloor(roundIdBytes, contract) {
    if (!namedClaims(contract) || !this.round.keepFundingSessionFloor) return [];
    // (a round that takes any federation names no federation before its entries do: no floor is kept for it yet, and its claims are not filed on)
    const fids = takesAnyFederation(contract) ? [] : [toHex(contract.federationId)];
    const kept = [];
    for (const fid of fids) {
      if (this.round.fundingSessionFloor(roundIdBytes, fid) !== null) continue;
      try {
        const port = await this.portForFederation(fid);
        if (!port || typeof port.sessionCount !== 'function') continue;
        this.round.keepFundingSessionFloor(roundIdBytes, fid, await port.sessionCount());
        kept.push(fid);
      } catch { /* read again on the next round in; the filer then reads nothing for it */ }
    }
    return kept;
  }

  /**
   * FILE A PROOF OF EACH NAMED CLAIM'S OFFENCE THIS SEAT CAN SHOW (§5A.3 rows (a), (b), protocol 27, kanban #1044 B1, rulings #1131 4, #1135 2). Per federation the
   * round settles in: the federation's signed sessions from the round's funding floor, read OFFLINE by the stake-lock tool (arena-claim-read).
   *  (a) offTableClaims against the bodies THIS seat acked, judging only claims that spend a lock its own bodies claim: each other body is filed with
   *      the acked table and what shows it (entries, FINALs, losers' P) - a table this seat cannot show to be exactly F builds no proof, and the
   *      judge would refuse one;
   *  (b) forfeitsOfLostEntries against the signed results this seat holds: a seat that signed an entry non-qualifying and is named on its lock's forfeit.
   * One proof per named signer, kept once by id (named_claim_proofs, listed among the held proofs slash-start-run files), posted to the round's relays.
   * Never against this seat itself. `advertOf(hex)` -> the accused's advertisement. Money is not touched.
   */
  async fileNamedClaimProofs(roundIdBytes, { advertOf = () => null, relays = [] } = {}) {
    const report = { filed: [], refused: [], published: 0 };
    const row = this.round.get(roundIdBytes);
    if (!row) { report.refused.push('no such round'); return report; }
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    if (!namedClaims(contract)) return report;
    const rid = toHex(roundIdBytes);
    const me = toHex(this.round.pubkey);
    const own = this.round.settlementAcksOf(roundIdBytes).map((x) => { try { return { ...x, decoded: decodeSettlementTable(x.table) }; } catch { return null; } }).filter(Boolean);
    const byId = new Map(this.round.entriesOf(roundIdBytes).map((x) => [toHex(x.entryId), x]));
    const found = pluginForRound(contract, this.round.plugins || []);
    const manifest = found && found.ok ? found.plugin.manifest : null;
    const lockOf = new Map();
    for (const [id, x] of byId) for (const o of [x.entry.stakeLockOutpoint, x.entry.feeLockOutpoint]) { const t = namedOutpointText(o); if (t) lockOf.set(t, id); }
    const homeOf = (t) => (t.federationId && t.federationId.some((b) => b) ? toHex(t.federationId) : toHex(contract.federationId));
    const fids = new Set([toHex(contract.federationId), ...own.map((x) => homeOf(x.decoded)), ...[...byId.values()].map((x) => { const f = entryFederation(contract, x.entry); return f.ok ? toHex(f.federationId) : null; }).filter(Boolean)]);
    for (const fid of fids) {
      const floor = this.round.fundingSessionFloor ? this.round.fundingSessionFloor(roundIdBytes, fid) : null;
      if (floor === null) { report.refused.push(`${fid.slice(0, 16)}: no funding-session floor kept for this round`); continue; }
      let port, ex, read;
      try {
        port = await this.portForFederation(fid);
        // NO SESSION FINISHED SINCE THE BOUND: nothing to read yet (the tool refuses an empty range), asked again on the next pass. AND NONE SINCE THIS
        // SEAT'S LAST READ OF THE ROUND: the same sessions are not exported again (measured 2026-11-05: every pass re-exported every round's sessions)
        if (typeof port.sessionCount === 'function') {
          const count = Number(await port.sessionCount());
          if (count <= floor) { report.refused.push(`${fid.slice(0, 16)}: no session finished since the bound ${floor} yet`); continue; }
          const readKey = `${rid}:${fid}`;
          if (this.#namedReadAt.get(readKey) === count) { report.refused.push(`${fid.slice(0, 16)}: no session finished since the last read (${count})`); continue; }
          this.#namedReadAt.set(readKey, count);
          if (this.#namedReadAt.size > 4096) this.#namedReadAt.delete(this.#namedReadAt.keys().next().value);
        }
        // FROM THE BOUND, NEVER SEARCHING (ruling #1139 B): the bound is the funding session the seat found when it verified the lock. A spend of
        // this round's lock whose funding lies below it names no keys and is not judged - nothing is held against a seat for it
        // ON THE SEAT'S ONE SESSION LANE (stake-lock-signer-node.js inSessionLane): never beside a funding search or another read
        ({ ex, read } = await inSessionLane(async () => {
          const e = await port.sessionExport({ from: floor });
          return { ex: e, read: await port.arenaClaimRead(claimReadInput({ config: e.config, firstSession: e.firstSession, sessions: e.sessions, roundId: roundIdBytes })) };
        }));
        const unfunded = read ? (read.spends || []).filter((sp) => !sp.lock && lockOf.has(String(sp.outpoint).toLowerCase())) : [];
        for (const sp of unfunded) report.refused.push(`${fid.slice(0, 16)}: lock ${String(sp.outpoint).slice(0, 20)} was funded below the bound ${floor}: unread`);
      } catch (e) { report.refused.push(`${fid.slice(0, 16)}: the sessions were not read: ${e.message}`); continue; }
      if (!read) { report.refused.push(`${fid.slice(0, 16)}: no claim reader (arena-claim-read) here`); continue; }
      if (read.unverified && read.unverified.length) { report.refused.push(`${fid.slice(0, 16)}: sessions ${read.unverified.join(', ')} do not verify`); continue; }
      const sessions = { row: 0, config: ex.config, firstSession: ex.firstSession, sessions: ex.sessions };
      const filings = [];
      // ROW (a): the bodies this seat acked in this federation, and the claims spending their locks
      const mine = own.filter((x) => homeOf(x.decoded) === fid);
      const claimedBy = new Map();
      for (const x of mine) for (const c of x.decoded.claims) claimedBy.set(`${toHex(c.outpoint.txid)}:${String(c.outpoint.outIdx)}`, x);
      const spendsOfMine = (read.spends || []).filter((sp) => sp.kind === 'claim' && claimedBy.has(String(sp.outpoint).toLowerCase()));
      for (const off of offTableClaims({ spends: spendsOfMine, roundId: rid, correctBodyIds: mine.map((x) => x.txid) })) {
        const pair = claimedBy.get(String(spendsOfMine.find((sp) => String(sp.txid).toLowerCase() === off.txid).outpoint).toLowerCase());
        const shown = await this.#tableShown(roundIdBytes, contract, pair.decoded, byId, report);
        for (const who of off.offenders) filings.push({ row: NAMED_ROW_OFF_TABLE, who, txid: off.txid, why: off.why, parts: { ...sessions, row: NAMED_ROW_OFF_TABLE, table: pair.table, ...shown }, tableId: pair.tableId });
      }
      // ROW (b): each forfeit of a lock whose entry a named signer signed non-qualifying, by the signed results this seat holds
      const lostSigned = new Map();
      for (const id of byId.keys()) {
        for (const r of this.round.results(roundIdBytes, fromHex(id))) {
          let body; try { body = decodePlayerResult(splitSignedResult(r.bytes).body); } catch { continue; }
          if (body.outcome === VOID || isQualifier(body, contract.minScore)) continue;
          lostSigned.set(`${id}:${toHex(r.nodePubkey)}`, new Uint8Array(r.bytes));
        }
      }
      const forfeits = forfeitsOfLostEntries({ spends: read.spends || [], entryOf: (o) => lockOf.get(String(o).toLowerCase()) || null,
        lostBy: (eid) => [...lostSigned.keys()].filter((k) => k.startsWith(`${eid}:`)).map((k) => k.slice(eid.length + 1)) });
      // ROW (a) AT LEVEL 2 (rulings #1138 2, #1140): EVERY claim of the round's locks, by who it pays - an output to a key the round may not pay, or the
      // node row above the fee locks it claims. Filed beside a level-1 proof of the same claim too: a level-1 judge rebuilds the correct table's body through
      // the federation, which holds no lock the claim spent (measured 2026-11-05, round a8e68cb6: every judge said undefined), and level 2 needs no rebuild
      const payees = this.payeesFor ? await this.payeesFor(contract, roundIdBytes).catch(() => null) : null;
      if (payees) {
        const entries = [...byId.values()].map((x) => x.entry);
        const readNow = [];
        for (const off of unpayableClaims({ spends: read.spends || [], roundId: rid, entries, payees, read: readNow })) {
          for (const who of off.offenders)
            filings.push({ row: NAMED_ROW_PAYEE, who, txid: off.txid, why: off.why, parts: { ...sessions, row: NAMED_ROW_PAYEE, entries } });
        }
        // ONE LINE PER CLAIM READ, once: the gate (#1139) is measured on what honest settlements this seat read at level 2
        for (const x of readNow) {
          const k = `${rid}:${x.txid}`;
          if (this.#level2Said.has(k)) continue;
          this.#level2Said.add(k);
          report.level2 = (report.level2 || []).concat([x]);
          console.log(`[slash] ${rid.slice(0, 16)} level 2 read claim ${x.txid.slice(0, 16)}: ${x.outputs} outputs, ${x.false ? `FALSE: ${x.why}` : 'every payee on the list'}${x.unread.length ? `; unread: ${x.unread.join('; ')}` : ''}`);
        }
      } else report.refused.push(`${fid.slice(0, 16)}: no payees read for the round: level 2 not read`);
      // A FORFEIT THE PROTOCOL ALLOWS (forfeit.js lostForfeitAllowed: ENTRY_VOID, nobody won) IS NO OFFENCE; one this seat cannot read yet waits for a later pass
      const allowedNow = new Map();
      const allowedOf = (eid) => { if (!allowedNow.has(eid)) allowedNow.set(eid, lostForfeitAllowed(this.round, roundIdBytes, fromHex(eid), { finalityOf: this.finalityOf, settledOf: this.settledOf })); return allowedNow.get(eid); };
      for (const f of forfeits) for (const who of f.offenders) {
        const ok = allowedOf(f.entryId);
        if (ok.allowed !== false) { report.refused.push(`forfeit ${String(f.txid).slice(0, 16)} of entry ${f.entryId.slice(0, 16)}: ${ok.allowed ? `allowed - ${ok.why}` : `not read yet - ${ok.why}`}`); continue; }
        filings.push({ row: NAMED_ROW_FORFEIT, who, txid: f.txid, why: `forfeit of entry ${f.entryId.slice(0, 16)} it signed as lost`,
          parts: { ...sessions, row: NAMED_ROW_FORFEIT, entry: byId.get(f.entryId).entry, signedResult: lostSigned.get(`${f.entryId}:${who}`) }, entry: byId.get(f.entryId).entry });
      }
      // ONE PROOF PER (ACCUSED, ROW, SPEND) (measured 2026-11-05 on s27d: each pass after a new session built the same offence's proof over one session more -
      // a new id - and kept it again, 12 proofs a seat in ten minutes)
      const kept = new Set((this.round.namedClaimProofs ? this.round.namedClaimProofs(roundIdBytes) : []).map((x) => {
        try { return `${toHex(x.nodePubkey)}:${x.row}:${toHex(splitNamedClaimEvidence(x.bytes).proof.signedResultId)}`; } catch { return null; }
      }).filter(Boolean));
      for (const fl of filings) {
        if (fl.who === me) continue;
        if (kept.has(`${fl.who}:${fl.row}:${String(fl.txid).toLowerCase()}`)) continue;
        const advert = advertOf(fl.who);
        if (!advert) { report.refused.push(`${fl.who.slice(0, 16)}: no advertisement names its bond`); continue; }
        const proof = namedClaimProofBody({ row: fl.row, roundId: roundIdBytes, accused: fromHex(fl.who), spendTxid: fl.txid, tableId: fl.tableId || null, entry: fl.entry || null, advert });
        const record = joinNamedClaimEvidence(encodeSlashProof(proof), fl.parts);
        const { id, bytes: complete } = this.round.fraudProof(roundIdBytes, null, record);
        if (!this.round.fileNamedClaimProof(roundIdBytes, fromHex(fl.who), fl.row, id, record)) continue;
        report.filed.push({ who: fl.who, row: fl.row === NAMED_ROW_FORFEIT ? 'b' : fl.row === NAMED_ROW_PAYEE ? 'a2' : 'a', txid: fl.txid, proofId: toHex(id) });
        console.log(`[slash] ${rid.slice(0, 16)} filed ${fl.row === NAMED_ROW_FORFEIT ? 'FORFEIT_OF_LOST_ENTRY' : fl.row === NAMED_ROW_PAYEE ? 'OFF_TABLE_CLAIM (level 2, who is paid)' : 'OFF_TABLE_CLAIM'} against ${fl.who.slice(0, 16)}: ${fl.why} (proof ${toHex(id).slice(0, 16)})`);
        const put = await askPeers(relays, (relay, signal) => this.fetcher(`${String(relay).replace(/\/+$/, '')}/slash/${toHex(id)}`, { method: 'PUT', body: complete, signal }), { boundMs: this.peerReadMs });
        for (const { peer: relay, value, error } of put) {
          if (error) report.refused.push(`${relay}: ${error.message}`);
          else if (value.ok) report.published += 1;
          else report.refused.push(`${relay}: kept no proof (${value.status})`);
        }
      }
    }
    return report;
  }

  /** ROUND ONE: this signer node's nonce commitment for the settlement it would sign; from version 22, only with a threshold of acks. */
  async commit(roundIdBytes, { txid = null, entry = null, federation = null, acks = null, door = false, ask = null } = {}) {
    const m = await this.#askedMessage(roundIdBytes, { txid, entry, federation });
    if (!m.ok) return m;
    // ONLY A SEAT OF THE ROUND ASKS (kanban #1075), before anything is kept or drawn
    const stranger = this.#askRefusal(roundIdBytes, m, { door, ask, entry, federation, step: ASK_COMMIT, payload: acks && acks.length ? acks : null });
    if (stranger) return stranger;
    if (acksSettlement(m.contract)) {
      const counted = this.#countAcks(roundIdBytes, m, splitAcks(acks));
      if (counted.refused.length) this.#suspect(roundIdBytes);
      if (!counted.final) return refuse(`this signer node joins the signing only with acks from ${counted.needed} of the round's seats, and holds ${counted.agreed}${counted.refused.length ? `: ${counted.refused.join('; ')}` : ''}`);
      if (this.round.putSettlementAcks)
        this.round.putSettlementAcks({ roundId: roundIdBytes, scope: federation ? String(federation).toLowerCase() : entry ? toHex(entry) : '', txid: m.txid,
          tableId: settlementTableId(m.ackTable), table: encodeSettlementTable(m.ackTable), acks: joinAcks(counted.kept) });
    }
    const key = federation ? `${toHex(roundIdBytes)}:fed:${String(federation).toLowerCase()}` : entry ? `${toHex(roundIdBytes)}:${toHex(entry)}` : toHex(roundIdBytes);
    if (m.named) return this.#commitNamed(roundIdBytes, m, key);
    let pair = this.pairs.get(key);
    // A PAIR THAT SIGNED A LIST IS SPENT, and a new pair signs the next one (kanban #1061, #1070; a reserve payout's rule too: "a nonce pair signs one list once"): a list that never
    // completed - a seat on it hung after its commitment, or gave no share - otherwise held every seat that gave its share to that one list until it restarted. A list from anyone
    // at the door did the same.
    if (!pair || toHex(pair.message) !== toHex(m.message) || pair.list) {
      const hiding = nonceGenerate340(this.random(32), m.signerNode.share);
      const binding = nonceGenerate340(this.random(32), m.signerNode.share);
      pair = { message: m.message, hiding, binding, list: null, share: null,
        commitment: { id: m.signerNode.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
      this.pairs.set(key, pair);
    }
    if (stallsOut(m.contract)) {
      const word = signSettlementCommit({ roundId: roundIdBytes, settlementTxid: fromHex(m.txid), hiding: pair.commitment.hiding, binding: pair.commitment.binding },
        this.round.pubkey, (digest) => schnorr.sign(digest, this.round.identity.secret));
      return { ok: true, commitment: pair.commitment, word };
    }
    return { ok: true, commitment: pair.commitment };
  }

  /** ROUND TWO: this signer node's signature share over the txid it rebuilt, for ONE commitment list. */
  async share(roundIdBytes, commitments, { entry = null, federation = null, door = false, ask = null, named = null } = {}) {
    const m = federation ? await this.fedMessage(roundIdBytes, federation) : entry ? await this.lateMessage(roundIdBytes, entry) : await this.message(roundIdBytes);
    if (!m.ok) return m;
    if (named !== null && named !== !!m.named) return refuse(m.named ? 'that round is signed by a named signer set (protocol 27): ask with its list' : 'that round is signed by its claim key: a named list is not taken', 400);
    // ONLY A SEAT OF THE ROUND ASKS (kanban #1075): a share spends this seat's nonce pair for the pass, so a stranger's list never reaches it
    const stranger = this.#askRefusal(roundIdBytes, m, { door, ask, entry, federation, step: ASK_SHARE, payload: m.named ? commitments : encodeCommitments(commitments) });
    if (stranger) return stranger;
    // PROTOCOL 27: `commitments` is the signer list's bytes (named-settlement.js encodeNamedList), answered with this seat's partials
    if (m.named) return this.#shareNamed(roundIdBytes, m, commitments, { entry, federation });
    const pair = this.pairs.get(federation ? `${toHex(roundIdBytes)}:fed:${String(federation).toLowerCase()}` : entry ? `${toHex(roundIdBytes)}:${toHex(entry)}` : toHex(roundIdBytes));
    if (!pair || toHex(pair.message) !== toHex(m.message)) return refuse('this signer node committed to no settlement of that round');
    const own = commitments.find((c) => String(c.id) === String(pair.commitment.id));
    if (!own || toHex(own.hiding) !== toHex(pair.commitment.hiding) || toHex(own.binding) !== toHex(pair.commitment.binding))
      return refuse('that list does not carry this signer node\'s own commitment');
    if (commitments.length < m.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${m.needed}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse('this signer node signed that settlement over another list, and keeps no second pair');
    if (pair.share === null) {
      { const c = this.#claiming(roundIdBytes, m, 'a settlement share given'); if (!c.ok) return c; }
      pair.share = signShare340({ id: pair.commitment.id, share: m.signerNode.share, groupPublicKey: m.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message: m.message, commitments, curve: this.curve });
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /** A combined signature handed over by a peer: kept only if it verifies over what THIS signer node rebuilt. */
  async take(roundIdBytes, signature, { entry = null, federation = null, named = null } = {}) {
    let m = federation ? await this.fedMessage(roundIdBytes, federation) : entry ? await this.lateMessage(roundIdBytes, entry) : await this.message(roundIdBytes);
    if (!m.ok) return m;
    if (named !== null && named !== !!m.named) return refuse(m.named ? 'that round is signed by a named signer set (protocol 27): hand its batch' : 'that round is signed by its claim key: a batch is not taken', 400);
    // PROTOCOL 27: `signature` is the whole batch (named-settlement.js encodeNamedBatch), each signature checked over what THIS seat rebuilds for its S
    if (m.named) {
      const n = await this.#takeNamed(roundIdBytes, m, signature, { entry, federation });
      if (!n.ok) return n;
      ({ m, signature } = n);
      // A BATCH OF ANOTHER SIGNER SET OVER THE SAME BODY (kanban #1170): T and T' are both valid, and only one lands. A row SUBMITTING or ACCEPTED on T
      // stays on T - its sends and refunds are T's - and T' is kept with what it moves, so the federation is asked about it too: if T' is the one
      // that lands, the row moves onto it (verified) and the scope stands on its batch then
      const row = this.#scopeRow(roundIdBytes, { entry, federation });
      if (row && (row.state === SUBMITTING || row.state === ACCEPTED) && row.txid !== m.txid) {
        if (federation || entry) this.keepScopedMoves(roundIdBytes, federation ? { federation } : { entry }, m);
        else if (typeof this.round.putSettlementTxid === 'function')
          this.round.putSettlementTxid({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, claims: m.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`), payouts: m.plan.payouts.length });
        if (row.state === SUBMITTING) this.confirmSoon(roundIdBytes);
        return refuse(`this seat's row is ${row.state} on ${String(row.txid).slice(0, 16)}: the batch of ${String(m.txid).slice(0, 16)} (S ${m.signers.join(',')}) is kept beside it, not in its place`, 409);
      }
    } else if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return refuse('that settlement signature does not verify under the round\'s claim key');
    { const c = this.#claiming(roundIdBytes, m, 'a settlement handed and kept'); if (!c.ok) return c; }
    if (federation || entry) {
      // THE SAME RULE AS THE ROUND'S ROW (kanban #1172): a REFUSED row takes a handed signature (the asker signed again); ACCEPTED never moves; the
      // txid kept with what it moves, and the federation asked soon
      const where = federation ? { federation } : { entry };
      const held = this.#scopeRow(roundIdBytes, where);
      this.keepScopedMoves(roundIdBytes, where, m);
      if (!held || held.state === REFUSED || (held.state === SUBMITTING && held.txid !== m.txid))
        this.#putScoped(roundIdBytes, where, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
          why: 'signed by the signer nodes; submitted by the signer node that combined it' });
      if (federation) this.confirmSoon(roundIdBytes);
      return { ok: true };
    }
    // A SIGNATURE OVER THE BYTES THIS SIGNER NODE REBUILDS NOW replaces a SUBMITTING row of other bytes: the proposer
    // re-signs only after the federation answered that the old settlement is not in (measured: after a fee-rule change
    // across a restart, the proposer held ACCEPTED on the new txid and this node SUBMITTING on the old one for good).
    const held = this.round.lockSettlement(roundIdBytes);
    // A REFUSED ROW TAKES A HANDED SIGNATURE TOO (kanban #1171): the asker signed again after its first refusal; ACCEPTED never moves
    if (!held || held.state === REFUSED || (held.state === SUBMITTING && held.txid !== m.txid)) {
      this.keepMoves(roundIdBytes, m);
      this.#putRow(roundIdBytes, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: 'signed by the signer nodes; submitted by the signer node that combined it' });
    }
    // AND IT ASKS THE FEDERATION SOON, not on the minute's sweep (measured: a non-proposer read NONE while the proposer
    // held ACCEPTED): SUBMITTING becomes ACCEPTED when the settlement's payouts are stored.
    this.confirmSoon(roundIdBytes);
    return { ok: true };
  }

  /**
   * WHAT A ROUND THAT TAKES ANY FEDERATION MOVES, OVER ALL ITS FEDERATIONS (2026.0.3 step 6): every claimed lock of every
   * federation's transaction, under the txid "federations", and the whole plan's winners' shares - so a forfeit, a late entry
   * and the return door read one record, as for a round in one federation (keepMoves).
   */
  keepFederationMoves(roundIdBytes, got) {
    if (!got || !got.split || !Array.isArray(got.split.settlements)) return;
    const claims = got.split.settlements.flatMap((s) => s.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`));
    this.round.putLockSettlementMoves({ roundId: roundIdBytes, txid: FEDERATIONS_TXID, claims,
      payouts: got.split.settlements.reduce((t, s) => t + s.payouts.length, 0) });
    if (this.round.putLockSettlementShares) this.round.putLockSettlementShares(roundIdBytes, got.plan.stakeShares || []);
  }

  /** What the signed settlement moves, kept with its intent (W6). */
  keepMoves(roundIdBytes, m) {
    const claims = m.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`);
    this.round.putLockSettlementMoves({ roundId: roundIdBytes, txid: m.txid, claims, payouts: m.plan.payouts.length });
    if (typeof this.round.putSettlementTxid === 'function') this.round.putSettlementTxid({ roundId: roundIdBytes, txid: m.txid, message: m.message, claims, payouts: m.plan.payouts.length });
    // AND WHAT IT PAID EACH WINNER, in the table's order: a late loser's second settlement is split by these (C3b-1).
    if (this.round.putLockSettlementShares) this.round.putLockSettlementShares(roundIdBytes, m.plan.stakeShares || []);
  }

  /**
   * DID THE SETTLEMENT THIS SIGNER NODE SIGNED GO THROUGH? (W6, 2026-09-15). Asked of the
   * federation from what the signer node kept with its intent - never from a rebuild, which a restart
   * may not manage or may make differently. IN: a payout contract of that txid is stored (only
   * that transaction makes one) and none of its claimed locks is still held. OUT: every claimed
   * lock still held and no payout of it stored. Anything else is not decided here - a claimed lock
   * can leave by its own refund after expiry, and a winner can collect its payout.
   */
  async federationSaw(roundIdBytes, kept) {
    let moves = this.round.lockSettlementMoves(roundIdBytes);
    // ANY TXID THIS SEAT SIGNED OR WAS HANDED (kanban #1171): its moves from the history, not only the last one kept
    if ((!moves || moves.txid !== kept.txid) && typeof this.round.settlementTxidsOf === 'function') {
      const h = this.round.settlementTxidsOf(roundIdBytes).find((x) => x.txid === kept.txid);
      moves = h ? { txid: h.txid, claims: h.claims, payouts: h.payouts } : null;
    }
    if (!moves || moves.txid !== kept.txid) return { verdict: 'unknown', why: 'this signer node kept no record of what its settlement moves' };
    if (!this.port || typeof this.port.status !== 'function') return { verdict: 'unknown', why: 'this signer node reaches no federation to ask' };
    const held = async (o) => !!(await (await this.portFor(roundIdBytes)).status(o)).stored;
    const claimsHeld = [];
    for (const c of moves.claims) claimsHeld.push(await held(outpointOf(c)));
    const payoutsHeld = [];
    for (let i = 0; i < moves.payouts; i++) payoutsHeld.push(await held({ txid: fromHex(kept.txid), outIdx: BigInt(i) }));
    const locksGone = claimsHeld.filter((x) => !x).length;
    const paid = payoutsHeld.filter(Boolean).length;
    const seen = `${paid} of ${moves.payouts} payout contract(s) of ${kept.txid.slice(0, 12)} stored, ${locksGone} of ${moves.claims.length} claimed lock(s) gone`;
    if (paid > 0 && locksGone === moves.claims.length) return { verdict: 'in', why: seen };
    // A SENT WINNING IS NOT STORED ONCE IT IS PAID: the gateway claims its contract (measured: every look read "0 of 1
    // payout contract(s) stored" after the winner was paid). A PAID ROW IS NO PROOF THE CONTRACT WAS MADE (kanban #1185): the payee holds its
    // invoice's preimage from the start, and a settlement that never landed, whose claimed locks refunded at expiry, read "every lock gone + a paid
    // send" and went ACCEPTED - forfeits gated on ACCEPTED then moved on false moves. The proof is the gateway's claim of one of this txid's
    // outgoing contracts, read from the federation (port.sendClaimed: the preimage the guardians stored when the gateway claimed that outpoint -
    // there is none for an outpoint no landed transaction made). A port that cannot read it leaves the row where it is ('mixed').
    if (paid === 0 && locksGone === moves.claims.length && this.winnings) {
      const paidSends = this.round.sendAttemptsOf(roundIdBytes).filter((r) => r.state === 'PAID' && r.preimage);
      if (paidSends.length) {
        const port = await this.portFor(roundIdBytes);
        if (!port || typeof port.sendClaimed !== 'function')
          return { verdict: 'mixed', why: `${seen}; ${paidSends.length} send(s) of this round PAID here, and this seat reads no gateway claim at the federation to tell it landed` };
        for (let i = 0; i < moves.payouts; i++) {
          const c = await port.sendClaimed({ txid: fromHex(kept.txid), outIdx: BigInt(i) }).catch(() => null);
          if (c && c.claimed) return { verdict: 'in', why: `${seen}; the gateway's claim of ${kept.txid.slice(0, 12)}:${i} is held by the federation` };
        }
        return { verdict: 'mixed', why: `${seen}; ${paidSends.length} send(s) PAID here, and the federation holds no gateway claim of a contract of ${kept.txid.slice(0, 12)}` };
      }
    }
    if (paid === 0 && locksGone === 0) return { verdict: 'out', why: seen };
    return { verdict: 'mixed', why: seen };
  }

  /** THE ONE WRITER OF THE ROUND'S SETTLEMENT ROW (kanban #1171): through settlementRowStep, the txid kept in the history. False when the step is refused. */
  #putRow(roundIdBytes, next) {
    const held = this.round.lockSettlement(roundIdBytes);
    const st = settlementRowStep(held, next);
    if (!st.ok) { console.log(`#1171 [settle] ${toHex(roundIdBytes).slice(0, 16)} row not moved: ${st.why} (${held ? `${held.state} ${String(held.txid).slice(0, 12)}` : 'none'} -> ${next.state} ${String(next.txid).slice(0, 12)})`); return false; }
    this.round.putLockSettlement({ roundId: roundIdBytes, txid: next.txid, message: next.message, signature: next.signature, state: next.state, why: next.why });
    if (typeof this.round.putSettlementTxid === 'function') this.round.putSettlementTxid({ roundId: roundIdBytes, txid: next.txid, message: next.message, signature: next.signature });
    // THE STANDING BATCH FOLLOWS THE ROW (kanban #1170): a protocol-27 row on T stands on T's batch
    if (next.state === SUBMITTING || next.state === ACCEPTED) this.#standBatch(roundIdBytes, {}, next.txid);
    return true;
  }

  /**
   * EVERY TXID THIS SEAT SIGNED OR WAS HANDED, ASKED (kanban #1171): the first the federation holds as in decides. Answers { verdict: 'in' | 'mixed' |
   * 'out', txid, why } - 'mixed' when one of them is neither in nor out (its landing may be under way).
   */
  async #historyVerdict(roundIdBytes) {
    const rows = typeof this.round.settlementTxidsOf === 'function' ? this.round.settlementTxidsOf(roundIdBytes) : [];
    let mixed = null;
    for (const h of rows) {
      let saw;
      try { saw = await this.federationSaw(roundIdBytes, { txid: h.txid }); } catch (e) { saw = { verdict: 'unknown', why: e.message }; }
      if (saw.verdict === 'in') return { verdict: 'in', txid: h.txid, message: h.message, signature: h.signature, why: saw.why };
      if (saw.verdict !== 'out' && !mixed) mixed = { verdict: 'mixed', txid: h.txid, why: saw.why };
    }
    return mixed || { verdict: 'out', why: `${rows.length} txid(s) this seat signed or was handed, none in` };
  }

  // ---- A FEDERATION'S AND A LATE ENTRY'S SETTLEMENT ROWS (kanban #1172): the round's row rule (#1171), per scope ----

  /** A federation's or a late entry's row: its store key, its reads and writes, and the federation port its transaction is in. */
  #rowScope(roundIdBytes, { entry = null, federation = null }) {
    if (federation) {
      const fid = String(federation).toLowerCase();
      return { opts: { federation: fid }, key: `fed:${fid}`, tag: `fed ${fid.slice(0, 8)}`, get: () => this.round.fedLockSettlement(roundIdBytes, fid),
        put: (x) => this.round.putFedLockSettlement({ roundId: roundIdBytes, federation: fid, ...x }), port: () => this.portForFederation(fid) };
    }
    return { opts: { entry }, key: `late:${toHex(entry)}`, tag: `late ${toHex(entry).slice(0, 8)}`, get: () => this.round.lateLockSettlement(roundIdBytes, entry),
      put: (x) => this.round.putLateLockSettlement({ roundId: roundIdBytes, entryId: entry, ...x }), port: () => this.latePort(roundIdBytes, entry) };
  }

  /**
   * THE PORT A LATE LOSER'S SETTLEMENT IS IN (kanban #1172): a round in one federation, that one; a round that takes any federation, the late loser's
   * entry's federation - its lock is there, and the winners' payouts are to keys, the same in every federation. null when it names none reachable.
   */
  async latePort(roundIdBytes, entryIdBytes) {
    const row = this.round.get(roundIdBytes);
    const c = row ? decodeRoundContract(new Uint8Array(row.contract)) : null;
    if (!c || !takesAnyFederation(c)) return this.portFor(roundIdBytes);
    const raw = this.round.entry(entryIdBytes);
    let ef = null;
    try { ef = raw ? entryFederation(c, decodeEntryContract(new Uint8Array(raw))) : null; } catch { ef = null; }
    return ef && ef.ok ? this.portForFederation(toHex(ef.federationId)) : null;
  }

  /** THE ONE WRITER OF A FEDERATION'S OR A LATE ENTRY'S ROW (kanban #1172): through settlementRowStep, as the round's own. False when the step is refused. */
  #putScoped(roundIdBytes, where, next) {
    const sc = this.#rowScope(roundIdBytes, where);
    const held = sc.get();
    const st = settlementRowStep(held, next);
    if (!st.ok) { console.log(`#1172 [settle] ${toHex(roundIdBytes).slice(0, 16)} ${sc.tag} row not moved: ${st.why} (${held ? `${held.state} ${String(held.txid).slice(0, 12)}` : 'none'} -> ${next.state} ${String(next.txid).slice(0, 12)})`); return false; }
    sc.put({ txid: next.txid, message: next.message, signature: next.signature, state: next.state, why: next.why });
    if (this.round.putScopedSettlementTxid) this.round.putScopedSettlementTxid({ roundId: roundIdBytes, scope: sc.key, txid: next.txid, message: next.message, signature: next.signature });
    if (next.state === SUBMITTING || next.state === ACCEPTED) this.#standBatch(roundIdBytes, sc.opts, next.txid);
    return true;
  }

  /** What a federation's or a late entry's transaction moves, kept with its txid (kanban #1172) - before it is submitted, and when it is handed. */
  keepScopedMoves(roundIdBytes, where, m) {
    if (!this.round.putScopedSettlementTxid) return;
    const claims = (m.claims || []).map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`);
    const payouts = (m.settlement ? m.settlement.payouts : m.plan.payouts).length;
    this.round.putScopedSettlementTxid({ roundId: roundIdBytes, scope: this.#rowScope(roundIdBytes, where).key, txid: m.txid, message: m.message, claims, payouts });
  }

  /** DID THIS TXID OF THE SCOPE GO IN (kanban #1172), asked of the scope's own federation, as federationSaw asks for the round's: { verdict, why }. */
  async #scopedSaw(roundIdBytes, where, txid) {
    const sc = this.#rowScope(roundIdBytes, where);
    const moves = (this.round.scopedSettlementTxidsOf ? this.round.scopedSettlementTxidsOf(roundIdBytes, sc.key) : []).find((x) => x.txid === txid);
    if (!moves) return { verdict: 'unknown', why: 'this signer node kept no record of what that transaction moves' };
    const port = await sc.port();
    if (!port || typeof port.status !== 'function') return { verdict: 'unknown', why: `this signer node reaches no federation of ${sc.tag}` };
    const held = async (o) => !!(await port.status(o)).stored;
    let locksGone = 0, paid = 0;
    for (const c of moves.claims) if (!(await held(outpointOf(c)))) locksGone++;
    for (let i = 0; i < moves.payouts; i++) if (await held({ txid: fromHex(txid), outIdx: BigInt(i) })) paid++;
    const seen = `${sc.tag}: ${paid} of ${moves.payouts} payout contract(s) of ${txid.slice(0, 12)} stored, ${locksGone} of ${moves.claims.length} claimed lock(s) gone`;
    if (paid > 0 && locksGone === moves.claims.length) return { verdict: 'in', why: seen };
    if (paid === 0 && locksGone === 0) return { verdict: 'out', why: seen };
    return { verdict: 'mixed', why: seen };
  }

  /** Every txid of the scope this seat signed or was handed, asked (kanban #1172): 'in' (the first in decides), 'mixed', 'out', or 'unknown' (none kept). */
  async #scopedHistoryVerdict(roundIdBytes, where) {
    const sc = this.#rowScope(roundIdBytes, where);
    const rows = this.round.scopedSettlementTxidsOf ? this.round.scopedSettlementTxidsOf(roundIdBytes, sc.key) : [];
    let mixed = null;
    for (const h of rows) {
      let saw;
      try { saw = await this.#scopedSaw(roundIdBytes, where, h.txid); } catch (e) { saw = { verdict: 'unknown', why: e.message }; }
      if (saw.verdict === 'in') return { verdict: 'in', txid: h.txid, message: h.message, signature: h.signature, why: saw.why };
      if (saw.verdict !== 'out' && !mixed) mixed = { verdict: 'mixed', txid: h.txid, why: saw.why };
    }
    return mixed || { verdict: rows.length ? 'out' : 'unknown', why: `${rows.length} txid(s) of ${sc.tag} this seat signed or was handed, none in` };
  }

  /**
   * A FEDERATION'S OR A LATE ENTRY'S ROW, ASKED OF ITS FEDERATION (kanban #1172): a row not ACCEPTED whose txid - or any other this seat signed or was
   * handed - is in becomes ACCEPTED on it. Answers { state, verdict, txid, why }.
   */
  async checkScoped(roundIdBytes, where) {
    const sc = this.#rowScope(roundIdBytes, where);
    const held = sc.get();
    if (!held || held.state === ACCEPTED) return { state: held ? held.state : null, verdict: held ? 'in' : 'unknown', txid: held ? held.txid : null, why: held ? held.why : 'no row' };
    // A ROW KEPT BEFORE ITS TXID HISTORY: what it moves is read from a rebuild of the same txid, as the late row's check did before
    if (this.round.scopedSettlementTxidsOf && !this.round.scopedSettlementTxidsOf(roundIdBytes, sc.key).length) {
      try {
        const m = where.federation ? await this.fedMessage(roundIdBytes, where.federation) : await this.lateMessage(roundIdBytes, where.entry);
        if (m && m.ok && !m.named && m.txid === held.txid) this.keepScopedMoves(roundIdBytes, where, m);
      } catch { /* asked again next pass */ }
    }
    const h = await this.#scopedHistoryVerdict(roundIdBytes, where);
    if (h.verdict === 'in') {
      const why = `found in the federation (${held.state} here before): ${h.why}`;
      this.#putScoped(roundIdBytes, where, { txid: h.txid, message: h.message, signature: h.signature.length ? h.signature : held.signature, state: ACCEPTED, verified: true, why });
      return { state: ACCEPTED, verdict: 'in', txid: h.txid, why };
    }
    return { state: held.state, verdict: h.verdict, txid: held.txid, why: h.why };
  }

  /**
   * WHAT A FEDERATION'S OR A LATE ENTRY'S SUBMIT DECIDES (kanban #1172), as recordSubmit for the round's: ACCEPTED only landed, a pre-validated submit
   * stays SUBMITTING, REFUSED only after every txid of the scope was asked. Answers the state written.
   */
  async recordScopedSubmit(roundIdBytes, where, m, signature, sent, whyAccepted) {
    const stored = Array.isArray(sent.payoutsStored) && sent.payoutsStored.some(Boolean);
    const gone = Array.isArray(sent.locksAfter) && sent.locksAfter.length > 0 && sent.locksAfter.every((x) => !x);
    if (sent.accepted && (sent.landed === true || (sent.landed === undefined && stored && gone))) {
      this.#putScoped(roundIdBytes, where, { txid: m.txid, message: m.message, signature, state: ACCEPTED, why: whyAccepted, verified: true });
      return ACCEPTED;
    }
    if (sent.accepted) {
      this.#putScoped(roundIdBytes, where, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: `the guardians took the submit; not yet seen in (payouts ${stored ? 'stored' : 'not stored'}, claimed locks ${gone ? 'gone' : 'still held'}) - asked again` });
      if (where.federation) this.confirmSoon(roundIdBytes);
      return SUBMITTING;
    }
    const h = await this.#scopedHistoryVerdict(roundIdBytes, where);
    if (h.verdict === 'in') {
      this.#putScoped(roundIdBytes, where, { txid: h.txid, message: h.message, signature: h.signature.length ? h.signature : signature, state: ACCEPTED, verified: true,
        why: `this submit was refused (${sent.error}), and ${h.txid.slice(0, 12)} of the same scope is in: ${h.why}` });
      return ACCEPTED;
    }
    if (h.verdict === 'mixed') {
      this.#putScoped(roundIdBytes, where, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: `the guardians refused it (${sent.error}); ${h.txid.slice(0, 12)} of the same scope is neither in nor out: ${h.why}` });
      if (where.federation) this.confirmSoon(roundIdBytes);
      return SUBMITTING;
    }
    this.#putScoped(roundIdBytes, where, { txid: m.txid, message: m.message, signature, state: REFUSED, checkedAll: true, why: `the guardians refused it: ${sent.error}` });
    return REFUSED;
  }

  /**
   * WHAT A SUBMIT DECIDES (kanban #1171): ACCEPTED only when the guardians hold its payouts stored and its claimed locks gone; a pre-validated submit
   * stays SUBMITTING and the federation is asked again; a refused one is REFUSED only after every txid of the round was asked - one of them may have
   * landed (the other asker's). Answers the state written.
   */
  async recordSubmit(roundIdBytes, m, signature, sent, whyAccepted) {
    const stored = Array.isArray(sent.payoutsStored) && sent.payoutsStored.some(Boolean);
    const gone = Array.isArray(sent.locksAfter) && sent.locksAfter.length > 0 && sent.locksAfter.every((x) => !x);
    if (sent.accepted && (sent.landed === true || (sent.landed === undefined && stored && gone))) {
      this.#putRow(roundIdBytes, { txid: m.txid, message: m.message, signature, state: ACCEPTED, why: whyAccepted, verified: true });
      return ACCEPTED;
    }
    if (sent.accepted) {
      this.#putRow(roundIdBytes, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: `the guardians took the submit; not yet seen in (${sent.landed === false && !Array.isArray(sent.payoutsStored) ? 'the claimed lock not spent yet' : `payouts ${stored ? 'stored' : 'not stored'}, claimed locks ${gone ? 'gone' : 'still held'}`}) - asked again` });
      this.confirmSoon(roundIdBytes);
      return SUBMITTING;
    }
    const h = await this.#historyVerdict(roundIdBytes);
    if (h.verdict === 'in') {
      this.#putRow(roundIdBytes, { txid: h.txid, message: h.message, signature: h.signature, state: ACCEPTED, verified: true,
        why: `this submit was refused (${sent.error}), and ${h.txid.slice(0, 12)} of the same round is in: ${h.why}` });
      return ACCEPTED;
    }
    if (h.verdict === 'mixed') {
      this.#putRow(roundIdBytes, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: `the guardians refused it (${sent.error}); ${h.txid.slice(0, 12)} of the same round is neither in nor out: ${h.why}` });
      this.confirmSoon(roundIdBytes);
      return SUBMITTING;
    }
    this.#putRow(roundIdBytes, { txid: m.txid, message: m.message, signature, state: REFUSED, checkedAll: true, why: `the guardians refused it: ${sent.error}` });
    return REFUSED;
  }

  /**
   * A SIGNER NODE STARTED AGAIN ASKS ABOUT EVERY SETTLEMENT IT WAS INSIDE (W6): each round it holds as
   * SUBMITTING goes through settle(), which asks the federation before anything else. A REFUSED row is asked too (kanban #1171): the other asker's
   * transaction of the same round may have landed - every txid this seat signed or was handed is asked, and one that is in makes the row ACCEPTED.
   */
  async recover() {
    const out = [];
    for (const rid of (this.round.lockSettlementsIn(REFUSED) || [])) {
      const h = await this.#historyVerdict(rid).catch((e) => ({ verdict: 'unknown', why: e.message }));
      if (h.verdict !== 'in') continue;
      this.#putRow(rid, { txid: h.txid, message: h.message, signature: h.signature, state: ACCEPTED, verified: true, why: `found in the federation after a REFUSED row: ${h.why}` });
      out.push({ round: toHex(rid), ok: true, state: ACCEPTED, why: h.why });
    }
    // AND EVERY FEDERATION'S AND LATE ENTRY'S ROW NOT ACCEPTED (kanban #1172): asked of its own federation, every txid this seat signed or was handed
    for (const state of [SUBMITTING, REFUSED]) {
      for (const { roundId: rid, federation } of (this.round.fedLockSettlementsIn ? this.round.fedLockSettlementsIn(state) : [])) {
        const c = await this.checkScoped(rid, { federation }).catch((e) => ({ state, verdict: 'unknown', why: e.message }));
        if (c.state === ACCEPTED || state === SUBMITTING) out.push({ round: toHex(rid), federation, ok: c.state === ACCEPTED, state: c.state, why: c.why });
      }
      for (const { roundId: rid, entryId } of (this.round.lateLockSettlementsIn ? this.round.lateLockSettlementsIn(state) : [])) {
        const c = await this.checkScoped(rid, { entry: entryId }).catch((e) => ({ state, verdict: 'unknown', why: e.message }));
        if (c.state === ACCEPTED || state === SUBMITTING) out.push({ round: toHex(rid), entry: toHex(entryId), ok: c.state === ACCEPTED, state: c.state, why: c.why });
      }
    }
    for (const rid of this.round.lockSettlementsIn(SUBMITTING)) {
      const got = await this.settle(rid).catch((e) => ({ ok: false, why: e.message }));
      out.push({ round: toHex(rid), ok: !!got.ok, state: got.state || (this.round.lockSettlement(rid) || {}).state, why: got.why });
    }
    return out;
  }

  /**
   * A CLOSED LOCK ROUND NOBODY SETTLED IS ASKED AGAIN (kanban #803, measured 2026-11-01 on testnet4): at the close two seats built
   * other bytes than the asker, the asker's one settle ended there, and no other path reaches a round with every run FINAL, no send
   * plan row and no settlement row. Minutes later all six seats built the same bytes; the round sat at NONE until its locks
   * would have run out. Every closed lock round of the last day, once a quarter of an hour has passed, is asked every 5 minutes.
   * NOT BY A 24 H WINDOW AND MEMORY (kanban #1186): with a chain tip, every closed lock round not SETTLED or EXPIRED here, however old; each (round,
   * scope) keeps its tries, the height it is next asked at and its terminal state on disk (settle-retry.js), so a restart forgets no wait.
   * PAST THE TAKEOVER HEIGHT EVERY SEAT IS ON TURN, and two seats combining at once split the peers' one list ("keeps no second pair"),
   * so each takes its own slot of the clock: place k of n asks only in the k-th of n windows of `everyMs`.
   */
  async retryUnsettled({ ageMs = 900000, windowMs = 86400000, everyMs = 300000 } = {}) {
    if (this.#retrying) return [];
    this.#retrying = true;
    const out = [];
    try {
      const now = Number(this.now());
      for (const k of this.#retriedAt.keys()) if (now - this.#retriedAt.get(k).at > windowMs) this.#retriedAt.delete(k);
      // THE CHAIN TIP DECIDES HOW FAR BACK (kanban #1186): with a tip, every closed lock round not SETTLED or EXPIRED here, however old - a round is let
      // go only when its locks are past expiry; without one, the last day as before
      let tip = null;
      try { tip = this.turnClock && this.turnClock.tip ? await this.turnClock.tip() : null; } catch { tip = null; }
      if (!Number.isInteger(tip)) tip = null;
      const persisted = typeof this.round.settleRetry === 'function';
      for (const rid of this.round.closedLockRoundsUnsettled(tip !== null && persisted ? 0 : now - windowMs, now - ageMs)) {
        const k = toHex(rid);
        const row = persisted ? this.round.settleRetry(rid, '') : null;
        if (row && isFinalRetry(row.state)) continue;
        // EVERY LOCK PAST EXPIRY: nothing can be claimed, each lock is its player's again - EXPIRED, never asked again
        const gone = persisted && typeof this.round.lastLockExpiration === 'function' ? locksExpired(this.round.lastLockExpiration(rid), tip) : null;
        if (gone) {
          if (this.#retryMove(rid, row, { state: RETRY.EXPIRED, tries: row ? row.tries : 0, why: `every stake lock of the round is past its expiration at height ${tip}: nothing is claimed, each returns to its player` }))
            out.push({ round: k, ok: false, state: RETRY.EXPIRED, why: 'every stake lock past its expiration: not asked again' });
          continue;
        }
        if (row && row.nextAtHeight !== null && tip !== null && tip < row.nextAtHeight) continue;
        const was = this.#retriedAt.get(k);
        if (was && now - was.at < everyMs) continue;
        const seats = this.round.signerNodes(rid);
        if (!seats.some((s) => toHex(s) === toHex(this.round.pubkey))) continue;
        const t = await this.turn(rid);
        if (!t.mine || Math.floor(now / everyMs) % seats.length !== t.place % seats.length) continue;
        const got = await this.settle(rid).catch((e) => ({ ok: false, why: e.message }));
        const why = String(got.why || '');
        this.#retriedAt.set(k, { at: now, why });
        const settled = got.state === ACCEPTED || (typeof this.round.lockSettlement === 'function' && (this.round.lockSettlement(rid) || {}).state === ACCEPTED);
        const tries = (row ? row.tries : 0) + 1;
        this.#retryMove(rid, row, settled ? { state: RETRY.SETTLED, tries, why: why || 'ACCEPTED' }
          : { state: RETRY.WAITING, tries, nextAtHeight: tip === null ? null : tip + retryBlocks(tries), why: why || 'not settled' });
        if (got.ok || !was || was.why !== why) out.push({ round: k, ok: !!got.ok, state: got.state || null, why });
      }
    } finally { this.#retrying = false; }
    return out;
  }
  #retrying = false;

  /** A retry row moved through settle-retry.js retryStep, compare-and-set on the state it was read in (kanban #1186). True if it moved. */
  #retryMove(rid, row, next) {
    if (typeof this.round.putSettleRetry !== 'function') return true;
    const st = retryStep(row ? row.state : null, next.state);
    if (!st.ok) { console.log(`#1186 [settle] ${toHex(rid).slice(0, 16)} retry not moved: ${st.why}`); return false; }
    return this.round.putSettleRetry({ roundId: rid, scope: '', from: row ? row.state : null, ...next });
  }
  #retriedAt = new Map();   // round id hex -> { at, why } of its last ask (retryUnsettled)

  /**
   * THE SETTLEMENT, made now with the other signer nodes if this signer node holds none: the
   * combined signature checked under the claim key, the intent written, the
   * transaction submitted, and the guardians' answer kept.
   */
  async settle(roundIdBytes) {
    // ONE SETTLE OF A ROUND AT A TIME (measured 2026-10-10 on the regtest Up/Down market: the attested sweep asks
    // every 5 s, a settle of a book round with 26 locks ran longer than that, and the asks piled up - 80 arena-stake-lock
    // processes at once over the one client database, each killed at its timeout, and the round never settled). A second
    // ask while one runs waits for that one's answer instead of starting another.
    const k = toHex(roundIdBytes);
    if (this.#settling.has(k)) return this.#settling.get(k);
    const p = this.#settleOnce(roundIdBytes).finally(() => this.#settling.delete(k));
    this.#settling.set(k, p);
    return p;
  }
  #settling = new Map();
  #cancelsCarried = new Map();   // round id hex -> when its cancels were last pulled (cancelCarryDue)

  async #settleOnce(roundIdBytes) {
    // THE REGTEST FAULT (test-named-offence.js `settle-hold`, off by default): this seat is silent in this round's settlement
    if (settleHoldOn(roundIdBytes)) return refuse('test switch: this seat holds the settlement of this round (settle-hold)', 503);
    { const row = this.round.get(roundIdBytes);
      if (row && takesAnyFederation(decodeRoundContract(new Uint8Array(row.contract)))) return this.#settleFederations(roundIdBytes); }
    const held = this.#attestedHold(roundIdBytes);
    if (held) return held;
    const kept = this.round.lockSettlement(roundIdBytes);
    if (kept && kept.state === ACCEPTED) {
      // WINNINGS ARE ALWAYS SENT, restart or not: a settled round whose winnings are not all PAID is sent now.
      const sent = await this.sendWinnings(roundIdBytes);
      return { ok: true, kept: true, ...kept, sent };
    }
    // A SETTLEMENT THIS SIGNER NODE WAS INSIDE (W6): the federation first. Measured before: a signer node
    // restarted inside one never asked again - its row stayed SUBMITTING whether the money had
    // moved or not.
    if (kept && kept.state === SUBMITTING) {
      let saw = await this.federationSaw(roundIdBytes, kept);
      // ANOTHER TXID OF THE ROUND MAY BE THE ONE THAT LANDED (kanban #1170): a batch of another signer set over the same body, kept beside the row's
      if (saw.verdict !== 'in' && typeof this.round.settlementTxidsOf === 'function' && this.round.settlementTxidsOf(roundIdBytes).some((x) => x.txid !== kept.txid)) {
        const h = await this.#historyVerdict(roundIdBytes);
        if (h.verdict === 'in' && h.txid !== kept.txid) {
          const why = `found in the federation on ${h.txid.slice(0, 12)}, not this row's ${kept.txid.slice(0, 12)}: ${h.why}`;
          this.#putRow(roundIdBytes, { txid: h.txid, message: h.message, signature: h.signature, state: ACCEPTED, why, verified: true });
          await this.indexRecovered(roundIdBytes, h.txid);
          return { ok: true, state: ACCEPTED, why, txid: h.txid, signature: h.signature, recovered: true };
        }
        if (h.verdict === 'mixed' && saw.verdict === 'out') saw = { verdict: 'mixed', why: h.why };
      }
      if (saw.verdict === 'in') {
        const why = `found in the federation after this signer node was inside it: ${saw.why}`;
        this.#putRow(roundIdBytes, { txid: kept.txid, message: kept.message, signature: kept.signature, state: ACCEPTED, why, verified: true });
        // ITS DONATION-KEY OUTPUTS, RESTART OR NOT: from the plan kept in memory, else rebuilt from the store
        // and indexed only when it is the plan that was signed
        await this.indexRecovered(roundIdBytes, kept.txid);
        return { ok: true, state: ACCEPTED, why, txid: kept.txid, signature: kept.signature, recovered: true };
      }
      if (saw.verdict === 'mixed') {
        const why = `neither in nor out - not settled here, not submitted again: ${saw.why}`;
        this.#putRow(roundIdBytes, { txid: kept.txid, message: kept.message, signature: kept.signature, state: SUBMITTING, why });
        // A SIGNER NODE THAT ONLY ANSWERS asks again: it submits nothing, and "neither" is what it reads while the
        // proposer's submit is landing (measured: its one look fell between the claim and the payout).
        if (this.winnings && !(await this.turn(roundIdBytes)).mine) this.confirmSoon(roundIdBytes);
        return refuse(why, 409);
      }
    }
    // ONE SIGNER NODE COMBINES AND SUBMITS AT A TIME: the round's asker, and after it the takeover order of M3.3-19 (seat
    // k once the chain is k x TAKEOVER_BLOCKS past the round's beacon). Measured on a 5-of-7: every node that took the
    // plan combined at once, each peer gives a share over one list only ("keeps no second pair"), and none completed;
    // and a single fixed proposer that saw the run end otherwise stalled the round for good. The others answer, keep
    // the signature they are handed (`take`), and ask the federation whether it went in.
    if (this.winnings) {
      const t = await this.turn(roundIdBytes);
      if (!t.mine) {
        if (kept && kept.state === SUBMITTING) this.confirmSoon(roundIdBytes);
        return refuse(`not this signer node's turn to combine: ${t.why}`, 409, t.code || REFUSAL.NOT_MY_TURN, Number.isInteger(t.takeoverAt) ? { takeoverAt: t.takeoverAt } : {});
      }
    }
    // THE SEND PLANS, before anything is rebuilt: proposed here, checked by every peer, or no settlement. After the
    // federation was asked (W6) - a plan the money already moved on is not re-planned - and before the rebuild, so a
    // kept plan the payout no longer matches is planned again (measured: a fee rule changed across a restart and every
    // rebuild was refused against the old amount).
    if (this.winnings) {
      const planned = await this.planSends(roundIdBytes);
      if (!planned.ok) {
        // A PEER NOT YET READY FOR THE PLAN IS OFFERED IT AGAIN, a second later, a bounded number of times. Measured:
        // a peer whose run was not yet final refused it, then became final and waited for a plan nobody offered again.
        if (planned.peerRefused) this.retryPlan(roundIdBytes, planned.outOfReach ? { most: PLAN_OUT_OF_REACH_OFFERS } : {});
        return planned;
      }
      this.planRetries.delete(toHex(roundIdBytes));
    }
    let m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    // THE KEPT SIGNATURE ONLY OVER THE BYTES IT SIGNED: a plan rebuilt differently is signed afresh.
    let signature = !m.named && kept && kept.signature && kept.txid === m.txid ? kept.signature : null;
    // PROTOCOL 27: THE SIGNER SET'S BATCH (kanban #1044 B1), kept for this body or signed now; `m` becomes the real transaction
    if (m.named) {
      const n = await this.#namedSigned(roundIdBytes, m, `round=${toHex(roundIdBytes)}`, '', {});
      if (!n.ok) return n;
      ({ m, signature } = n);
    } else if (!signature) {
      const q = `round=${toHex(roundIdBytes)}`;
      const held = await this.#gatherAcks(roundIdBytes, m, q, '');
      if (!held.ok) {
        if ((held.refused || []).some((x) => /rebuilt settlement/.test(x))) await this.bookResync(roundIdBytes);
        return held;
      }
      const own = await this.commit(roundIdBytes, { acks: held.acks });
      if (!own.ok) return own;
      const { signers, refused, committed, refusedBy } = await this.#peerCommitments(roundIdBytes, own, q, m, held.acks);
      if (signers.length < m.needed) {
        this.#stoppedAt(roundIdBytes, m.contract, '', 'commit', committed, refusedBy);
        // THE ASKER ITSELF HELD THE BOOK SHORT (kanban #740): peers that rebuilt another settlement have it read the batches again,
        // and the next pass builds anew
        if (refused.some((x) => /rebuilt settlement/.test(x))) await this.bookResync(roundIdBytes);
        return refuse(`${signers.length} of the ${m.needed} signer nodes the settlement needs committed to it: ${refused.join('; ')}`);
      }
      const listed = this.#listed(q, signers, m.needed);
      const combined = await this.#gatherShares(roundIdBytes, m, q, listed, '', refusedBy, {});
      if (!combined.ok) return this.#leaveOut(q, combined, listed, m.needed) ? this.#settleOnce(roundIdBytes) : combined;
      ({ signature } = combined);
      await this.#handSignature(roundIdBytes, q, signature, m);
    }
    // THE INTENT IS ON DISK BEFORE THE SUBMIT, as a hold's settle is: a signer node that
    // dies here comes back knowing it signed, and asks the federation.
    this.keepMoves(roundIdBytes, m);
    if (!this.#putRow(roundIdBytes, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
      why: 'about to submit; if this signer node dies here, ask the federation for the claimed locks' })) return refuse('this round\'s settlement row is final here: nothing is submitted again', 409);
    const sent = await this.#submit(await this.portFor(roundIdBytes), m, { payouts: m.plan.payouts, nonce: m.plan.nonce, signature });
    const stakeClaims = m.plan.claims.filter((c) => c.kind !== 'fee').length;
    const qualifiers = m.plan.payouts.filter((p) => p.kind === 'qualifier' || (p.kind === 'sent' && !p.donation)).length;
    const remainder = m.plan.remainder
      ? `; the walk-away's remainder ${m.plan.remainder.nodesMsat} msat to ${m.plan.remainder.sitting} signer node(s), `
        + `${m.plan.remainder.donationMsat} msat to ${m.plan.remainder.recipients} donation recipient(s)` : '';
    const feePart = m.plan.feeClaims && m.plan.feeClaims.length
      ? `; fee locks ${m.plan.feeClaims.length}, ${m.plan.feePoolMsat} msat, paid ${feeLine(m.plan.signerNodePayouts)}`
      : (m.plan.feeHole ? `; no fee lock claimed: ${m.plan.feeHole.why}` : '');
    const why = sent.accepted
      ? `claimed ${stakeClaims} loser lock(s), ${m.plan.poolMsat} msat; paid ${qualifiers} qualifier(s) ${m.plan.paidMsat} msat${remainder}${feePart}`
      : `the guardians refused it: ${sent.error}`;
    const state = await this.recordSubmit(roundIdBytes, m, signature, sent, why);
    // A REFUSED CLAIM MAY NAME A LOCK THAT WENT AFTER IT WAS BUILT (kanban #1146 A): the next plan reads the losers' locks at the federation, from a fresh build
    if (!sent.accepted) { const k = toHex(roundIdBytes); this.#suspectGone.add(k); this.built.delete(k); this.byPlan.delete(k); }
    // SAID, AND NEVER LOST IN A THROW (2026.1.9.11 release check: no seat held a settlement row since 10-25 - the website share of
    // settlement ed86a2fa (800 msat) was listed under its key nowhere, so a referrer's wallet could never collect it)
    // ONLY ON A LANDED SETTLEMENT (kanban #1171): a pre-validated submit stays SUBMITTING and its sends wait for the federation's word (confirmSoon,
    // then the kept-SUBMITTING path); one ACCEPTED on another txid of the round (the other asker's, found in) is indexed from what was kept of it
    const row = this.round.lockSettlement(roundIdBytes);
    if (state === ACCEPTED && row && row.txid !== m.txid) await this.indexRecovered(roundIdBytes, row.txid);
    if (state === ACCEPTED && row && row.txid === m.txid) {
      try {
        const n = this.indexDonationKeys(roundIdBytes, m.txid, m.plan);
        const kinds = (m.plan.payouts || []).filter((p) => SETTLEMENT_ROW_KINDS.has(p.kind)).map((p) => p.kind);
        console.log(`[settle] ${toHex(roundIdBytes).slice(0, 16)} donation keys of the settlement: ${n} row(s) kept${kinds.length ? ` (${kinds.join(', ')})` : ''}`);
      } catch (e) { console.error(`[settle] ${toHex(roundIdBytes).slice(0, 16)} donation keys not indexed: ${e.message}`); }
    }
    const winnings = state === ACCEPTED ? await this.sendWinnings(roundIdBytes) : null;
    return { ok: state === ACCEPTED, state, why: row ? row.why : why, txid: row ? row.txid : m.txid, signature, plan: m.plan, answer: sent, winnings };
  }

  /**
   * A ROUND THAT TAKES ANY FEDERATION, SETTLED ONE FEDERATION AT A TIME (2026.0.3): for each federation of the split
   * whose row is not ACCEPTED, the steps of the round's one settlement - this node's turn, the peers' commitments and shares over
   * THAT federation's bytes (`&federation=`), the combined signature checked under the claim key, the intent on disk, the submit
   * through that federation's port, the guardians' answer kept - each under its own nonce and its own row.
   */
  async #settleFederations(roundIdBytes) {
    // AN ATTESTED ROUND IS HELD, OR VOID, AS IN ONE FEDERATION (#attestedHold): nothing moves in any federation before its outcome
    const hold = this.#attestedHold(roundIdBytes);
    if (hold) return hold;
    // EVERY FEDERATION'S ROW THIS SEAT WAS INSIDE, ASKED OF ITS FEDERATION FIRST (kanban #1172), by every seat and before anything is rebuilt: a
    // SUBMITTING row was otherwise rebuilt and submitted again until the 24 h window ended, and never read as in
    const asked = new Map();
    for (const r of (this.round.fedLockSettlementsOf ? this.round.fedLockSettlementsOf(roundIdBytes) : [])) {
      if (r.state === ACCEPTED) continue;
      asked.set(r.federation, await this.checkScoped(roundIdBytes, { federation: r.federation }).catch((e) => ({ state: r.state, verdict: 'unknown', why: e.message })));
    }
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    if (this.winnings) {
      const t = await this.turn(roundIdBytes);
      if (!t.mine) return refuse(`not this signer node's turn to combine: ${t.why}`, 409, t.code || REFUSAL.NOT_MY_TURN, Number.isInteger(t.takeoverAt) ? { takeoverAt: t.takeoverAt } : {});
    }
    // WHAT THE ROUND MOVES OVER ALL ITS FEDERATIONS, NEVER REWRITTEN ONCE ONE FEDERATION'S IS IN (kanban #1172): each federation's own moves are kept
    // with its txid (keepScopedMoves) at its first SUBMITTING
    if (!(this.round.fedLockSettlementsOf ? this.round.fedLockSettlementsOf(roundIdBytes) : []).some((r) => r.state === ACCEPTED)) this.keepFederationMoves(roundIdBytes, got);
    const results = [];
    for (let i = 0; i < got.split.settlements.length; i++) {
      const s = got.split.settlements[i];
      const fid = s.federation;
      const where = { federation: fid };
      const kept = this.round.fedLockSettlement(roundIdBytes, fid);
      if (kept && kept.state === ACCEPTED) { results.push({ federation: fid, state: ACCEPTED, txid: kept.txid, kept: true }); continue; }
      // NEITHER IN NOR OUT: not submitted again (the round's row rule, W6)
      const a = asked.get(fid);
      if (kept && kept.state === SUBMITTING && a && a.verdict === 'mixed') { results.push({ federation: fid, ok: false, state: SUBMITTING, txid: kept.txid, why: `neither in nor out - not submitted again: ${a.why}` }); continue; }
      let m = await this.fedMessage(roundIdBytes, fid);
      if (!m.ok) { results.push({ federation: fid, ok: false, why: m.why }); continue; }
      let signature = !m.named && kept && kept.signature && kept.txid === m.txid ? kept.signature : null;
      if (m.named) {
        const n = await this.#namedSigned(roundIdBytes, m, `round=${toHex(roundIdBytes)}&federation=${fid}`, fid, { federation: fid });
        if (!n.ok) { results.push({ federation: fid, ok: false, why: n.why }); continue; }
        ({ m, signature } = n);
      } else if (!signature) {
        const q = `round=${toHex(roundIdBytes)}&federation=${fid}`;
        const held = await this.#gatherAcks(roundIdBytes, m, q, fid);
        if (!held.ok) { results.push({ federation: fid, ok: false, why: held.why }); continue; }
        const own = await this.commit(roundIdBytes, { federation: fid, acks: held.acks });
        if (!own.ok) { results.push({ federation: fid, ok: false, why: own.why }); continue; }
        const { signers, refused, committed, refusedBy } = await this.#peerCommitments(roundIdBytes, own, q, m, held.acks);
        if (signers.length < m.needed) { this.#stoppedAt(roundIdBytes, m.contract, fid, 'commit', committed, refusedBy); results.push({ federation: fid, ok: false, why: `${signers.length} of the ${m.needed} signer nodes committed: ${refused.join('; ')}` }); continue; }
        const listed = this.#listed(q, signers, m.needed);
        const combined = await this.#gatherShares(roundIdBytes, m, q, listed, fid, refusedBy, { federation: fid });
        if (!combined.ok) {
          if (this.#leaveOut(q, combined, listed, m.needed)) { i--; continue; }
          results.push({ federation: fid, ok: false, why: combined.why });
          continue;
        }
        ({ signature } = combined);
        await this.#handSignature(roundIdBytes, q, signature, m);
      }
      // THE INTENT ON DISK WITH WHAT IT MOVES, THROUGH THE ROW'S ONE TRANSITION FUNCTION (kanban #1172), then the submit
      this.keepScopedMoves(roundIdBytes, where, m);
      if (!this.#putScoped(roundIdBytes, where, { txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: 'about to submit; if this signer node dies here, ask the federation for the claimed locks' })) { results.push({ federation: fid, ok: false, why: 'this federation\'s row is final here: nothing is submitted again' }); continue; }
      const port = await this.portForFederation(fid);
      const sent = await this.#submit(port, m, { payouts: s.payouts, nonce: s.nonce, signature });
      const whyIn = `federation ${fid.slice(0, 16)}: claimed ${s.claims.length} lock(s), ${s.poolMsat + s.feePoolMsat} msat; paid ${s.payouts.length} payout(s)`;
      // ACCEPTED ONLY LANDED, REFUSED ONLY AFTER EVERY TXID OF THIS FEDERATION WAS ASKED (kanban #1172)
      const state = await this.recordScopedSubmit(roundIdBytes, where, m, signature, sent, whyIn);
      // A REFUSED CLAIM MAY NAME A LOCK THAT WENT AFTER IT WAS BUILT (kanban #1146 A): the next plan reads the losers' locks at their federations
      if (!sent.accepted) { const k = toHex(roundIdBytes); this.#suspectGone.add(k); this.built.delete(`${k}:fed:${fid}`); }
      const row = this.round.fedLockSettlement(roundIdBytes, fid);
      results.push({ federation: fid, ok: state === ACCEPTED, state, txid: row ? row.txid : m.txid, why: row ? row.why : whyIn });
    }
    const all = results.length > 0 && results.every((r) => r.state === ACCEPTED);
    return { ok: all, state: all ? ACCEPTED : SUBMITTING, federations: results,
      why: results.map((r) => `${r.federation.slice(0, 8)}: ${r.state || 'not built'}${r.why ? ` (${r.why})` : ''}`).join('; ') };
  }

  /**
   * A WALK-AWAY'S DONATION, PAID TO KEYS, IN THE DONATIONS INDEX (2026-10-03): each `donation key` payout of an
   * accepted settlement is a payout contract at (txid, its place among the payouts) - the out_idx a winner redeems by -
   * listed under its key like a lock transaction's donation output, so the dev's client finds it (GET /donations).
   */
  indexDonationKeys(roundIdBytes, txid, plan, { only = null } = {}) {
    if (!plan || !Array.isArray(plan.payouts) || !this.round.putDonationOutputs || !/^[0-9a-f]{64}$/.test(String(txid))) return 0;
    const row = this.round.get(roundIdBytes);
    const federationId = row ? decodeRoundContract(new Uint8Array(row.contract)).federationId : new Uint8Array(32);
    // AND A MARKET'S PROTOCOL RESERVE (2026-10-20 #502, measured on round 6c68396b: its settlement paid 333 msat to
    // 337ae01a's reserve key - 20 % of the 1,666 msat of fees due - and GET /reserves never listed it: the reserves' book held only
    // the reserve outputs a game entry makes at its lock; a market pays its reserve at settlement): each 'reserve' payout is a
    // row under the reserve key too, its entry id zeros (it is the round's, no one entry's)
    const rows = plan.payouts.map((p, i) => ({ p, i })).filter(({ p, i }) => SETTLEMENT_ROW_KINDS.has(p.kind) && (!only || only.has(i))).map(({ p, i }) => ({
      outpoint: { txid: fromHex(String(txid)), outIdx: BigInt(i) }, entryId: p.donation ? p.donation.id : new Uint8Array(32), roundId: roundIdBytes, federationId,
      recipientPk: p.payoutPk, amountMsat: p.msat, contractId: `settlement:${i}`, ...(p.kind === 'frontend' ? { item: 'website' } : {}),
      // a market's donation names each filled order's part (kanban #580): its entry, its player key, the fee it paid (the weight)
      ...(p.donation && Array.isArray(p.donation.parts) && p.donation.parts.length ? { parts: p.donation.parts.map((x) => ({ entryId: String(x.entryId), playerPubkey: String(x.playerPubkey), feeMsat: String(x.feeMsat) })) } : {}) }));
    if (rows.length) this.round.putDonationOutputs(rows);
    return rows.length;
  }

  /**
   * A RECOVERED SETTLEMENT'S DONATION-KEY OUTPUTS (2026-10-07): a seat restarted between submitting a
   * walk-away's settlement and finding it in the federation had no plan in memory, so its donation-key payouts were never
   * indexed and the donors never saw them. The plan kept in this process is used when it is the settlement's; else it is
   * rebuilt from the store as summaryOf does (no preimage opened) and indexed ONLY when it is the signed one: the same
   * claimed locks and the same payout count as the moves kept at signing. A plan that is not is indexed nowhere, and the log
   * says why. `onlyStored` (the backfill) indexes only payouts the guardians still hold: one a donor already redeemed is
   * not handed to the donors again.
   */
  async indexRecovered(roundIdBytes, txid, { onlyStored = false } = {}) {
    const key = toHex(roundIdBytes);
    const not = (why) => { console.log(`[settle] ${key.slice(0, 16)} donation keys not indexed: ${why}`); return { indexed: 0, why }; };
    const b = this.built.get(key);
    let plan = b && b.ok && b.txid === txid ? b.plan : null;
    if (!plan) {
      const moves = this.round.lockSettlementMoves(roundIdBytes);
      if (!moves || moves.txid !== txid) return not('this signer node kept no record of what that settlement moves');
      let got;
      try { got = await this.planOf(roundIdBytes, { withSends: true }); } catch (e) { return not(`its plan was not rebuilt: ${e.message}`); }
      if (!got || !got.ok) return not(`its plan was not rebuilt: ${got ? got.why : 'no answer'}`);
      const claims = got.plan.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`).sort();
      const signed = [...moves.claims].sort();
      if (claims.length !== signed.length || claims.some((c, i) => c !== signed[i]) || got.plan.payouts.length !== moves.payouts)
        return Object.assign(not(`the rebuilt plan claims ${claims.length} lock(s) and pays ${got.plan.payouts.length}, the signed one claims `
          + `${signed.length} and pays ${moves.payouts}: nothing is indexed from a plan that was not signed`), { mismatched: true });
      plan = got.plan;
    }
    const keys = plan.payouts.map((p, i) => ({ p, i })).filter(({ p }) => SETTLEMENT_ROW_KINDS.has(p.kind)).map(({ i }) => i);
    if (!keys.length) return { indexed: 0, why: 'its plan pays no donation key' };
    let only = null, redeemed = 0;
    if (onlyStored) {
      only = new Set();
      for (const i of keys) {
        let held = false;
        try { held = !!(await (await this.portFor(roundIdBytes)).status({ txid: fromHex(txid), outIdx: BigInt(i) })).stored; } catch { held = false; }
        if (held) only.add(i); else redeemed++;
      }
    }
    const indexed = this.indexDonationKeys(roundIdBytes, txid, plan, { only });
    console.log(`[settle] ${key.slice(0, 16)} donation keys indexed: ${indexed} of ${keys.length}${redeemed ? ` (${redeemed} no longer held: redeemed already)` : ''}`);
    return { indexed, redeemed };
  }

  /**
   * THE BACKFILL OF (2026-10-07): every settlement this seat recovered from the federation ("found in the
   * federation after this signer node was inside it") with no donation output indexed for it, once each - the same matched
   * rebuild, only payouts the guardians still hold, a marker per round with a definitive outcome so none is asked twice -
   * a round not rebuildable yet stays unmarked and is tried on later passes, a try counted at most once per 6 h, and marked
   * checked after BACKFILL_TRIES counted tries. Paced: one round per
   * `paceMs`, so a seat with hundreds of them is not held at a core.
   */
  /**
   * THE MARKETS' RESERVES SETTLED BEFORE THEY WERE KEPT AS ROWS (2026-10-20, #502): every market round (one holding an outcome
   * attestation) whose settlement this seat holds ACCEPTED and that has no reserve row yet (a 'settlement:' row with entry id zeros)
   * is indexed again from its matched plan - only payouts the guardians still hold. Once per round per process; the backfill of
   * donation keys skips these rounds when their donation keys were indexed, so it never reached their reserve.
   */
  async backfillMarketReserves({ paceMs = 3000 } = {}) {
    const out = { checked: 0, indexed: 0 };
    if (!this.round.db || !this.round.lockSettlement) return out;
    const seen = this.reservesBackfilled || (this.reservesBackfilled = new Set());
    let ids = [];
    try { ids = this.round.db.prepare('SELECT DISTINCT round_id FROM outcome_attestations').all().map((r) => new Uint8Array(r.round_id)); } catch { return out; }
    const zero = Buffer.alloc(32);
    for (const rid of ids) {
      const key = toHex(rid);
      if (seen.has(key)) continue;
      const kept = this.round.lockSettlement(rid);
      if (!kept || kept.state !== ACCEPTED || !kept.txid) continue;
      seen.add(key);
      const has = this.round.db.prepare("SELECT COUNT(*) AS n FROM donation_outputs WHERE round_id = ? AND entry_id = ? AND contract_id LIKE 'settlement:%'").get(Buffer.from(rid), zero).n;
      if (has > 0) continue;
      out.checked++;
      const r = await this.indexRecovered(rid, kept.txid, { onlyStored: true });
      if (r.indexed) out.indexed++;
      if (paceMs) await new Promise((ok) => setTimeout(ok, paceMs));
    }
    if (out.checked) console.log(`[settle] markets' reserves backfilled: ${out.indexed} of ${out.checked} settled market round(s) indexed`);
    return out;
  }

  async backfillDonationKeys({ paceMs = 3000 } = {}) {
    const out = { checked: 0, indexed: 0, outputs: 0, mismatched: 0, redeemed: 0, noKeys: 0, failed: 0, gaveUp: 0 };
    if (!this.round.lockSettlementsIn || !this.round.donationBackfilled) return out;
    for (const rid of this.round.lockSettlementsIn(ACCEPTED)) {
      const kept = this.round.lockSettlement(rid);
      if (!kept || !String(kept.why || '').startsWith('found in the federation after this signer node was inside it')) continue;
      if (this.round.donationBackfilled(rid) || this.round.settlementDonationOutputs(rid) > 0) continue;
      out.checked++;
      const r = await this.indexRecovered(rid, kept.txid, { onlyStored: true });
      if (r.indexed) { out.indexed++; out.outputs += r.indexed; }
      if (r.mismatched) out.mismatched++;
      else if (r.why === 'its plan pays no donation key') out.noKeys++;
      else if (!r.indexed && !r.redeemed) out.failed++;
      out.redeemed += r.redeemed || 0;
      // ONLY A DEFINITIVE OUTCOME IS MARKED: a round whose plan could not be rebuilt now - a run still
      // PROVISIONALLY_FINAL on this seat - is left unmarked, and a later pass tries it again
      const notRebuilt = !r.indexed && !r.redeemed && !r.mismatched && r.why !== 'its plan pays no donation key';
      // ...BUT NOT FOREVER (2026-10-07): after BACKFILL_TRIES passes that could not rebuild it - a day or more on the
      // 6 h clock - the round is marked checked with the reason, and not asked again
      // A TRY COUNTS ONLY WHEN THE ROUND'S LAST COUNTED TRY IS BACKFILL_TRY_GAP_MS OLD (2026-10-07, comment 723):
      // a seat start inside that time runs the pass but consumes nothing, so BACKFILL_TRIES tries span about a day
      let tries = 0;
      if (notRebuilt && this.round.backfillTry) {
        const was = this.round.backfillTry(rid), at = this.now();
        tries = was ? was.tries : 0;
        if (!was || at - was.lastMs >= BACKFILL_TRY_GAP_MS) { tries++; this.round.putBackfillTry(rid, tries, at); }
      }
      if (!notRebuilt) this.round.markDonationBackfilled(rid, { indexed: r.indexed || 0, why: r.why || null });
      else if (tries >= BACKFILL_TRIES) {
        this.round.markDonationBackfilled(rid, { indexed: 0, why: `not rebuilt after ${tries} tries: ${r.why}` });
        out.gaveUp++;
      }
      if (paceMs) await new Promise((ok) => setTimeout(ok, paceMs));
    }
    console.log(`[settle] donation-key backfill: ${out.checked} recovered settlement(s) checked - ${out.indexed} indexed `
      + `(${out.outputs} output(s)), ${out.redeemed} payout(s) already redeemed, ${out.noKeys} paying no donation key, ${out.mismatched} not the signed plan, ${out.failed} not rebuilt (${out.gaveUp} marked after ${BACKFILL_TRIES} tries)`);
    return out;
  }

  /** THE COORDINATOR'S SEND PLANS: proposed from the base plan and handed to every peer, which checks them itself. */
  async planSends(roundIdBytes) {
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    // ONE PROPOSER AT A TIME: whose turn it is (`turn`, M3.3-19's order). Every signer node settles on its own clock, and
    // two proposals would fetch two invoices and build two transactions that no signature joins (measured: "the
    // combined settlement signature does not verify"). The others wait for its plan and check it.
    const t = await this.turn(roundIdBytes);
    if (!t.mine) {
      if (this.round.sendPlansOf(roundIdBytes).length || !this.winnings.wanting(got.base).length) return { ok: true, rows: [] };
      return refuse(`the send plan is proposed by the signer node whose turn it is; this one waits for it and checks it (${t.why})`);
    }
    // ADOPT BEFORE PROPOSING: a plan a peer already keeps, if it stands here, is this asker's plan too - a second invoice
    // would be a second plan the peers split over. The lowest-keyed that stands wins (`check` gives way to it).
    await this.adoptPeerPlan(roundIdBytes, got.base);
    let proposed = await this.winnings.propose(roundIdBytes, got.base);
    if (!proposed.ok) return proposed;
    // AN EMPTY PLAN IS HANDED OUT TOO: a peer that holds an address this signer node does not refuses it by name.
    let body = JSON.stringify(proposed.rows.map(sendPlanToJson));
    const peers = this.peersFor(roundIdBytes);
    // A PLAN HANDED TO NOBODY IS NOT TAKEN. Measured: a signer node restarted inside a settlement asked again before it
    // knew its peers, "handed" a new plan to none, and the peer went on refusing against the old one.
    if (!peers.length && got.contract.nodes.length > 1)
      return { ...refuse('this signer node knows no peer to hand the send plan to yet, so nothing is settled'), peerRefused: true };
    // THE ROUND'S SIGNING THRESHOLD TAKES IT, NOT EVERY PEER (measured on a 5-of-7: one signer node that saw the run end
    // otherwise refused the plan, and nothing was ever settled). The settlement is signed by whoever rebuilt the same
    // bytes; the plan needs as many as that signature does. A 2-of-2 still needs both. AND IT IS COUNTED IN SIGNATURES,
    // NOT HTTP STATUSES (plan-taken.js): a seat's yes is its node key's signature over the plan's id.
    let agreed = await this.planAgreed(roundIdBytes, null, body, got.contract, peers, toHex(roundIdBytes));
    // A DONATION RECIPIENT THAT ANSWERS HERE AND NOT AT A SEAT (hole 1 (a)): a seat names the first it cannot reach; each
    // one named is planned HELD - its share settled under the committee key and retried - and the plan offered again,
    // until the seats agree or name no new one, rather than the whole settlement stalling into a refund.
    const hold = new Set();
    while (!agreed.final) {
      const named = proposed.rows.filter((r) => r.donation && r.invoice && !hold.has(r.address)
        && agreed.refused.some((x) => x.includes(`the donation recipient does not answer here: ${r.address}`))).map((r) => r.address);
      if (!named.length || !(this.round.dropPlannedSends(roundIdBytes) > 0)) break;
      for (const a of named) hold.add(a);
      proposed = await this.winnings.propose(roundIdBytes, got.base, { hold });
      if (!proposed.ok) return proposed;
      body = JSON.stringify(proposed.rows.map(sendPlanToJson));
      agreed = await this.planAgreed(roundIdBytes, null, body, got.contract, peers, toHex(roundIdBytes));
    }
    if (!agreed.final) {
      this.#stoppedAt(roundIdBytes, got.contract, '', 'plan', agreed.certificate.map((b) => splitPlanTaken(b).nodePubkey), agreed.refusedBy);
      return { ...refuse(`${agreed.agreed} of the ${agreed.needed} seats the settlement needs signed the send plan, so nothing is settled: ${agreed.refused.join('; ')}`), peerRefused: true, outOfReach: planOutOfReach(agreed) };
    }
    console.log(`[winnings] ${toHex(roundIdBytes).slice(0, 16)} ${agreed.agreed} of ${got.contract.nodes.length} seats signed send plan ${toHex(agreed.planId).slice(0, 16)} (${agreed.needed} needed)${agreed.refused.length ? `; did not count: ${agreed.refused.join('; ')}` : ''}`);
    this.built.delete(toHex(roundIdBytes));
    return { ok: true, rows: proposed.rows };
  }

  /**
   * THE SEATS' SIGNED AGREEMENT ON A SEND PLAN (plan-taken.js): the plan handed to every peer, each answer a signed
   * acceptance or nothing, and only verified signatures by the round's seats over this plan's id counted - this seat's
   * own among them. The certificate that counted is kept, for GET /settle-taken and for anyone who checks it.
   */
  async planAgreed(roundIdBytes, lateEntryId, body, contract, peers, query) {
    const planId = planTakenId({ roundId: roundIdBytes, lateEntryId, rows: JSON.parse(body) });
    const own = this.planTakenBy(planId);
    // THE PLAN GOES SIGNED BY THIS SEAT'S NODE KEY (kanban #1154): a seat takes a send plan only from a seat of the round
    const headers = sendPlanAskHeaders(this.round, { kind: PLAN_ASK.PROPOSE, roundId: roundIdBytes, lateEntryId, body });
    // EVERY PEER AT ONCE, AND THE THRESHOLD GOES ON (kanban #1061): `receiptsNeeded` as `countPlanTaken` reads it, this seat's own acceptance among them. A seat left past the
    // grace is still sent the plan; only its acceptance is not in this certificate.
    const asked = await askPeers(peers, async (base, signal) => {
      const r = await this.fetcher(`${base}/settle-sends?round=${query}`, { method: 'POST', body, headers, signal });
      if (!r.ok) return { why: (await r.text()).trim(), byName: refusedByName(r) };
      return { bytes: new Uint8Array(await r.arrayBuffer()) };
    }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: receiptsNeeded(contract.settlementSlots) - 1, counts: (x) => !!x.bytes });
    const answers = asked.map(({ peer: base, value, error }) => ({ base, ...(value || { why: error.message }) }));
    const counted = countPlanTaken({ own, answers, seats: contract.nodes, planId, slots: contract.settlementSlots });
    if (counted.final) {
      const certificate = joinCertificate(counted.certificate);
      this.planCertificates.set(lateEntryId ? `${toHex(roundIdBytes)}:${toHex(lateEntryId)}` : toHex(roundIdBytes), { planId, certificate });
      // EVERY SEAT HOLDS IT, not the asker alone: handed to each peer, which keeps it only if it stands against the plan
      // that peer kept itself (`takeCertificate`). A peer that misses it still signed its own acceptance.
      const handed = new Uint8Array(32 + certificate.length); handed.set(planId, 0); handed.set(certificate, 32);
      await askPeers(answers.filter((a) => a.bytes).map((a) => a.base), (base, signal) => this.fetcher(`${base}/settle-taken?round=${query}`, { method: 'POST', body: handed, signal }),
        { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: 0 });
    }
    return { ...counted, planId, refusedBy: answers.filter((a) => a.byName).map((a) => a.base) };
  }

  /**
   * A PEER KEEPS THE SEATS' CERTIFICATE only if it stands here: over the id of the plan this seat kept, a threshold of
   * the round's seats, each signature verified here.
   */
  takeCertificate(roundIdBytes, lateEntryId, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 32) return refuse('a certificate is a plan id and signed acceptances', 400);
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this seat holds no such round');
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const sender = lateEntryId ? this.lateWinningsFor(roundIdBytes, lateEntryId) : this.winnings;
    if (!sender) return refuse('this signer node sends no winnings');
    const kept = sender.keptPlan(roundIdBytes);
    if (!kept.length) return refuse('this seat keeps no send plan for that settlement');
    const planId = planTakenId({ roundId: roundIdBytes, lateEntryId, rows: kept });
    if (toHex(planId) !== toHex(bytes.subarray(0, 32))) return refuse('that certificate is for another plan than the one this seat kept');
    const records = splitCertificate(bytes.subarray(32));
    const counted = countPlanTaken({ own: records[0], answers: records.slice(1).map((b, i) => ({ base: `record ${i + 1}`, bytes: b })),
      seats: contract.nodes, planId, slots: contract.settlementSlots });
    if (!counted.final) return refuse(`${counted.agreed} of the ${counted.needed} seats in that certificate stand here: ${counted.refused.join('; ')}`);
    this.planCertificates.set(lateEntryId ? `${toHex(roundIdBytes)}:${toHex(lateEntryId)}` : toHex(roundIdBytes),
      { planId, certificate: joinCertificate(counted.certificate) });
    return { ok: true, agreed: counted.agreed, needed: counted.needed };
  }

  /** This seat's signed acceptance of a plan id. */
  planTakenBy(planId) {
    return signPlanTaken({ planId, secret: this.round.identity.secret, pubkey: this.round.pubkey });
  }

  /** The certificate a settlement's plan was agreed by, or null. */
  planCertificate(roundIdBytes, lateEntryId = null) {
    return this.planCertificates.get(lateEntryId ? `${toHex(roundIdBytes)}:${toHex(lateEntryId)}` : toHex(roundIdBytes)) || null;
  }

  // A SECOND, THEN TWICE AS LONG EACH TIME, UP TO A MINUTE (2026-10-07 08:35): offered every second, a
  // plan no peer could take - "this signer node knows no peer to hand the send plan to yet" - was a whole settle pass a
  // second per round, 120 times, and every code-seat29 seat sat near one core. The bound of 120 offers stays.
  retryPlan(roundIdBytes, { everyMs = 1000, most = 120, longestMs = 60000 } = {}) {
    const key = toHex(roundIdBytes);
    const n = (this.planRetries.get(key) || 0) + 1;
    if (n > most) return;
    this.planRetries.set(key, n);
    const waitMs = Math.min(longestMs, everyMs * 2 ** Math.min(n - 1, 30));
    const t = setTimeout(() => {
      this.retryTimers.delete(t);
      this.settle(roundIdBytes).then((got) => console.log(`[settle] ${key.slice(0, 16)} plan offered again (${n}): ${got.state || (got.ok ? 'ok' : 'refused')} - ${got.why || ''}`))
        .catch((e) => console.log(`[settle] ${key.slice(0, 16)} plan offered again (${n}): ${e.message}`));
    }, waitMs);
    if (t.unref) t.unref();
    this.retryTimers.add(t);
  }

  stop() { for (const t of this.retryTimers) clearTimeout(t); this.retryTimers.clear(); }

  /**
   * WHOSE TURN IT IS TO PROPOSE THE SEND PLAN AND COMBINE THE SETTLEMENT - M3.3-19, the payout's own takeover, not a new
   * rule: the round's signer nodes sorted by key and rotated by an index from the round id (`askerOrder`); seat 0 alone
   * at the close, seat k once this node's chain is k x TAKEOVER_BLOCKS past the round's beacon. A node that reads no
   * chain tip or no beacon never takes over; seat 0 still asks.
   */
  async turn(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { mine: false, why: 'this node holds no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const nodes = [...contract.nodes].sort((a, b) => (toHex(a) < toHex(b) ? -1 : 1));
    const ring = askerOrder(roundIdBytes, nodes);
    if (!ring.ok) return { mine: false, why: ring.why, code: REFUSAL.NO_ASKER };
    const place = ring.order.findIndex((k) => toHex(k) === toHex(this.round.pubkey));
    if (place < 0) return { mine: false, place, why: 'this node is not one of the round\'s signer nodes', code: REFUSAL.NOT_A_SEAT };
    if (place === 0) return { mine: true, place, why: 'this node is the round\'s asker' };
    const clock = this.turnClock;
    let beacon = null; let tip = null;
    try { beacon = clock && clock.beaconHeight ? await clock.beaconHeight(roundIdBytes, contract) : null; } catch { beacon = null; }
    try { tip = clock && clock.tip ? await clock.tip() : null; } catch { tip = null; }
    if (!Number.isInteger(beacon) || !Number.isInteger(tip))
      return { mine: false, place, why: `this node is ${place} of ${ring.order.length} in the asker order and reads no chain to take over with` };
    const e = eligibleAsker({ roundId: roundIdBytes, signerNodes: nodes, beaconHeight: beacon, tipHeight: tip });
    if (!e.ok) return { mine: false, place, why: e.why };
    return place < e.allowed.length ? { mine: true, place, why: `this node takes over at ${tip}, ${e.advanced} block(s) past the beacon` }
      : { mine: false, place, takeoverAt: beacon + place * 2, why: `this node is ${place} of ${ring.order.length} in the asker order and may take over at height ${beacon + place * 2}; the chain is at ${tip}` };
  }

  /** A SIGNATURE THIS SIGNER NODE WAS HANDED, checked against the federation every 2 s until it is in, a bounded while. */
  confirmSoon(roundIdBytes, { everyMs = 2000, most = 60 } = {}) {
    const key = `confirm:${toHex(roundIdBytes)}`;
    if (this.planRetries.get(`${key}:pending`)) return;
    const n = (this.planRetries.get(key) || 0) + 1;
    if (n > most) return;
    this.planRetries.set(key, n);
    this.planRetries.set(`${key}:pending`, 1);
    const t = setTimeout(() => {
      this.retryTimers.delete(t);
      this.planRetries.delete(`${key}:pending`);
      const kept = this.round.lockSettlement(roundIdBytes);
      // A ROUND THAT TAKES ANY FEDERATION (kanban #1172): a SUBMITTING federation row is asked as the round's row is
      const fedPending = !kept && this.round.fedLockSettlementsOf && this.round.fedLockSettlementsOf(roundIdBytes).some((r) => r.state === SUBMITTING);
      if ((!kept || kept.state !== SUBMITTING) && !fedPending) return;
      this.settle(roundIdBytes)
        .then((got) => console.log(`[settle] ${toHex(roundIdBytes).slice(0, 16)} asked the federation (${n}): ${got.state || (got.ok ? 'ok' : 'not yet')} - ${String(got.why || '').slice(0, 140)}`))
        .catch(() => {});
    }, everyMs);
    if (t.unref) t.unref();
    this.retryTimers.add(t);
  }

  /**
   * The plans this asker's peers keep, lowest-keyed first; the first that stands here is kept (see `check`). EACH ANSWER SIGNED BY THE SEAT
   * THAT KEPT IT (kanban #1154): a plan a seat of the round signed may replace this asker's own lower-keyed; an unsigned one (a seat that
   * does not sign its answer yet) is only adopted where this asker keeps none, and is checked as any plan is.
   */
  async adoptPeerPlan(roundIdBytes, base) {
    const plans = [];
    const row = this.round.get(roundIdBytes);
    const seats = row ? decodeRoundContract(new Uint8Array(row.contract)).nodes : [];
    // EVERY SEAT'S PLAN IS WEIGHED, lowest-keyed first below, so all are read at once and none is cut off by a threshold; a peer down or hung: the others decide
    const asked = await askPeers(this.peersFor(roundIdBytes), async (peer, signal) => {
      const r = await this.fetcher(`${peer}/settle-sends?round=${toHex(roundIdBytes)}`, { signal });
      if (!r.ok) return null;
      const text = typeof r.text === 'function' ? await r.text() : JSON.stringify(await r.json());
      const by = checkSendPlanAsk(r.headers && r.headers.get ? r.headers.get(SEND_PLAN_ASK_HEADER) : null,
        { kind: PLAN_ASK.KEPT, roundId: roundIdBytes, body: text, seats });
      return { rows: JSON.parse(text), from: by.ok ? by.who : null };
    }, { boundMs: this.peerReadMs });
    for (const { value } of asked) {
      const rows = value && value.rows;
      if (!Array.isArray(rows) || !rows.length) continue;
      const same = plans.find((p) => planKey(p.rows) === planKey(rows));
      if (!same) plans.push({ rows, from: value.from });
      else if (!same.from && value.from) same.from = value.from;
    }
    plans.sort((a, b) => (planKey(a.rows) < planKey(b.rows) ? -1 : 1));
    const mine = this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0);
    for (const { rows, from } of plans) {
      if (mine.length && !(planKey(rows) < planKey(mine))) break;
      const took = await this.winnings.check(roundIdBytes, base, rows, { from });
      if (took.ok) { this.built.delete(toHex(roundIdBytes)); return took; }
    }
    return null;
  }

  /**
   * A PEER takes the coordinator's plans only if each stands here - and then rebuilds with them. `from`: the seat of the round that signed
   * them (server.js checked its signature against the contract's nodes, kanban #1154).
   */
  async takeSends(roundIdBytes, proposed, { from = null } = {}) {
    if (!this.winnings) return refuse('this signer node sends no winnings');
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    const checked = await this.winnings.check(roundIdBytes, got.base, proposed, { from });
    if (checked.ok) this.built.delete(toHex(roundIdBytes));
    return checked.ok ? { ...checked, taken: this.planTakenBy(planTakenId({ roundId: roundIdBytes, rows: proposed })) } : checked;
  }

  /** The settled round's winnings, sent (winnings-send.js `sendAll`). */
  async sendWinnings(roundIdBytes) {
    if (!this.winnings || !this.round.sendPlansOf(roundIdBytes).length) return [];
    // THE SIGNER NODE WHOSE TURN IT IS DRIVES THE SENDS; the others answer its signing rounds and keep its preimage.
    if (!(await this.turn(roundIdBytes)).mine) return [];
    // PLANNED BUT NOT YET SETTLED: the settlement is made first - the kept plan offered again - and the send follows it.
    // Measured: the proposer's one attempt met a peer whose run was not yet FINAL, the finality watch had nothing left
    // to wait for, and nothing tried again; the round sat unsettled.
    const kept = this.round.lockSettlement(roundIdBytes);
    if (!kept || kept.state !== ACCEPTED) {
      const got = await this.settle(roundIdBytes).catch((e) => ({ ok: false, why: e.message }));
      return [{ ok: !!got.ok, settle: got.state || null, why: got.why }];
    }
    const m = this.sendBuilt(roundIdBytes, await this.message(roundIdBytes));
    if (!m.ok) return [{ ok: false, why: m.why }];
    return this.winnings.sendAll(roundIdBytes, m);
  }

  /**
   * WHAT THE SENDS OF A PROTOCOL-27 SETTLEMENT READ (kanban #1044 B1, ruling #1134 2): the real transaction (its txid, the send contracts'
   * outpoints), the refund key KeyAgg(S) and the batch the seats kept - its presigned auths and refunds (c). Below 27 the build as it is.
   */
  sendBuilt(roundIdBytes, m, { entry = null, federation = null } = {}) {
    if (!m || !m.ok || !m.named) return m;
    // THE BATCH OF THE TXID THE ROW STANDS ON (kanban #1170): the sends' auths and the refund key are that transaction's, never another S's
    const batch = this.batchFor(roundIdBytes, { entry, federation });
    if (!batch || batch.bodyId !== m.bodyId) return refuse('this signer node keeps no signed batch of that settlement, so it sends nothing');
    const { seatKeys, threshold } = namedClaimKeys(m.contract);
    return { ...m, txid: batch.txid, claimPk: signerSetKey(seatKeys, threshold, batch.signers), signers: batch.signers, batch };
  }
}

export { encodeCommitments, encodeShare, decodeCommitments };
