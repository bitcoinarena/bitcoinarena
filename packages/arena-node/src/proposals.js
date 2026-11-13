// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROPOSALS A SEAT KEEPS AND SERVES (spec §27A.7.2-3): a vote carries only proposal_id[0:8] (ballot.js), so a voter
// needs the full proposal from somewhere - the seats. A proposal is taken only when it stands on its face (proposalStands: signed by
// its proposer, activation after cooldown, deposit within the cap) and its deposit is on this seat's chain (depositOf, RULED option
// A): the proposer names the block its deposit_txid confirmed in, and the seat reads the transaction from that block itself.
//
//   POST /proposal   { proposal: hex of body || signature, blockHash: hex }   -> 201 { id, publishedAt, votingFrom, ... } or 422 why
//   GET  /proposals                                                            -> { proposals: [...] }, newest publication first
//
// A REPEAL (§27A.7.6) is read against the history live AT THE PROPOSAL'S PUBLICATION HEIGHT (`historyFor(net, height)`, the
// tally's - ballot-tally.js): the same answer at every seat, whenever it is asked. Until this seat has decided every proposal
// that activates at or before that height, it cannot know that history, and says so (503) rather than guess a schedule.
// ITS STATE, ONE ENUM AND ONE TRANSITION FUNCTION (kanban #1152): COUNTING (kept, in review or voting, or counted again) -> PASSED |
// FAILED (the outcome, written once at its depth, ballot-tally.js) -> COUNTING again only when the chain it was counted on changed
// below its anchor (a hash that differs, never an RPC error); and ORPHANED when its publication block left this seat's chain:
// kept with its bytes and its old outcome, never deleted, and COUNTING again when that block is back or the proposal is posted
// again from a new block. Each move is a compare-and-set on the state it leaves, and is written to the store BEFORE this
// seat's memory takes it: a write that fails leaves the proposal where it was.
import { decodeConfigProposalBody, proposalId, proposalStands, isRepeal, SCHEDULES, REPEAL_SCHEDULES } from '../../arena-protocol/src/ballot.js';
import { depositOf } from '../../arena-protocol/src/ballot-chain.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

/**
 * `confirmedTx(txidHex, blockHashHex)` -> { raw: Uint8Array, height } or null: the transaction from that block of this seat's
 * chain, and the block's height (main.js: getrawtransaction with the block hash, which needs no txindex). `recipientsFor(networkIdHex,
 * height)` -> the network's donation set in force at that height (its recipients), or null; `lowestBondMinSatsFor(networkIdHex)` -> BigInt; `verify(sig, msg, pubkey)`; `store`:
 * { read() -> [], write(list) }. `scheduleFor(net)` / `repealScheduleFor(net)`: the network's schedules (regtest's short ones);
 * `historyFor(net, height)` -> the live history at that height ([{ config }], liveConfig's), or null while it cannot be known yet;
 * none given: no proposal is read as a repeal (the first slice's behaviour). `censusAt(networkIdHex, height)` -> [{ pubkey }] or
 * null: the bonds active at that height (the tally's census, ballot-tally.js); given, a proposer outside it is refused (kanban #1489).
 * `tipHeight()` -> this seat's tip (or set later by the tally, `useTip`); given, a proposal first posted once its voting has begun is
 * refused (kanban #1608).
 * `blockHashAt(height)` -> this seat's block hash at that height, null above the tip (throws: no answer): given (here, or to
 * recheck by the tally), a kept record's proposer is judged only on the branch its publication block is on (kanban #2032).
 * `bindHeightFor(net)` -> the network's BALLOT_BIND_HEIGHT (ballot.js; none given: never bound, the old reading): a proposal whose
 * deposit confirmed at or above it is BOUND (ruled 2026-11-12, kanban #2125 / #2012) - its deposit must commit to its proposer
 * and bytes (ballot-chain.js depositOf), it is taken at any time (the commitment, not this seat's tip, fixes it before its voting),
 * and the tally reads its votes by seq (`bound(record)`).
 */
export const PROPOSAL_STATE = Object.freeze({ COUNTING: 'COUNTING', PASSED: 'PASSED', FAILED: 'FAILED', ORPHANED: 'ORPHANED' });
const S = PROPOSAL_STATE;
/** The only moves there are: anything else is refused. */
const MOVES = Object.freeze({ [S.COUNTING]: [S.PASSED, S.FAILED, S.ORPHANED], [S.PASSED]: [S.COUNTING, S.ORPHANED], [S.FAILED]: [S.COUNTING, S.ORPHANED],
  [S.ORPHANED]: [S.COUNTING] });
