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
// rebuilt by the stock client (blwp-stake-lock --mode settle, dry), and the signer node
// signs only the 32 bytes it got back.
//
// FEES ARE NOT IN IT. The fee locks' claim hash and §22A's node slots are not
// decided (FEDERATION.md F5); the fee lock expires back to its player as before.
import { feeBpsOf, donationBpsOf, donationInFee } from '../../arena-protocol/src/fee.js';
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { decodeRoundContract, decodeEntryContract, entryFederation } from '../../arena-protocol/src/contracts.js';
import { takesAnyFederation } from '../../arena-protocol/src/constants.js';
import { splitByFederation } from '../../arena-protocol/src/federation-settlement.js';
import { pluginForRound, payoutRuleOfRound } from './plugins.js';
import { heldOutcomes, marketVoidOf, attestedTable } from './game-market.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { lockSettlement, lateLockSettlement, attestedLockSettlement, bookLockSettlement, RESERVE_LATER_PK } from '../../arena-protocol/src/lock-settlement.js';
import { roundSplitBps } from '../../arena-protocol/src/fee-proposal.js';
import { paysReserves } from '../../arena-protocol/src/reserves.js';
import { bookSettlement } from '../../arena-protocol/src/book-ledger.js';
import { isScalar, marketOfRound } from '../../arena-protocol/src/manifest.js';
import { outcomeFinality } from '../../arena-protocol/src/attested.js';
import { FORFEIT, VOID, ENTRY_VOID, isQualifier } from '../../arena-protocol/src/payout.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { lockFieldsFromJson } from '../../arena-protocol/src/stake-lock.js';
import { scalarFrom32, FIELD } from '../../arena-protocol/src/shares.js';
import { FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { resultFinality } from './finality.js';
import { encodeCommitments, decodeCommitments, encodeShare, decodeShare } from './pool-wire.js';
import { sendPlanToJson, planKey } from './winnings-send.js';
import { askerOrder, eligibleAsker } from './payout.js';
import { planTakenId, signPlanTaken, countPlanTaken, joinCertificate, splitCertificate } from './plan-taken.js';

// WHO THE FEE LOCKS PAID: the signer nodes, and a market's donation keys - named apart
const feeLine = (payouts) => {
  const part = (kind) => { const p = payouts.filter((x) => (x.kind === 'donation key') === kind); return [p.length, p.reduce((t, x) => t + x.msat, 0n)]; };
  const [n, nodes] = part(false); const [d, gifts] = part(true);
  return `${n} signer node(s) ${nodes} msat${d ? ` and ${d} donation key(s) ${gifts} msat` : ''}`;
};

const listKey = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).sort().join('|');
const refuse = (why, status = 409) => ({ ok: false, status, why });
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

/** Whether a round's stake is a federation stake lock (and so settled here). */
export const locksStake = (contract) => contract.federationId instanceof Uint8Array
  && (contract.federationId.some((b) => b !== 0) || takesAnyFederation(contract)) && contract.stakeMsat > 0n;

const NO_FEES = { ppm: 0n, baseMsat: 0n };
/**
 * A ROUND THAT TAKES ANY FEDERATION, SETTLED (2026.0.3): its plan decided once - lockSettlement with no fee, since
 * every federation prices its own (splitByFederation) - and split into one balanced transaction per federation. `args`:
 * lockSettlement's; `federationOf(outpoint)` -> the federation hex a claimed lock is in; `feesOf(fidHex)` -> its fee rule.
 */
