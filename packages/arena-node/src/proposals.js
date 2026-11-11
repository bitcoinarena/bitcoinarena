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
import { decodeConfigProposalBody, proposalId, proposalStands, SCHEDULES, REPEAL_SCHEDULES } from '../../arena-protocol/src/ballot.js';
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
 */
export const PROPOSAL_STATE = Object.freeze({ COUNTING: 'COUNTING', PASSED: 'PASSED', FAILED: 'FAILED', ORPHANED: 'ORPHANED' });
const S = PROPOSAL_STATE;
/** The only moves there are: anything else is refused. */
const MOVES = Object.freeze({ [S.COUNTING]: [S.PASSED, S.FAILED, S.ORPHANED], [S.PASSED]: [S.COUNTING, S.ORPHANED], [S.FAILED]: [S.COUNTING, S.ORPHANED],
  [S.ORPHANED]: [S.COUNTING] });
/** A kept record's state - a record written before kanban #1152 carries none, and reads as its `decided` says. */
export const stateOf = (r) => (r && S[r.state] ? r.state : r && r.orphaned ? S.ORPHANED : r && r.decided ? (r.decided.passed ? S.PASSED : S.FAILED) : S.COUNTING);

export function createProposals({ confirmedTx, recipientsFor, lowestBondMinSatsFor, verify, store, schedule = SCHEDULES.mainnet, scheduleFor = null,
  repealSchedule = REPEAL_SCHEDULES.mainnet, repealScheduleFor = null, historyFor = null, censusAt = null }) {
  const held = new Map((store && store.read ? store.read() || [] : []).map((x) => [x.id, { ...x, state: stateOf(x) }]));
  /** WRITTEN FIRST: the store takes `next` (or throws), and only then this seat's memory. */
  const commit = (next) => {
    if (store && store.write) store.write([...held.values()].filter((x) => x.id !== next.id).concat([next]));
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
    let next;
    if (to === S.PASSED || to === S.FAILED) {
      if (!outcome || outcome.passed !== (to === S.PASSED)) return false;
      next = { ...had, state: to, decided: outcome };
    } else if (to === S.ORPHANED) {
      const { decided, ...rest } = had;
      next = { ...rest, state: S.ORPHANED, orphaned: { at, why, was: from, ...(decided ? { outcome: decided } : {}) } };
    } else if (from === S.ORPHANED) {
      const { orphaned, ...rest } = record ? { ...record, orphaned: had.orphaned } : had;
      next = { ...rest, state: S.COUNTING, restored: { at, why, was: orphaned ? orphaned.was : null } };
    } else {
      const { decided, ...rest } = had;
      next = { ...rest, state: S.COUNTING, undecided: { at: decided ? decided.decidedAt : null, was: from, why } };
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
  const backedBy = (depositHex, id) => [...held.values()].find((r) => r.id !== id && depositTxidOf(r) === depositHex) || null;
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
      const dep = depositOf({ raw: tx.raw, height: tx.height, proposal: p, recipients });
      if (!dep.ok) return { ok: false, status: 422, why: dep.why };
      // THE HISTORY A REPEAL IS READ AGAINST: the configs live before, at the height it was published at (27A.7.6)
      const history = historyFor ? historyFor(net, dep.publishedAt) : null;
      if (historyFor && !history)
        return { ok: false, status: 503, why: `this seat has not yet decided every proposal that activates by height ${dep.publishedAt}, so it cannot yet say whether this one is a repeal: ask again shortly` };
      const stands = proposalStands(p, { publishedAt: dep.publishedAt, depositSats: dep.depositSats, lowestBondMinSats: lowestBondMinSatsFor(net),
        schedule: (scheduleFor && scheduleFor(net)) || schedule, repealSchedule: (repealScheduleFor && repealScheduleFor(net)) || repealSchedule, verify, history });
      if (!stands.ok) return { ok: false, status: 422, why: stands.why };
      // THE PROPOSER IS A BONDED NODE (27A.7.2 "node pubkey with an active bond", kanban #1489): its key is in the census at the
      // publication height - the census the tally counts with. A fresh key with a 1-sat deposit took the ballot before; now refused
      // at the door. A census not readable yet is a 503 (ask again), never a guess.
      if (typeof censusAt === 'function') {
        let census = null;
        try { census = await censusAt(net, dep.publishedAt); } catch { census = null; }
        if (!Array.isArray(census)) return { ok: false, status: 503, why: `this seat cannot read the census at height ${dep.publishedAt} yet: ask again shortly` };
        const xOnly = (k) => { const h = typeof k === 'string' ? k.toLowerCase() : k ? toHex(Uint8Array.from(k)) : ''; return h.length === 66 ? h.slice(2) : h; };
        const me = xOnly(p.proposer);
        if (!census.some((e) => e && xOnly(e.pubkey) === me))
          return { ok: false, status: 422, why: `the proposer holds no active bond in the census at height ${dep.publishedAt} (27A.7.2)` };
      }
      // checked on a proposal that stands on its face and on the chain: refused by its own fault first, then by the deposit (#1489)
      const other = backedBy(depositHex, id);
      if (other) return { ok: false, status: 409, why: `that deposit (deposit_txid) already backs proposal ${other.id}: one deposit pays for one proposal` };
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
    transition,
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
      for (const r of (Array.isArray(records) ? records : []).slice(0, 256)) {
        if (!r || typeof r.proposal !== 'string' || typeof r.blockHash !== 'string') continue;
        const mine = typeof r.id === 'string' ? held.get(r.id.toLowerCase()) : null;
        if (mine && stateOf(mine) !== S.ORPHANED) continue;             // kept and counted here: nothing to learn
        try { const got = await api.add({ proposal: r.proposal, blockHash: r.blockHash }); if (got.ok && got.status === 201) took++; } catch { /* not one */ }
      }
      return took;
    },
  };
  return api;
}
