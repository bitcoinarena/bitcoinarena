// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH BLOCK SEEDS A COMMITTEE, AND WHY IT CANNOT BE THE TIP.
//
// 5A.5 (spec v4.6.2) names the beacon by TIME - the first Bitcoin block whose
// median-time-past is after committee_time - so every node lands on one value
// without anybody naming it. But `bitcoin-block-hash` is a SOURCE, not a
// selection: two honest nodes polling at different moments take different tips
// and signer node different committees. This is the selection.
//
// The timestamps here are chosen, not mined, which is the point: a fixture
// with a known clock is the only way to assert WHICH block the rule picks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { beaconFromChain, beaconIsTheChains, beaconIsAfterRound, medianTimePast,
  MEDIAN_TIME_SPAN, committeeSeedFromBeacon, committeeSeedFrom } from '../src/beacon.js';
import { blockOf } from '../tools/bond.js';
import { hash256, blockHashOf, blockTimeOf } from '../src/chain.js';
import { toHex, fromHex } from '../src/hash.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const BASE = 1_700_000_000;          // a round number of seconds, for arithmetic
const FIRST = 100;

/** A chain of `n` blocks from height FIRST, ten minutes apart unless told otherwise. */
function chainOf(n, { times } = {}) {
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < n; i++) {
    const time = times ? times[i] : BASE + i * 600;
    const { header } = blockOf(hash256, [b32(i + 1)], { previous, time });
    headers.push(header);
    previous = blockHashOf(header);
  }
  return { headers, firstHeight: FIRST };
}

const contract = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST,
  committeeTimeMs: BigInt(BASE + 6 * 600) * 1000n,
  censusConfirmations: 3,
  censusRoot: b32(2),
  randomnessRule: 'bitcoin-block-hash',
  ...over,
});

test('the median time past is eleven blocks including the one it is for', () => {
  const view = chainOf(15);
  const headers = view.headers;

  // ten blocks of history is not enough for a median over eleven
  assert.equal(medianTimePast(headers, FIRST, FIRST + 9), null);
  assert.equal(MEDIAN_TIME_SPAN, 11);

  // and with eleven, the median of an ascending run is its middle
  assert.equal(medianTimePast(headers, FIRST, FIRST + 10), BASE + 5 * 600);
  assert.equal(medianTimePast(headers, FIRST, FIRST + 11), BASE + 6 * 600);
  assert.equal(blockTimeOf(headers[10]), BASE + 10 * 600,
    'the header still carries its own time; the median is a different number');
});

test('the block chosen is the FIRST whose median time is after committee_time', () => {
  const view = chainOf(15);                     // heights 100..114
  const seen = beaconFromChain(contract(), view);
  assert.equal(seen.ok, true, seen.why);

  // committee_time is exactly the median at 111, and AT is not after - the
  // creator could have held it when the round was made - so 112 is the first.
  assert.equal(seen.height, 112);
  assert.equal(seen.timeMs, BigInt(BASE + 7 * 600) * 1000n);
  assert.ok(seen.timeMs > contract().committeeTimeMs);
  assert.deepEqual(seen.hash, blockHashOf(view.headers[112 - FIRST]));
  assert.equal(seen.depth, 3, 'the tip is 114, so the chosen block is three deep');

  // NOT THE TIP, and not any later qualifying block. 113 and 114 both have a
  // median after committee_time too; picking either would make the answer
  // depend on when a node happened to look.
  assert.notEqual(seen.height, 114);
  assert.notEqual(toHex(seen.hash), toHex(blockHashOf(view.headers[14])));
});

test('two nodes with the same chain view get the same height, hash and seed', () => {
  const view = chainOf(15);
  const one = beaconFromChain(contract(), view);
  const two = beaconFromChain(contract(), { headers: view.headers.slice(), firstHeight: FIRST });

  assert.equal(one.height, two.height);
  assert.equal(toHex(one.hash), toHex(two.hash));
  assert.equal(one.timeMs, two.timeMs);

  const seedOne = committeeSeedFromBeacon(contract(), {
    roundId: b32(9), randomness: one.hash, height: one.height, timeMs: one.timeMs });
  const seedTwo = committeeSeedFromBeacon(contract(), {
    roundId: b32(9), randomness: two.hash, height: two.height, timeMs: two.timeMs });
  assert.equal(seedOne.ok, true, seedOne.why);
  assert.equal(toHex(seedOne.seed), toHex(seedTwo.seed),
    'one chain view gave two committees');
});

