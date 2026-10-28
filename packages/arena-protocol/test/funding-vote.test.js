// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BOND-WEIGHTED VOTE OF A FUNDING PROPOSAL (§27A.9.3 stage 2): #329's on-chain votes, counted on the bonds
// active at the vote's start, weighted by bond. the owner's edges: YES 19.99 % of everyone who could vote fails and 20 % passes (rule 3,
// 2026-10-17, replacing the 30 % turnout); YES at 59.99 % of YES + NO fails
// and 60 % passes; ABSTAIN moves turnout, not approval; votes at signalEnd - 1 and signalEnd + 2016 do not count, at signalEnd and
// signalEnd + 2015 they do; the last vote per bond counts, a tie in one block to the lower txid; a key that is no bond does not count;
// a failed signal opens no vote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fundingTally, votePeriodOf, fundingProposalId, FUNDING_SCHEDULES } from '../src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../src/ballot.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 2; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const P = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 156800, amountSats: 250000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'A second relay' };
const ID = fundingProposalId(P);
const bond = (n, bondSats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(bondSats) });
const vote = (n, choice, height, txid = 'aa'.repeat(32)) => ({ payload: encodeVote({ proposalId: ID, choice, signature: schnorr.sign(voteMessage(ID, choice), sk(n)) }), height, txid });
const period = votePeriodOf({ proposal: P, signal: { state: 'passed' } });
const count = (census, votes) => fundingTally({ proposalId: ID, census, votes, from: period.from, until: period.until, verify });
const IN = period.from + 10;

test('the period: it opens at signalEnd (published + 1008) for 2016 blocks; decided at 6 deep; a failed or open signal opens none', () => {
  assert.deepEqual(period, { from: 157808, until: 159824, last: 159823, decidableAt: 159828 });
  assert.equal(FUNDING_SCHEDULES.spec.vote, 2016);
  assert.equal(votePeriodOf({ proposal: P, signal: { state: 'failed' } }), null);
  assert.equal(votePeriodOf({ proposal: P, signal: { state: 'signalling' } }), null);
});

test('rule 3: YES at 19.99 % of everyone who could vote fails, 20 % passes - however few voted', () => {
  const census = [bond(1, 1999), bond(2, 1), bond(3, 8000)];
  const low = count(census, [vote(1, CHOICE.YES, IN)]);
  assert.deepEqual([low.yesOfAllPct, low.absolute, low.passed], [19.99, false, false]);
  const at = count(census, [vote(1, CHOICE.YES, IN), vote(2, CHOICE.YES, IN)]);
  assert.deepEqual([at.yesOfAllPct, at.turnoutPct, at.approvalPct, at.passed], [20, 20, 100, true], '20 % turnout is enough when all of it says YES');
});

test('approval: YES at 59.99 % of YES + NO fails, 60 % passes; ABSTAIN moves turnout, not approval', () => {
  const census = [bond(1, 5999), bond(2, 4000), bond(3, 1), bond(4, 5000)];
  const under = count(census, [vote(1, CHOICE.YES, IN), vote(2, CHOICE.NO, IN), vote(3, CHOICE.NO, IN)]);
  assert.deepEqual([under.approvalPct, under.approved, under.passed], [59.99, false, false]);
  const at = count(census, [vote(1, CHOICE.YES, IN), vote(3, CHOICE.YES, IN), vote(2, CHOICE.NO, IN)]);
  assert.deepEqual([at.approvalPct, at.approved, at.passed], [60, true, true]);
  const withAbstain = count(census, [vote(1, CHOICE.YES, IN), vote(3, CHOICE.YES, IN), vote(2, CHOICE.NO, IN), vote(4, CHOICE.ABSTAIN, IN)]);
  assert.deepEqual([withAbstain.approvalPct, withAbstain.turnoutPct, withAbstain.abstainSats], [60, 100, '5000'], 'approval the same, turnout up');
  assert.equal(at.turnoutPct, 66.66, 'shown floored to the hundredth, as \'s tally');
});

test('the window: votes at signalEnd - 1 and signalEnd + 2016 do not count; at signalEnd and signalEnd + 2015 they do', () => {
  const census = [bond(1, 100), bond(2, 100)];
  const edges = count(census, [vote(1, CHOICE.YES, period.from - 1), vote(2, CHOICE.YES, period.until)]);
  assert.equal(edges.bondsVoted, 0);
  const inside = count(census, [vote(1, CHOICE.YES, period.from), vote(2, CHOICE.YES, period.until - 1)]);
  assert.deepEqual([inside.bondsVoted, inside.yesSats], [2, '200']);
});

test('the last vote per bond counts, a tie in one block goes to the lower txid; a key that is no bond does not count', () => {
  const census = [bond(1, 100), bond(2, 100)];
  const changed = count(census, [vote(1, CHOICE.YES, IN), vote(1, CHOICE.NO, IN + 1)]);
  assert.deepEqual([changed.yesSats, changed.noSats, changed.bondsVoted], ['0', '100', 1]);
  const tie = count(census, [vote(1, CHOICE.YES, IN, 'bb'.repeat(32)), vote(1, CHOICE.NO, IN, 'aa'.repeat(32))]);
  assert.deepEqual([tie.yesSats, tie.noSats], ['0', '100'], 'the lower txid (aa) wins the block');
  const stranger = count(census, [vote(9, CHOICE.YES, IN)]);
  assert.deepEqual([stranger.bondsVoted, stranger.yesSats], [0, '0'], 'bond 9 is not in the census at the vote\'s start');
});
