// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE VOTE HIJACK AND THE FIVE RULES (§27A.9.52026-10-17: "people can just spin up nodes with lots of btc
// temporarily" - "Make it 3 months", "older nodes ... can get a factor that increases their weight", "It needs to be more simple"): a
// bond under 3 months old, or unlocking within 3 months of the vote, has no vote (rule 1); older bonds weigh 2x and 3x (rule 2); YES
// needs 60 % of the votes and 20 % of everyone who could vote (rule 3); a payment over the caps waits or never goes (rule 4); payments
// wait 2 weeks and come in tranches (rule 5); the signal counts nodes active in 3 of 4 weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { fundingTally, voteWeights, ageFactor, capStands, trancheSchedule, activeInWeeks, fundingProposalId, FUNDING_SCHEDULES } from '../src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../src/ballot.js';

const S = FUNDING_SCHEDULES.spec;
const sk = (n) => { const b = new Uint8Array(32); b[0] = 3; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const PUB = 200000;                                                   // the proposal's published height
const P = { networkId: new Uint8Array(32).fill(7), author: pk(99), publishedHeight: PUB, amountSats: 1000n, lnurl: 'anyone@example.org', purpose: 'Pay me' };
const ID = fundingProposalId(P);
const FROM = PUB + S.signal, UNTIL = FROM + S.vote, LAST = UNTIL - 1;
const SEASONED = PUB - S.season, YEAR = LAST + S.year;      // a bond exactly 3 months old; a lock a year past the vote
const bond = (n, sats, height, maturity) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height, maturity });
const vote = (n, choice, height = FROM + 10) => ({ payload: encodeVote({ proposalId: ID, choice, signature: schnorr.sign(voteMessage(ID, choice), sk(n)) }), height, txid: 'aa'.repeat(32) });
const count = (census, votes) => { const w = voteWeights({ census, publishedHeight: PUB, last: LAST, schedule: S });
  return { w, t: fundingTally({ proposalId: ID, census: w.voters, votes, from: FROM, until: UNTIL, verify: (s, m, k) => schnorr.verify(s, m, k) }) }; };

// the honest network: three operators, 3 months to 2 years in the game, locked a year past the vote
const HONEST = [bond(1, 400_000_000, SEASONED - 2 * S.year, YEAR), bond(2, 300_000_000, SEASONED - 1, YEAR), bond(3, 300_000_000, SEASONED, YEAR)];

test('rule 1, fresh bonds: 100 BTC bonded after the proposal - or a day short of 3 months before it - carries no vote', () => {
  const attacker = [bond(9, 10_000_000_000, PUB + 10, YEAR + 100000), bond(8, 5_000_000_000, SEASONED + 144, YEAR)];
  const { w, t } = count([...HONEST, ...attacker], [vote(9, CHOICE.YES), vote(8, CHOICE.YES), vote(1, CHOICE.NO)]);
  assert.deepEqual(w.voters.map((b) => b.outpoint.slice(0, 2)), ['01', '02', '03'], 'only the bonds 3 months old vote');
  assert.deepEqual([t.yesSats, t.passed], ['0', false]);
});

test('rule 1, short locks: a bond unlocking less than 3 months after the vote has no vote; past its lock date it serves but does not vote', () => {
  const short = bond(4, 1_000_000_000, SEASONED - 10, LAST + S.lockAfterVote - 1);
  const enough = bond(5, 1_000_000_000, SEASONED - 10, LAST + S.lockAfterVote);
  const { w } = count([short, enough, bond(6, 1_000_000_000, SEASONED - 10, LAST - 1)], []);
  assert.deepEqual(w.voters.map((b) => b.outpoint.slice(0, 2)), ['05']);
});