test('a block too shallow to have settled is refused, not assigned on', () => {
  const view = chainOf(15);
  // 112 is three deep against a tip of 114. Ask for four.
  const seen = beaconFromChain(contract({ censusConfirmations: 4 }), view);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /is 3 deep and this round asks for 4/);
  assert.match(seen.why, /reorg that changes the seed changes who sits/);

  // and one more block makes the same choice settled
  const deeper = chainOf(16);
  const ok = beaconFromChain(contract({ censusConfirmations: 4 }), deeper);
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.height, 112, 'a deeper chain moved the choice');
});

test('a chain that never reaches committee_time is refused by name', () => {
  const view = chainOf(15);
  const late = contract({ committeeTimeMs: BigInt(BASE + 100 * 600) * 1000n });
  const seen = beaconFromChain(late, view);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /no block in this view is after this round's committee time/);
  assert.match(seen.why, /median time past is/);
});

test('a view too short for a median says so instead of guessing', () => {
  const seen = beaconFromChain(contract(), chainOf(9));
  assert.equal(seen.ok, false);
  assert.match(seen.why, /9 blocks and a median time past is taken over 11/);
});

/**
 * A LYING TIMESTAMP MOVES THE CHOICE BY ONE BLOCK, NOT BY SIX - measured,
 * because the first version of this test asserted it moved the choice by NONE
 * and that was wrong.
 *
 * Bitcoin lets a header claim up to two hours ahead, and header times need not
 * increase. Against raw nTime one such header IS the qualifying block, six
 * blocks early. Against the median it is one of eleven values, so it can push
 * the median up by one position and no further: the choice moves from 112 to
 * 111.
 *
 * SO THE MEDIAN BOUNDS A MINER'S INFLUENCE RATHER THAN REMOVING IT, and that
 * is worth stating plainly. A miner who wants a different seed must move the
 * median, which takes six of the eleven, and even then they choose a HEIGHT
 * and not a hash - the hash is still whatever they mined. The depth rule is
 * the other half: by the time the seed is deep enough to be used, moving it
 * means re-mining that many blocks.
 */
test('a timestamp two hours ahead moves the choice by one block, not by six', () => {
  const times = Array.from({ length: 15 }, (_, i) => BASE + i * 600);
  times[6] = BASE + 6 * 600 + 7200;
  const view = chainOf(15, { times });
  assert.equal(blockTimeOf(view.headers[6]), BASE + 6 * 600 + 7200);

  const honest = beaconFromChain(contract(), chainOf(15));
  const lied = beaconFromChain(contract({ censusConfirmations: 2 }), view);
  assert.equal(honest.height, 112);
  assert.equal(lied.ok, true, lied.why);
  assert.equal(lied.height, 111, 'the median did not bound the lie to one block');

  // and against the header's own time it would have been six blocks earlier,
  // which is the number the median is there to stop
  const byHeaderTime = view.headers.findIndex(
    (h) => BigInt(blockTimeOf(h)) * 1000n > contract().committeeTimeMs);
  assert.equal(FIRST + byHeaderTime, 106);
});

test('a height on the contract changes nothing, because it is never read', () => {
  const view = chainOf(15);
  const honest = beaconFromChain(contract(), view);
  // Every shape an author might use to name the block they want.
  for (const named of [{ beaconHeight: 114 }, { height: 114 }, { randomnessHeight: 100 },
                       { beacon: { height: 114, hash: b32(0xbe) } }]) {
    const seen = beaconFromChain(contract(named), view);
    assert.equal(seen.height, honest.height,
      'a field on the contract moved the block the committee is drawn on');
    assert.equal(toHex(seen.hash), toHex(honest.hash));
  }
});

test('a round with no committee time or no depth is refused rather than defaulted', () => {
  const view = chainOf(15);
  assert.match(beaconFromChain(contract({ committeeTimeMs: undefined }), view).why,
    /names no committee time/);
  assert.match(beaconFromChain(contract({ censusConfirmations: undefined }), view).why,
    /names no confirmation depth/);
  assert.match(beaconFromChain(contract(), { headers: [], firstHeight: 0 }).why,
    /at least one header/);
});

/**
 * LATE IS NOT THE SAME AS RIGHT.
 *
 * `beaconIsAfterRound` asks only whether a beacon came after committee_time,
 * and that is all it CAN ask - it is handed a height and a time and no chain.
 * A node that has a chain can ask the other half: is this the block the chain
 * names? Without it, an operator hands their node any late block and picks the
 * seed, which is 5A.5's attack with one extra step.
 */
