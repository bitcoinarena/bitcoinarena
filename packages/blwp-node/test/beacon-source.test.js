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
import { blockOf } from '../../protocol/tools/bond.js';
import { hash256, blockHashOf } from '../../protocol/src/chain.js';
import { committeeSeedFromBeacon, beaconFromChain, medianTimePast } from '../../protocol/src/beacon.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

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
  const round = new Round(openStore(':memory:'));
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