test('rule 2, the age factor: 1x under a year, 2x from one, 3x from two - old nodes outweigh new money up to 3 : 1', () => {
  assert.deepEqual([ageFactor(S.season), ageFactor(S.year - 1), ageFactor(S.year), ageFactor(2 * S.year - 1), ageFactor(2 * S.year), ageFactor(10 * S.year)], [1n, 1n, 2n, 2n, 3n, 3n]);
  const { w } = count(HONEST, []);
  assert.deepEqual(w.voters.map((b) => [b.factor, b.weight]), [[3, 1_200_000_000n], [1, 300_000_000n], [1, 300_000_000n]]);
  assert.equal(w.totalWeight, 1_800_000_000n);
});

test('rule 3: 60 % of the votes YES and YES at least 20 % of everyone who could vote; a quiet electorate is not enough', () => {
  // 18 weight units could vote; node 2 alone votes YES: 100 % of the votes, but 3 of 18 = 16.66 % of everyone - fails
  const quiet = count(HONEST, [vote(2, CHOICE.YES)]).t;
  assert.deepEqual([quiet.approved, quiet.absolute, quiet.yesOfAllPct, quiet.passed], [true, false, 16.66, false]);
  // node 1 (3x) YES, nodes 2 and 3 NO: YES 12 of 18 = 66.66 % of the votes, and of everyone - passes
  const ok = count(HONEST, [vote(1, CHOICE.YES), vote(2, CHOICE.NO), vote(3, CHOICE.NO)]).t;
  assert.deepEqual([ok.approvalPct, ok.passed], [66.66, true]);
  // nodes 2 and 3 YES, node 1 NO: 6 of 18 is 33 % of everyone but 33 % of the votes - fails at 60 %
  const no = count(HONEST, [vote(1, CHOICE.NO), vote(2, CHOICE.YES), vote(3, CHOICE.YES)]).t;
  assert.deepEqual([no.approved, no.passed], [false, false]);
});

test('rule 4 over-cap: a proposal over 10 % of the reserves is never paid; a payment over 25 % in 90 days waits', () => {
  assert.deepEqual(capStands({ proposalSats: 101_000, paymentSats: 101_000, reservesSats: 1_000_000 }).final, true);
  assert.equal(capStands({ proposalSats: 100_000, paymentSats: 100_000, reservesSats: 1_000_000 }).ok, true);
  // 200,000 paid in the window from 1,000,000 at its start (800,000 held now): another 50,000 makes 25 % - fits; 50,001 waits
  assert.equal(capStands({ proposalSats: 50_000, paymentSats: 50_000, reservesSats: 800_000, paidInWindowSats: 200_000 }).ok, true);
  const w = capStands({ proposalSats: 80_000, paymentSats: 50_001, reservesSats: 800_000, paidInWindowSats: 200_000 });
  assert.deepEqual([w.ok, w.final], [false, false]); assert.match(w.why, /more than 25 % of 1000000 sat/);
  // a proposal's earlier tranches count toward its own 10 %, not as reserves lost
  assert.equal(capStands({ proposalSats: 100_000, paymentSats: 25_000, reservesSats: 925_000, paidByProposalSats: 75_000 }).ok, true);
});

test('rule 5 tranches: up to 1 % of the reserves pays once after 2 weeks; more pays in 4 monthly tranches', () => {
  const one = trancheSchedule({ amountSats: 10_000n, reservesSats: 1_000_000n, last: LAST, schedule: S });
  assert.deepEqual(one.map((t) => [t.k, t.amountSats, t.dueAt]), [[0, 10_000n, LAST + 2016]]);
  const four = trancheSchedule({ amountSats: 100_003n, reservesSats: 1_000_000n, last: LAST, schedule: S });
  assert.deepEqual(four.map((t) => [t.amountSats, t.dueAt - LAST]), [[25_000n, 2016], [25_000n, 6336], [25_000n, 10656], [25_003n, 14976]]);
});

test('the signal: a node counts as active only with rounds served in 3 of the 4 weeks', () => {
  const weeks = [new Set(['aa', 'bb', 'cc']), new Set(['aa', 'bb']), new Set(['aa', 'cc']), new Set(['dd', 'cc'])];
  assert.deepEqual(activeInWeeks(weeks).sort(), ['aa', 'cc'], 'aa in 3 weeks, cc in 3, bb in 2 and dd in 1 do not count');
});
