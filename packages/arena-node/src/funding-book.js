// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FUNDING PROPOSALS A SEAT KEEPS (§27A.9.3 stage 1): every proposal, comment and signal it was handed - by its
// owner's own node, by a writer, or forwarded by another seat - checked, kept in its store and listed with the signal's state. Signals
// are signed messages the seats keep and pass on (2026-10-16), never on chain; they weigh one per node and move no money.
//
//   add(kind, hex)   a new object (body || 64-byte BIP340 signature): kept when it stands - a proposal by ANY key (2026-10-17:
//                    "Anyone can do a proposal to pay out"; its signal and vote stay with the bonded nodes) not dated ahead of this
//                    seat's chain, a comment or signal on a proposal held here; `fresh` when it was new (the server
//                    forwards it once)
//   list()           every proposal with its comments, its signals and its signal's state
//   decide()         each proposal whose signal period is over is decided ONCE, on the nodes active in the 432 blocks before its end
//                    (`activeAt(endHeight)`, from the seats' signed FINALs) - written down, so a seat's answer does not move later
import { readSignedFunding, signalOutcome, votePeriodOf, fundingTally, voteWeights, trancheSchedule, FUNDING_SCHEDULES, FUNDING_TRANCHES } from '../../arena-protocol/src/funding.js';
import { createHash } from 'node:crypto';
import { newerPlayerName, PLAYER_NAME_SKEW_MS } from '../../arena-protocol/src/player-name.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { countFeeChain } from '../../arena-protocol/src/fee-signal-chain.js';
import { feeProposalStands, feeProposalOutcome, feesAt as feesAtOf, FEES, FEES_TODAY, donationChanges, devMajority } from '../../arena-protocol/src/fee-proposal.js';
import { leaderboardVotePeriod, leaderboardPasses } from '../../arena-protocol/src/leaderboard-payout.js';

export const FUNDING_SQL = `CREATE TABLE IF NOT EXISTS funding_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, proposal TEXT NOT NULL, hex TEXT NOT NULL, at_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS funding_signal_ends (proposal TEXT PRIMARY KEY, seen_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS funding_outcomes (proposal TEXT PRIMARY KEY, outcome TEXT NOT NULL, decided_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS funding_vote_census (proposal TEXT PRIMARY KEY, height INTEGER NOT NULL, census TEXT NOT NULL, hash TEXT);
  CREATE TABLE IF NOT EXISTS funding_vote_blocks (proposal TEXT NOT NULL, height INTEGER NOT NULL, hash TEXT, votes TEXT NOT NULL, PRIMARY KEY (proposal, height));
  CREATE TABLE IF NOT EXISTS funding_vote_outcomes (proposal TEXT PRIMARY KEY, outcome TEXT NOT NULL, last_hash TEXT, decided_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS funding_payments (proposal TEXT PRIMARY KEY, tranches INTEGER NOT NULL, cancelled TEXT, cancelled_k INTEGER);
  CREATE TABLE IF NOT EXISTS fee_outcomes (proposal TEXT PRIMARY KEY, outcome TEXT NOT NULL, activation INTEGER NOT NULL, decided_ms INTEGER NOT NULL)`;

/** A payment's id: the proposal's own for a single payment (rule 5), else one per tranche. */
export const trancheIdOf = (pid, k, of) => (of === 1 ? pid : createHash('sha256').update(`ARENA/v1/FundingTranche:${pid}:${k}`).digest('hex'));

/**
 * HOW MANY PARTS A PASSED PROPOSAL PAYS IN (§27A.9.5 rule 5, kanban #1175): a function of the proposal's own amount, which every seat
 * reads alike. It was fixed from the reserves this seat held at its first ask - rows that differ between seats (and can be forged) - so
 * seats fixed different counts, named different part ids, and a payout plan was "no passed vote" at its peers: it never reached its
 * 5 signatures. Every payout now goes in FUNDING_TRANCHES monthly parts; an amount too small to split (under one sat a part) in one.
 */
export const trancheCountOf = (amountSats) => (BigInt(amountSats) >= BigInt(FUNDING_TRANCHES) ? FUNDING_TRANCHES : 1);
/** Every id a proposal's payment can have had (one part, or FUNDING_TRANCHES): what counts as paid by that proposal (rule 4). */
export const paymentIdsOf = (pid) => [pid, ...Array.from({ length: FUNDING_TRANCHES }, (_, k) => trancheIdOf(pid, k, FUNDING_TRANCHES))];

/**
 * A PROPOSAL'S PAYMENT ROW, ONE STATE AND ONE TRANSITION FUNCTION (kanban #1175): FIXED (its part count) -> CANCELLED (from part k,
 * for good). `row` the stored { tranches, cancelled, cancelled_k } or null; `ev` one of
 *   { kind: 'fix', tranches }                        null -> FIXED
 *   { kind: 'refix', tranches, payable: false }      FIXED -> FIXED with the derived count, only while no part is payable yet (no part
 *                                                    can have gone under the old ids): a row the old reserve rule fixed
 *   { kind: 'cancel', k, why }                       FIXED -> CANCELLED; a CANCELLED row never changes
 * Answers { ok: true, row } or { ok: false, why }.
 */
export const FUNDING_PAYMENT_STATE = Object.freeze({ FIXED: 'FIXED', CANCELLED: 'CANCELLED' });
export const fundingPaymentStateOf = (row) => (!row ? null : row.cancelled !== null && row.cancelled !== undefined ? FUNDING_PAYMENT_STATE.CANCELLED : FUNDING_PAYMENT_STATE.FIXED);
export function fundingPaymentStep(row, ev) {
  const state = fundingPaymentStateOf(row);
  const count = (n) => n === 1 || n === FUNDING_TRANCHES;
  if (ev.kind === 'fix') return state === null && count(ev.tranches) ? { ok: true, row: { tranches: ev.tranches, cancelled: null, cancelled_k: null } }
    : { ok: false, why: state ? 'its parts are fixed already' : 'no such part count' };
  if (ev.kind === 'refix') {
    if (state !== FUNDING_PAYMENT_STATE.FIXED) return { ok: false, why: state ? 'a cancelled proposal keeps its parts' : 'nothing fixed to change' };
    if (ev.payable !== false) return { ok: false, why: 'a part is payable already: it may have gone under its id' };
    if (!count(ev.tranches) || ev.tranches === row.tranches) return { ok: false, why: 'no other part count' };
    return { ok: true, row: { ...row, tranches: ev.tranches } };
  }
  if (ev.kind === 'cancel') {
    if (state !== FUNDING_PAYMENT_STATE.FIXED) return { ok: false, why: state ? 'cancelled already, for good' : 'nothing fixed to cancel' };
    if (!Number.isInteger(ev.k) || ev.k < 0 || ev.k >= row.tranches) return { ok: false, why: 'no such part' };
    return { ok: true, row: { ...row, cancelled: String(ev.why || 'cancelled'), cancelled_k: ev.k } };
  }
  return { ok: false, why: 'no such step' };
}

