// THE VOTE HIJACK AND ITS DEFENCES (§27A.9.5, kanban #397, the owner 2026-10-17: "people can just spin up nodes with lots of btc temporarily
// for a few weeks and then shut them down to steal funds" - "Take D1-D6 as proposed"): an attacker who bonds a lot after a proposal is
// published, or locks only briefly, has no vote (D1, D2); a payment over the caps waits or never goes (D3); a passing share of a quiet
// electorate is not enough without 20 % of the seasoned capital (D4); only nodes active in 3 of 4 weeks count for the signal (D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { fundingTally, voteWeights, capStands, trancheSchedule, activeInWeeks, fundingProposalId, FUNDING_SCHEDULES } from '../src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../src/ballot.js';

const S = FUNDING_SCHEDULES.spec;
const sk = (n) => { const b = new Uint8Array(32); b[0] = 3; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const PUB = 200000;                                                   // the proposal's published height
const P = { networkId: new Uint8Array(32).fill(7), author: pk(99), publishedHeight: PUB, amountSats: 1000n, lnurl: 'anyone@example.org', purpose: 'Pay me' };
const ID = fundingProposalId(P);
const FROM = PUB + S.signal, UNTIL = FROM + S.vote, LAST = UNTIL - 1;
const SEASONED = PUB - S.season, YEAR = LAST + S.fullLock;
const bond = (n, sats, height, maturity) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height, maturity });
const vote = (n, choice, height = FROM + 10) => ({ payload: encodeVote({ proposalId: ID, choice, signature: schnorr.sign(voteMessage(ID, choice), sk(n)) }), height, txid: 'aa'.repeat(32) });
const count = (census, votes) => { const w = voteWeights({ census, publishedHeight: PUB, last: LAST, schedule: S });
  return { w, t: fundingTally({ proposalId: ID, census: w.voters, votes, from: FROM, until: UNTIL, verify: (s, m, k) => schnorr.verify(s, m, k), seasonedSats: w.seasonedSats }) }; };

// the honest network: three seasoned operators locked a year past the vote, 10 BTC between them
const HONEST = [bond(1, 400_000_000, SEASONED - 5000, YEAR), bond(2, 300_000_000, SEASONED - 1, YEAR), bond(3, 300_000_000, SEASONED, YEAR)];

test('D1 fresh bonds: 100 BTC bonded after the proposal - or a day short of 6 months before it - carries no vote', () => {
  const attacker = [bond(9, 10_000_000_000, PUB + 10, YEAR + 100000), bond(8, 5_000_000_000, SEASONED + 144, YEAR)];
  const { w, t } = count([...HONEST, ...attacker], [vote(9, CHOICE.YES), vote(8, CHOICE.YES), vote(1, CHOICE.NO)]);
  assert.deepEqual(w.voters.map((b) => b.outpoint.slice(0, 2)), ['01', '02', '03'], 'only the seasoned bonds vote');
  assert.equal(w.seasonedSats, 1_000_000_000n);
  assert.deepEqual([t.yesSats, t.noSats, t.passed], ['0', '400000000', false]);
});

test('D2 short locks: a seasoned bond that unlocks before 3 months after the vote has no vote; half a year left is half the weight', () => {
  const short = bond(4, 1_000_000_000, SEASONED - 10, LAST + S.lockAfterVote - 1);     // one block short of 3 months
  const half = bond(5, 1_000_000_000, SEASONED - 10, LAST + S.fullLock / 2);            // ~6 months left
  const { w } = count([...HONEST, short, half], []);
  assert.equal(w.voters.find((b) => b.outpoint.startsWith('04')), undefined);
  assert.equal(w.voters.find((b) => b.outpoint.startsWith('05')).weight, 500_000_000n);
  assert.equal(w.seasonedSats, 3_000_000_000n, 'both still count as seasoned capital (D4\'s base), whatever their lock');
  const past = bond(6, 1_000_000_000, SEASONED - 10, LAST - 1);                           // past its lock date: serves rounds, no vote
  assert.equal(count([past], []).w.voters.length, 0);
});

test('D4 low absolute support: 30 % turnout and 100 % YES of a quiet electorate still fail without 20 % of the seasoned capital', () => {
  // 10 BTC seasoned, only 1.9 BTC locked long enough to vote - all of it YES: turnout 100 % of the voters, but 19 % of the seasoned capital
  const census = [bond(1, 190_000_000, SEASONED, YEAR), bond(2, 810_000_000, SEASONED, LAST + 10)];
  const { t } = count(census, [vote(1, CHOICE.YES)]);
  assert.deepEqual([t.quorum, t.approved, t.absolute, t.passed], [true, true, false, false]);
  const { t: t2 } = count([bond(1, 200_000_000, SEASONED, YEAR), bond(2, 800_000_000, SEASONED, LAST + 10)], [vote(1, CHOICE.YES)]);
  assert.deepEqual([t2.absolute, t2.passed], [true, true], 'exactly 20 % passes');
});

test('D3 over-cap: a proposal over 10 % of the reserves is never paid; a payment over 25 % in 90 days waits', () => {
  assert.deepEqual(capStands({ proposalSats: 101_000, paymentSats: 101_000, reservesSats: 1_000_000 }).final, true);
  assert.equal(capStands({ proposalSats: 100_000, paymentSats: 100_000, reservesSats: 1_000_000 }).ok, true);
  // 200,000 paid in the window from 1,000,000 at its start (800,000 held now): another 50,000 makes 25 % - fits; 50,001 waits
  assert.equal(capStands({ proposalSats: 50_000, paymentSats: 50_000, reservesSats: 800_000, paidInWindowSats: 200_000 }).ok, true);
  const w = capStands({ proposalSats: 80_000, paymentSats: 50_001, reservesSats: 800_000, paidInWindowSats: 200_000 });
  assert.deepEqual([w.ok, w.final], [false, false]); assert.match(w.why, /more than 25 % of 1000000 sat/);
  // a proposal's earlier tranches count toward its own 10 %, not as reserves lost
  assert.equal(capStands({ proposalSats: 100_000, paymentSats: 25_000, reservesSats: 925_000, paidByProposalSats: 75_000 }).ok, true);
});

test('D5 tranches: up to 1 % of the reserves pays once after 2 weeks; more pays in 4 monthly tranches', () => {
  const one = trancheSchedule({ amountSats: 10_000n, reservesSats: 1_000_000n, last: LAST, schedule: S });
  assert.deepEqual(one.map((t) => [t.k, t.amountSats, t.dueAt]), [[0, 10_000n, LAST + 2016]]);
  const four = trancheSchedule({ amountSats: 100_003n, reservesSats: 1_000_000n, last: LAST, schedule: S });
  assert.deepEqual(four.map((t) => [t.amountSats, t.dueAt - LAST]), [[25_000n, 2016], [25_000n, 6336], [25_000n, 10656], [25_003n, 14976]]);
});

test('D6 signal sybil: a node counts as active only with rounds served in 3 of the 4 weeks', () => {
  const weeks = [new Set(['aa', 'bb', 'cc']), new Set(['aa', 'bb']), new Set(['aa', 'cc']), new Set(['dd', 'cc'])];
  assert.deepEqual(activeInWeeks(weeks).sort(), ['aa', 'cc'], 'aa in 3 weeks, cc in 3, bb in 2 and dd in 1 do not count');
});
