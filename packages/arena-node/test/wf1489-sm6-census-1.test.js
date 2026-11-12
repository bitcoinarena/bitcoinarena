// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 STATE-MACHINE AUDIT, ROUND 6, AREA CENSUS (ballot tally, B1): A CHAIN SEEN SHORTER THAN AN OPEN COUNT FORGETS
// THE COUNT BUT NOT THE VOTE CACHE. followReorgs answers `above` for an open proposal whose last read block is above the tip:
// it drops the proposal from `open` (memory) and moves nothing - so `moved` stays 0 and votesByHeight / hashByHeight are NOT
// cleared. The count restarts from its first block and is held to the hash of the highest block it reads now, which is below
// the fork. When the chain is back on another branch, the heights above the fork are read FROM THE CACHE - the votes of the
// branch the chain left - and the last block (read fresh) gives the anchor. The anchor is on the chain, so the outcome is
// never checked again: this seat decides on votes that are not on its chain, for good, and a seat that reads the same chain
// afresh decides the other way.
//
// Trigger: the tip seen below an open count's last read block while a reorg takes the blocks above it (a reorg seen part way,
// an invalidateblock, a node reading through a bridge that answered from a lagging backend), then the new branch grows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32), C = key(0x33);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];
const NET = toHex(H(0x4e));
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });

function kept({ publishedAt = 100, review = 1, voting = 6, cooldown = 1 } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: H(0x4e), parent: BALLOT_GENESIS.configHash, configHash: H(0x22), config: Uint8Array.of(2), class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature]));
  return { idBytes, record: { id: toHex(idBytes), proposal: hex, networkId: NET, parent: toHex(p.parent), configHash: toHex(p.configHash),
    class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting,
    activationHeight, repeal: false } };
}
function forkable(votesByHeight, top = 140) {
  const c = { tip: 0, blocks: new Map(), byHash: new Map(), branch: 0 };
  const put = (h, votes) => { const hash = `${String(c.branch).padStart(2, '0')}${String(h).padStart(6, '0')}`.padEnd(64, 'f'); c.blocks.set(h, hash); c.byHash.set(hash, votes || []); };
  for (let h = 0; h <= top; h++) put(h, votesByHeight.get(h));
  c.fork = (at, votes = new Map()) => { c.branch++; for (let h = at; h <= top; h++) put(h, votes.get(h)); };
  c.tipHeight = async () => c.tip;
  c.blockHashAt = async (h) => (h <= c.tip ? c.blocks.get(h) : null);
  c.votesAt = async (h, hash) => c.byHash.get(hash || c.blocks.get(h)) || [];
  c.censusAt = async () => CENSUS;
  return c;
}
function seatStore(records = []) {
  const rows = new Map(records.map((r) => [r.id, JSON.stringify(r)]));
  return { rows, read() { return [...rows.values()].map((j) => JSON.parse(j)); }, write(list) { for (const x of list) rows.set(x.id, JSON.stringify(x)); } };
}
const seat = (k, ch) => {
  const proposals = createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify,
    store: seatStore([{ ...k.record, blockHash: ch.blocks.get(100) }]) });
  const t = createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify,
    decideDepthFor: () => 6, minDecideDepthFor: () => 1 });
  return { proposals, t };
};

test('wf1489-sm6-census-1: a tip seen below an open count keeps the left branch\'s votes in the cache, and the outcome is decided on them for good', async () => {
  const k = kept();                                               // published 100, voting 101-106, activation 108
  // THE FIRST BRANCH: A (50 M) and B (30 M) vote YES at 104 and 105 - 80 % turnout, passed
  const ch = forkable(new Map([[104, [vote(A, k.idBytes, CHOICE.YES, 104, 'a1')]], [105, [vote(B, k.idBytes, CHOICE.YES, 105, 'b1')]]]));
  const s = seat(k, ch);
  ch.tip = 105; await s.t.pass();                                 // read 101-105 on branch 0, cached
  // A REORG FROM 104 ON, seen with the tip at 103 for one pass: the votes are not in the new branch
  ch.fork(104); ch.tip = 103;
  const short = await s.t.pass();
  // THE NEW BRANCH GROWS past the decision depth
  ch.tip = 110; const grown = await s.t.pass();
  ch.tip = 112; await s.t.pass();
  const mine = s.proposals.list()[0];
  // A SEAT READING THE SAME CHAIN AFRESH
  const fresh = seat(k, ch);
  await fresh.t.pass();
  const theirs = fresh.proposals.list()[0];
  console.log('  sm6-census-1:', JSON.stringify({ short, grown, mine: { state: mine.state, yes: mine.decided && mine.decided.yesSats, anchor: mine.decided && mine.decided.anchor },
    fresh: { state: theirs.state, yes: theirs.decided && theirs.decided.yesSats }, live: s.t.live(NET).configHash.slice(0, 16), liveFresh: fresh.t.live(NET).configHash.slice(0, 16) }));
  assert.equal(theirs.state, 'FAILED', 'on the chain as it is, nobody voted: the proposal fails');
  assert.equal(mine.state, theirs.state, 'the seat that saw the short tip decides on the same chain the same way (it decided on votes of the branch the chain left)');
  assert.equal(s.t.live(NET).configHash, fresh.t.live(NET).configHash, 'both seats name the same live config');
});
