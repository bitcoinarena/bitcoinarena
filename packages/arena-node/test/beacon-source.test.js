// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEED A NODE SIGNER NODES WITH IS THE CHAIN'S, OR THERE IS NONE.
//
// The 2-of-2 tool used to answer every beacon question with 32 bytes of 0xbe
// at height 900005. A committee drawn on a constant is a committee its
// operator chose, which is 5A.5's attack without even the grinding. This is
// what replaced it, measured on the number that actually moves: the seed
// `roster.seedFor` hands the lottery.
//
// A WARNING THIS FILE EXISTS TO CARRY. The two-tab test's ghost pose is NOT
// sensitive to the beacon - measured: a truck driven on throttle alone reaches
// x -6366013 under 0xbe and under any other beacon, because the seed drives
// the world and not that trajectory. So a green two-tab test says the ghost is
// the other player's transcript; it says nothing about which beacon was used.
// This does.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chainBeacon, BEACON_WINDOW } from '../src/beacon-source.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { hash256, blockHashOf } from '../../arena-protocol/src/chain.js';
import { committeeSeedFromBeacon, beaconFromChain, medianTimePast } from '../../arena-protocol/src/beacon.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = Math.floor(Date.now() / 1000);

/** A mined chain and the three RPC calls the reader makes of it. */
function chainNode({ blocks = 40, spacing = 600, breaks = false } = {}) {
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < blocks; i++) {
    const { header } = blockOf(hash256, [b32(i + 1)], { previous, time: NOW + (i - 20) * spacing });
    headers.push(header);
    previous = blockHashOf(header);
  }
  const call = async (method, params = []) => {
    if (breaks) throw new Error('connect ECONNREFUSED 127.0.0.1:29643');
    if (method === 'getblockcount') return headers.length - 1;
    if (method === 'getblockhash') return toHex(blockHashOf(headers[params[0]]));
    if (method === 'getblockheader')
      return toHex(headers[headers.findIndex((h) => toHex(blockHashOf(h)) === params[0])]);
    throw new Error('this node was asked ' + method);
  };
  return { headers, call };
}

const contract = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST,
  committeeTimeMs: BigInt(NOW) * 1000n,
  censusConfirmations: 1,
  censusRoot: b32(2),
  randomnessRule: 'bitcoin-block-hash',
  ...over,
});

test('nothing is held until the chain is read, and nothing is invented if it cannot be', async () => {
  const node = chainNode();
  const beacon = chainBeacon({ call: node.call });

  assert.equal(beacon.for({ contract: contract() }), undefined, 'a beacon appeared before any read');
  assert.equal(beacon.size, 0);
  assert.equal(beacon.for({}), undefined);

  const dead = chainBeacon({ call: chainNode({ breaks: true }).call });
  await assert.rejects(dead.refresh(contract()), /ECONNREFUSED/);
  assert.equal(dead.for({ contract: contract() }), undefined,
    'a failed read left something behind to assign on');
  assert.throws(() => chainBeacon({}), /needs a way to ask a node/);
  assert.equal(BEACON_WINDOW, 64);
});

test('what it holds is the block the chain names, and the seed is that hash', async () => {
  const node = chainNode();
  const beacon = chainBeacon({ call: node.call });
  const seen = await beacon.refresh(contract());
  assert.equal(seen.ok, true, seen.why);

  // the same answer the rule gives when handed the same headers
  const named = beaconFromChain(contract(), { headers: node.headers, firstHeight: 0 });
  assert.equal(seen.height, named.height);
  assert.deepEqual(seen.hash, named.hash);
  assert.deepEqual(beacon.for({ contract: contract() }).hash, blockHashOf(node.headers[seen.height]));
  assert.equal(beacon.for({ contract: contract() }).timeMs,
    BigInt(medianTimePast(node.headers, 0, seen.height)) * 1000n);

  // AND THE SEED MOVED. This is the number the slice is about: the constant
  // and the chain do not name the same committee.
  const chainSeed = committeeSeedFromBeacon(contract(), {
    roundId: b32(9), randomness: seen.hash, height: seen.height, timeMs: seen.timeMs });
  const inventedSeed = committeeSeedFromBeacon(contract(), {
    roundId: b32(9), randomness: b32(0xbe), height: 900005, timeMs: 900n });
  assert.equal(chainSeed.ok, true, chainSeed.why);
  console.log(`  seed from the chain    ${toHex(chainSeed.seed)}`);
  console.log(`  seed from 32 x 0xbe    ${inventedSeed.ok ? toHex(inventedSeed.seed) : inventedSeed.why}`);
  assert.notEqual(inventedSeed.ok && toHex(inventedSeed.seed), toHex(chainSeed.seed));

  // and reading twice names one block and one seed
  const again = await beacon.refresh(contract());
  assert.equal(again.height, seen.height);
  assert.deepEqual(again.hash, seen.hash);
});

