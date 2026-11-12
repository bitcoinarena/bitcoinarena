// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit (census area), finding 1: a reorg that lands WHILE one tally pass reads a voting phase.
// The count is held to the hash of the LAST block it read only; that hash commits to the chain below it as it is NOW, not to
// the blocks the pass read earlier. Fixtures copied from ballot-tally.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32), C = key(0x33), STRANGER = key(0x34);
// THE BONDS AT THE PUBLICATION: 50 + 30 + 20 = 100 M sat
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });

/** A proposal as proposals.js keeps it (regtest: review 1, voting 6, cooldown 1). */
function kept({ net = H(0x4e), parent = BALLOT_GENESIS.configHash, configHash = H(0x22), config = Uint8Array.of(2), cls = CLASS.DESIGN, publishedAt = 100,
  review = 1, voting = 6, cooldown = 1, repeal = false } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: net, parent, configHash, config, class: cls, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(net),
    parent: toHex(parent), configHash: toHex(configHash), class: Object.keys(CLASS).find((k) => CLASS[k] === cls), proposer: toHex(A.pubkey), publishedAt,
    depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting, activationHeight, repeal } };
}
/** proposals.js's list / decide over a plain array, its writes counted. */
function store(records) {
  const held = new Map(records.map((r) => [r.id, r]));
  const s = { writes: 0, list: () => [...held.values()], decide: (id, outcome) => { const h = held.get(id); if (!h || h.decided) return false; held.set(id, { ...h, decided: outcome }); s.writes++; return true; } };
  return s;
}
/** A chain: a tip that moves, the votes of each height, and every read counted. */
function chain(votesByHeight) {
  const c = { tip: 0, reads: [], censusReads: 0 };
  c.tipHeight = async () => c.tip;
  c.votesAt = async (h) => { c.reads.push(h); return votesByHeight.get(h) || []; };
  c.censusAt = async () => { c.censusReads++; return CENSUS; };
  return c;
}

// A REORG (the hole of comment 2255): a count is held to the hashes of the blocks it read. A chain that can fork:
// each height a block with its own hash and votes; fork(at, votes) replaces every block from `at` up with new ones.
function forkable(votesByHeight, top = 120) {
  const c = { tip: 0, reads: [], hashCalls: 0, censusReads: 0, blocks: new Map(), byHash: new Map(), branch: 0 };
  const put = (h, votes) => { const hash = `${String(c.branch).padStart(2, '0')}${String(h).padStart(6, '0')}`.padEnd(64, 'f'); c.blocks.set(h, hash); c.byHash.set(hash, votes || []); };
  for (let h = 0; h <= top; h++) put(h, votesByHeight.get(h));
  c.fork = (at, votes) => { c.branch++; for (let h = at; h <= top; h++) put(h, votes.get(h)); };
  c.tipHeight = async () => c.tip;
  c.blockHashAt = async (h) => { c.hashCalls++; return h <= c.tip ? c.blocks.get(h) : null; };
  c.votesAt = async (h, hash) => { c.reads.push(h); return c.byHash.get(hash || c.blocks.get(h)) || []; };
  c.censusAt = async () => { c.censusReads++; return CENSUS; };
  return c;
}
/** store() with proposals.js's undecide, orphan and restore (kanban #1152: nothing is forgotten, an orphan keeps its bytes). */
function reorgStore(records) {
  const held = new Map(records.map((r) => [r.id, r]));
  const s = { writes: 0, orphaned: [],
    list: () => [...held.values()],
    decide: (id, outcome) => { const h = held.get(id); if (!h || h.decided || h.orphaned) return false; held.set(id, { ...h, decided: outcome }); s.writes++; return true; },
    undecide: (id) => { const h = held.get(id); if (!h || !h.decided) return false; const { decided, ...rest } = h; held.set(id, rest); s.writes++; return true; },
    orphan: (id) => { const h = held.get(id); if (!h || h.orphaned) return false; const { decided, ...rest } = h; held.set(id, { ...rest, state: 'ORPHANED', orphaned: { was: decided ? 'decided' : 'COUNTING' } }); s.orphaned.push(id); s.writes++; return true; },
    restore: (id) => { const h = held.get(id); if (!h || !h.orphaned) return false; const { orphaned, state, ...rest } = h; held.set(id, rest); s.writes++; return true; } };
  return s;
}


test('wf1489-sm2-census-1: a reorg between two block reads of one pass leaves the old branch\'s votes in the count, and the outcome is written on them', async () => {
  const { idBytes, record } = kept();
  // OLD BRANCH: A (50 M) votes YES at 101, B (30 M) ABSTAIN at 102 -> passes (turnout 80 %, approval 100 %)
  const yes = new Map([[101, [vote(A, idBytes, CHOICE.YES, 101, 'a1')]], [102, [vote(B, idBytes, CHOICE.ABSTAIN, 102, 'b1')]]]);
  const ch = forkable(yes);
  const proposals = reorgStore([{ ...record, blockHash: ch.blocks.get(100) }]);
  // THE CHAIN MOVES WHILE THE PASS READS (testnet4: a 3-block reorg while the pass waits on bitcoind): just before the pass reads
  // block 103, blocks 101-102 are replaced - on the new branch A votes NO at 101 and B NO at 102
  const read = ch.votesAt;
  let forked = false;
  ch.votesAt = async (h, hash) => {
    if (h === 103 && !forked) {
      forked = true;
      ch.fork(101, new Map([[101, [vote(A, idBytes, CHOICE.NO, 101, 'a1x')]], [102, [vote(B, idBytes, CHOICE.NO, 102, 'b1x')]]]));
      hash = ch.blocks.get(103);                     // the hash the pass asked a moment before is the new branch's too
    }
    return read(h, hash);
  };
  const t = createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  ch.tip = 106; await t.pass();
  assert.ok(forked, 'the fork happened mid-pass');
  // later passes on the chain as it now is: every reorg check has had its chance
  ch.tip = 110; await t.pass(); await t.pass();
  const p = proposals.list()[0];
  console.log('  DECIDED:', JSON.stringify({ passed: p.decided.passed, yesSats: p.decided.yesSats, noSats: p.decided.noSats, anchor: p.decided.anchor.hash.slice(0, 8),
    chainAt106: ch.blocks.get(106).slice(0, 8), live: t.live(toHex(H(0x4e))).configHash.slice(0, 16) }));
  // THE CHAIN NOW HOLDS A NO (50 M) and B NO (30 M): the proposal fails on it. Every seat that read the phase after the reorg
  // writes FAILED; this seat wrote PASSED from votes in blocks that are not on its chain, and its anchor (the new 106) never moves.
  assert.equal(p.decided.passed, false, 'the outcome is the count of the chain the seat is on');
  assert.equal(t.live(toHex(H(0x4e))).configHash, toHex(BALLOT_GENESIS.configHash), 'no config goes live on votes the chain does not hold');
});

