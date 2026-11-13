// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE VOTE AS A SEAT DECIDES IT (§27A.9.3 stage 2): opened only by a signal the seat decided passed; the census
// taken once at the vote's start; undecided while the last voting block is 5 deep, decided at 6, written once - later votes and a
// later census do not move it - and reopened only when the counted last block is reorged away. The short schedule (a 1-block signal,
// a 6-block vote) keeps the chain small; the spec's 1008 / 2016 are funding-vote.test.js'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 3; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const proposal = (n, purpose) => ({ networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, amountSats: 1000n, lnurl: 'dev@bitcoin-arena.io', purpose });
const P1 = proposal(1, 'passes its signal'), P2 = proposal(1, 'fails its signal');
const ID1 = fundingProposalId(P1);
// seasoned (confirmed 50 blocks before the proposal, D1) and locked a year past the vote (full weight, D2)
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const vote = (n, choice, txid = 'aa'.repeat(32)) => ({ payload: encodeVote({ proposalId: ID1, choice, signature: schnorr.sign(voteMessage(ID1, choice), sk(n)) }), txid });

function world(extra = {}) {
  const chain = { tip: 100, blocks: new Map(), bonds: [bond(10, 3000), bond(11, 7000)], censusAsked: [] };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async (net, h) => { chain.censusAsked.push(h); return chain.bonds.map((b) => ({ ...b })); } };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain, ...extra });
  return { b, chain, at };
}
async function signalled({ b, chain }) {
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  await b.add('proposal', hexOf(encodeFundingProposal(P2), fundingProposalId(P2), 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  chain.tip = 101; await b.decide();                                    // the end seen (kanban #1279: decided decideDepth deep)
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  const d = await b.decide();
  assert.deepEqual(d.map((x) => x.state).sort(), ['failed', 'passed']);
}
const viewOf = (b, id, tip) => b.list(tip).find((x) => x.id === toHex(id)).vote;

test('a passed signal opens [101, 107); a failed one none; the census is taken once, at the vote\'s start', async () => {
  const w = world(); await signalled(w);
  await w.b.voteRound();
  assert.deepEqual(w.chain.censusAsked, [101], 'only the passed proposal, at signalEnd');
  const v = viewOf(w.b, ID1, 101);
  assert.deepEqual([v.from, v.until, v.last, v.decidableAt, v.state, v.censusHeight], [101, 107, 106, 111, 'voting', 101]);
  assert.equal(viewOf(w.b, fundingProposalId(P2), 101), null, 'a failed signal opens no vote');
});

test('undecided at 5 deep, decided at 6, once: later votes and a later census do not move it; a reorg of the counted block reopens it', async () => {
  const w = world(); await signalled(w);
  w.at(101).votes.push(vote(10, CHOICE.YES));
  w.at(106).votes.push(vote(11, CHOICE.YES));
  w.at(107).votes.push(vote(11, CHOICE.NO));                     // after the period: not counted
  w.chain.tip = 110;
  for (let i = 0; i < 3; i++) await w.b.voteRound();
  let v = viewOf(w.b, ID1, 110);
  assert.deepEqual([v.state, v.readTo, v.count.yesSats, v.count.turnoutPct], ['voting', 106, '10000', 100], '5 deep: the running count, no outcome');
  w.chain.tip = 111;
  const [d] = await w.b.voteRound();
  assert.deepEqual([d.passed, d.yesSats, d.noSats, d.totalSats, d.bondsVoted, d.turnoutPct, d.approvalPct, d.lastHash], [true, '10000', '0', '10000', 2, 100, 100, '106'.padStart(64, '0')]);
  // later: a new bond, another vote in a counted block, more blocks - nothing moves
  w.chain.bonds.push(bond(12, 90000)); w.at(105).votes.push(vote(12, CHOICE.NO)); w.chain.tip = 130;
  assert.deepEqual(await w.b.voteRound(), []);
  v = viewOf(w.b, ID1, 130);
  assert.deepEqual([v.state, v.count.yesSats, v.count.totalSats], ['passed', '10000', '10000']);
  assert.deepEqual(w.chain.censusAsked, [101]);
  // a reorg replaces block 106: in the new one bond 11 votes NO - the vote is counted again and fails (YES 30 % of YES + NO)
  w.chain.blocks.set(106, { hash: 'ff'.repeat(32), votes: [vote(11, CHOICE.NO)] });
  const [again] = await w.b.voteRound();
  assert.deepEqual([again.passed, again.yesSats, again.noSats, again.approvalPct, again.lastHash], [false, '3000', '7000', 30, 'ff'.repeat(32)]);
  assert.equal(viewOf(w.b, ID1, 130).state, 'failed');
});

// kanban #2576 (left open by #2562): past BALLOT_BIND_HEIGHT a funding vote is read by seq, as a config proposal's - a bond's older vote
// (lower seq) mined later no longer overturns its newer one; below the gate the last vote by height still counts
const seqVote = (n, choice, seq) => ({ payload: encodeVote({ proposalId: ID1, choice, seq, signature: schnorr.sign(voteMessage(ID1, choice, seq), sk(n)) }), txid: 'bb'.repeat(32) });
test('#2576: past the gate the highest seq counts, not the last block; below it the last block still does', async () => {
  for (const [gate, want] of [[0, { passed: true, yes: '10000', no: '0' }], [null, { passed: false, yes: '3000', no: '7000' }]]) {
    const w = world(gate === null ? {} : { bindHeightFor: () => gate }); await signalled(w);
    w.at(101).votes.push(vote(10, CHOICE.YES));
    if (gate === null) { w.at(102).votes.push(vote(11, CHOICE.YES)); w.at(105).votes.push(vote(11, CHOICE.NO)); }   // old: the later block wins
    else { w.at(102).votes.push(seqVote(10, CHOICE.YES, 1)); w.at(102).votes.push(seqVote(11, CHOICE.YES, 2)); w.at(105).votes.push(seqVote(11, CHOICE.NO, 1)); } // a replayed older vote
    w.chain.tip = 111;
    let d = null; for (let i = 0; i < 4 && !d; i++) [d] = await w.b.voteRound();
    assert.deepEqual([d.passed, d.yesSats, d.noSats], [want.passed, want.yes, want.no], `gate ${gate}`);
  }
});

// feedback #031 (kanban #2580): the operator vote door asks the funding book whether a funding / fee / leaderboard proposal is
// voted bound, so it signs the 80-byte seq vote the bound tally counts (a 77-byte one was dropped: unanimous YES read 0 / 0)
test('#2580: boundOf says bound past the gate, not below it, and null for an id this seat does not hold', async () => {
  const bound = world({ bindHeightFor: () => 0 }); await signalled(bound);
  assert.equal(bound.b.boundOf(toHex(ID1)), true);
  assert.equal(bound.b.boundOf('ab'.repeat(32)), null, 'an id the funding book does not hold');
  const old = world({ bindHeightFor: () => 1000 }); await signalled(old);
  assert.equal(old.b.boundOf(toHex(ID1)), false, 'published at 100, below a gate at 1000');
  const none = world(); await signalled(none);
  assert.equal(none.b.boundOf(toHex(ID1)), false, 'no gate given: the old reading');
  // and the 77-byte vote the door signed before is exactly what the bound tally drops (the report's measurement)
  const w = world({ bindHeightFor: () => 0 }); await signalled(w);
  w.at(101).votes.push(vote(10, CHOICE.YES)); w.at(102).votes.push(vote(11, CHOICE.YES));
  w.chain.tip = 111;
  let d = null; for (let i = 0; i < 4 && !d; i++) [d] = await w.b.voteRound();
  assert.deepEqual([d.passed, d.yesSats], [false, '0'], '77-byte votes on a bound proposal count nothing');
});
