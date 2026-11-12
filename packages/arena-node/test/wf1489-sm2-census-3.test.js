// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit (census area), finding 2: a reorg below a decided proposal whose
// votes do not change: the outcome is taken back at once and the config goes back until the whole phase is read again. Fixtures copied from ballot-tally.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { createProposals } from '../src/proposals.js';
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


test('wf1489-sm2-census-2: a reorg below a decided repeal whose votes do not change takes the live config back for many passes', async () => {
  // A REPEAL ON THE MAINNET SCHEDULE (review 0, voting 720, cooldown 0): decided one deep (the 1.9 line's minDecideDepthFor 1,
  // min(6, activation - votingUntil + 1) = 1), live from its activation = votingUntil
  const { idBytes, record } = kept({ review: 0, voting: 720, cooldown: 0, configHash: H(0x24) });
  const votes = new Map([[100, [vote(A, idBytes, CHOICE.YES, 100, 'a1')]]]);
  const ch = forkable(votes, 900);
  const proposals = reorgStore([{ ...record, blockHash: ch.blocks.get(100) }]);
  const t = createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify,
    decideDepthFor: () => 6, minDecideDepthFor: () => 1 });
  ch.tip = 819;
  for (let i = 0; i < 20 && !proposals.list()[0].decided; i++) await t.pass();
  assert.equal(proposals.list()[0].decided.passed, true);
  ch.tip = 822; await t.pass();
  assert.equal(t.live(toHex(H(0x4e))).configHash, toHex(H(0x24)), 'live from 820');
  // A 3-BLOCK REORG (819-821): the same votes (none in those blocks), only other hashes
  ch.fork(819, new Map());
  ch.tip = 822;
  const liveAfter = [];
  for (let i = 0; i < 4; i++) { await t.pass(); liveAfter.push(t.live(toHex(H(0x4e))).configHash.slice(0, 8)); }
  console.log('  LIVE AFTER THE REORG, PASS BY PASS:', JSON.stringify(liveAfter), 'phase', t.list()[0].phase);
  // NOTHING THE TALLY COUNTS CHANGED, yet the seat serves the config the repeal replaced for the passes the recount takes
  // (720 blocks at 64 a pass = 12 passes, 2 minutes at 10 s): rounds created at census >= 820 naming the live config are refused here
  assert.deepEqual(liveAfter, Array(4).fill(toHex(H(0x24)).slice(0, 8)), 'the live config does not flip back while an unchanged count is redone');
});

test('kanban #1635: the replaced outcome stays in force through a restart mid-recount, and the recount decides it again', async () => {
  const { idBytes, record } = kept({ review: 0, voting: 720, cooldown: 0, configHash: H(0x24) });
  const votes = new Map([[100, [vote(A, idBytes, CHOICE.YES, 100, 'a1')]]]);
  const ch = forkable(votes, 900);
  // proposals.js itself over a store that outlives the process (a crash = a new createProposals over the same rows)
  let rows = [{ ...record, blockHash: ch.blocks.get(100) }];
  const disk = { read: () => rows.map((r) => ({ ...r })), write: (l) => { rows = l.map((r) => ({ ...r })); } };
  const open = () => createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify, store: disk });
  const mk = (proposals) => createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify,
    decideDepthFor: () => 6, minDecideDepthFor: () => 1 });
  let p1 = open(), t = mk(p1);
  ch.tip = 822;
  for (let i = 0; i < 20 && !p1.list()[0].decided; i++) await t.pass();
  await t.pass();
  const NEW = toHex(H(0x24)).slice(0, 8);
  assert.equal(t.live(toHex(H(0x4e))).configHash.slice(0, 8), NEW);
  ch.fork(819, new Map());
  await t.pass();
  assert.equal(p1.list()[0].state, 'COUNTING', 'the outcome was taken back');
  assert.equal(t.live(toHex(H(0x4e))).configHash.slice(0, 8), NEW, 'held in force while recounting');
  // RESTART mid-recount: the held outcome is read back from the record
  const p2 = open(); t = mk(p2);
  await t.pass();
  assert.equal(p2.list()[0].state, 'COUNTING');
  assert.equal(t.live(toHex(H(0x4e))).configHash.slice(0, 8), NEW, 'held in force after a restart');
  for (let i = 0; i < 20 && !p2.list()[0].decided; i++) await t.pass();
  assert.equal(p2.list()[0].decided.passed, true, 'decided again, same outcome');
  assert.equal(t.live(toHex(H(0x4e))).configHash.slice(0, 8), NEW);
  // the publication block leaving: orphaned, nothing held - the config the repeal replaced is back
  ch.fork(100, new Map()); await t.pass();
  assert.equal(p2.list()[0].state, 'ORPHANED');
  assert.equal(t.live(toHex(H(0x4e))).configHash, toHex(BALLOT_GENESIS.configHash));
});
