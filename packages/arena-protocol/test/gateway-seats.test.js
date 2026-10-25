// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TWO GATEWAY SEATS (spec §23A.9): who may stand, how the best two are ranked, one seat per operator, the seats rotating
// every epoch, an empty seat said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatGateways, ineligibleWhy, GATEWAY_MINIMUMS } from '../src/gateway-seats.js';
import { toHex } from '../src/hash.js';

const k = (n) => new Uint8Array(32).fill(n);
const beacon = new Uint8Array(32).fill(0xbe);
const ok = (n, over = {}) => ({ node: k(n), operatorId: `op${n}`, seatedGuardian: true, registered: true, volumeSats: 0n, inboundSats: 300_000n, outsideInboundSats: 150_000n, outboundSats: 150_000n,
  pegInSats: 60_000n, availabilityPct: 99, bondSats: 50_000n, ...over });
const seat = (candidates, incumbents = []) => seatGateways({ candidates, beacon, incumbents, network: 'testnet4', bondMinGuardian: 50_000n });

test('who may stand: each requirement named when it is missing', () => {
  const m = GATEWAY_MINIMUMS.testnet4;
  const why = (over) => ineligibleWhy(ok(1, over), { minimums: m, bondMinGuardian: 50_000n });
  assert.equal(why({}), null);
  assert.match(why({ seatedGuardian: false }), /not a seated guardian/);
  assert.match(why({ registered: false }), /not registered/);
  assert.match(why({ outsideInboundSats: 99_999n }), /inbound liquidity from outside the federation 99999 below 100000 sat \(deposits/, 'outbound only takes no deposit');
  assert.match(why({ inboundSats: 900_000n, outsideInboundSats: 0n }), /from outside the federation 0 below/, 'inbound from the ring alone takes no deposit from the wider network');
  assert.match(why({ outboundSats: 0n }), /outbound liquidity 0 below 100000 sat \(payouts/);
  assert.match(why({ pegInSats: 49_999n }), /peg-in 49999 below 50000/);
  assert.match(why({ availabilityPct: 94.9 }), /available 94 %/);
  assert.match(why({ bondSats: 1n }), /bond below/);
});

test('the best two: routed volume first, then capacity, availability, bond, the ticket; one seat per operator', () => {
  const r = seat([ok(1, { volumeSats: 5_000n }), ok(2, { volumeSats: 9_000n }), ok(3, { volumeSats: 9_400n }), ok(4, { volumeSats: 50_000n, operatorId: 'op3' }), ok(5, { outsideInboundSats: 100n })]);
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

test('the seats rotate every epoch (2026-10-20: "rotate ... daily every 144 blocks among those that want to be gateways"); an empty seat is said', () => {
  const c = [ok(1, { volumeSats: 50_000n }), ok(2, { volumeSats: 30_000n }), ok(3, { volumeSats: 10_000n }), ok(4, { volumeSats: 5_000n })];
  const e1 = seat(c);
  assert.deepEqual(e1.seated, [toHex(k(1)), toHex(k(2))], 'no epoch before: the best two');
  const e2 = seat(c, e1.seated);
  assert.deepEqual(e2.seated, [toHex(k(3)), toHex(k(4))], 'last epoch\'s two step back, however much they routed');
  assert.deepEqual(e2.waiting.map((x) => x.why), ['held a seat last epoch: steps back while others take their turn', 'held a seat last epoch: steps back while others take their turn']);
  assert.deepEqual(seat(c, e2.seated).seated, e1.seated, 'and back');
  const three = [ok(1, { volumeSats: 50_000n }), ok(2, { volumeSats: 30_000n }), ok(3)];
  assert.deepEqual(seat(three, [toHex(k(1)), toHex(k(2))]).seated, [toHex(k(1)), toHex(k(3))], 'three for two seats: the one who waited, and the better of last epoch\'s holders (50,000 routed against 30,000)');
  assert.deepEqual(seat([ok(1), ok(2)], [toHex(k(1)), toHex(k(2))]).seated.length, 2, 'nobody else eligible: the holders keep their seats');
  const one = seatGateways({ candidates: [ok(5, { operatorId: 'op1', volumeSats: 90_000n }), ok(1), ok(2)], beacon, incumbents: [toHex(k(1))], network: 'testnet4', bondMinGuardian: 50_000n, seats: 1 });
  assert.deepEqual(one.seated, [toHex(k(2))], 'an operator steps back with all its nodes, not just the one that held the seat');
  const gone = seat([ok(1, { volumeSats: 90_000n, availabilityPct: 80 }), ok(2)], [toHex(k(1))]);
  assert.deepEqual([gone.seated, gone.empty], [[toHex(k(2))], 1], 'an ineligible holder goes; one seat empty, said');
  assert.match(gone.why, /1 of 2 gateway seats filled/);
});
test('at least one gateway (2026-10-20): no operator eligible, the best that can still serve holds one seat', () => {
  // the measured case: Federation 2 (draining, 1 seat), its gateway up 92 % on one guardian's probes, the other one holding no e-cash there
  const one = seatGateways({ candidates: [ok(1, { availabilityPct: 92, pegInSats: 95_393n }), ok(2, { pegInSats: 0n })], beacon, network: 'testnet4', bondMinGuardian: 50_000n, seats: 1 });
  assert.deepEqual(one.seated, [toHex(k(1))]);
  assert.deepEqual(one.belowMinimums, [toHex(k(1))]);
  assert.equal(one.empty, 0);
  assert.match(one.why, /1 of 1 gateway seats filled from 0 eligible operators, 2 not eligible; 0101010101 holds the seat below the minimums/);
  const best = seat([ok(3, { availabilityPct: 80 }), ok(4, { availabilityPct: 90 })]);
  assert.deepEqual(best.seated, [toHex(k(4))], 'ranked as the eligible are: the one up 90 % before the one up 80 %');
  assert.equal(best.empty, 1, 'one seat only: the second stays empty until an operator clears the minimums');
  for (const cannot of [{ seatedGuardian: false }, { registered: false }, { pegInSats: 0n }])
    assert.deepEqual(seat([ok(5, { availabilityPct: 50, ...cannot })]).seated, [], `a candidate that cannot serve is never seated (${Object.keys(cannot)[0]})`);
  const eligibleThere = seat([ok(6), ok(7, { availabilityPct: 50 })]);
  assert.deepEqual([eligibleThere.seated, eligibleThere.belowMinimums], [[toHex(k(6))], []], 'with an eligible operator nothing below the minimums is seated');
});

test('who waits and why (kanban #552): behind the same operator\'s better node, or ranked below the seats', () => {
  const r = seat([ok(1, { volumeSats: 9_000n }), ok(2, { operatorId: 'op1' }), ok(3, { volumeSats: 5_000n }), ok(4)]);
  assert.deepEqual(r.seated, [toHex(k(1)), toHex(k(3))]);
  assert.deepEqual(r.waiting.map((x) => [x.node, x.why]), [
    [toHex(k(2)), 'the same operator as 0101010101, whose node stands for it (one seat per operator)'],
    [toHex(k(4)), 'eligible, ranked below the seated gateways'],
  ]);
  assert.deepEqual(seat([ok(5)]).waiting, [], 'nobody waits when every eligible operator is seated');
});

// kanban #559/#543 (spec §23A.3a part 2): under peg-in pressure the proved peg-in up to P* ranks before routed volume
test('peg-in pressure: the proved peg-in (up to P*) ranks before volume; without pressure volume ranks first as before', async () => {
  const { pegInPressure } = await import('../src/capacity.js');
  const busy = ok(1, { volumeSats: 900_000n, provedPegInSats: 10_000n }), deep = ok(2, { volumeSats: 1_000n, provedPegInSats: 60_000n }), mid = ok(3, { volumeSats: 5_000n, provedPegInSats: 0n });
  const at = (star) => seatGateways({ candidates: [busy, deep, mid], beacon, network: 'testnet4', bondMinGuardian: 50_000n, seats: 1, pegInStarSats: star }).seated;
  assert.deepEqual(at(null), [toHex(k(1))], 'no pressure: the most routed volume');
  assert.deepEqual(at(50_000n), [toHex(k(2))], 'under pressure: the gateway that can take the deposits');
  assert.deepEqual(at(5_000n), [toHex(k(1))], 'both above a small P*: capped alike, volume decides again');
  // the pressure itself: PRESSURE band (load 0.8) and the seated short of 2 x P*; full at P*: none; CALM: none
  const base = { reserveSats: 800_000n, exposureCapSats: 1_000_000n, pegInMinSats: 50_000n, seats: 2 };
  assert.deepEqual(pegInPressure({ ...base, pegIns: [{ node: 'a', pegInSats: 10_000n }, { node: 'b', pegInSats: 60_000n }] }), { targetPegInSats: 50_000n });
  assert.equal(pegInPressure({ ...base, pegIns: [{ node: 'a', pegInSats: 50_000n }, { node: 'b', pegInSats: 60_000n }] }), null);
  assert.equal(pegInPressure({ ...base, reserveSats: 300_000n, pegIns: [{ node: 'a', pegInSats: 0n }] }), null);
});
