// THE TWO GATEWAY SEATS (spec §23A.9, kanban #471): who may stand, how the best two are ranked, one seat per operator, an incumbent kept
// unless ineligible or out-routed by 25 %, an empty seat said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatGateways, ineligibleWhy, GATEWAY_MINIMUMS } from '../src/gateway-seats.js';
import { toHex } from '../src/hash.js';

const k = (n) => new Uint8Array(32).fill(n);
const beacon = new Uint8Array(32).fill(0xbe);
const ok = (n, over = {}) => ({ node: k(n), operatorId: `op${n}`, seatedGuardian: true, registered: true, volumeSats: 0n, inboundSats: 150_000n, outboundSats: 150_000n,
  pegInSats: 60_000n, availabilityPct: 99, bondSats: 50_000n, ...over });
const seat = (candidates, incumbents = []) => seatGateways({ candidates, beacon, incumbents, network: 'testnet4', bondMinGuardian: 50_000n });

test('who may stand: each requirement named when it is missing', () => {
  const m = GATEWAY_MINIMUMS.testnet4;
  const why = (over) => ineligibleWhy(ok(1, over), { minimums: m, bondMinGuardian: 50_000n });
  assert.equal(why({}), null);
  assert.match(why({ seatedGuardian: false }), /not a seated guardian/);
  assert.match(why({ registered: false }), /not registered/);
  assert.match(why({ inboundSats: 99_999n }), /inbound liquidity 99999 below 100000 sat \(deposits/, 'outbound only takes no deposit');
  assert.match(why({ outboundSats: 0n }), /outbound liquidity 0 below 100000 sat \(payouts/);
  assert.match(why({ pegInSats: 49_999n }), /peg-in 49999 below 50000/);
  assert.match(why({ availabilityPct: 94.9 }), /available 94 %/);
  assert.match(why({ bondSats: 1n }), /bond below/);
});

test('the best two: routed volume first, then capacity, availability, bond, the ticket; one seat per operator', () => {
  const r = seat([ok(1, { volumeSats: 5_000n }), ok(2, { volumeSats: 9_000n }), ok(3, { volumeSats: 9_400n }), ok(4, { volumeSats: 50_000n, operatorId: 'op3' }), ok(5, { inboundSats: 100n })]);
  assert.deepEqual(r.seated, [toHex(k(4)), toHex(k(2))], 'op3\'s best node stands for it (one seat per operator); 9,400 and 9,000 floor apart');
  assert.deepEqual(r.ineligible.map((x) => x.node), [toHex(k(5))]);
  const tie = seat([ok(6, { volumeSats: 1_200n }), ok(7, { volumeSats: 1_900n })]);
  assert.equal(tie.ranked[0].volume, 1000n, 'floored to 1,000 sat: equal volume');
  const cap = seat([ok(6, { inboundSats: 250_000n, outboundSats: 900_000n }), ok(7, { inboundSats: 400_000n, outboundSats: 420_000n }), ok(8, { inboundSats: 450_000n, outboundSats: 460_000n, availabilityPct: 97 })]);
  assert.equal(cap.seated.length, 2);
  assert.equal(cap.ranked[0].capacity, 400_000n, 'two-way capacity is the smaller side, floored to 100,000: 400k and 450k equal, then availability decides');
  assert.equal(cap.ranked[2].node, toHex(k(6)), 'outbound alone does not rank: 900k out but 250k in counts as 200k');
  assert.equal(cap.seated[0], toHex(k(7)), 'equal capacity: the one up 99 % before the one up 97 %');
});

test('an incumbent keeps its seat unless out-routed by 25 %, or ineligible; an empty seat is said', () => {
  const inc = toHex(k(1));
  const kept = seat([ok(1, { volumeSats: 10_000n }), ok(2, { volumeSats: 30_000n }), ok(3, { volumeSats: 12_000n })], [inc]);
  assert.ok(kept.seated.includes(inc), 'the newcomer routed 12,000: not 25 % over 10,000');
  const lost = seat([ok(1, { volumeSats: 10_000n }), ok(2, { volumeSats: 30_000n }), ok(3, { volumeSats: 13_000n })], [inc]);
  assert.ok(!lost.seated.includes(inc) && lost.seated.includes(toHex(k(3))), '13,000 is more than 25 % over 10,000: the incumbent yields (volumes compare floored: 12,500 counts as 12,000)');
  const gone = seat([ok(1, { volumeSats: 90_000n, availabilityPct: 80 }), ok(2)], [inc]);
  assert.deepEqual([gone.seated, gone.empty], [[toHex(k(2))], 1], 'an ineligible incumbent goes; one seat empty, said');
  assert.match(gone.why, /1 of 2 gateway seats filled/);
});