test('a late block that is not the first one is refused, not accepted for being late', () => {
  const view = chainOf(15);
  const named = beaconFromChain(contract(), view);
  assert.equal(named.height, 112);

  // the honest one passes both directions
  const ok = beaconIsTheChains(contract(), named, view);
  assert.equal(ok.ok, true, ok.why);

  // 113 is later than committee_time too, and 27's own check would let it by
  const later = {
    height: 113,
    hash: blockHashOf(view.headers[113 - FIRST]),
    timeMs: BigInt(medianTimePast(view.headers, FIRST, 113)) * 1000n,
  };
  assert.equal(beaconIsAfterRound(contract({ censusConfirmations: 1 }), later).ok, true,
    'the older check was supposed to accept a late block');
  const seen = beaconIsTheChains(contract(), later, view);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /is block 113 where this chain names 112/);
  assert.match(seen.why, /a later block is a block somebody chose/);

  // and the right height with the wrong hash or the wrong time is refused too
  assert.match(beaconIsTheChains(contract(), { ...named, hash: b32(0xbe) }, view).why,
    /carries a hash block 112 does not have/);
  assert.match(beaconIsTheChains(contract(), { ...named, timeMs: named.timeMs + 1n }, view).why,
    /median time past is/);
  assert.match(beaconIsTheChains(contract(), null, view).why, /no beacon was offered/);
});

/**
 * A VIEW THAT STARTS TOO LATE CANNOT SAY WHICH BLOCK IS FIRST.
 *
 * Found on a real regtest and not by reading the code: the answer was
 * window-dependent. A node reading 64 headers to the tip named block 69; a node
 * whose view began at 103 named block 112 - same chain, same round. Two honest
 * nodes would have assigned different committees, which is exactly what this rule
 * exists to prevent.
 */
test('a view that begins after committee_time says so instead of answering', () => {
  const whole = chainOf(30);        // long enough that the late window is still
                                    // longer than the median span, so what is
                                    // measured is where it STARTS
  const named = beaconFromChain(contract(), whole);
  assert.equal(named.ok, true, named.why);
  assert.equal(named.height, 112);

  // THE SAME CHAIN, SEEN FROM LATER. Every block in this window is after
  // committee_time, so its "first" is only the first it holds.
  const late = { headers: whole.headers.slice(13), firstHeight: FIRST + 13 };
  const seen = beaconFromChain(contract(), late);
  assert.equal(seen.ok, false, 'a window starting after committee_time answered anyway');
  assert.match(seen.why, /begins at height 113/);
  assert.match(seen.why, /it cannot say which block is the FIRST one/);

  // A window that reaches back before the instant answers, and answers the
  // same as the whole chain - which is the property.
  const enough = { headers: whole.headers.slice(1), firstHeight: FIRST + 1 };
  const also = beaconFromChain(contract(), enough);
  assert.equal(also.ok, true, also.why);
  assert.equal(also.height, named.height);
  assert.deepEqual(also.hash, named.hash);
});

// ROUND_RANDOMNESS IS THE BLOCK HASH ITSELF, IN INTERNAL ORDER (§5A.5 and §12, RULED 2026-09-24, ruling B). A PIN,
// NOT A RED-FIRST TEST: the code never mixed in a height, the spec now says so, and nothing measured here changed. It
// fixes the bytes: a height term, or the reversed hex a block explorer prints, would move every committee and world.
test('round_randomness is the beacon block\'s hash in internal order, and the committee seed is built on it alone', () => {
  const genesis = fromHex('01000000' + '00'.repeat(32)
    + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + '29ab5f49' + 'ffff001d' + '1dac2b7c');
  assert.equal(genesis.length, 80);
  const hash = blockHashOf(genesis);
  assert.equal(toHex(hash), '6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000');
  const seedOf = (roundRandomness) => toHex(committeeSeedFrom({
    censusRootGameVerify: b32(2), censusRootSettlement: b32(2), roundId: b32(0x11), roundRandomness }));
  assert.equal(seedOf(hash), 'a49389d4602ca1cd78dd92f855f9d358b8158887bbc6dd8ee4cd489a17872634');
  const explorer = Uint8Array.from(hash).reverse();
  assert.equal(toHex(explorer), '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  assert.equal(seedOf(explorer), 'c229da37ce0df2335d77fa10b505127f01c2a02bf3aa650872de89813ae3ae22');
  assert.notEqual(seedOf(explorer), seedOf(hash));
});
