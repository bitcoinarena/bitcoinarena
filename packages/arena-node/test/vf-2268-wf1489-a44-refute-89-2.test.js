// kanban #1840 re-check (#1489 fix-refute, audit44 item 89): the SAME PROPOSER, the TIMING EDGE. In production the tally hands
// proposals.js the tip (ballot-tally useTip), and a proposal first seen once its voting began is refused (kanban #1608) - in the peer
// pull too. The proposer posts A to seat 1 and B to seat 2 in the last review block (tip = votingFrom - 1); the next pull (every
// 10 min, about one block) runs after the voting began: each seat refuses the other's 422, holds ONE proposal for the deposit, and
// counts it - seat 1 A, seat 2 B. #1840's "a deposit backing two kept proposals backs none" never sees the second one.
// kanban #2536 (re-check on 1.9 acbc1948c): the test read every deposit unbound (_common89.mjs gives no bindHeightFor). 1.9 reads a
// deposit at or above BALLOT_BIND_HEIGHT bound (#2562, regtest and mainnet from 0, testnet4 from 161 400): the deposit commits to one
// proposer and one body, and a bound proposal is taken at any time (no #1608 tip gate). Adapted to sup-common89-bound.mjs, the same
// deposit with its commitment to A's body (activation 208); the same sequence - A to seat 1, B (activation 209) to seat 2 in the last
// review block, the pull one block later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seat, proposal, BLOCK, ids, countedIds, P_CONFIG } from './sup-common89-bound.mjs';

test('#1840 refute 2: A and B over one deposit posted to two seats in the last review block are each counted at one seat', async () => {
  const A = proposal(208, P_CONFIG);
  const B = proposal(209, P_CONFIG);
  const t1 = { h: 200 }, t2 = { h: 200 };               // published at 200, regtest review 1: voting from 201
  const s1 = seat(t1), s2 = seat(t2);
  const [a1, b2] = await Promise.all([s1.add({ proposal: A, blockHash: BLOCK }), s2.add({ proposal: B, blockHash: BLOCK })]);
  console.log('  posted:', JSON.stringify({ seat1A: [a1.status, a1.why], seat2B: [b2.status, b2.why] }));
  assert.equal(a1.status, 201, a1.why);
  t1.h = 201; t2.h = 201;                               // one block later: the pull
  const r1 = await s1.add({ proposal: B, blockHash: BLOCK }), r2 = await s2.add({ proposal: A, blockHash: BLOCK });
  await s1.pull(s2.list()); await s2.pull(s1.list());
  console.log('  after the pull:', JSON.stringify({ seat1: ids(s1), seat2: ids(s2), counted1: countedIds(s1), counted2: countedIds(s2),
    seat1OnB: [r1.status, r1.why], seat2OnA: [r2.status, r2.why] }));
  assert.deepEqual(countedIds(s1), countedIds(s2), 'two seats count the same proposals for one deposit');
  assert.equal(countedIds(s1).length, 1, 'the deposit backs one counted proposal');
});