export function federationPlans(args, { federationOf, feesOf }) {
  const plan = lockSettlement({ ...args, fees: NO_FEES });
  if (!plan.ok) return { ok: false, why: plan.why };
  if (plan.nothing) return { ok: false, why: plan.why };
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

export class LockSettlement {
  /**
   * `dkg` holds this signer node's share of the round's claim key; `port` is the
   * federation (blwp-stake-lock); `stakeSecrets` opens a loser's P with the other
   * signer nodes; `peersFor(rid)` names the other settlement signer nodes' bases.
   */
  constructor(round, { dkg, port, curve, random, stakeSecrets, peersFor = () => [], fetcher = (u, o) => fetch(u, o),
    signerNodesFor = (rid, contract) => ({ gameVerify: contract.nodes, settlement: contract.nodes }), winnings = null,
    turnClock = null, donationSetFor = null, donationTargetFor = null, orderBook = null, now = () => Date.now(), conflictsFor = null,
    reserveKeyFor = null, feesFor = null, finalityOf = resultFinality } = {}) {
    this.round = round;
    // THE FEES IN FORCE AT A ROUND (funding-book.js feesAt): `feesFor(contract)` -> the fee set at its census height. A
    // version-11 round's node fee and every round's website share are settled from it; unset, today's
    this.feesFor = feesFor;
    // A FEDERATION'S RESERVE KEY (server.js `reserveKeyFor(fedHex)`, async): where a market's protocol reserve is paid
    this.reserveKeyFor = reserveKeyFor;
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
      const mine = this.round.results(roundIdBytes, entryId).find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
      if (!mine) return refuse(`this signer node signed no result for ${toHex(entryId).slice(0, 16)}, so it settles nothing`);
      const r = decodePlayerResult(splitSignedResult(mine.bytes).body);
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
      const mine = this.round.results(roundIdBytes, entryIdBytes).find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
      const r = mine ? decodePlayerResult(splitSignedResult(mine.bytes).body) : null;
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
      const opened = await this.stakeSecrets.open({ roundId: roundIdBytes, entryId, needed: receiptsNeeded(got.contract.nodes.length) });
      if (!opened.ok) return refuse(`a loser's P could not be opened: ${opened.why}`);
      claims.push({ ...c, preimage: opened.preimage });
    }
    const port = await this.portForFederation(fid);
    if (!port || typeof port.settle !== 'function') return refuse(`this signer node cannot reach federation ${String(fid).slice(0, 16)}, so it builds nothing there`);
    const tx = await port.settle({ claimPk: got.claimPk, claims, payouts: s.payouts, nonce: s.nonce });
    const built = { ok: true, message: fromHex(tx.message), txid: tx.txid, settlement: s, plan: got.plan, claims, claimPk: got.claimPk,
      signerNode: got.held.signerNode, needed: receiptsNeeded(got.contract.nodes.length), federation: String(fid).toLowerCase() };
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
    const first = this.round.lockSettlement(roundIdBytes);
    if (!first || first.state !== ACCEPTED) return refuse('the round\'s own settlement is not accepted here yet, so no entry is late');
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
      const mine = this.round.results(roundIdBytes, entryIdBytes).find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
      if (!mine) return refuse('this signer node signed no result for that entry, so it settles nothing');
      const r = decodePlayerResult(splitSignedResult(mine.bytes).body);
      outcome = r.outcome; score = r.score;
    } else if (standing.state !== FORFEIT && standing.state !== VOID) {
      return refuse(`that entry is not decided: ${standing.state || 'without a result'}`);
    }
    const held = this.dkg.signerNodeFor(contract.nodes);
    if (!held.ok) return refuse(`this signer node holds no share of the round's claim key: ${held.why}`);
    const claimPk = held.pool.groupPublicKey;
    const e = found.entry;
    const entry = { pubkey: e.playerPubkey, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat, outcome, score };
    const fields = lockFieldsFromJson(lockRow.fields);
    if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('that lock names another claim key than the round\'s');
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
    let fees = this.fees.get(toHex(roundIdBytes));
    if (!fees) { fees = await (await this.portFor(roundIdBytes)).fees(); this.fees.set(toHex(roundIdBytes), fees); }
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
      const opened = await this.stakeSecrets.open({ roundId: roundIdBytes, entryId: entryIdBytes, needed: receiptsNeeded(contract.nodes.length) });
      if (!opened.ok) return refuse(`the late loser's P could not be opened: ${opened.why}`);
      if (fields.paymentImage.kind === 'point') {
        const point = this.curve.pointFromScalar(scalarFrom32(opened.preimage) % FIELD);
        if (toHex(point) !== toHex(fields.paymentImage.bytes)) return refuse('the P the signer nodes opened is not the scalar of the point the late lock names');
      }
      claims.push({ ...c, preimage: opened.preimage });
    }
    const tx = await (await this.portFor(roundIdBytes)).settle({ claimPk, claims, payouts: plan.payouts, nonce: plan.nonce });
    const built = { ok: true, message: fromHex(tx.message), txid: tx.txid, plan, claims, claimPk,
      signerNode: held.signerNode, needed: receiptsNeeded(contract.nodes.length) };
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
    const voided = marketVoidOf(this.round, roundIdBytes, { contract: a.contract, manifest: a.plugin.manifest, held: a.held, nowMs: this.round.now ? this.round.now() : Date.now() });
    if (voided.voided) return { ok: false, state: 'VOID', why: `a market round that is not settled on any outcome: ${voided.why}`, outcome: 'VOID' };
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
    const held = heldOutcomes(this.round, roundIdBytes);
    return { contract, plugin: found.plugin, held,
      finality: outcomeFinality(held, { windowMs: contract.objectionWindowMs, nowMs: this.round.now ? this.round.now() : Date.now() }) };
  }

  /**
   * THE PLAN OF AN ATTESTED ROUND WHOSE OUTCOME IS FINAL (§0A.7a slice 2): its counted entries (a stake this seat saw), the
   * pari-mutuel table over them and the outcome, and `attestedLockSettlement` - the losers' stake locks and every fee lock
   * claimed, the winners paid their shares of the losing pool, the seats their §22A fee.
   */
  // THE CANCELS THE OTHER SEATS HOLD, pulled before a market is settled so every seat builds its table from
  // the same entries: each kept only if its player's session key signed it - a seat cannot forge one for anybody
  async #carryCancels(roundIdBytes) {
    for (const peer of this.peersFor(roundIdBytes)) {
      let body;
      try {
        const answer = await this.fetcher(`${peer}/cancels?round=${toHex(roundIdBytes)}`);
        if (!answer.ok) continue;
        body = await answer.json();
      } catch { continue; }
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
    await this.orderBook.carry(roundIdBytes);
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
        if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a lock of this round names another claim key than the round\'s');
        locks.set(toHex(e.playerPubkey), { outpoint: outpointOf(lock.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk, fields });
        lockEntry.set(toHex(e.playerPubkey), entryId);
      }
      const fl = this.round.feeLock ? this.round.feeLock(entryId) : null;
      if (fl) {
        const fields = lockFieldsFromJson(fl.fields);
        if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a fee lock of this round names another claim key than the round\'s');
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
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`);
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
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`);
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
    if (!entries.length) return refuse('an attested round with no counted entry: nothing is claimed');
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
        if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a lock of this round names another claim key than the round\'s');
        locks.set(toHex(e.pubkey), { outpoint: outpointOf(lock.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk, fields });
        lockEntry.set(toHex(e.pubkey), e.entryIdBytes);
      }
      const fl = this.round.feeLock ? this.round.feeLock(e.entryIdBytes) : null;
      if (fl) {
        const fields = lockFieldsFromJson(fl.fields);
        if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a fee lock of this round names another claim key than the round\'s');
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
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`);
    return { ok: true, plan, base: { plan, entryOf: lockEntry }, contract, claimPk, held, locks, lockEntry, table };
  }

  /**
   * SETTLE A LATE LOSER (slice C3b-1): the round's asker combines and submits, as for the round's own settlement; a
   * second attempt on an ACCEPTED one builds nothing. A signer node whose turn it is not, holding a signature it was
   * handed, asks the federation whether it went in: every claimed lock gone and a payout of that txid stored.
   */
  async settleLate(roundIdBytes, entryIdBytes) {
    if (this.#attestedOf(roundIdBytes)) return { ok: false, state: 'HELD', why: 'an attested round has no late entry: its picks are all in its one settlement' };
    const kept = this.round.lateLockSettlement(roundIdBytes, entryIdBytes);
    if (kept && kept.state === ACCEPTED) return { ok: true, kept: true, ...kept, sent: await this.sendLate(roundIdBytes, entryIdBytes) };
    const t = await this.turn(roundIdBytes);
    if (!t.mine) {
      if (kept && kept.state === SUBMITTING) {
        const m = await this.lateMessage(roundIdBytes, entryIdBytes);
        if (m.ok && m.txid === kept.txid && this.port && typeof this.port.status === 'function') {
          const held = async (o) => !!(await (await this.portFor(roundIdBytes)).status(o)).stored;
          let gone = 0;
          for (const c of m.claims) if (!(await held(c.outpoint))) gone++;
          let paid = 0;
          for (let i = 0; i < m.plan.payouts.length; i++) if (await held({ txid: fromHex(kept.txid), outIdx: BigInt(i) })) paid++;
          if (gone === m.claims.length && paid > 0) {
            const why = `found in the federation: ${gone} claimed lock(s) gone, ${paid} payout contract(s) stored`;
            this.round.putLateLockSettlement({ roundId: roundIdBytes, entryId: entryIdBytes, txid: kept.txid, message: kept.message,
              signature: kept.signature, state: ACCEPTED, why });
            return { ok: true, state: ACCEPTED, why, txid: kept.txid };
          }
        }
      }
      return refuse(`not this signer node's turn to combine: ${t.why}`, 409);
    }
    // THE LATE SEND PLANS FIRST, as for the round's own settlement: proposed here, checked by every peer, or nothing.
    if (this.winnings && !(kept && kept.state === SUBMITTING)) {
      const planned = await this.planLateSends(roundIdBytes, entryIdBytes);
      if (!planned.ok) return planned;
    }
    const m = await this.lateMessage(roundIdBytes, entryIdBytes);
    if (!m.ok) return m;
    let signature = kept && kept.signature && kept.txid === m.txid ? kept.signature : null;
    if (!signature) {
      const q = `round=${toHex(roundIdBytes)}&entry=${toHex(entryIdBytes)}`;
      const own = await this.commit(roundIdBytes, { entry: entryIdBytes });
      if (!own.ok) return own;
      const signers = [{ base: null, commitment: own.commitment }];
      const refused = [];
      for (const base of this.peersFor(roundIdBytes)) {
        try {
          const r = await this.fetcher(`${base}/settle-commit?${q}&txid=${m.txid}`, { method: 'POST' });
          if (!r.ok) { refused.push(`${base}: ${(await r.text()).trim()}`); continue; }
          signers.push({ base, commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] });
        } catch (e) { refused.push(`${base}: ${e.message}`); }
      }
      if (signers.length < m.needed)
        return refuse(`${signers.length} of the ${m.needed} signer nodes the late settlement needs committed to it: ${refused.join('; ')}`);
      const commitments = signers.map((x) => x.commitment).sort((a, b) => a.id - b.id);
      const shares = [];
      for (const x of signers) {
        if (x.base === null) {
          const mine = await this.share(roundIdBytes, commitments, { entry: entryIdBytes });
          if (!mine.ok) return mine;
          shares.push(mine.share);
          continue;
        }
        const r = await this.fetcher(`${x.base}/settle-share?${q}`, { method: 'POST', body: encodeCommitments(commitments) });
        if (!r.ok) return refuse(`${x.base} gave no share: ${(await r.text()).trim()}`);
        shares.push(decodeShare(new Uint8Array(await r.arrayBuffer())));
      }
      ({ signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve }));
      if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1)))
        return refuse('the combined late settlement signature does not verify under the round\'s claim key', 500);
      for (const x of signers) {
        if (x.base === null) continue;
        try { await this.fetcher(`${x.base}/settle-signature?${q}`, { method: 'POST', body: signature }); } catch { /* it asks again */ }
      }
    }
    this.round.putLateLockSettlement({ roundId: roundIdBytes, entryId: entryIdBytes, txid: m.txid, message: m.message, signature, state: SUBMITTING,
      why: 'about to submit; if this signer node dies here, ask the federation for the claimed lock' });
    const sent = await (await this.portFor(roundIdBytes)).settle({ claimPk: m.claimPk, claims: m.claims, payouts: m.plan.payouts, nonce: m.plan.nonce, signature });
    const state = sent.accepted ? ACCEPTED : REFUSED;
    const why = sent.accepted
      ? `claimed the late loser's lock, ${m.plan.poolMsat} msat; paid ${m.plan.payouts.filter((p) => p.kind !== 'signer node').length} winner(s) ${m.plan.paidMsat} msat`
        + `${m.plan.feeClaims && m.plan.feeClaims.length ? `; its fee lock ${m.plan.feePoolMsat} msat to ${m.plan.signerNodePayouts.length} signer node(s)` : ''}`
      : `the guardians refused it: ${sent.error}`;
    this.round.putLateLockSettlement({ roundId: roundIdBytes, entryId: entryIdBytes, txid: m.txid, message: m.message, signature, state, why });
    const winnings = sent.accepted ? await this.sendLate(roundIdBytes, entryIdBytes) : null;
    return { ok: sent.accepted, state, why, txid: m.txid, signature, plan: m.plan, answer: sent, winnings };
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
        peersFor: o.peersFor, fetcher: o.fetcher, lnurlFetch: o.lnurlFetch, network: o.network, scopeParam: `&late=${toHex(entryIdBytes)}` });
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

  /** A PEER'S TAKE of the asker's late send plans, checked against its own late base plan. */
  async takeLateSends(roundIdBytes, entryIdBytes, proposed) {
    if (!this.winnings) return refuse('this signer node sends no winnings');
    const got = await this.lateMessage(roundIdBytes, entryIdBytes, { onlyBase: true });
    if (!got.ok) return got;
    const checked = await this.lateWinningsFor(roundIdBytes, entryIdBytes).check(roundIdBytes, got.base, proposed);
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
    const m = await this.lateMessage(roundIdBytes, entryIdBytes);
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
    const { plan, contract, claimPk, held, locks, lockEntry } = got;
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
      const opened = await this.stakeSecrets.open({ roundId: roundIdBytes, entryId, needed: receiptsNeeded(contract.nodes.length) });
      if (!opened.ok) return refuse(`a loser's P could not be opened: ${opened.why}`);
      const lock = locks.get(toHex(c.pubkey));
      if (lock.fields.paymentImage.kind === 'point') {
        const point = this.curve.pointFromScalar(scalarFrom32(opened.preimage) % FIELD);
        if (toHex(point) !== toHex(lock.fields.paymentImage.bytes))
          return refuse('the P the signer nodes opened is not the scalar of the point that loser\'s lock names');
      }
      claims.push({ ...c, preimage: opened.preimage });
    }
    const tx = await (await this.portFor(roundIdBytes)).settle({ claimPk, claims, payouts: plan.payouts, nonce: plan.nonce });
    const built = { ok: true, message: fromHex(tx.message), txid: tx.txid, plan, claims, claimPk,
      signerNode: held.signerNode, needed: receiptsNeeded(contract.nodes.length) };
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
    const held = this.dkg.signerNodeFor(contract.nodes);
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

    const on = this.entriesOnRecord(roundIdBytes, contract);
    if (!on.ok) return on;
    // THE GAME'S PAYOUT RULE: §18A's curve or its manifest's top split - the table every seat settles by
    const rule = payoutRuleOfRound(contract, this.round.plugins);
    if (!rule.ok) return refuse(`no lock is claimed: ${rule.why}`);
    const payoutShares = rule.payoutShares;
    const locks = new Map();
    const lockEntry = new Map();
    for (const e of on.entries) {
      const lock = this.round.stakeLock(e.entryId);
      if (!lock) continue;
      const fields = lockFieldsFromJson(lock.fields);
      if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a lock of this round names another claim key than the round\'s');
      locks.set(toHex(e.pubkey), { outpoint: outpointOf(lock.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk, fields });
      lockEntry.set(toHex(e.pubkey), e.entryId);
    }
    // AND EVERY FEE LOCK THIS SIGNER NODE VERIFIED (Pick A), with the F its entry hands over.
    const feeLocks = new Map();
    for (const e of on.entries) {
      const fl = this.round.feeLock ? this.round.feeLock(e.entryId) : null;
      if (!fl) continue;
      const fields = lockFieldsFromJson(fl.fields);
      if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a fee lock of this round names another claim key than the round\'s');
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
      return { ok: true, anyFed: true, plan: got.plan, split: got.split, base: { plan: got.plan, entryOf: lockEntry }, contract, claimPk, held, locks, lockEntry };
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
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`);
    const base = { plan, entryOf: lockEntry };
    // THE PLAN THAT IS SIGNED pays every addressed qualifier by its accepted send - never by a contract its key moves.
    if (withSends && plan.payouts.some((p) => p.kind === 'qualifier' || p.kind === 'donation')) {
      if (!this.winnings) return refuse('this signer node sends no winnings, so it builds no payout to a named address');
      plan = lockSettlement({ ...args, sends: this.winnings.sendsFor(roundIdBytes, base, claimPk), requireSends: true });
      if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    }
    return { ok: true, plan, base, contract, claimPk, held, locks, lockEntry };
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

  /** ROUND ONE: this signer node's nonce commitment for the settlement it would sign. */
  async commit(roundIdBytes, { txid = null, entry = null, federation = null } = {}) {
    const m = federation ? await this.fedMessage(roundIdBytes, federation) : entry ? await this.lateMessage(roundIdBytes, entry) : await this.message(roundIdBytes);
    if (!m.ok) return m;
    // A COMMITMENT ONLY TO THE BYTES THE ASKER BUILT (measured on a 5-of-7): a signer node that rebuilt another
    // settlement - it saw a run end differently - would otherwise commit, and its share over its own bytes spoils the
    // combined signature for everyone. It refuses by name, and the threshold of the others decides.
    if (txid && String(txid).toLowerCase() !== String(m.txid).toLowerCase())
      return refuse(`this signer node rebuilt settlement ${String(m.txid).slice(0, 16)}, not ${String(txid).slice(0, 16)}: it commits to no other bytes`, 409);
    const key = federation ? `${toHex(roundIdBytes)}:fed:${String(federation).toLowerCase()}` : entry ? `${toHex(roundIdBytes)}:${toHex(entry)}` : toHex(roundIdBytes);
    let pair = this.pairs.get(key);
    if (!pair || toHex(pair.message) !== toHex(m.message)) {
      const hiding = nonceGenerate340(this.random(32), m.signerNode.share);
      const binding = nonceGenerate340(this.random(32), m.signerNode.share);
      pair = { message: m.message, hiding, binding, list: null, share: null,
        commitment: { id: m.signerNode.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
      this.pairs.set(key, pair);
    }
    return { ok: true, commitment: pair.commitment };
  }

  /** ROUND TWO: this signer node's signature share over the txid it rebuilt, for ONE commitment list. */
  async share(roundIdBytes, commitments, { entry = null, federation = null } = {}) {
    const m = federation ? await this.fedMessage(roundIdBytes, federation) : entry ? await this.lateMessage(roundIdBytes, entry) : await this.message(roundIdBytes);
    if (!m.ok) return m;
    const pair = this.pairs.get(federation ? `${toHex(roundIdBytes)}:fed:${String(federation).toLowerCase()}` : entry ? `${toHex(roundIdBytes)}:${toHex(entry)}` : toHex(roundIdBytes));
    if (!pair || toHex(pair.message) !== toHex(m.message)) return refuse('this signer node committed to no settlement of that round');
    const own = commitments.find((c) => String(c.id) === String(pair.commitment.id));
    if (!own || toHex(own.hiding) !== toHex(pair.commitment.hiding) || toHex(own.binding) !== toHex(pair.commitment.binding))
      return refuse('that list does not carry this signer node\'s own commitment');
    if (commitments.length < m.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${m.needed}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse('this signer node signed that settlement over another list, and keeps no second pair');
    if (pair.share === null) {
      pair.share = signShare340({ id: pair.commitment.id, share: m.signerNode.share, groupPublicKey: m.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message: m.message, commitments, curve: this.curve });
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /** A combined signature handed over by a peer: kept only if it verifies over what THIS signer node rebuilt. */
  async take(roundIdBytes, signature, { entry = null, federation = null } = {}) {
    const m = federation ? await this.fedMessage(roundIdBytes, federation) : entry ? await this.lateMessage(roundIdBytes, entry) : await this.message(roundIdBytes);
    if (!m.ok) return m;
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return refuse('that settlement signature does not verify under the round\'s claim key');
    if (federation) {
      const held = this.round.fedLockSettlement(roundIdBytes, federation);
      if (!held || (held.state === SUBMITTING && held.txid !== m.txid))
        this.round.putFedLockSettlement({ roundId: roundIdBytes, federation, txid: m.txid, message: m.message, signature, state: SUBMITTING,
          why: 'signed by the signer nodes; submitted by the signer node that combined it' });
      return { ok: true };
    }
    if (entry) {
      const held = this.round.lateLockSettlement(roundIdBytes, entry);
      if (!held || (held.state === SUBMITTING && held.txid !== m.txid))
        this.round.putLateLockSettlement({ roundId: roundIdBytes, entryId: entry, txid: m.txid, message: m.message, signature, state: SUBMITTING,
          why: 'signed by the signer nodes; submitted by the signer node that combined it' });
      return { ok: true };
    }
    // A SIGNATURE OVER THE BYTES THIS SIGNER NODE REBUILDS NOW replaces a SUBMITTING row of other bytes: the proposer
    // re-signs only after the federation answered that the old settlement is not in (measured: after a fee-rule change
    // across a restart, the proposer held ACCEPTED on the new txid and this node SUBMITTING on the old one for good).
    const held = this.round.lockSettlement(roundIdBytes);
    if (!held || (held.state === SUBMITTING && held.txid !== m.txid)) {
      this.keepMoves(roundIdBytes, m);
      this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state: SUBMITTING,
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
    this.round.putLockSettlementMoves({ roundId: roundIdBytes, txid: m.txid,
      claims: m.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`), payouts: m.plan.payouts.length });
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
    const moves = this.round.lockSettlementMoves(roundIdBytes);
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
    // payout contract(s) stored" after the winner was paid). Its preimage, held here only if it hashes to the invoice
    // the settlement's contract named, is the proof that contract was made - so every claimed lock gone and a paid
    // winning of this round held is IN. A lock that left by its own refund, with nothing paid, is still neither.
    if (paid === 0 && locksGone === moves.claims.length && this.winnings) {
      const paidSends = this.round.sendAttemptsOf(roundIdBytes).filter((r) => r.state === 'PAID' && r.preimage);
      if (paidSends.length) return { verdict: 'in', why: `${seen}; ${paidSends.length} sent winning(s) of this round paid, the preimage held here` };
    }
    if (paid === 0 && locksGone === 0) return { verdict: 'out', why: seen };
    return { verdict: 'mixed', why: seen };
  }

  /**
   * A SIGNER NODE STARTED AGAIN ASKS ABOUT EVERY SETTLEMENT IT WAS INSIDE (W6): each round it holds as
   * SUBMITTING goes through settle(), which asks the federation before anything else.
   */
  async recover() {
    const out = [];
    for (const rid of this.round.lockSettlementsIn(SUBMITTING)) {
      const got = await this.settle(rid).catch((e) => ({ ok: false, why: e.message }));
      out.push({ round: toHex(rid), ok: !!got.ok, state: got.state || (this.round.lockSettlement(rid) || {}).state, why: got.why });
    }
    return out;
  }

  /**
   * THE SETTLEMENT, made now with the other signer nodes if this signer node holds none: the
   * combined signature checked under the claim key, the intent written, the
   * transaction submitted, and the guardians' answer kept.
   */
  async settle(roundIdBytes) {
    // ONE SETTLE OF A ROUND AT A TIME (measured 2026-10-10 on the regtest Up/Down market: the attested sweep asks
    // every 5 s, a settle of a book round with 26 locks ran longer than that, and the asks piled up - 80 blwp-stake-lock
    // processes at once over the one client database, each killed at its timeout, and the round never settled). A second
    // ask while one runs waits for that one's answer instead of starting another.
    const k = toHex(roundIdBytes);
    if (this.#settling.has(k)) return this.#settling.get(k);
    const p = this.#settleOnce(roundIdBytes).finally(() => this.#settling.delete(k));
    this.#settling.set(k, p);
    return p;
  }
  #settling = new Map();

  async #settleOnce(roundIdBytes) {
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
      const saw = await this.federationSaw(roundIdBytes, kept);
      if (saw.verdict === 'in') {
        const why = `found in the federation after this signer node was inside it: ${saw.why}`;
        this.round.putLockSettlement({ roundId: roundIdBytes, txid: kept.txid, message: kept.message, signature: kept.signature, state: ACCEPTED, why });
        // ITS DONATION-KEY OUTPUTS, RESTART OR NOT: from the plan kept in memory, else rebuilt from the store
        // and indexed only when it is the plan that was signed
        await this.indexRecovered(roundIdBytes, kept.txid);
        return { ok: true, state: ACCEPTED, why, txid: kept.txid, signature: kept.signature, recovered: true };
      }
      if (saw.verdict === 'mixed') {
        const why = `neither in nor out - not settled here, not submitted again: ${saw.why}`;
        this.round.putLockSettlement({ roundId: roundIdBytes, txid: kept.txid, message: kept.message, signature: kept.signature, state: SUBMITTING, why });
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
        return refuse(`not this signer node's turn to combine: ${t.why}`, 409);
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
        if (planned.peerRefused) this.retryPlan(roundIdBytes);
        return planned;
      }
      this.planRetries.delete(toHex(roundIdBytes));
    }
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    // THE KEPT SIGNATURE ONLY OVER THE BYTES IT SIGNED: a plan rebuilt differently is signed afresh.
    let signature = kept && kept.signature && kept.txid === m.txid ? kept.signature : null;
    if (!signature) {
      const q = `round=${toHex(roundIdBytes)}`;
      const own = await this.commit(roundIdBytes);
      if (!own.ok) return own;
      const signers = [{ base: null, commitment: own.commitment }];
      const refused = [];
      for (const base of this.peersFor(roundIdBytes)) {
        try {
          const r = await this.fetcher(`${base}/settle-commit?${q}&txid=${m.txid}`, { method: 'POST' });
          if (!r.ok) { refused.push(`${base}: ${(await r.text()).trim()}`); continue; }
          signers.push({ base, commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] });
        } catch (e) { refused.push(`${base}: ${e.message}`); }
      }
      if (signers.length < m.needed)
        return refuse(`${signers.length} of the ${m.needed} signer nodes the settlement needs committed to it: ${refused.join('; ')}`);
      const commitments = signers.map((s) => s.commitment).sort((a, b) => a.id - b.id);
      const shares = [];
      for (const s of signers) {
        if (s.base === null) {
          const mine = await this.share(roundIdBytes, commitments);
          if (!mine.ok) return mine;
          shares.push(mine.share);
          continue;
        }
        const r = await this.fetcher(`${s.base}/settle-share?${q}`, { method: 'POST', body: encodeCommitments(commitments) });
        if (!r.ok) return refuse(`${s.base} gave no share: ${(await r.text()).trim()}`);
        shares.push(decodeShare(new Uint8Array(await r.arrayBuffer())));
      }
      ({ signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve }));
      if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1)))
        return refuse('the combined settlement signature does not verify under the round\'s claim key', 500);
      for (const s of signers) {
        if (s.base === null) continue;
        try { await this.fetcher(`${s.base}/settle-signature?${q}`, { method: 'POST', body: signature }); } catch { /* it asks again */ }
      }
    }
    // THE INTENT IS ON DISK BEFORE THE SUBMIT, as a hold's settle is: a signer node that
    // dies here comes back knowing it signed, and asks the federation.
    this.keepMoves(roundIdBytes, m);
    this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state: SUBMITTING,
      why: 'about to submit; if this signer node dies here, ask the federation for the claimed locks' });
    const sent = await (await this.portFor(roundIdBytes)).settle({ claimPk: m.claimPk, claims: m.claims, payouts: m.plan.payouts, nonce: m.plan.nonce, signature });
    const state = sent.accepted ? ACCEPTED : REFUSED;
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
    this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state, why });
    if (sent.accepted) this.indexDonationKeys(roundIdBytes, m.txid, m.plan);
    const winnings = sent.accepted ? await this.sendWinnings(roundIdBytes) : null;
    return { ok: sent.accepted, state, why, txid: m.txid, signature, plan: m.plan, answer: sent, winnings };
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
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    if (this.winnings) {
      const t = await this.turn(roundIdBytes);
      if (!t.mine) return refuse(`not this signer node's turn to combine: ${t.why}`, 409);
    }
    this.keepFederationMoves(roundIdBytes, got);
    const results = [];
    for (const s of got.split.settlements) {
      const fid = s.federation;
      const kept = this.round.fedLockSettlement(roundIdBytes, fid);
      if (kept && kept.state === ACCEPTED) { results.push({ federation: fid, state: ACCEPTED, txid: kept.txid, kept: true }); continue; }
      const m = await this.fedMessage(roundIdBytes, fid);
      if (!m.ok) { results.push({ federation: fid, ok: false, why: m.why }); continue; }
      let signature = kept && kept.signature && kept.txid === m.txid ? kept.signature : null;
      if (!signature) {
        const q = `round=${toHex(roundIdBytes)}&federation=${fid}`;
        const own = await this.commit(roundIdBytes, { federation: fid });
        if (!own.ok) { results.push({ federation: fid, ok: false, why: own.why }); continue; }
        const signers = [{ base: null, commitment: own.commitment }];
        const refused = [];
        for (const base of this.peersFor(roundIdBytes)) {
          try {
            const r = await this.fetcher(`${base}/settle-commit?${q}&txid=${m.txid}`, { method: 'POST' });
            if (!r.ok) { refused.push(`${base}: ${(await r.text()).trim()}`); continue; }
            signers.push({ base, commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] });
          } catch (e) { refused.push(`${base}: ${e.message}`); }
        }
        if (signers.length < m.needed) { results.push({ federation: fid, ok: false, why: `${signers.length} of the ${m.needed} signer nodes committed: ${refused.join('; ')}` }); continue; }
        const commitments = signers.map((x) => x.commitment).sort((a, b) => a.id - b.id);
        const shares = [];
        let failed = null;
        for (const x of signers) {
          if (x.base === null) { const mine = await this.share(roundIdBytes, commitments, { federation: fid }); if (!mine.ok) { failed = mine.why; break; } shares.push(mine.share); continue; }
          const r = await this.fetcher(`${x.base}/settle-share?${q}`, { method: 'POST', body: encodeCommitments(commitments) });
          if (!r.ok) { failed = `${x.base} gave no share: ${(await r.text()).trim()}`; break; }
          shares.push(decodeShare(new Uint8Array(await r.arrayBuffer())));
        }
        if (failed) { results.push({ federation: fid, ok: false, why: failed }); continue; }
        ({ signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve }));
        if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) { results.push({ federation: fid, ok: false, why: 'the combined signature does not verify under the round\'s claim key' }); continue; }
        for (const x of signers) { if (x.base === null) continue; try { await this.fetcher(`${x.base}/settle-signature?${q}`, { method: 'POST', body: signature }); } catch { /* it asks again */ } }
      }
      this.round.putFedLockSettlement({ roundId: roundIdBytes, federation: fid, txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: 'about to submit; if this signer node dies here, ask the federation for the claimed locks' });
      const port = await this.portForFederation(fid);
      const sent = await port.settle({ claimPk: m.claimPk, claims: m.claims, payouts: s.payouts, nonce: s.nonce, signature });
      const state = sent.accepted ? ACCEPTED : REFUSED;
      const why = sent.accepted ? `federation ${fid.slice(0, 16)}: claimed ${s.claims.length} lock(s), ${s.poolMsat + s.feePoolMsat} msat; paid ${s.payouts.length} payout(s)`
        : `the guardians of federation ${fid.slice(0, 16)} refused it: ${sent.error}`;
      this.round.putFedLockSettlement({ roundId: roundIdBytes, federation: fid, txid: m.txid, message: m.message, signature, state, why });
      results.push({ federation: fid, ok: !!sent.accepted, state, txid: m.txid, why });
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
    const rows = plan.payouts.map((p, i) => ({ p, i })).filter(({ p, i }) => p.kind === 'donation key' && (!only || only.has(i))).map(({ p, i }) => ({
      outpoint: { txid: fromHex(String(txid)), outIdx: BigInt(i) }, entryId: p.donation.id, roundId: roundIdBytes, federationId,
      recipientPk: p.payoutPk, amountMsat: p.msat, contractId: `settlement:${i}` }));
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
    const keys = plan.payouts.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'donation key').map(({ i }) => i);
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
    if (!agreed.final)
      return { ...refuse(`${agreed.agreed} of the ${agreed.needed} seats the settlement needs signed the send plan, so nothing is settled: ${agreed.refused.join('; ')}`), peerRefused: true };
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
    const answers = [];
    for (const base of peers) {
      try {
        const r = await this.fetcher(`${base}/settle-sends?round=${query}`, { method: 'POST', body });
        if (!r.ok) { answers.push({ base, why: (await r.text()).trim() }); continue; }
        answers.push({ base, bytes: new Uint8Array(await r.arrayBuffer()) });
      } catch (e) { answers.push({ base, why: e.message }); }
    }
    const counted = countPlanTaken({ own, answers, seats: contract.nodes, planId });
    if (counted.final) {
      const certificate = joinCertificate(counted.certificate);
      this.planCertificates.set(lateEntryId ? `${toHex(roundIdBytes)}:${toHex(lateEntryId)}` : toHex(roundIdBytes), { planId, certificate });
      // EVERY SEAT HOLDS IT, not the asker alone: handed to each peer, which keeps it only if it stands against the plan
      // that peer kept itself (`takeCertificate`). A peer that misses it still signed its own acceptance.
      const body = new Uint8Array(32 + certificate.length); body.set(planId, 0); body.set(certificate, 32);
      for (const a of answers) {
        if (!a.bytes) continue;
        try { await this.fetcher(`${a.base}/settle-taken?round=${query}`, { method: 'POST', body }); } catch { /* it holds its own acceptance */ }
      }
    }
    return { ...counted, planId };
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
      seats: contract.nodes, planId });
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
    if (!ring.ok) return { mine: false, why: ring.why };
    const place = ring.order.findIndex((k) => toHex(k) === toHex(this.round.pubkey));
    if (place < 0) return { mine: false, place, why: 'this node is not one of the round\'s signer nodes' };
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
      : { mine: false, place, why: `this node is ${place} of ${ring.order.length} in the asker order and may take over at height ${beacon + place * 2}; the chain is at ${tip}` };
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
      if (!kept || kept.state !== SUBMITTING) return;
      this.settle(roundIdBytes)
        .then((got) => console.log(`[settle] ${toHex(roundIdBytes).slice(0, 16)} asked the federation (${n}): ${got.state || (got.ok ? 'ok' : 'not yet')} - ${String(got.why || '').slice(0, 140)}`))
        .catch(() => {});
    }, everyMs);
    if (t.unref) t.unref();
    this.retryTimers.add(t);
  }

  /** The plans this asker's peers keep, lowest-keyed first; the first that stands here is kept (see `check`). */
  async adoptPeerPlan(roundIdBytes, base) {
    const plans = [];
    for (const peer of this.peersFor(roundIdBytes)) {
      try {
        const r = await this.fetcher(`${peer}/settle-sends?round=${toHex(roundIdBytes)}`);
        if (!r.ok) continue;
        const rows = await r.json();
        if (Array.isArray(rows) && rows.length && !plans.some((p) => planKey(p) === planKey(rows))) plans.push(rows);
      } catch { /* a peer down: the others decide */ }
    }
    plans.sort((a, b) => (planKey(a) < planKey(b) ? -1 : 1));
    const mine = this.round.sendAttemptsOf(roundIdBytes).filter((x) => x.attempt === 0);
    for (const rows of plans) {
      if (mine.length && !(planKey(rows) < planKey(mine))) break;
      const took = await this.winnings.check(roundIdBytes, base, rows);
      if (took.ok) { this.built.delete(toHex(roundIdBytes)); return took; }
    }
    return null;
  }

  /** A PEER takes the coordinator's plans only if each stands here - and then rebuilds with them. */
  async takeSends(roundIdBytes, proposed) {
    if (!this.winnings) return refuse('this signer node sends no winnings');
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    const checked = await this.winnings.check(roundIdBytes, got.base, proposed);
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
    const m = await this.message(roundIdBytes);
    if (!m.ok) return [{ ok: false, why: m.why }];
    return this.winnings.sendAll(roundIdBytes, m);
  }
}

export { encodeCommitments, encodeShare, decodeCommitments };