/**
 * `db` a better-sqlite3 handle; `verify(sig, digest, key32)` BIP340; `isBonded(nodeHex)` true / false, or null when this seat cannot
 * tell yet; `tip()` this seat's height (a promise; null when unknown); `activeAt(endHeight)` -> { ok, nodes: [hex] } or { ok: false, why };
 * `schedule` FUNDING_SCHEDULES.spec unless a live proof runs the short one; `seasonedNodes(networkHex, publishedHeight, atHeight)` -> [hex]
 * the nodes whose bond confirmed `season` blocks before publication (the signal rule), or null when this seat cannot tell yet.
 */
// FEE PROPOSALS (fee-proposal.js): kind 'fee', kept and passed on as a funding proposal is, given the same signal and the
// same bond-weighted vote; kind 'fee-approval', a protocol developer's yes or no to one. `devKeysOf(networkHex)` -> the protocol
// developers' keys (32-byte x-only hex) of that network, or null when this seat cannot tell yet. Once its vote is decided a fee
// proposal is decided whole (feeProposalOutcome) against the fees in force before its activation; feesAt(height) answers the set
// in force at a height - what a round of that census height settles with.
export function createFundingBook({ db, verify, isBonded, tip, activeAt, schedule = FUNDING_SCHEDULES.spec, log = () => {}, now = () => Date.now(),
  voteChain = null, maxBlocksPerPass = 64, seasonedNodes = null, devKeysOf = null, pull = null, feeChainFrom = () => null, endTimeAt = null }) {
  db.exec(FUNDING_SQL);
  // A FEE PROPOSAL'S SIGNAL READ FROM THE CHAIN (kanban #1283, RULED #1277 B): the signal period's blocks, held by hash, a reorg of one re-decides
  db.exec('CREATE TABLE IF NOT EXISTS fee_chain_blocks (proposal TEXT NOT NULL, height INTEGER NOT NULL, hash TEXT, items TEXT NOT NULL, PRIMARY KEY (proposal, height))');
  // kanban #1749: the census is held to the hash of the block it was read at (a store from before has no column: added, rows without one)
  if (!db.prepare('PRAGMA table_info(funding_vote_census)').all().some((c) => c.name === 'hash')) db.exec('ALTER TABLE funding_vote_census ADD COLUMN hash TEXT');
  const rows = (kind) => db.prepare('SELECT id, proposal, hex, kind FROM funding_items WHERE kind = ? ORDER BY at_ms, id').all(kind);
  // the proposals the signal and the vote run over: funding proposals and fee proposals
  // ... and leaderboard payout requests: voted on as they are, but with no signal - their vote starts at publication
  const votedRows = () => [...rows('proposal'), ...rows('fee'), ...rows('leaderboard')];
  const periodOf = (kind, o, signal) => (kind === 'leaderboard' ? leaderboardVotePeriod({ proposal: o, schedule }) : votePeriodOf({ proposal: o, signal, schedule }));
  // A LEADERBOARD PAYOUT'S ONLY PASS TEST (2026-10-18): YES >= 25 % of the voting weight (leaderboard-payout.js)
  const ruleOf = (kind, count) => (kind === 'leaderboard' && count ? leaderboardPasses(count) : count);
  const read = (kind, hex) => readSignedFunding(kind, fromHex(hex), verify);
  const outcomeOf = (pid) => { const r = db.prepare('SELECT outcome FROM funding_outcomes WHERE proposal = ?').get(pid); return r ? JSON.parse(r.outcome) : null; };
  // `beforeMs` (kanban #1279, RULED #1277 A): only the signals some seat held before the signal period ended (at_ms is the earliest time a seat held it)
  const signalsOf = (pid, beforeMs = null) => db.prepare("SELECT hex, at_ms FROM funding_items WHERE kind = 'signal' AND proposal = ?").all(pid)
    .filter((r) => beforeMs === null || Number(r.at_ms) <= Number(beforeMs))
    .map((r) => read('signal', r.hex)).filter((x) => x.ok).map((x) => ({ node: toHex(x.obj.node), atHeight: x.obj.atHeight }));
  // THE VOTE (§27A.9.3 stage 2): opened only by a signal this seat decided passed; the census taken ONCE at the
  // vote's start (signalEnd); each voting block read once for this proposal's votes, held to by its hash; the outcome written once
  // when the last voting block is `decideDepth` deep, and reopened only when that counted block is reorged away
  const voteCensus = (pid) => { const r = db.prepare('SELECT height, census, hash FROM funding_vote_census WHERE proposal = ?').get(pid);
    return r ? { height: r.height, hash: r.hash || null, census: JSON.parse(r.census).map((b) => ({ pubkey: fromHex(b.pubkey), outpoint: b.outpoint, bondSats: BigInt(b.bondSats),
      height: Number.isInteger(b.height) ? b.height : null, maturity: Number.isInteger(b.maturity) ? b.maturity : null })) } : null; };
  const voteBlocks = (pid) => db.prepare('SELECT height, hash, votes FROM funding_vote_blocks WHERE proposal = ? ORDER BY height').all(pid);
  const voteOutcome = (pid) => { const r = db.prepare('SELECT outcome, last_hash FROM funding_vote_outcomes WHERE proposal = ?').get(pid); return r ? { ...JSON.parse(r.outcome), lastHash: r.last_hash } : null; };
  const votesHeld = (pid) => voteBlocks(pid).flatMap((b) => JSON.parse(b.votes).map((v) => ({ payload: fromHex(v.payload), height: b.height, txid: v.txid })));
  // THE COUNT WITH THE FIVE RULES (§27A.9.5): only bonds 3 months old and locked 3 months past the vote vote, weighted by their age
  // (rules 1, 2); 60 % YES and YES at least 20 % of everyone who could vote (rule 3). `until` the vote's end, or a payment's due
  // height + 1 for its re-count (rule 5)
  // A BOND SPENT BEFORE last + lockAfterVote (kanban #1334): the census at min(tip, last + lockAfterVote) no longer holds it - read in voteRound,
  // kept per proposal; its vote is voided, its weight stays in everyone who could vote
  const lateCensus = new Map();                 // proposal -> { height, outpoints: Set }
  const spentAtOf = (pid) => { const l = lateCensus.get(pid); return l ? (op) => (l.outpoints.has(op) ? null : l.height) : null; };
  const countOf = (pid, period, o, until = period.until) => { const c = voteCensus(pid); if (!c) return null;
    const w = voteWeights({ census: c.census, publishedHeight: o.publishedHeight, last: period.last, schedule, spentAt: spentAtOf(pid) });
    return { ...fundingTally({ proposalId: fromHex(pid), census: w.voters, votes: votesHeld(pid), from: period.from, until, verify }),
      votersEligible: w.voters.length, bondsInCensus: c.census.length }; };
  /** The last block a passed proposal's votes are read to: its last payment's due height (rule 5, at most four tranches). */
  const readEndOf = (period) => period.last + schedule.delay + (FUNDING_TRANCHES - 1) * schedule.trancheEvery;
  function voteView(pid, o, signal, kind = 'proposal') {
    const period = periodOf(kind, o, signal);
    if (!period) return null;
    const decided = voteOutcome(pid);
    const blocks = voteBlocks(pid);
    return { ...period, censusHeight: voteCensus(pid) ? voteCensus(pid).height : null, readTo: blocks.length ? blocks[blocks.length - 1].height : null,
      state: decided ? (decided.passed ? 'passed' : 'failed') : 'voting', count: decided || ruleOf(kind, countOf(pid, period, o)) };
  }
  async function voteRound() {
    if (!voteChain) return [];
    const height = await Promise.resolve(voteChain.tipHeight()).catch(() => null);
    if (!Number.isInteger(height)) return [];
    const hashAt = async (h) => { try { const x = await voteChain.blockHashAt(h); return x ? String(x).toLowerCase() : null; } catch { return null; } };
    const done = [];
    for (const row of votedRows()) {
      const signal = outcomeOf(row.id);
      const p = read(row.kind, row.hex); if (!p.ok) continue;
      const period = periodOf(row.kind, p.obj, signal);
      if (!period || height < period.from) continue;
      // THE CENSUS IS HELD TO ITS BLOCK (kanban #1749, state audit 2026-11-12): read once at period.from, it stood for good, so a reorg
      // over the vote's start (a bond withdrawn in the replacing block) left this seat counting with a branch the chain left while a seat
      // that read it later counted with the chain's - one vote, two outcomes, never healed. Now its block hash is stored with it and
      // checked every pass, decided or not: a different hash at period.from (never a missing one - an RPC error or a tip below it) drops
      // the census, the vote blocks and the outcome (a fee proposal's with it), and all are read again on this chain. A census stored
      // without a hash (before this column, or while the hash could not be read) takes the hash it finds first.
      const held0 = voteCensus(row.id);
      if (held0) {
        const fromHash = await hashAt(period.from);
        if (fromHash && !held0.hash) db.prepare('UPDATE funding_vote_census SET hash = ? WHERE proposal = ? AND hash IS NULL').run(fromHash, row.id);
        else if (fromHash && fromHash !== held0.hash) {
          const own = !db.isTransaction;   // one step: the census never goes without its blocks and outcome
          if (own) db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('DELETE FROM funding_vote_census WHERE proposal = ?').run(row.id);
            db.prepare('DELETE FROM funding_vote_blocks WHERE proposal = ?').run(row.id);
            db.prepare('DELETE FROM funding_vote_outcomes WHERE proposal = ?').run(row.id);
            db.prepare('DELETE FROM fee_outcomes WHERE proposal = ?').run(row.id);
            if (own) db.exec('COMMIT');
          } catch (e) { if (own) db.exec('ROLLBACK'); throw e; }
          lateCensus.delete(row.id);   // 2.0 (kanban #1334): the late census was read on the branch left, too
          log(`[funding] ${row.id.slice(0, 16)}: the census block ${period.from} was reorged away - census and vote are read again`);
        }
      }
      // A DECIDED VOTE STANDS while its counted last block is still on this chain; a reorg that replaced it reopens the count
      let decided = voteOutcome(row.id);
      if (decided) {
        const onChain = await hashAt(period.last);
        // A VOTE DECIDED WITH NO ANCHOR (kanban #1750): a store written before the guard below holds an outcome whose last_hash is
        // NULL (an RPC error read as null in the deciding pass) - no reorg could ever reopen it, so it is counted again from the
        // blocks held with a hash; the count over the same chain decides the same, a count over a replaced block now follows it
        if (onChain && (!decided.lastHash || onChain !== decided.lastHash)) {
          db.prepare('DELETE FROM funding_vote_outcomes WHERE proposal = ?').run(row.id);
          // AND A FEE PROPOSAL'S OUTCOME WITH IT (ruled on #1245, kanban #1231): decided again from the set held then
          db.prepare('DELETE FROM fee_outcomes WHERE proposal = ?').run(row.id);
          // the blocks read past the counted one (a passed vote's veto window) hang on the old branch: read again
          const unanchored = db.prepare('SELECT MIN(height) AS h FROM funding_vote_blocks WHERE proposal = ? AND hash IS NULL').get(row.id);
          db.prepare('DELETE FROM funding_vote_blocks WHERE proposal = ? AND height >= ?').run(row.id,
            unanchored && Number.isInteger(unanchored.h) ? Math.min(unanchored.h, period.last) : period.last);
          log(`[funding] ${row.id.slice(0, 16)}: the counted last voting block ${period.last} was reorged away - the vote is counted again`);
          decided = null;
        } else if (!decided.passed || row.kind === 'leaderboard') continue;   // a leaderboard payout has no veto window to read on
      }
      // the census at the vote's start, once
      if (!voteCensus(row.id)) {
        // kanban #1749: the hash read before and after the census - a reorg in between leaves it for the next pass
        const before = await hashAt(period.from);
        let c = null; try { c = await voteChain.censusAt(toHex(p.obj.networkId), period.from); } catch { c = null; }
        if (!c) continue;
        const after = await hashAt(period.from);
        if (before !== after) continue;
        db.prepare('INSERT OR IGNORE INTO funding_vote_census (proposal, height, census, hash) VALUES (?, ?, ?, ?)').run(row.id, period.from,
          JSON.stringify(c.map((b) => ({ pubkey: toHex(b.pubkey), outpoint: b.outpoint, bondSats: String(b.bondSats),
            height: Number.isInteger(b.height) ? b.height : null, maturity: Number.isInteger(b.maturity) ? b.maturity : null }))), after);
      }
      // the bonds still held at min(tip, last + lockAfterVote): one spent before is no longer in the census there (kanban #1334)
      // (its own door, `lateCensusAt`, read at most once every 144 blocks: the vote's census itself is read once, at the vote's start)
      if (height >= period.last && typeof voteChain.lateCensusAt === 'function') {
        const at = Math.min(height, period.last + schedule.lockAfterVote);
        const had = lateCensus.get(row.id);
        if (!had || (had.height !== at && (at - had.height >= 144 || at === period.last + schedule.lockAfterVote))) {
          let lc = null; try { lc = await voteChain.lateCensusAt(toHex(p.obj.networkId), at); } catch { lc = null; }
          if (lc) lateCensus.set(row.id, { height: at, outpoints: new Set(lc.map((b) => b.outpoint)) });
        }
      }
      // blocks a reorg replaced are read again: walk back from the newest held block while its hash moved
      let held = voteBlocks(row.id);
      while (held.length) {
        const top = held[held.length - 1];
        const h = await hashAt(top.height);
        if (h && top.hash && h === top.hash) break;
        db.prepare('DELETE FROM funding_vote_blocks WHERE proposal = ? AND height = ?').run(row.id, top.height);
        held.pop();
      }
      // and a row a store holds with no hash (written before kanban #1750) is read again, with every one after it
      const noHash = held.findIndex((r) => !r.hash);
      if (noHash >= 0) { db.prepare('DELETE FROM funding_vote_blocks WHERE proposal = ? AND height >= ?').run(row.id, held[noHash].height); held = held.slice(0, noHash); }
      // read on, a pass at a time, this proposal's votes only
      const prefix = row.id.slice(0, 16);
      let next = held.length ? held[held.length - 1].height + 1 : period.from;
      // a passed vote is read on through its payments' due heights: a NO in the delay cancels (rule 5)
      const upTo = Math.min(height, decided ? readEndOf(period) : period.last);
      for (let n = 0; next <= upTo && n < maxBlocksPerPass; next++, n++) {
        const hash = await hashAt(next);
        // NO BLOCK IS HELD WITHOUT ITS HASH (kanban #1750): a hash that did not answer (above the tip, or an RPC error - main.js
        // blockHashAt reads both as null) is read on the next pass, never stored as a row no reorg check can test
        if (!hash) break;
        let votes; try { votes = await voteChain.votesAt(next, hash || undefined); } catch { break; }
        const mine = (votes || []).filter((v) => toHex(v.payload).slice(8, 24) === prefix).map((v) => ({ payload: toHex(v.payload), txid: String(v.txid) }));
        db.prepare('INSERT OR REPLACE INTO funding_vote_blocks (proposal, height, hash, votes) VALUES (?, ?, ?, ?)').run(row.id, next, hash, JSON.stringify(mine));
      }
      held = voteBlocks(row.id);
      const readTo = held.length ? held[held.length - 1].height : null;
      if (decided || readTo === null || readTo < period.last || held.length !== readTo - period.from + 1 || height < period.decidableAt) continue;
      // NEVER DECIDED WITHOUT ITS ANCHOR (kanban #1750): the outcome is held to the hash of its last voting block as held, and that
      // block must still be this chain's - with no hash (an RPC error) or a moved one, the decision waits for the next pass
      const lastHash = await hashAt(period.last);
      const lastRow = held.find((r) => r.height === period.last);
      if (!lastHash || !lastRow || lastRow.hash !== lastHash || held.some((r) => !r.hash)) continue;
      const out = ruleOf(row.kind, countOf(row.id, period, p.obj));
      db.prepare('INSERT OR IGNORE INTO funding_vote_outcomes (proposal, outcome, last_hash, decided_ms) VALUES (?, ?, ?, ?)').run(row.id, JSON.stringify(out), lastHash, now());
      log(`[funding] ${row.id.slice(0, 16)}: vote ${out.passed ? 'passed' : 'failed'} - turnout ${out.turnoutPct} %, YES ${out.approvalPct} % of YES + NO, YES ${out.yesOfAllPct} % of everyone who could vote, ${out.bondsVoted} bond(s)`);
      done.push({ id: row.id, ...out, lastHash });
    }
    return done;
  }
  /**
   * THE PAYMENTS A PASSED PROPOSAL MAY MAKE NOW (§27A.9.5 rule 5): its parts (trancheCountOf: from its own amount, so every seat names
   * the same part ids - kanban #1175; `reservesSatsOf` is no longer read), each payable when its due block is `decideDepth` deep and a
   * re-count of every vote up to it still passes. A failed re-count cancels that payment and every later one, for good. Answers [{ id,
   * proposal, k, of, lnurl, amountSats, proposalSats, dueAt, decidableAt }].
   */
  // every write of a payment row is one fundingPaymentStep, kept by compare-and-set on the row as it was read
  const paymentRow = (pid) => db.prepare('SELECT tranches, cancelled, cancelled_k FROM funding_payments WHERE proposal = ?').get(pid) || null;
  function stepPayment(pid, ev) {
    const was = paymentRow(pid);
    const s = fundingPaymentStep(was, ev); if (!s.ok) return { ...s, row: was };
    const r = s.row;
    const ch = was === null
      ? db.prepare('INSERT OR IGNORE INTO funding_payments (proposal, tranches, cancelled, cancelled_k) VALUES (?, ?, ?, ?)').run(pid, r.tranches, r.cancelled, r.cancelled_k).changes
      : db.prepare('UPDATE funding_payments SET tranches = ?, cancelled = ?, cancelled_k = ? WHERE proposal = ? AND tranches = ? AND cancelled IS ? AND cancelled_k IS ?')
        .run(r.tranches, r.cancelled, r.cancelled_k, pid, was.tranches, was.cancelled, was.cancelled_k).changes;
    return ch === 1 ? { ok: true, row: r } : { ok: false, why: 'the row moved meanwhile', row: paymentRow(pid) };
  }
  // `recorded(id)`: whether a reserve payout record exists under that payment id (any state) - a refix never moves a proposal
  // one of whose ids has gone out, or may have (kanban #1235, audit 3 FIXES-11)
  function payments({ tip, recorded = null } = {}) {
    const out = [];
    for (const row of rows('proposal')) {
      const decided = voteOutcome(row.id); if (!decided || !decided.passed) continue;
      const p = read('proposal', row.hex); if (!p.ok) continue;
      const period = votePeriodOf({ proposal: p.obj, signal: outcomeOf(row.id), schedule }); if (!period) continue;
      const n = trancheCountOf(p.obj.amountSats);
      const scheduleOf = (parts) => trancheSchedule({ amountSats: p.obj.amountSats, reservesSats: parts === 1 ? 0n : p.obj.amountSats, last: period.last, schedule });
      let fixed = paymentRow(row.id);
      if (!fixed) fixed = stepPayment(row.id, { kind: 'fix', tranches: n }).row;
      // A REFIX ONLY ON A KNOWN TIP AND WITH NOTHING RECORDED (kanban #1235): with the tip unknown (a seat's first 120 s, a failed chain read)
      // "no part is payable yet" was read as true, and a row fixed at 1 part and paid was refixed to 4 new ids and paid again
      else if (fixed.tranches !== n && fundingPaymentStateOf(fixed) === FUNDING_PAYMENT_STATE.FIXED && Number.isInteger(tip)
        && !(typeof recorded === 'function' && paymentIdsOf(row.id).some((id) => recorded(id)))) {
        // a row the old reserve rule fixed: set right while no part of either count is payable yet, else it stands (a part may have gone)
        const payable = [scheduleOf(fixed.tranches)[0], scheduleOf(n)[0]].some((t) => Number.isInteger(tip) && tip >= t.payableAt);
        const s = stepPayment(row.id, { kind: 'refix', tranches: n, payable });
        if (s.ok) log(`[funding] ${row.id.slice(0, 16)}: its payment goes in ${n} part(s), not the ${fixed.tranches} this seat's reserve rows once gave`);
        fixed = s.row;
      }
      if (!fixed) continue;
      const held = voteBlocks(row.id); const readTo = held.length ? held[held.length - 1].height : -1;
      const plan = scheduleOf(fixed.tranches);
      for (const t of plan) {
        // a cancelled proposal keeps listing the payments due before the cancelling one: they may have gone, and their records stand
        if (fixed.cancelled_k !== null && t.k >= fixed.cancelled_k) break;
        if (!(Number.isInteger(tip) && tip >= t.payableAt) || readTo < t.dueAt) break;
        const again = countOf(row.id, period, p.obj, t.dueAt + 1);
        // A STOP NEEDS THE FLOOR A PASS NEEDS (kanban #1311/#1334): NO at least 20 % of rule 1's weight - one late NO does not stop a tranche
        if (!again || (!again.passed && again.stops)) {
          const why = `payment ${t.k + 1} of ${t.of} cancelled at its due block ${t.dueAt}: YES ${again ? again.approvalPct : '?'} % of YES + NO, ${again ? again.yesOfAllPct : '?'} % of everyone who could vote`;
          // compare-and-set from FIXED: a re-count after a reorg never moves a cancellation already kept
          if (stepPayment(row.id, { kind: 'cancel', k: t.k, why }).ok) log(`[funding] ${row.id.slice(0, 16)}: ${why}`);
          break;
        }
        out.push({ id: trancheIdOf(row.id, t.k, t.of), proposal: row.id, k: t.k, of: t.of, lnurl: p.obj.lnurl, amountSats: t.amountSats,
          proposalSats: p.obj.amountSats, dueAt: t.dueAt, decidableAt: t.payableAt });
      }
    }
    return out;
  }
  // THE FEE DECISIONS: accepted sets in activation order; feesAt(height) the one in force
  const feeOutcomes = () => db.prepare('SELECT proposal, outcome, activation FROM fee_outcomes ORDER BY activation, proposal').all()
    .map((r) => ({ proposal: r.proposal, ...JSON.parse(r.outcome) }));
  function feesAt(height) {
    const accepted = feeOutcomes().filter((o) => o.accepted).map((o) => ({ accepted: true, activationHeight: o.activationHeight, fees: o.fees }));
    return feesAtOf({ height, accepted, base: FEES_TODAY });
  }
  // ---- THE FEE SIGNAL ON CHAIN (kanban #1283, RULED #1277 B) ----
  const chainMode = (o) => { if (!voteChain || typeof voteChain.feeItemsAt !== 'function') return false; let from = null; try { from = feeChainFrom(toHex(o.networkId)); } catch { from = null; } return Number.isInteger(from) && o.publishedHeight >= from; };
  const chainHash = async (h) => { try { const x = await voteChain.blockHashAt(h); return x ? String(x).toLowerCase() : null; } catch { return null; } };
  const chainDepth = () => Math.max(3, Number(schedule.decideDepth) || 6);   // decided 6 deep, never under 3 (#1196)
  async function chainSignal(pid, o, height, end) {
    const last = end - 1;
    let held = db.prepare('SELECT height, hash FROM fee_chain_blocks WHERE proposal = ? ORDER BY height').all(pid);
    // a held block whose hash moved is read again, and every one above it
    for (const b of held) { const h = await chainHash(b.height); if (h && b.hash && h !== b.hash) { db.prepare('DELETE FROM fee_chain_blocks WHERE proposal = ? AND height >= ?').run(pid, b.height); break; } }
    held = db.prepare('SELECT height FROM fee_chain_blocks WHERE proposal = ? ORDER BY height').all(pid);
    let next = held.length ? held[held.length - 1].height + 1 : o.publishedHeight;
    for (let n = 0; next <= Math.min(last, height) && n < maxBlocksPerPass; next++, n++) {
      const hash = await chainHash(next);
      let items; try { items = await voteChain.feeItemsAt(next, hash || undefined); } catch { break; }
      const mine = (items || []).filter((x) => toHex(x.payload).slice(8, 24) === pid.slice(0, 16)).map((x) => ({ kind: x.kind, payload: toHex(x.payload), txid: String(x.txid) }));
      db.prepare('INSERT OR REPLACE INTO fee_chain_blocks (proposal, height, hash, items) VALUES (?, ?, ?, ?)').run(pid, next, hash, JSON.stringify(mine));
    }
    const rows = db.prepare('SELECT height, items FROM fee_chain_blocks WHERE proposal = ? ORDER BY height').all(pid);
    if (rows.length !== end - o.publishedHeight || height < last + chainDepth() - 1) return null;
    let census; try { census = await voteChain.censusAt(toHex(o.networkId), o.publishedHeight); } catch { census = null; }
    if (!Array.isArray(census)) { log(`[fees] ${pid.slice(0, 16)}: the census at ${o.publishedHeight} is not read yet`); return null; }
    let devKeys = []; if (typeof devKeysOf === 'function') { try { devKeys = (await devKeysOf(toHex(o.networkId))) || []; } catch { devKeys = []; } }
    const items = rows.flatMap((r) => JSON.parse(r.items).map((x) => ({ kind: x.kind, payload: fromHex(x.payload), height: r.height })));
    const c = countFeeChain({ proposalId: fromHex(pid), items, fromHeight: o.publishedHeight, toHeight: end, census, devKeys: devKeys.map((k) => (typeof k === 'string' ? fromHex(k) : k)), verify });
    return { state: c.signals.passes ? 'passed' : 'failed', chain: true, signalEnd: end, supporters: c.signals.bonds, active: c.signals.of, signals: c.signals.bonds,
      pct: c.signals.of ? Math.round((c.signals.bonds * 10000) / c.signals.of) / 100 : 0, sats: String(c.signals.sats), approvals: Object.fromEntries(c.approvals), lastHash: await chainHash(last), lastHeight: last };
  }
  // A REORG OF A COUNTED BLOCK RE-DECIDES (RULED #1277 B): a chain signal whose last block moved, of a fee not decided yet, is dropped and read again
  async function chainReorgs() {
    if (!voteChain) return;
    for (const r of db.prepare('SELECT proposal, outcome FROM funding_outcomes').all()) {
      let o; try { o = JSON.parse(r.outcome); } catch { continue; }
      if (!o || !o.chain || !Number.isInteger(o.lastHeight) || db.prepare('SELECT 1 FROM fee_outcomes WHERE proposal = ?').get(r.proposal)) continue;
      const h = await chainHash(o.lastHeight);
      if (h && o.lastHash && h !== o.lastHash) { db.prepare('DELETE FROM funding_outcomes WHERE proposal = ?').run(r.proposal); log(`[fees] ${r.proposal.slice(0, 16)}: block ${o.lastHeight} of its signal moved: decided again`); }
    }
  }
  const approvalsOf = (pid) => db.prepare("SELECT hex FROM funding_items WHERE kind = 'fee-approval' AND proposal = ? ORDER BY at_ms, id").all(pid)
    .map((x) => read('fee-approval', x.hex)).filter((x) => x.ok).map((x) => ({ approval: x.obj, signature: x.signature }));
  /**
   * DECIDE THE FEE PROPOSALS WHOSE VOTE IS DECIDED: each once, whole - its set against the fees in force just before its
   * activation, its signal, its vote, and the protocol developers' majority for a donation it changes. A refusal is written too: it
   * applies nothing. Answers the decisions made now.
   */
  async function decideFees() {
    const done = [];
    for (const row of rows('fee').map((r) => ({ r, p: read('fee', r.hex) })).filter((x) => x.p.ok).sort((a, b) => a.p.obj.activationHeight - b.p.obj.activationHeight)) {
      const pid = row.r.id;
      if (db.prepare('SELECT 1 FROM fee_outcomes WHERE proposal = ?').get(pid)) continue;
      const signal = outcomeOf(pid);
      if (!signal) continue;
      const vote = voteOutcome(pid);
      if (signal.state === 'passed' && !vote) continue;                 // its vote is still open
      const o = row.p.obj;
      let devKeys = [];
      if (donationChanges(o, feesAt(o.activationHeight - 1)).length) {
        devKeys = typeof devKeysOf === 'function' ? await Promise.resolve(devKeysOf(toHex(o.networkId))).catch(() => null) : null;
        if (!Array.isArray(devKeys)) { log(`[fees] ${pid.slice(0, 16)}: the protocol developers' keys not read yet`); continue; }
      }
      // THE PEERS' APPROVALS AND SIGNALS FIRST (ruled 2026-11-07 on #1245, kanban #1231): the census seats this seat reaches are asked for theirs and
      // every one that verifies is taken, so seats decide from the same set; what arrives after the decision is kept and not read
      if (typeof pull === 'function') {
        let got = []; try { got = await pull(pid); } catch { got = []; }
        let took = 0; for (const it of Array.isArray(got) ? got : []) { try { const r = await book.add(it.kind, it.hex, { heldAtMs: it.atMs === undefined ? null : Number(it.atMs) }); if (r && r.ok && r.fresh) took++; } catch { /* the next */ } }
        if (took) log(`[fees] ${pid.slice(0, 16)}: ${took} approval(s) or signal(s) pulled from the peers before deciding`);
      }
      const out = feeProposalOutcome({ proposal: o, current: feesAt(o.activationHeight - 1), signal, tally: vote, approvals: approvalsOf(pid), devKeys, verify, schedule,
        ...(signal.chain ? { devSaid: new Map(Object.entries(signal.approvals || {})) } : {}) });
      db.prepare('INSERT OR IGNORE INTO fee_outcomes (proposal, outcome, activation, decided_ms) VALUES (?, ?, ?, ?)').run(pid, JSON.stringify(out), o.activationHeight, now());
      log(`[fees] ${pid.slice(0, 16)}: ${out.accepted ? `accepted - in force from ${o.activationHeight}` : `refused - ${out.why}`}`);
      done.push({ id: pid, ...out });
    }
    return done;
  }
  /** The fee proposals as a page reads them: each one's changes, signal, vote, the developers' answers and its decision. */
  function feeList(height = null) {
    return rows('fee').map((row) => {
      const p = read('fee', row.hex); if (!p.ok) return null;
      const o = p.obj;
      const st = outcomeOf(row.id) || signalOutcome({ proposal: o, signals: signalsOf(row.id), active: null, tip: height, schedule });
      const decided = db.prepare('SELECT outcome FROM fee_outcomes WHERE proposal = ?').get(row.id);
      const before = feesAt(o.activationHeight - 1);
      const devs = approvalsOf(row.id).map((a) => ({ dev: toHex(a.approval.dev), approve: a.approval.approve }));
      return { id: row.id, network: toHex(o.networkId), author: toHex(o.author), publishedHeight: o.publishedHeight, activationHeight: o.activationHeight,
        changes: o.changes.map((c) => ({ fee: c.fee, from: before[c.fee], to: c.value, donation: !!FEES[c.fee].donation })), purpose: o.purpose,
        needsDevs: donationChanges(o, before).length > 0, devs, signal: st, vote: voteView(row.id, o, st), decision: decided ? JSON.parse(decided.outcome) : null, hex: row.hex };
    }).filter(Boolean).sort((a, b) => b.publishedHeight - a.publishedHeight);
  }
  /** THE LEADERBOARD PAYOUTS WHOSE VOTE PASSED HERE: [{ id, proposal (decoded), decidableAt }] - reserve-payout.js pays them. */
  function leaderboardsPassed() {
    return rows('leaderboard').map((row) => ({ row, p: read('leaderboard', row.hex), v: voteOutcome(row.id) })).filter((x) => x.p.ok && x.v && x.v.passed)
      .map((x) => ({ id: x.row.id, proposal: x.p.obj, decidableAt: leaderboardVotePeriod({ proposal: x.p.obj, schedule }).decidableAt }));
  }
  /** Every leaderboard payout request as a page reads it: its terms, its vote (the 25 % rule) and its hex. */
  function leaderboardList(height = null) {
    return rows('leaderboard').map((row) => {
      const p = read('leaderboard', row.hex); if (!p.ok) return null;
      const o = p.obj;
      return { id: row.id, network: toHex(o.networkId), author: toHex(o.author), publishedHeight: o.publishedHeight, scope: o.scope, gameName: o.gameName, top: o.top,
        amountSats: String(o.amountSats), federation: toHex(o.federationId), splitBps: o.splitBps, periodDays: o.periodDays, paymentHeight: o.paymentHeight, purpose: o.purpose,
        vote: voteView(row.id, o, null, 'leaderboard'), hex: row.hex, tip: height };
    }).filter(Boolean).sort((a, b) => b.publishedHeight - a.publishedHeight);
  }
  const cancelledOf = (pid) => { const r = db.prepare('SELECT cancelled FROM funding_payments WHERE proposal = ?').get(pid); return r ? r.cancelled : null; };
  const book = {
    schedule,
    voteRound,
    decideFees,
    feesAt,
    leaderboardsPassed,
    leaderboardList,
    feeList,
    devMajorityOf: (pid, devKeys) => devMajority({ proposalId: fromHex(pid), approvals: approvalsOf(pid), devKeys, verify }),
    payments,
    cancelledOf,
    // `heldAtMs` (kanban #1279): when a peer says it first held the object (GET /funding-items' atMs) - a signal or an approval is kept as of the
    // earliest time any seat held it, never later than now
    async add(kind, hex, { heldAtMs = null } = {}) {
      const r = (() => { try { return read(kind, String(hex || '').toLowerCase()); } catch (e) { return { ok: false, why: e.message }; } })();
      if (!r.ok) return { ok: false, status: 400, why: r.why };
      const id = toHex(r.id);
      const atMs = Number.isFinite(Number(heldAtMs)) && heldAtMs !== null ? Math.min(now(), Number(heldAtMs)) : now();
      if (db.prepare('SELECT 1 FROM funding_items WHERE id = ?').get(id)) {
        if ((kind === 'signal' || kind === 'fee-approval') && heldAtMs !== null) db.prepare('UPDATE funding_items SET at_ms = ? WHERE id = ? AND at_ms > ?').run(atMs, id, atMs);
        return { ok: true, fresh: false, id };
      }
      const height = await Promise.resolve(tip()).catch(() => null);
      // A PLAYER'S NAME (PIP, player-name.js): the newest per player is kept, the one it replaces dropped; one dated
      // more than the skew ahead of this seat's clock is refused, so nobody pins a name by dating it in the future
      if (kind === 'name') {
        if (r.obj.atMs > BigInt(now() + PLAYER_NAME_SKEW_MS)) return { ok: false, status: 422, why: 'that name is dated ahead of this seat\'s clock' };
        const key = 'name:' + toHex(r.obj.player);
        const held = db.prepare("SELECT id, hex FROM funding_items WHERE kind = 'name' AND proposal = ?").get(key);
        if (held) {
          const h = read('name', held.hex);
          const keep = newerPlayerName(h.ok ? { ...h, idHex: held.id } : null, { ...r, idHex: id });
          if (keep.idHex !== id) return { ok: true, fresh: false, id, why: 'this seat keeps a newer name of that player' };
          db.prepare('DELETE FROM funding_items WHERE id = ?').run(held.id);
        }
        db.prepare('INSERT OR IGNORE INTO funding_items (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, key, String(hex).toLowerCase(), now());
        return { ok: true, fresh: true, id, player: toHex(r.obj.player) };
      }
      let proposal;
      // A FEE PROPOSAL: anyone may propose; refused at submission when the whole set it makes from the fees in force at
      // its activation breaks a limit or a sum, or applies before its vote can be decided
      if (kind === 'fee') {
        const st = feeProposalStands(r.obj, { current: feesAt(r.obj.activationHeight - 1), schedule });
        if (!st.ok) return { ok: false, status: 422, why: st.why };
        if (Number.isInteger(height) && r.obj.publishedHeight > height + 1) return { ok: false, status: 422, why: `published at ${r.obj.publishedHeight}, and this seat's chain is at ${height}` };
        db.prepare('INSERT OR IGNORE INTO funding_items (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, id, String(hex).toLowerCase(), now());
        return { ok: true, fresh: true, id, proposal: id };
      }
      // A LEADERBOARD PAYOUT REQUEST: anyone may ask; kept as a proposal, voted from its publication
      if (kind === 'leaderboard') {
        if (Number.isInteger(height) && r.obj.publishedHeight > height + 1) return { ok: false, status: 422, why: `published at ${r.obj.publishedHeight}, and this seat's chain is at ${height}` };
        const vp = leaderboardVotePeriod({ proposal: r.obj, schedule });
        if (r.obj.paymentHeight < vp.decidableAt) return { ok: false, status: 422, why: `the payment height ${r.obj.paymentHeight} comes before its vote is decided (${vp.decidableAt})` };
        db.prepare('INSERT OR IGNORE INTO funding_items (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, id, String(hex).toLowerCase(), now());
        return { ok: true, fresh: true, id, proposal: id };
      }
      // A PROTOCOL DEVELOPER'S ANSWER: to a fee proposal this seat holds; the newest answer of each developer counts (devMajority)
      if (kind === 'fee-approval') {
        proposal = toHex(r.obj.proposalId);
        if (!db.prepare("SELECT 1 FROM funding_items WHERE kind = 'fee' AND id = ?").get(proposal)) return { ok: false, status: 404, why: 'this seat holds no such fee proposal: send the proposal first' };
        db.prepare('INSERT OR IGNORE INTO funding_items (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, proposal, String(hex).toLowerCase(), atMs);
        return { ok: true, fresh: true, id, proposal };
      }
      if (kind === 'proposal') {
        // ANYONE MAY PROPOSE (2026-10-17: "Anyone can do a proposal to pay out, doesn't have to be the dev"): the
        // author is any key that signs it; only the nodes' signal and the bonded capital's vote decide whether it is paid
        proposal = id;
        if (Number.isInteger(height) && r.obj.publishedHeight > height + 1) return { ok: false, status: 422, why: `published at ${r.obj.publishedHeight}, and this seat's chain is at ${height}` };
      } else {
        proposal = toHex(r.obj.proposalId);
        if (!db.prepare("SELECT 1 FROM funding_items WHERE kind IN ('proposal', 'fee', 'leaderboard') AND id = ?").get(proposal)) return { ok: false, status: 404, why: 'this seat holds no such proposal: send the proposal first' };
        if (Number.isInteger(height) && r.obj.atHeight > height + 1) return { ok: false, status: 422, why: `dated ${r.obj.atHeight}, and this seat's chain is at ${height}` };
        if (kind === 'signal') {
          const bonded = isBonded(toHex(r.obj.node));
          if (bonded === false) return { ok: false, status: 422, why: 'a signal is given by a bonded node' };
        }
      }
      db.prepare('INSERT OR IGNORE INTO funding_items (id, kind, proposal, hex, at_ms) VALUES (?, ?, ?, ?, ?)').run(id, kind, proposal, String(hex).toLowerCase(), kind === 'signal' ? atMs : now());
      return { ok: true, fresh: true, id, proposal };
    },
    list(height = null) {
      return rows('proposal').map((row) => {
        const p = read('proposal', row.hex); if (!p.ok) return null;
        const o = p.obj;
        const comments = db.prepare("SELECT hex FROM funding_items WHERE kind = 'comment' AND proposal = ? ORDER BY at_ms, id").all(row.id)
          .map((c) => read('comment', c.hex)).filter((c) => c.ok)
          .map((c) => ({ id: toHex(c.id), parent: toHex(c.obj.parentId), author: toHex(c.obj.author), atHeight: c.obj.atHeight, text: c.obj.text }));
        const signals = signalsOf(row.id);
        const decided = outcomeOf(row.id);
        const st = decided || signalOutcome({ proposal: o, signals, active: null, tip: height, schedule });
        return { id: row.id, network: toHex(o.networkId), author: toHex(o.author), publishedHeight: o.publishedHeight, amountSats: String(o.amountSats),
          lnurl: o.lnurl, purpose: o.purpose, signal: st, vote: voteView(row.id, o, st), cancelled: cancelledOf(row.id), signals, comments, hex: row.hex };
      }).filter(Boolean).sort((a, b) => b.publishedHeight - a.publishedHeight);
    },
    /** Every player's newest name this seat holds (PIP): the player's identity key, the name ('' = its generated one), when, the hex. */
    names() {
      return db.prepare("SELECT hex FROM funding_items WHERE kind = 'name' ORDER BY at_ms, id").all().map((x) => ({ x, r: read('name', x.hex) })).filter(({ r }) => r.ok)
        .map(({ x, r }) => ({ player: toHex(r.obj.player), name: r.obj.name, atMs: String(r.obj.atMs), network: toHex(r.obj.networkId), hex: x.hex }));
    },
    /** The objects of one proposal as hex - what another seat is handed to hold it too. */
    hexOf(pid) { return db.prepare('SELECT kind, hex FROM funding_items WHERE proposal = ? ORDER BY at_ms').all(String(pid).toLowerCase()); },
    async decide() {
      const height = await Promise.resolve(tip()).catch(() => null);
      if (!Number.isInteger(height)) return [];
      const done = [];
      await chainReorgs();
      for (const row of votedRows()) {
        if (row.kind === 'leaderboard') continue;            // no signal period
        if (outcomeOf(row.id)) continue;
        const p = read(row.kind, row.hex); if (!p.ok) continue;
        const end = p.obj.publishedHeight + schedule.signal;
        if (height < end) continue;
        // FROM FEE_SIGNAL_CHAIN_HEIGHT A FEE PROPOSAL'S SIGNAL IS READ FROM THE CHAIN (kanban #1283): the off-chain records count for nothing
        if (row.kind === 'fee' && chainMode(p.obj)) {
          const out = await chainSignal(row.id, p.obj, height, end);
          if (out) { db.prepare('INSERT OR IGNORE INTO funding_outcomes (proposal, outcome, decided_ms) VALUES (?, ?, ?)').run(row.id, JSON.stringify(out), now());
            log(`[fees] ${row.id.slice(0, 16)}: signal on chain ${out.state} - ${out.supporters} of ${out.active} bonds (${out.pct} %)`); done.push({ id: row.id, ...out }); }
          continue;
        }
        // THE SIGNAL DECIDED AFTER A PULL, ON WHAT SOME SEAT HELD BEFORE THE END (kanban #1279, RULED #1277 A, the interim until signals are read from
        // the chain; audit 4 #1257 seats-4): each seat decided at the period's end from its own rows, so a signal posted to three seats just before the
        // end passed there and failed elsewhere - two fee sets from activation. When this seat first saw the end is kept; it decides once the end is
        // `decideDepth` deep, after asking the seats it reaches, and counts a signal only when some seat held it before then
        db.prepare('INSERT OR IGNORE INTO funding_signal_ends (proposal, seen_ms) VALUES (?, ?)').run(row.id, now());
        if (height < end + Math.max(1, Number(schedule.decideDepth) || 1) - 1) continue;
        if (typeof pull === 'function') {
          let got = []; try { got = await pull(row.id); } catch { got = []; }
          let took = 0; for (const it of Array.isArray(got) ? got : []) { try { const x = await book.add(it.kind, it.hex, { heldAtMs: it.atMs === undefined ? null : Number(it.atMs) }); if (x && x.ok && x.fresh) took++; } catch { /* the next */ } }
          if (took) log(`[funding] ${row.id.slice(0, 16)}: ${took} signal(s) or approval(s) pulled from the peers before deciding the signal`);
        }
        // ONE CUTOFF FOR EVERY SEAT (audit 5, kanban #1410): the end was "when this seat first saw it" - a seat restarting or catching up hours later counted
        // every signal held before then, a live seat did not, and one period had two outcomes. With `endTimeAt(height)` (the end block's header time, the
        // same on every seat that holds that chain) a signal counts when some seat held it by the time the end block was made; without it, as before
        let endSeen = db.prepare('SELECT seen_ms FROM funding_signal_ends WHERE proposal = ?').get(row.id).seen_ms;
        if (typeof endTimeAt === 'function') {
          let t = null; try { t = Number(await endTimeAt(end)); } catch { t = null; }
          if (!Number.isFinite(t) || t <= 0) { log(`[funding] ${row.id.slice(0, 16)}: the signal ended at ${end}, that block's time not read yet`); continue; }
          // A HEADER TIME AHEAD OF THIS SEAT'S CLOCK (audit 6 re-check N5, kanban #1426): a miner may date a block up to 2 h ahead; deciding before that
          // moment, a seat missed signals other seats still counted until it - two outcomes again. It decides once its own clock has passed it
          if (t > now()) { log(`[funding] ${row.id.slice(0, 16)}: the end block is dated ${Math.round((t - now()) / 1000)} s ahead of this seat's clock: decided after it`); continue; }
          endSeen = t;
        }
        const a = await activeAt(end).catch((e) => ({ ok: false, why: e.message }));
        if (!a || !a.ok) { log(`[funding] ${row.id.slice(0, 16)}: the signal ended at ${end}, its active nodes not read yet: ${a ? a.why : '?'}`); continue; }
        // THE SIGNAL RULE: only nodes with a bond 3 months old count, among the active and among the signals
        if (typeof seasonedNodes === 'function') {
          const seasoned = await Promise.resolve(seasonedNodes(toHex(p.obj.networkId), p.obj.publishedHeight, end)).catch(() => null);
          if (!Array.isArray(seasoned)) { log(`[funding] ${row.id.slice(0, 16)}: the seasoned bonds at ${end} not read yet`); continue; }
          const s = new Set(seasoned.map((k) => String(k).toLowerCase()));
          a.nodes = a.nodes.filter((k) => s.has(String(k).toLowerCase()));
        }
        const out = { ...signalOutcome({ proposal: p.obj, signals: signalsOf(row.id, endSeen), active: a.nodes, tip: height, schedule }), activeFrom: a.fromHeight ?? null, activeTo: end };
        db.prepare('INSERT OR IGNORE INTO funding_outcomes (proposal, outcome, decided_ms) VALUES (?, ?, ?)').run(row.id, JSON.stringify(out), now());
        log(`[funding] ${row.id.slice(0, 16)}: signal ${out.state} - ${out.supporters} of ${out.active} active nodes (${out.pct} %, ${out.needed} needed)`);
        done.push({ id: row.id, ...out });
      }
      return done;
    },
    /** The signals and fee approvals this seat holds for a proposal, as signed (GET /funding-items, a peer's pull before it decides; kanban #1231). */
    itemsOf(pid) {
      return db.prepare("SELECT kind, hex, at_ms FROM funding_items WHERE kind IN ('signal', 'fee-approval') AND proposal = ? ORDER BY id").all(String(pid).toLowerCase())
        .map((r) => ({ kind: r.kind, hex: r.hex, atMs: String(r.at_ms) }));   // when this seat first held it (kanban #1279)
    },
  };
  return book;
}
