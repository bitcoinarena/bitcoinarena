// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BALLOT COUNTED ON THIS SEAT'S OWN CHAIN, AND THE CONFIG IT MAKES LIVE (spec §27A.7.3-§27A.7.6the third
// slice). "The tally is a pure function of chain state. Every participant computes the same result" - so every seat counts
// for itself, from its own bitcoind, and nobody's count is taken on trust:
//
//   THE VOTES     the blocks of each kept proposal's voting phase, read from this seat's chain (`votesAt(height)`, main.js:
//                 getblock -> ballot-chain.js votesInBlock), each block ONCE however many proposals vote in it, and only its
//                 vote outputs kept (a few bytes each, never the block)
//   THE CENSUS    the bonds active at the proposal's publication height, each with its bond amount (`censusAt(net, height)`,
//                 main.js: the same derivation the roster's rounds use, roster.js censusOfView) - read once per proposal
//   THE TALLY     ballot.js tally, re-run only when a block with new votes was read for that proposal
//   THE OUTCOME   once the voting phase is over and its last block is `decideDepthFor(net)` deep, written into the proposal's
//                 record once (proposals.js decide, the ballot_proposals table), with the hash of that last voting block (its
//                 ANCHOR) - and a decided proposal's blocks and census are not read again, not after a restart either
//   A REORG       the chain a count was made on is held to by hash (`blockHashAt(height)`, main.js getblockhash): a block's
//                 hash commits to every block below it, so ONE hash per proposal says whether anything it was counted on
//                 changed. Each pass asks it: a decided proposal's anchor (moved: the outcome is taken back, proposals.js
//                 undecide, and the proposal is counted again from its phase's first block), an open proposal's last block read
//                 (moved: its votes are read again from the start of its phase), and a proposal not read yet its publication
//                 block. Whichever moved, the publication block is asked too: another block there, the proposal is ORPHANED
//                 (proposals.js orphan) - kept with its bytes, counted for nothing, never deleted, and counted again when that
//                 block is back (restore) or it is posted again from a new block. Only a hash that DIFFERS moves anything
//                 (kanban #1152): an RPC that did not answer skips the pass, and a height above this seat's tip waits. Cost
//                 with no reorg: one getblockhash per kept proposal a pass
//   GOING LIVE    ballot-chain.js liveConfig over the passed proposals of a network (§27A.7.5): `live(net)` at the tip for
//                 GET /config, `spans(net)` over every passed proposal for the serving rule (configServesRound)
//
// BOUNDED, after the series writer's lesson (server.js `assignedSeen`, measured 2026-10-15: a pass that asked again what it had
// already learned outran its slice on the slower machine and held seven seats at 105-170 % of a core): a pass reads at most
// `maxBlocksPerPass` blocks over all proposals, each proposal keeps how far it has read, nothing already read or decided is
// asked again, and the vote cache drops every height below the lowest phase still open.
import { tally, CLASS } from '../../arena-protocol/src/ballot.js';
import { liveConfig, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { decodeConfigProposalBody } from '../../arena-protocol/src/ballot.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { stateOf, PROPOSAL_STATE as S } from './proposals.js';

/** THE FEWEST CONFIRMATIONS AN OUTCOME IS WRITTEN AT (kanban #1152): a one- or two-block reorg never moves a decided proposal - a repeal's included. */
export const MIN_DECIDE_DEPTH = 3;

/**
 * A BLOCK'S HASH AT A HEIGHT, WITH ITS THREE ANSWERS (kanban #1152), over a bitcoind `call(method, params)` (chain-rpc.js): the
 * hash; null only when the height is above the tip (bitcoind's -8 "Block height out of range", or a tip below it); and an
 * RPC that did not answer THROWS - a full work queue, a timeout, a reindex is no reorg, and the tally skips that pass.
 */
export const chainHashReader = (call) => async (height) => {
  try { return String(await call('getblockhash', [height])); } catch (e) {
    if (/out of range|"code":\s*-8\b/i.test(String(e && e.message))) return null;
    let top; try { top = Number(await call('getblockcount')); } catch { throw e; }
    if (Number.isInteger(top) && height > top) return null;
    throw e;
  }
};

const str = (x) => (typeof x === 'bigint' ? String(x) : x);
/** A tally as JSON carries it: the sats as strings, the percentages as numbers. */
const tallyJson = (t) => ({ totalSats: str(t.totalSats), yesSats: str(t.yesSats), noSats: str(t.noSats), abstainSats: str(t.abstainSats),
  bondsVoted: t.bondsVoted, turnoutPct: t.turnoutPct, approvalPct: t.approvalPct, quorum: t.quorum, approved: t.approved, passed: t.passed });

/**
 * `proposals`: proposals.js (list, decide, undecide, orphan, restore). `blockHashAt(height)` -> the hash of this seat's block at that
 * height, null above the tip, and THROWS when the chain did not answer (none given: no reorg is followed - the first slice's
 * behaviour, kept for a harness). `tipHeight()` -> this seat's tip; `votesAt(height)` -> [{ payload, height, txid }];
 * `censusAt(networkIdHex, height)` -> [{ pubkey, outpoint, bondSats }] or null (not readable yet); `verify(sig, msg, pubkey)`;
 * `genesisFor(net)` -> { configHash, config }; `decideDepthFor(net)` -> confirmations of the last voting block before the outcome
 * is written (a reorg below it is followed through the anchor: the outcome is taken back and counted again), held to at least
 * `minDecideDepthFor(net)` (MIN_DECIDE_DEPTH; regtest's seat passes 1).
 */
export function createBallotTally({ proposals, tipHeight, votesAt, censusAt, verify, blockHashAt = null, genesisFor = () => BALLOT_GENESIS,
  decideDepthFor = () => 6, minDecideDepthFor = () => MIN_DECIDE_DEPTH, maxBlocksPerPass = 64, log = () => {} }) {
  const votesByHeight = new Map();          // height -> the vote outputs of that block (shared by every proposal voting there)
  const hashByHeight = new Map();           // height -> the hash of the block those votes were read from
  const open = new Map();                   // proposal id -> { readTo, readHash, census, votes: [], result } while undecided
  const reorgs = [];                        // what the reorg checks did, newest last (GET /proposals shows the last few)
  const bodies = new Map();                 // proposal id -> its decoded body (parent, configHash, config bytes)
  let tip = null;
  let lives = new Map();                    // network hex -> liveConfig at the tip
  let spansAll = new Map();                 // network hex -> liveConfig over every passed proposal (no height cut)
  let running = false;

  const bodyOf = (p) => {
    let b = bodies.get(p.id);
    if (!b) {
      const bytes = fromHex(p.proposal);
      b = decodeConfigProposalBody(bytes.subarray(0, bytes.length - 64));
      bodies.set(p.id, b);
    }
    return b;
  };
  const passedOf = (net) => proposals.list().filter((p) => p.networkId === net && stateOf(p) === S.PASSED)
    .map((p) => { const b = bodyOf(p); return { id: fromHex(p.id), parent: b.parent, configHash: b.configHash, config: b.config, activationHeight: p.activationHeight }; });
  const networks = () => new Set(proposals.list().map((p) => p.networkId));
  /** Recomputed when something was decided or the tip moved: a few proposals, so a few comparisons. */
  const refreshLive = () => {
    const l = new Map(), s = new Map();
    for (const net of networks()) {
      const genesis = genesisFor(net);
      const passed = passedOf(net);
      l.set(net, liveConfig({ genesis, passed, height: tip === null ? 0 : tip }));
      s.set(net, liveConfig({ genesis, passed, height: Number.MAX_SAFE_INTEGER }));
    }
    lives = l; spansAll = s;
  };

  /**
   * THE REORG CHECK, before anything is counted: per kept proposal one hash - its anchor if decided, its last block read if
   * open, its publication block otherwise. Answers how many proposals were taken back or forgotten.
   */
  async function followReorgs() {
    if (typeof blockHashAt !== 'function') return 0;
    // THREE ANSWERS, NEVER TWO (kanban #1152): the hash (`same` or `other`), `above` this seat's tip (bitcoind said so: null), or
    // an RPC that did not answer (it threw). Only `other` is evidence of a reorg. A failed read is no answer at all: the
    // whole pass stops before anything moves (an exception, ballot-tally pass), and the next pass asks again
    const at = async (h, want) => {
      const x = await blockHashAt(h);                      // throws on an RPC error: the pass is skipped
      if (!x) return 'above';
      return String(x).toLowerCase() === want ? 'same' : 'other';
    };
    // ONE SNAPSHOT OF WHAT TO CHECK, then every read, then the moves: a read that fails part way has moved nothing
    const plan = [];
    for (const p of proposals.list()) {
      const st = stateOf(p), o = open.get(p.id);
      if (st === S.ORPHANED) { if (p.blockHash) plan.push({ p, st, kind: 'back', got: await at(p.publishedAt, p.blockHash) }); continue; }
      if ((st === S.PASSED || st === S.FAILED) && p.decided.anchor) plan.push({ p, st, kind: 'anchor', got: await at(p.decided.anchor.height, p.decided.anchor.hash) });
      else if (st === S.COUNTING && o && o.readHash) plan.push({ p, st, kind: 'read', got: await at(o.readTo, o.readHash) });
      else if (st === S.COUNTING && p.blockHash) plan.push({ p, st, kind: 'published', got: await at(p.publishedAt, p.blockHash) });
    }
    // and the publication block of each one whose count moved: is it still on this chain?
    for (const c of plan) if (c.got === 'other' && c.kind !== 'published' && c.kind !== 'back') c.pub = c.p.blockHash ? await at(c.p.publishedAt, c.p.blockHash) : 'same';
    let moved = 0;
    for (const c of plan) {
      const { p, st } = c;
      let what = null;
      if (c.kind === 'back') {
        if (c.got === 'same' && proposals.restore(p.id, { at: tip })) what = 'its publication block is on this chain again: counted again';
      } else if (c.got === 'above' && c.kind === 'read') {
        open.delete(p.id);                                  // this chain is shorter than the count: read again when it is there (memory only)
      } else if (c.got === 'other') {
        open.delete(p.id);
        const published = c.kind === 'published' ? 'other' : c.pub;
        if (published === 'other') {
          if (proposals.orphan(p.id, { at: tip })) what = `its publication block left this chain${st === S.COUNTING ? '' : ` (it had ${st} at ${p.decided.decidedAt})`}: orphaned, kept with its bytes`;
        } else if (st !== S.COUNTING) {
          if (proposals.undecide(p.id, `the chain under its outcome changed at ${p.decided.anchor.height}`)) what = `the chain under its outcome (${st} at ${p.decided.decidedAt}) changed: counted again`;
        } else what = 'the chain under its count changed: its votes are read again';
      }
      // `above` for an anchor or a publication: no evidence either way - nothing moves until this chain reaches that height again
      if (!what) continue;
      moved++;
      reorgs.push({ id: p.id, at: tip, what }); if (reorgs.length > 16) reorgs.shift();
      log(`[ballot] reorg: proposal ${p.id.slice(0, 16)}: ${what}`);
    }
    // a moved chain: no vote read before is trusted again - every open proposal reads its heights afresh
    if (moved) { votesByHeight.clear(); hashByHeight.clear(); }
    return moved;
  }

  /** One pass: the tip, the reorg check, then for each undecided proposal in its voting phase its census once and its new blocks. */
  async function pass() {
    if (running) return { skipped: true };
    running = true;
    let read = 0, decided = 0, reorged = 0;
    try {
      const now = Number(await tipHeight());
      if (!Number.isInteger(now) || now < 0) return { skipped: 'tip', why: 'this seat\'s chain named no tip', read: 0, decided: 0, reorged: 0 };
      tip = now;
      // THE PROPOSER CHECK OF RECORDS KEPT BEFORE THIS START (kanban #1670, proposals.js recheck): one not checked yet reads as
      // ORPHANED and is not counted; one whose census was not readable at the start is asked again here, before anything is counted
      // - on the branch of each one's own publication block (kanban #2032): this tally's block reader goes with it, and an
      // `unbonded` record not yet confirmed on its own block is read again too
      if (typeof proposals.recheck === 'function' && typeof proposals.unchecked === 'function'
        && (proposals.unchecked() || (typeof proposals.toReview === 'function' && typeof blockHashAt === 'function' && proposals.toReview()))) {
        try { await proposals.recheck(typeof blockHashAt === 'function' ? { blockHashAt } : {}); } catch (e) { log(`[ballot] the proposer check did not run: ${e.message}`); }
      }
      // A CHAIN THAT DID NOT ANSWER IS NO REORG (kanban #1152): the pass stops here - nothing taken back, orphaned or written
      try { reorged = await followReorgs(); } catch (e) {
        log(`[ballot] the chain did not answer the reorg check (${e.message}): this pass is skipped, nothing moved`);
        return { tip, skipped: 'rpc', why: e.message, read: 0, decided: 0, reorged: 0 };
      }
      if (reorged) refreshLive();
      for (const p of proposals.list().slice().sort((a, b) => a.votingFrom - b.votingFrom)) {
        if (stateOf(p) !== S.COUNTING) { open.delete(p.id); continue; }       // decided, or orphaned: not counted
        if (tip < p.votingFrom) continue;                       // review: votes are not counted yet (27A.7.4)
        let o = open.get(p.id);
        if (!o) { o = { readTo: p.votingFrom - 1, readHash: null, census: null, votes: [], result: null, dirty: true }; open.set(p.id, o); }
        // THE CENSUS AT ITS PUBLICATION (27A.7.3: "the census is snapshotted when the proposal is published"), read once
        if (!o.census) {
          let c = null;
          try { c = await censusAt(p.networkId, p.publishedAt); } catch (e) { log(`[ballot] ${p.id.slice(0, 16)}: no census at ${p.publishedAt} yet: ${e.message}`); }
          if (!c) continue;
          o.census = c; o.dirty = true;
        }
        // ITS VOTING PHASE'S BLOCKS, from where it stopped, up to the tip - each height read once for every proposal
        const last = Math.min(tip, p.votingUntil - 1);
        while (o.readTo < last && read < maxBlocksPerPass) {
          const h = o.readTo + 1;
          if (!votesByHeight.has(h)) {
            // the block's hash first, and its votes from THAT block: the hash the count is later held to is the block it read
            const hash = typeof blockHashAt === 'function' ? await blockHashAt(h) : null;
            if (typeof blockHashAt === 'function' && !hash) break;          // above this seat's tip after all: the next pass
            votesByHeight.set(h, await votesAt(h, hash || undefined)); hashByHeight.set(h, hash ? String(hash).toLowerCase() : null); read++;
          }
          const got = votesByHeight.get(h);
          if (got.length) { o.votes.push(...got); o.dirty = true; }
          o.readTo = h; o.readHash = hashByHeight.get(h) || null;
        }
        if (o.dirty) {
          o.result = tally({ proposal: { class: CLASS[p.class] }, standing: { id: fromHex(p.id), votingFrom: p.votingFrom, votingUntil: p.votingUntil },
            census: o.census, votes: o.votes, verify });
          o.dirty = false;
        }
        // DECIDED ONCE: the whole phase read, and its last block deep enough - no later than the block before its activation
        // (a round created at the activation height must already find the new config live here, or it would be taken under
        // the old one and refused later, mid-flight), and never less than `minDecideDepthFor` deep (kanban #1152: a one- or
        // two-block reorg moves no outcome; a repeal's cooldown, 27A.7.6, leaves room for exactly that)
        const depth = Math.max(1, minDecideDepthFor(p.networkId), Math.min(decideDepthFor(p.networkId), p.activationHeight - p.votingUntil + 1));
        // a count held to the chain names the block it ends on (its anchor); without one nothing is written
        if (typeof blockHashAt === 'function' && !o.readHash) continue;
        if (o.readTo >= p.votingUntil - 1 && tip >= p.votingUntil - 2 + depth) {
          // ITS ANCHOR: the last voting block's hash - it commits to the publication, the census and every vote below it
          const outcome = { ...tallyJson(o.result), decidedAt: tip, census: o.census.length,
            anchor: o.readHash ? { height: o.readTo, hash: o.readHash } : null };
          if (proposals.decide(p.id, outcome)) {
            decided++;
            log(`[ballot] proposal ${p.id.slice(0, 16)} ${outcome.passed ? 'PASSED' : 'FAILED'} at ${tip}: turnout ${outcome.turnoutPct} %, approval ${outcome.approvalPct} % `
              + `(yes ${outcome.yesSats}, no ${outcome.noSats}, abstain ${outcome.abstainSats} of ${outcome.totalSats} sat)`);
          }
          open.delete(p.id);
        }
      }
      // THE VOTE CACHE BELOW EVERY OPEN PHASE IS LET GO: no undecided proposal will ask for those heights again
      const floor = Math.min(...[...open.keys()].map((id) => { const p = proposals.list().find((x) => x.id === id); return p ? p.votingFrom : Infinity; }));
      for (const h of votesByHeight.keys()) if (h < floor) { votesByHeight.delete(h); hashByHeight.delete(h); }
      refreshLive();
      return { tip, read, decided, reorged };
    } finally { running = false; }
  }

  /** The phase of a kept proposal at the tip (27A.7.4): review, voting, cooldown, activated, failed - or void (27A.7.2). */
  const phaseOf = (p) => {
    if (stateOf(p) === S.ORPHANED) return 'orphaned';
    if (!p.decided) return tip !== null && tip >= p.votingFrom ? 'voting' : 'review';
    if (!p.decided.passed) return 'failed';
    if (tip === null || tip < p.activationHeight) return 'cooldown';
    const l = lives.get(p.networkId);
    return l && l.void.some((v) => toHex(v.id) === p.id) ? 'void' : 'activated';
  };
  const historyJson = (h) => h.map((x) => ({ configHash: toHex(x.configHash), config: x.config ? toHex(x.config) : null, since: x.since, by: x.by ? toHex(x.by) : null }));

  return {
    pass,
    get tip() { return tip; },
    /** The last reorg checks that moved something (newest last), for GET /proposals. */
    reorgs: () => reorgs.slice(),
    /** GET /proposals: each kept proposal with its phase and its tally - the decided one, or the running count of its phase. */
    list: () => proposals.list().map((p) => {
      const o = open.get(p.id);
      const t = p.decided ? p.decided : o && o.result ? { ...tallyJson(o.result), running: true } : null;
      return { ...p, phase: phaseOf(p), tally: t };
    }),
    /** GET /config for a network: the config live at the tip (27A.7.5), since when and by which proposal, and its history. */
    live(net) {
      const l = lives.get(net) || liveConfig({ genesis: genesisFor(net), passed: [], height: tip === null ? 0 : tip });
      const now = l.history[l.history.length - 1];
      return { network: net, tip, configHash: toHex(l.configHash), since: now.since, by: now.by ? toHex(now.by) : null,
        history: historyJson(l.history), void: l.void.map((v) => ({ id: toHex(v.id), why: v.why })) };
    },
    /** The history over every passed proposal, for the serving rule (ballot-chain.js configServesRound). */
    spans: (net) => (spansAll.get(net) || liveConfig({ genesis: genesisFor(net), passed: [], height: 0 })).history,
    /**
     * The history live at `height`, for reading a repeal (proposals.js historyFor) - or null while a proposal that would
     * activate by then is still undecided here (its outcome is not known yet, so neither is the history).
     */
    historyAt(net, height) {
      // a record whose proposer is not checked yet (kanban #1670) may be a PASSED one: its outcome is not known here yet either
      // (kanban #1865: only one stored OPEN and activating by `height` - a decided one is held with its outcome, see proposals.js)
      const pending = (typeof proposals.openUnchecked === 'function' ? proposals.openUnchecked(net, height) > 0
        : typeof proposals.unchecked === 'function' && proposals.unchecked(net) > 0)
        || proposals.list().some((p) => p.networkId === net && stateOf(p) === S.COUNTING && p.activationHeight <= height);
      if (pending) return null;
      return liveConfig({ genesis: genesisFor(net), passed: passedOf(net), height }).history;
    },
  };
}