test('a node holding no beacon says who it cannot signer node, rather than joining', async () => {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const c = contract();

  // NO BEACON. This is what a 2-of-2 with no bitcoind now looks like.
  const blind = new Roster(round, {});
  const none = blind.seedFor(b32(7), c);
  assert.equal(none.ok, false);
  assert.match(none.why, /has no beacon for that round/);

  // WITH THE CHAIN. The same roster, handed the reader's answer.
  const node = chainNode();
  const beacon = chainBeacon({ call: node.call });
  await beacon.refresh(c);
  const seeing = new Roster(round, { randomnessFor: beacon.for });
  const seeded = seeing.seedFor(b32(7), c);
  assert.equal(seeded.ok, true, seeded.why);

  const named = beaconFromChain(c, { headers: node.headers, firstHeight: 0 });
  const wanted = committeeSeedFromBeacon(c, {
    roundId: b32(7), randomness: named.hash, height: named.height, timeMs: named.timeMs });
  assert.equal(toHex(seeded.seed), toHex(wanted.seed),
    'the roster assigned on something other than the block the chain names');
});

// ONE HEADER WINDOW FOR EVERY ROUND (ORDER-2116, measured on the free pair 2026-10-01): ten rounds posted ahead each read
// the whole window on every ask - 800 calls a round - and their beacons came minutes after their entry closed. Read once,
// then extended by the blocks past its tip; a reorganised tip reads it whole again.
test('the header window is read once and extended by new blocks; two rounds share it; a new tip that does not link reads it whole', async () => {
  const node = chainNode({ blocks: 30, spacing: 60 });
  let calls = 0;
  const call = (m, p) => { calls++; return node.call(m, p); };
  const beacon = chainBeacon({ call, window: 20 });
  const mine = (n, from = node.headers[node.headers.length - 1]) => {
    let previous = blockHashOf(from);
    for (let i = 0; i < n; i++) {
      const t = NOW + (node.headers.length - 20) * 60;
      const { header } = blockOf(hash256, [b32(100 + node.headers.length)], { previous, time: t });
      node.headers.push(header);
      previous = blockHashOf(header);
    }
  };
  // a round whose beacon is not on the chain yet: its committee time past every block
  const ahead = (sec) => contract({ committeeTimeMs: BigInt(NOW + sec) * 1000n });
  const first = await beacon.refresh(ahead(3000));
  const fullRead = calls;
  calls = 0;
  mine(2);
  const second = await beacon.refresh(ahead(3600));
  const extended = calls;
  calls = 0;
  const third = await beacon.refresh(ahead(3600));
  const unchanged = calls;
  // a fork: the last block replaced by another, then one more on top of it
  node.headers.pop();
  const { header: other } = blockOf(hash256, [b32(250)], { previous: blockHashOf(node.headers[node.headers.length - 1]), time: NOW + 999 * 60 });
  node.headers.push(other);
  mine(1);
  calls = 0;
  await beacon.refresh(ahead(4200));
  const reorged = calls;
  console.log('  FACTS (shared window):', JSON.stringify({ fullRead, extended, unchanged, reorged, first: first.ok, second: second.ok, third: third.ok }));
  assert.equal(fullRead, 2 + 2 * 20, 'the first read is not one window (its tip asked, then the window)');
  assert.equal(extended, 1 + 2 * 2, 'two new blocks were not read as two headers');
  assert.equal(unchanged, 1, 'an unchanged tip read headers again');
  assert.equal(reorged, 1 + 2 + 1 + 2 * 20, 'a tip that does not link to the held one did not read the window whole (the new header read, then the window)');
  // and the answer is the rule's on the extended window, the same as a fresh reader's on the same chain
  mine(10);
  const asked = contract({ committeeTimeMs: BigInt(NOW + 3000) * 1000n });
  const fresh = await chainBeacon({ call: node.call, window: 20 }).refresh(asked);
  const kept = await beacon.refresh(asked);
  assert.deepEqual({ ok: kept.ok, height: kept.height }, { ok: fresh.ok, height: fresh.height });
});