/** A kept record's state - a record written before kanban #1152 carries none, and reads as its `decided` says. */
export const stateOf = (r) => (r && S[r.state] ? r.state : r && r.orphaned ? S.ORPHANED : r && r.decided ? (r.decided.passed ? S.PASSED : S.FAILED) : S.COUNTING);

export function createProposals({ confirmedTx, recipientsFor, lowestBondMinSatsFor, verify, store, schedule = SCHEDULES.mainnet, scheduleFor = null,
  repealSchedule = REPEAL_SCHEDULES.mainnet, repealScheduleFor = null, historyFor = null, censusAt = null, tipHeight = null, blockHashAt = null, bindHeightFor = null }) {
  let tipOf = typeof tipHeight === 'function' ? tipHeight : null;
  /** BOUND: deposited at or above its network's BALLOT_BIND_HEIGHT (kanban #2125); below it, or with no gate given, the old reading. */
  const isBound = (net, height) => {
    if (typeof bindHeightFor !== 'function') return false;
    const gate = Number(bindHeightFor(net));
    return Number.isFinite(gate) && Number.isInteger(height) && height >= gate;
  };
  const held = new Map((store && store.read ? store.read() || [] : []).map((x) => [x.id, { ...x, state: stateOf(x) }]));
  // EVERY KEPT RECORD IS HELD TO THE CENSUS AGAIN ON LOAD (kanban #1670, after #1489): a record a seat kept on a build without the
  // proposer check (a never-bonded key, a 1-sat deposit) would otherwise stay COUNTING - served and tallied - or PASSED after the
  // upgrade. Nothing in a stored record proves its proposer was checked (a field saying so is the store's word, not the chain's),
  // so with `censusAt` given each one is UNCHECKED until `recheck` reads the census at its publication height: meanwhile it reads
  // as ORPHANED in this seat's memory (counted for nothing, not restorable, its outcome not live) while the store keeps the
  // record as it was. Bonded: it is back exactly as it was kept (a PASSED one keeps its outcome, nothing is counted again).
  // Not bonded: it is written ORPHANED with `unbonded` - kept with its bytes, never deleted, never restored from that block.
  const unchecked = new Map();              // id -> the record as stored, while its proposer is not checked yet
  const xOnly = (k) => { const h = typeof k === 'string' ? k.toLowerCase() : k ? toHex(Uint8Array.from(k)) : ''; return h.length === 66 ? h.slice(2) : h; };
  const asOrphan = (r, why, extra = {}) => {
    const { decided, orphaned, ...rest } = r;
    const was = stateOf(r) === S.ORPHANED && orphaned ? orphaned.was : stateOf(r);
    const outcome = decided || (orphaned && orphaned.outcome) || null;
    return { ...rest, state: S.ORPHANED, orphaned: { at: orphaned ? orphaned.at : null, why, was, ...(outcome ? { outcome } : {}), ...extra } };
  };
  // A DECIDED OUTCOME STAYS LIVE UNTIL THE CENSUS SHOWS ITS PROPOSER UNBONDED (kanban #1865, after #1670): a PASSED / FAILED record
  // is NOT hidden while its census is unreadable - a bitcoind warming up, main.js's 60 s hold after a failed block read, an old
  // height whose census takes minutes to derive. Hiding it rolled an activated config back to genesis on an ordinary restart:
  // GET /config named the old hash, rounds were created and served under the superseded config. Such a record is held as
  // stored and waits in `decidedUnchecked`; recheck orphans it (unbonded) only when the census it reads positively leaves its
  // proposer out. An open (COUNTING) or ORPHANED record is not live anyway, so it waits hidden as before - nothing is counted
  // for it until its proposer is checked.
  const decidedUnchecked = new Set();       // ids of PASSED / FAILED records held as stored while their proposer is not checked yet
  const uncheckedWhy = 'kept before this start: its proposer is checked against the census first (kanban #1670)';
  if (typeof censusAt === 'function') {
    for (const [id, r] of held) {
      if (stateOf(r) === S.PASSED || stateOf(r) === S.FAILED) { decidedUnchecked.add(id); continue; }
      unchecked.set(id, r);
      held.set(id, asOrphan(r, uncheckedWhy, { unchecked: true }));
    }
  }
  /**
   * WRITTEN FIRST: the store takes `next` (or throws), and only then this seat's memory. A record not checked yet is written as it was stored.
   * A decided record not checked yet that leaves its outcome (a reorg: undecided or orphaned, kanban #1865) is written as it
   * moves but waits for its proposer check hidden, like a record loaded open: nothing is counted or restored for it unchecked.
   */
  const commit = (next) => {
    if (store && store.write) store.write([...held.values()].filter((x) => x.id !== next.id).map((x) => unchecked.get(x.id) || x).concat([next]));
    unchecked.delete(next.id);
    if (decidedUnchecked.has(next.id) && stateOf(next) !== S.PASSED && stateOf(next) !== S.FAILED) {
      decidedUnchecked.delete(next.id);
      unchecked.set(next.id, next);
      held.set(next.id, asOrphan(next, uncheckedWhy, { unchecked: true }));
      return;
    }
    held.set(next.id, next);
  };
  /**
   * THE ONE TRANSITION: `id` from state `from` to state `to` - false when it is not in `from` (compare-and-set), the move is not
   * one there is, or the store did not take it. `outcome` (to PASSED / FAILED: the tally, its `passed` agreeing with `to`),
   * `record` (ORPHANED -> COUNTING from a new block: the record add() checked), `at` (the tip), `why`.
   */
  function transition(id, from, to, { outcome = null, record = null, at = null, why = '' } = {}) {
    const had = held.get(id);
    if (!had || stateOf(had) !== from || !MOVES[from] || !MOVES[from].includes(to)) return false;
    // NOT CHECKED, OR NOT BONDED (kanban #1670): only add() - which checks the census - takes it back to COUNTING (`record`)
    if (from === S.ORPHANED && !record && had.orphaned && (had.orphaned.unchecked || had.orphaned.unbonded)) return false;
    let next;
    if (to === S.PASSED || to === S.FAILED) {
      if (!outcome || outcome.passed !== (to === S.PASSED)) return false;
      next = { ...had, state: to, decided: outcome };
    } else if (to === S.ORPHANED) {
      // kanban #1635: an outcome a recount held in force (undecided.outcome) is not carried on - an orphan is counted for nothing
      const { decided, undecided, ...rest } = had;
      const u = undecided ? (({ outcome: _o, ...x }) => x)(undecided) : null;
      next = { ...rest, ...(u ? { undecided: u } : {}), state: S.ORPHANED, orphaned: { at, why, was: from, ...(decided ? { outcome: decided } : {}) } };
    } else if (from === S.ORPHANED) {
      const { orphaned, ...rest } = record ? { ...record, orphaned: had.orphaned } : had;
      next = { ...rest, state: S.COUNTING, restored: { at, why, was: orphaned ? orphaned.was : null } };
    } else {
      const { decided, ...rest } = had;
      // kanban #1635: the replaced outcome is kept with the record, so ballot-tally.js holds it in force through a restart mid-recount
      next = { ...rest, state: S.COUNTING, undecided: { at: decided ? decided.decidedAt : null, was: from, why, ...(decided ? { outcome: decided } : {}) } };
    }
    try { commit(next); } catch { return false; }
    return true;
  }
  // ONE DEPOSIT, ONE PROPOSAL (kanban #1489, 27A.7.2 "a fixed price"): the deposit_txid a kept proposal names backs no other -
  // a proposal naming a deposit another kept one (in any state, orphaned too) already names is refused at the door, so the first
  // kept stays. A record kept before #1489 carries no depositTxid: it is read off its own bytes.
  const depositTxidOf = (r) => {
    if (r && typeof r.depositTxid === 'string') return r.depositTxid;
    try { const b = fromHex(String(r.proposal)); return toHex(decodeConfigProposalBody(b.subarray(0, b.length - 64)).depositTxid); } catch { return null; }
  };
  // A DEPOSIT ITS OWN PROPOSER SIGNED TWICE (kanban #1840): the first-kept rule above decided by ARRIVAL ORDER, so two proposals of
  // one proposer over one deposit (a resend with an edit, or both posted at once) reaching two seats in different orders left seat 1
  // counting A and seat 2 counting B, each refusing the other's in the peer pull for good - different configs live. Now such a
  // competitor is KEPT (and pulled) like any proposal, up to SAME_DEPOSIT_KEPT per deposit, and a deposit that backs more than
  // one kept proposal backs NONE: every one of them is void (counts(): not tallied, not live, phase 'void'). Contested is monotonic
  // and read from the set alone, so every seat that holds two of them answers the same. Another proposer naming a kept deposit
  // is still refused by name (the deposit is not his).
  const SAME_DEPOSIT_KEPT = 8;
  const backedBy = (depositHex, id, proposerHex = null) => [...held.values()].find((r) => r.id !== id && depositTxidOf(r) === depositHex
    && (proposerHex === null || String(r.proposer || '').toLowerCase() !== proposerHex)) || null;
  const sameDeposit = (depositHex, id) => [...held.values()].filter((r) => r.id !== id && depositTxidOf(r) === depositHex);
  /** COUNTED: the only kept proposal its deposit backs (kanban #1840). */
  const counts = (id) => { const r = held.get(id); if (!r) return false; const d = depositTxidOf(r); return !!d && sameDeposit(d, id).length === 0; };
  // THE CENSUS OF A KEPT RECORD'S OWN BRANCH (kanban #2032, after #1670 / #1865): a restart while a reorg has taken out its
  // publication block (and a fresh bond with it) read the census of ANOTHER branch, which left the proposer out - and the
  // record was written `unbonded` for good, never restored when its block came back. With a block reader the census is read
  // only while the block at its publication height IS its block (read before and after the census); otherwise it waits (null).
  // Without one, the census alone as before. Answers the census (`ownBranch` true when the branch was checked) or null.
  const OTHER_BRANCH = Object.freeze({ other: true });
  const confirmedUnbonded = new Set();      // ids of unbonded records whose census was read on their own block: settled for good
  const withoutUnbonded = (r) => {
    const { unbonded: _u, unchecked: _c, ...o } = r.orphaned || {};
    return { ...r, state: S.ORPHANED, orphaned: { ...o, why: 'its proposer is bonded on the branch of its publication block (kanban #2032)' } };
  };
  async function ownCensus(r, reader) {
    const own = reader && r.blockHash ? String(r.blockHash).toLowerCase() : null;
    // 'same' | 'other' (a hash that differs: evidence) | 'none' (above the tip, or no answer: no evidence either way)
    const onIt = async () => { try { const h = await reader(r.publishedAt); return !h ? 'none' : String(h).toLowerCase() === own ? 'same' : 'other'; } catch { return 'none'; } };
    if (own) { const w = await onIt(); if (w !== 'same') return w === 'other' ? OTHER_BRANCH : null; }
    let census = null;
    try { census = await censusAt(r.networkId, r.publishedAt); } catch { census = null; }
    if (!Array.isArray(census)) return null;
    if (own && (await onIt()) !== 'same') return null;                      // the branch moved while the census was read
    const out = census.slice(); out.ownBranch = !!own;
    return out;
  }
  const api = {
    async add({ proposal: hex, blockHash }) {
      if (!/^[0-9a-f]+$/i.test(String(hex || '')) || String(hex).length < 130) return { ok: false, status: 400, why: 'a proposal is the hex of its body and its 64-byte signature' };
      if (!/^[0-9a-f]{64}$/i.test(String(blockHash || ''))) return { ok: false, status: 400, why: 'name the block its deposit confirmed in (blockHash, 64 hex)' };
      const bytes = fromHex(String(hex).toLowerCase());
      let p;
      try { p = { ...decodeConfigProposalBody(bytes.subarray(0, bytes.length - 64)), signature: bytes.slice(bytes.length - 64) }; }
      catch (e) { return { ok: false, status: 400, why: `that is no config proposal: ${e.message}` }; }
      const id = toHex(proposalId(p));
      // KEPT ALREADY - unless orphaned and named from another block: then it is checked again, and taken from that block
      const was = held.get(id);
      if (was && (stateOf(was) !== S.ORPHANED || was.blockHash === String(blockHash).toLowerCase())) return { ok: true, status: 200, ...was, already: true };
      const net = toHex(p.networkId);
      const depositHex = toHex(p.depositTxid);
      const tx = await confirmedTx(toHex(Uint8Array.from(p.depositTxid).reverse()), String(blockHash).toLowerCase());
      if (!tx) return { ok: false, status: 422, why: 'that block of this seat\'s chain does not hold the deposit the proposal names' };
      // the network's donation set IN FORCE AT THE DEPOSIT'S HEIGHT (27A.4): the set the deposit had to pay
      const recipients = recipientsFor(net, tx.height);
      if (!recipients) return { ok: false, status: 422, why: `this seat knows no donation set in force for that network at height ${tx.height}` };
      const bound = isBound(net, tx.height);
      const dep = depositOf({ raw: tx.raw, height: tx.height, proposal: p, recipients, bound });
      if (!dep.ok) return { ok: false, status: 422, why: dep.why };
      // THE HISTORY A REPEAL IS READ AGAINST: the configs live before, at the height it was published at (27A.7.6)
      const history = historyFor ? historyFor(net, dep.publishedAt) : null;
      if (historyFor && !history)
        return { ok: false, status: 503, why: `this seat has not yet decided every proposal that activates by height ${dep.publishedAt}, so it cannot yet say whether this one is a repeal: ask again shortly` };
      const stands = proposalStands(p, { publishedAt: dep.publishedAt, depositSats: dep.depositSats, lowestBondMinSats: lowestBondMinSatsFor(net),
        schedule: (scheduleFor && scheduleFor(net)) || schedule, repealSchedule: (repealScheduleFor && repealScheduleFor(net)) || repealSchedule, verify, history });
      if (!stands.ok) return { ok: false, status: 422, why: stands.why };
      // SEEN BEFORE ITS VOTING (kanban #1608): the deposit commits to nothing of the proposal and a vote names only
      // proposal_id[0:8], so a proposer could confirm a deposit, vote YES alone, and post the proposal only after its voting phase
      // and activation - counted on his own vote, and live retroactively under rounds this seat served. Taken only while this
      // seat's tip is below its first voting block (a review-0 repeal, whose voting starts at its own block: at that block).
      // Mainnet's review is 1008 blocks, time enough for every seat to hear of it (POST or the peer pull). A tip not read is a 503.
      // BOUND (ruling #2012 (c)): the deposit commits to these bytes and confirmed at the publication height - before the first
      // voting block (votingFrom >= publishedAt: a repeal's review 0 votes from that very block) - so the chain, not this seat's
      // tip, says it was there in time: a late pull is as good as an early POST, and every seat that hears of it takes it.
      if (bound) {
        if (!(dep.publishedAt <= stands.votingFrom)) return { ok: false, status: 422, why: `its deposit confirmed at ${dep.publishedAt}, after its first voting block ${stands.votingFrom}` };
      } else if (tipOf) {
        let tip = NaN;
        try { tip = Number(await tipOf()); } catch { tip = NaN; }
        if (!Number.isFinite(tip)) return { ok: false, status: 503, why: 'this seat could not read its tip: ask again shortly' };
        if (tip >= Math.max(stands.votingFrom, dep.publishedAt + 1))
          return { ok: false, status: 422, why: `its voting began at ${stands.votingFrom} and this seat's tip is ${tip}: a proposal must be posted before its voting phase` };
      }
      // THE PROPOSER IS A BONDED NODE (27A.7.2 "node pubkey with an active bond", kanban #1489): its key is in the census at the
      // publication height - the census the tally counts with. A fresh key with a 1-sat deposit took the ballot before; now refused
      // at the door. A census not readable yet is a 503 (ask again), never a guess.
      if (typeof censusAt === 'function') {
        let census = null;
        try { census = await censusAt(net, dep.publishedAt); } catch { census = null; }
        if (!Array.isArray(census)) return { ok: false, status: 503, why: `this seat cannot read the census at height ${dep.publishedAt} yet: ask again shortly` };
        const me = xOnly(p.proposer);
        if (!census.some((e) => e && xOnly(e.pubkey) === me))
          return { ok: false, status: 422, why: `the proposer holds no active bond in the census at height ${dep.publishedAt} (27A.7.2)` };
      }
      // checked on a proposal that stands on its face and on the chain: refused by its own fault first, then by the deposit (#1489)
      const other = backedBy(depositHex, id, toHex(p.proposer));
      if (other) return { ok: false, status: 409, why: `that deposit (deposit_txid) already backs proposal ${other.id}: one deposit pays for one proposal` };
      // A BOUND TWIN ONCE THE VOTING BEGAN (kanban #2590): the deposit commits to the body, not the signature, and proposal_id covers the
      // signature - so the proposer can sign the same body again and the twin passes depositOf. Taken at any time (#2562), it voided the
      // first (#1840) after its vote had passed and activated: one proposer undoing a vote. A second proposal over a deposit this seat
      // already keeps is taken only while the tip is below its first voting block - the #1608 tip check, kept for twins alone.
      if (bound && sameDeposit(depositHex, id).length && tipOf) {
        let tip = NaN;
        try { tip = Number(await tipOf()); } catch { tip = NaN; }
        if (!Number.isFinite(tip)) return { ok: false, status: 503, why: 'this seat could not read its tip: ask again shortly' };
        if (tip >= stands.votingFrom)
          return { ok: false, status: 409, why: `that deposit already backs a proposal of this proposer whose voting began at ${stands.votingFrom} (tip ${tip}): a second one signed over it is refused` };
      }
      if (sameDeposit(depositHex, id).length >= SAME_DEPOSIT_KEPT)
        return { ok: false, status: 409, why: `that deposit already backs ${SAME_DEPOSIT_KEPT} proposals of this proposer: all of them are void (kanban #1840)` };
      const kept = { id, proposal: toHex(bytes), networkId: net, parent: toHex(p.parent), configHash: toHex(p.configHash), class: stands.class,
        proposer: toHex(p.proposer), publishedAt: dep.publishedAt, depositSats: String(dep.depositSats), votingFrom: stands.votingFrom,
        votingUntil: stands.votingUntil, activationHeight: stands.activationHeight, repeal: stands.repeal, depositTxid: depositHex,
        // THE BLOCK IT WAS PUBLISHED IN: a reorg that takes it out unpublishes the proposal (ballot-tally.js)
        blockHash: String(blockHash).toLowerCase(), state: S.COUNTING };
      // TAKEN AGAIN FROM A NEW BLOCK: the orphaned record moves back to COUNTING with the record checked here
      if (was) {
        if (!transition(id, S.ORPHANED, S.COUNTING, { record: kept, at: dep.publishedAt, why: 'posted again from a block of this chain' }))
          return held.has(id) ? { ok: true, status: 200, ...held.get(id), already: true } : { ok: false, status: 409, why: 'that proposal moved while it was checked: ask again' };
        return { ok: true, status: 201, ...held.get(id) };
      }
      if (held.has(id)) return { ok: true, status: 200, ...held.get(id), already: true };   // taken by another ask while this one read the chain
      try { commit(kept); } catch (e) { return { ok: false, status: 503, why: `this seat could not keep it: ${e.message}` }; }
      return { ok: true, status: 201, ...kept };
    },
    list: () => [...held.values()].sort((a, b) => b.publishedAt - a.publishedAt),
    /** Is a kept record read bound (kanban #2125): its votes by seq. From its network's gate and its publication height, never the store's word. */
    bound: (r) => !!r && isBound(r.networkId, Number(r.publishedAt)),
    counts,
    /** THE TIP add() reads (kanban #1608), handed by the tally when none was given here. */
    useTip(fn) { if (!tipOf && typeof fn === 'function') tipOf = fn; },
    /** How many kept records of `net` (any network: none given) wait for their proposer check (kanban #1670). */
    unchecked: (net = null) => [...unchecked.values()].filter((r) => net === null || r.networkId === net).length
      + [...decidedUnchecked].filter((id) => net === null || (held.get(id) && held.get(id).networkId === net)).length,
    /**
     * How many hidden unchecked records of `net` were stored OPEN (COUNTING) and activate by `height` (kanban #1865): only these
     * leave the history at `height` unknown (ballot-tally historyAt). A decided one is held with its outcome; an orphaned one is
     * live for nothing either way - neither blocks a new proposal's repeal reading for good when its census never comes back.
     */
    openUnchecked: (net, height) => [...unchecked.values()].filter((r) => r.networkId === net && stateOf(r) === S.COUNTING
      && !(Number(r.activationHeight) > height)).length,
    /**
     * THE PROPOSER CHECK OF THE RECORDS KEPT BEFORE THIS START (kanban #1670): the census at each one's publication height,
     * the one add() asks. Bonded: the record is back as stored. Not bonded: written ORPHANED with `unbonded`. Census not
     * readable yet: it waits for the next call (ballot-tally runs one before each pass). Answers { restored, unbonded, waiting }.
     */
    async recheck({ blockHashAt: hashGiven = null } = {}) {
      const reader = typeof hashGiven === 'function' ? hashGiven : typeof blockHashAt === 'function' ? blockHashAt : null;
      let restored = 0, unbonded = 0, cleared = 0;
      for (const [id, r] of [...unchecked]) {
        const census = await ownCensus(r, reader);
        if (!census || unchecked.get(id) !== r) continue;          // not readable yet, or add() took it meanwhile
        if (census === OTHER_BRANCH) {
          // its publication block is not on this chain: no verdict on its proposer. An open one is orphaned plainly (as
          // followReorgs would have done in session) and waits, still unchecked, for its block - it holds no history up meanwhile
          if (stateOf(r) === S.COUNTING) {
            const next = asOrphan(r, 'its publication block left this chain');
            try {
              if (store && store.write) store.write([...held.values()].filter((x) => x.id !== id).map((x) => unchecked.get(x.id) || x).concat([next]));
              unchecked.set(id, next); held.set(id, asOrphan(next, uncheckedWhy, { unchecked: true }));
            } catch { /* the store did not take it: asked again */ }
          }
          continue;
        }
        if (census.some((e) => e && xOnly(e.pubkey) === xOnly(r.proposer))) {
          // bonded ON ITS OWN BRANCH: a stored `unbonded` (read on another branch by an earlier build, kanban #2032) is cleared
          if (census.ownBranch && r.orphaned && r.orphaned.unbonded) {
            try { commit(withoutUnbonded(r)); cleared++; } catch { /* the store did not take it: still unchecked, asked again */ }
            continue;
          }
          held.set(id, r); unchecked.delete(id); restored++; continue;
        }
        const next = asOrphan(r, `the proposer holds no active bond in the census at height ${r.publishedAt} (27A.7.2, kanban #1670)`, { unbonded: true });
        try { commit(next); unbonded++; } catch { /* the store did not take it: still unchecked, asked again */ }
      }
      // THE DECIDED ONES, HELD AS STORED (kanban #1865): orphaned only on a census that positively leaves the proposer out
      for (const id of [...decidedUnchecked]) {
        const r = held.get(id);
        if (!r) { decidedUnchecked.delete(id); continue; }
        const census = await ownCensus(r, reader);
        // not readable yet, not on its own branch (followReorgs orphans it, and it waits hidden for its block), or it moved
        if (!census || census === OTHER_BRANCH || !decidedUnchecked.has(id) || held.get(id) !== r) continue;
        if (census.some((e) => e && xOnly(e.pubkey) === xOnly(r.proposer))) { decidedUnchecked.delete(id); restored++; continue; }
        const next = asOrphan(r, `the proposer holds no active bond in the census at height ${r.publishedAt} (27A.7.2, kanban #1670)`, { unbonded: true });
        decidedUnchecked.delete(id);
        try { commit(next); unbonded++; } catch { decidedUnchecked.add(id); /* the store did not take it: still unchecked, asked again */ }
      }
      // AN `unbonded` READ ON ANOTHER BRANCH IS NO VERDICT (kanban #2032): each kept unbonded record is read once more on the
      // branch of its own publication block - bonded there, it is a plain orphan again, and restore brings it back with its block
      if (reader) for (const r of [...held.values()]) {
        if (unchecked.has(r.id) || stateOf(r) !== S.ORPHANED || !r.orphaned || !r.orphaned.unbonded || !r.blockHash) continue;
        if (confirmedUnbonded.has(r.id)) continue;
        const census = await ownCensus(r, reader);
        if (!census || census === OTHER_BRANCH || !census.ownBranch || held.get(r.id) !== r) continue;   // not on its own branch now: asked again later
        if (!census.some((e) => e && xOnly(e.pubkey) === xOnly(r.proposer))) { confirmedUnbonded.add(r.id); continue; }
        try { commit(withoutUnbonded(r)); cleared++; } catch { /* the store did not take it: asked again */ }
      }
      return { restored, unbonded, cleared, waiting: unchecked.size + decidedUnchecked.size };
    },
    /** How many kept `unbonded` records are not yet confirmed on their own branch (kanban #2032): the tally runs recheck for them. */
    toReview: () => [...held.values()].filter((r) => !unchecked.has(r.id) && stateOf(r) === S.ORPHANED && r.orphaned && r.orphaned.unbonded
      && r.blockHash && !confirmedUnbonded.has(r.id)).length,
    transition,
    /**
     * ITS SCHEDULE READ AGAIN (kanban #1631): whether a proposal is a repeal, and so its voting window (27A.7.6), is a function of
     * the history live at its publication height - not of what this seat had decided when the proposal reached it. A seat that
     * took a repeal before it heard of the proposal it repeals (posted to one seat, pulled 10 min later) read it against the
     * genesis alone and kept the ordinary schedule for good, so two seats counted different blocks and went live on different
     * configs. The tally (ballot-tally.js) asks this for every kept proposal on every pass, before it counts: 'pending' while
     * that history is not known here (a proposal activating by then is undecided: nothing of this one is counted or moved),
     * 'same', or 'moved' - the record's repeal / votingFrom / votingUntil rewritten from the history now (written FIRST, a
     * failed write moves nothing), a decided one back to COUNTING to be counted on its window, and one that no longer stands
     * on its face under that schedule (activation before the end of its cooldown) FAILED as void, held to its publication block.
     */
    reschedule(id, { at = null } = {}) {
      const had = held.get(id);
      const st = stateOf(had);
      if (!had || st === S.ORPHANED || !historyFor) return 'same';
      let p; try { const b = fromHex(String(had.proposal)); p = decodeConfigProposalBody(b.subarray(0, b.length - 64)); } catch { return 'same'; }
      const history = historyFor(had.networkId, had.publishedAt);
      if (!history) return 'pending';
      const repeal = isRepeal(p, history);
      const s = repeal ? ((repealScheduleFor && repealScheduleFor(had.networkId)) || repealSchedule) : ((scheduleFor && scheduleFor(had.networkId)) || schedule)[p.class];
      const votingFrom = had.publishedAt + s.review, votingUntil = votingFrom + s.voting, earliest = votingUntil + s.cooldown;
      const stands = p.activationHeight >= earliest;
      const isVoid = !!(had.decided && had.decided.void);
      if (repeal === !!had.repeal && votingFrom === had.votingFrom && votingUntil === had.votingUntil && stands === !isVoid) return 'same';
      const { decided, undecided, ...rest } = had;
      const rescheduled = { at, was: { state: st, repeal: !!had.repeal, votingFrom: had.votingFrom, votingUntil: had.votingUntil } };
      const next = stands
        ? { ...rest, repeal, votingFrom, votingUntil, state: S.COUNTING, rescheduled }
        : { ...rest, repeal, votingFrom, votingUntil, state: S.FAILED, rescheduled, decided: { passed: false, decidedAt: at,
          void: `activation_height ${p.activationHeight} is before the end of cooldown (${earliest}) under the history live at ${had.publishedAt}`,
          anchor: had.blockHash ? { height: had.publishedAt, hash: had.blockHash } : null } };
      if (held.get(id) !== had) return 'same';                          // compare-and-set: moved meanwhile, asked again next pass
      try { commit(next); } catch { return 'same'; }
      return 'moved';
    },
    /** THE OUTCOME, WRITTEN ONCE (ballot-tally.js): COUNTING -> PASSED | FAILED - not tallied again, across restarts too. */
    decide: (id, outcome) => transition(id, S.COUNTING, outcome && outcome.passed ? S.PASSED : S.FAILED, { outcome }),
    /** A REORG BELOW ITS DECISION - a hash that differs (ballot-tally.js): PASSED | FAILED -> COUNTING, counted again on the chain now. */
    undecide(id, why = 'the chain under its outcome changed') {
      const from = stateOf(held.get(id));
      return (from === S.PASSED || from === S.FAILED) && transition(id, from, S.COUNTING, { why });
    },
    /** ITS PUBLICATION BLOCK LEFT THE CHAIN (ballot-tally.js): kept with its bytes and its old outcome, counted for nothing, never deleted. */
    orphan(id, { at = null, why = 'its publication block left this chain' } = {}) {
      if (!held.has(id)) return false;
      const from = stateOf(held.get(id));
      return from !== S.ORPHANED && transition(id, from, S.ORPHANED, { at, why });
    },
    /** ITS PUBLICATION BLOCK IS ON THIS CHAIN AGAIN (ballot-tally.js): ORPHANED -> COUNTING, from the same record. */
    restore: (id, { at = null, why = 'its publication block is on this chain again' } = {}) => transition(id, S.ORPHANED, S.COUNTING, { at, why }),
    /**
     * THE PEER PULL (server.js: GET /proposals of the census seats): each record a peer keeps is checked by add, as if posted
     * here - nothing a peer says is taken on trust. Answers how many were taken.
     */
    async pull(records) {
      let took = 0;
      // OLDEST PUBLICATION FIRST (kanban #1842): a peer lists newest first, and a repeal taken before the proposal it repeals
      // read a history without it (an ordinary schedule here, a repeal at every other seat); oldest first, the earlier one is
      // held when the later one is checked (and 503s it until decided here). Bounded first, in the peer's order, as before.
      const asked = (Array.isArray(records) ? records : []).slice(0, 256)
        .map((r, i) => ({ r, i, at: r && Number.isFinite(Number(r.publishedAt)) ? Number(r.publishedAt) : Infinity }))
        .sort((a, b) => a.at - b.at || a.i - b.i).map((x) => x.r);
      for (const r of asked) {
        if (!r || typeof r.proposal !== 'string' || typeof r.blockHash !== 'string') continue;
        const mine = typeof r.id === 'string' ? held.get(r.id.toLowerCase()) : null;
        if (mine && stateOf(mine) !== S.ORPHANED) continue;             // kept and counted here: nothing to learn
        try { const got = await api.add({ proposal: r.proposal, blockHash: r.blockHash }); if (got.ok && got.status === 201) took++; } catch { /* not one */ }
      }
      return took;
    },
  };
  // the first check runs at once; the tally asks again before each pass for any census that was not readable yet
  if (unchecked.size || decidedUnchecked.size) api.recheck().catch(() => {});
  return api;
}