// A BEACON BEHIND THE WINDOW: measured on testnet4 2026-10-07, a seat started after its round's beacon had
// sunk 736 blocks below the tip read a 400-header window that began after committee_time, and refused for good. From the
// round's census height, which comes before committee_time, the beacon is found - the same block the whole chain names.
test('a beacon below the tip window is read from the round\'s census height, the same block the whole chain names', async () => {
  const node = chainNode({ blocks: 600 });
  const c = contract({ committeeTimeMs: BigInt(NOW + 80 * 600) * 1000n, censusConfirmations: 6, censusHeight: 90 });
  const whole = beaconFromChain(c, { headers: node.headers, firstHeight: 0 });
  assert.equal(whole.ok, true, whole.why);
  const tipOnly = beaconFromChain(c, { headers: node.headers.slice(600 - BEACON_WINDOW), firstHeight: 600 - BEACON_WINDOW });
  assert.equal(tipOnly.ok, false, 'the tip window alone cannot say which block is the first');
  const seen = await chainBeacon({ call: node.call }).refresh(c);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.height, whole.height);
  assert.equal(toHex(seen.hash), toHex(whole.hash));
});

test('without a census height a tip window that begins after committee_time still refuses', async () => {
  const node = chainNode({ blocks: 600 });
  const c = contract({ committeeTimeMs: BigInt(NOW + 80 * 600) * 1000n, censusConfirmations: 6 });
  const seen = await chainBeacon({ call: node.call }).refresh(c);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /cannot say which block is the FIRST/);
});

test('the read from the census height goes up to the tip, not one window: a beacon further above the census than the window', async () => {
  const node = chainNode({ blocks: 600 });
  // census 20, beacon ~106: more than BEACON_WINDOW (64) above the census height
  const c = contract({ committeeTimeMs: BigInt(NOW + 80 * 600) * 1000n, censusConfirmations: 6, censusHeight: 20 });
  const whole = beaconFromChain(c, { headers: node.headers, firstHeight: 0 });
  assert.ok(whole.height - 20 > BEACON_WINDOW, 'the case: beacon further above the census than one window');
  const seen = await chainBeacon({ call: node.call }).refresh(c);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.height, whole.height);
});

// A HELD BEACON THE CHAIN LEFT IS DROPPED AND READ AGAIN (kanban #727, public testnet4 2026-10-28: an 11-block side branch held the
// seats' beacon eight deep and then lost; the seats kept the branch's block and drew every committee on it)
test('a held beacon whose block the chain replaced is dropped and the chain\'s block is read again', async () => {
  const node = chainNode({ blocks: 40 });
  const beacon = chainBeacon({ call: node.call, recheckMs: 0 });
  const c = contract();
  const first = await beacon.refresh(c);
  assert.equal(first.ok, true);
  const held = beacon.for({ contract: c });
  assert.equal(toHex(held.hash), toHex(blockHashOf(node.headers[first.height])));
  // the chain reorganises from two blocks below the beacon: other blocks at the same heights, and two more
  const from = first.height - 2;
  let previous = blockHashOf(node.headers[from - 1]);
  node.headers.length = from;
  for (let i = from; i < 42; i++) {
    const { header } = blockOf(hash256, [b32(200 + i)], { previous, time: NOW + (i - 20) * 600 });
    node.headers.push(header);
    previous = blockHashOf(header);
  }
  await new Promise((r) => setTimeout(r, 5));
  beacon.for({ contract: c });                     // reads the window again
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(beacon.for({ contract: c }), undefined, 'the branch\'s block is not answered once the chain left it');
  await new Promise((r) => setTimeout(r, 20));
  const again = beacon.for({ contract: c });
  assert.ok(again, 'the chain\'s own block is read again');
  assert.equal(toHex(again.hash), toHex(blockHashOf(node.headers[again.height])));
  assert.notEqual(toHex(again.hash), toHex(held.hash));
});
