// A CENSUS TOO SMALL TO HOLD A ROUND SAYS SO.
//
// `census_min_nodes` is a genesis parameter - "everything a network cannot
// change about itself lives in one block, fixed when the network is created
// and committed in `network_id`" - and the three networks name 10, 3 and 2.
// Measured at the start of this letter: it was written into the network id by
// `genesis.js` and read by NOTHING. Not one file in any `src/`, not one test.
//
// It was not decoration, though. `selectCommittee` ended in
// `scored.slice(0, slots)`, so a census with one eligible node and a contract
// naming two slots handed back a COMMITTEE OF ONE, silently - the thing
// section 13 spends five-of-seven preventing, arriving through the front door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusMinimumFor, meetsCensusMinimum } from '../src/census.js';
import { selectCommittee } from '../src/sortition.js';
import { genesisFor } from '../src/genesis.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// The seed the beacon would have produced. It is the fixture's, stated here,
// because a contract carries none: 5A.5 derives it and section 6's contract
// has no field for it.
const SEED = b32(11);
const round = (networkId, over = {}) => ({
  networkId, committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', gameVerifySlots: 2, settlementSlots: 2,
  bondMinSats: 100000n, ...over,
});
/** `n` bonded nodes declaring `roles`. */
const census = (n, roles = ['game']) => Array.from({ length: n }, (_, i) => ({
  txid: b32(i + 1), vout: 0, pubkey: b32(0x40 + i), bondSats: 200000n,
  height: 900000, roles, spent: false,
}));

test('the minimum is the network\'s, and it comes from genesis', () => {
  // READ OFF GENESIS, not written here. Measured while writing this file:
  // testnet4's genesis in this build carries `censusMinNodes: 2`, where the
  // spec's three-networks table says 3 - and a value in genesis cannot be
  // corrected in passing, because every parameter is committed in
  // `network_id` and changing one moves the network. The divergence is named
  // in TASKBOOK; these assertions say what the network this build has ACTUALLY
  // been born with requires, which is the only number a round of it can be
  // held against.
  assert.equal(censusMinimumFor(round(NETWORK_ID_REGTEST)).minimum, genesisFor('regtest').censusMinNodes);
  assert.equal(censusMinimumFor(round(NETWORK_ID_TESTNET4)).minimum, genesisFor('testnet4').censusMinNodes);
  assert.equal(censusMinimumFor(round(NETWORK_ID_REGTEST)).network, 'regtest');
  assert.equal(censusMinimumFor(round(NETWORK_ID_TESTNET4)).network, 'testnet4');

  // AND A CALLER CANNOT NAME IT. Not by an option, not by a field on the
  // contract: a number a caller picks is a number the operator picks, and an
  // operator who can lower this holds rounds on a census of one.
  const thin = census(1);
  for (const tried of [{ minimum: 1 }, { censusMinNodes: 1 }, { min: 1 }]) {
    assert.throws(() => selectCommittee({
      entries: thin, contract: round(NETWORK_ID_REGTEST), role: 'game', committeeSeed: SEED, ...tried }),
      /where regtest was born needing 2/, `a caller set the minimum with ${Object.keys(tried)[0]}`);
    assert.throws(() => selectCommittee({
      entries: thin, contract: { ...round(NETWORK_ID_REGTEST), ...tried }, role: 'game',
      committeeSeed: SEED,
    }), /where regtest was born needing 2/, `a contract field ${Object.keys(tried)[0]} lowered the minimum`);
  }
});

test('regtest holds a round on two and refuses one, by name', () => {
  const c = round(NETWORK_ID_REGTEST);

  const two = meetsCensusMinimum(census(2), c, 'game');
  assert.equal(two.ok, true, two.why);
  assert.equal(two.have, 2);
  assert.equal(two.need, 2);
  assert.equal(selectCommittee({ entries: census(2), contract: c, role: 'game', committeeSeed: SEED }).length, 2);

  const one = meetsCensusMinimum(census(1), c, 'game');
  assert.equal(one.ok, false, 'a census of one was held to be enough');
  assert.match(one.why, /that census carries 1 game node where regtest was born needing 2/);
  assert.throws(() => selectCommittee({ entries: census(1), contract: c, role: 'game', committeeSeed: SEED }),
    /that census carries 1 game node where regtest was born needing 2/);

  const none = meetsCensusMinimum([], c, 'game');
  assert.equal(none.ok, false);
  assert.match(none.why, /carries 0 game nodes where regtest was born needing 2/);
  assert.throws(() => selectCommittee({ entries: [], contract: c, role: 'game', committeeSeed: SEED }),
    /carries 0 game nodes/);
});

test('testnet4 is judged by testnet4\'s number, and says so by name', () => {
  const need = genesisFor('testnet4').censusMinNodes;
  const c = round(NETWORK_ID_TESTNET4, { gameVerifySlots: need, settlementSlots: need });

  assert.equal(meetsCensusMinimum(census(need), c, 'game').ok, true);
  assert.equal(selectCommittee({ entries: census(need), contract: c, role: 'game', committeeSeed: SEED }).length, need);

  const short = meetsCensusMinimum(census(need - 1), c, 'game');
  assert.equal(short.ok, false, 'testnet4 held a round one node short');
  assert.equal(short.need, need);
  assert.match(short.why, new RegExp(`where testnet4 was born needing ${need}`),
    'the refusal does not name the network whose number it applied');
  assert.throws(() => selectCommittee({ entries: census(need - 1), contract: c, role: 'game', committeeSeed: SEED }),
    new RegExp(`testnet4 was born needing ${need}`));

  // AND THE ANSWER IS THE ROUND'S, not the entries'. The same census put to a
  // regtest round and a testnet4 round is judged by each network's own number.
  const same = census(genesisFor('regtest').censusMinNodes);
  assert.equal(meetsCensusMinimum(same, round(NETWORK_ID_REGTEST), 'game').network, 'regtest');
  assert.equal(meetsCensusMinimum(same, c, 'game').network, 'testnet4');
});

test('the minimum is per role, not per census', () => {
  // Two bonded nodes, one of each role: on a census counted whole this is two
  // and passes; counted the way 5A.3 means eligibility - a settlement node is
  // not a game node that happens to be bonded - it is one and one, and neither
  // role can hold a round.
  const c = round(NETWORK_ID_REGTEST);
  const mixed = [...census(1, ['game']), ...census(1, ['settlement']).map((e) => ({ ...e, txid: b32(0x77) }))];
  assert.equal(mixed.length, 2);

  for (const role of ['game', 'settlement']) {
    const seen = meetsCensusMinimum(mixed, c, role);
    assert.equal(seen.ok, false, `${role} was held on a census of one`);
    assert.equal(seen.have, 1);
    assert.throws(() => selectCommittee({ entries: mixed, contract: c, role, committeeSeed: SEED }),
      new RegExp(`carries 1 ${role} node where regtest was born needing 2`));
  }

  // and a node declaring BOTH counts for both
  const both = census(2, ['game', 'settlement']);
  for (const role of ['game', 'settlement'])
    assert.equal(meetsCensusMinimum(both, c, role).ok, true);
});

test('a round on a network this build has no genesis for is refused, not given a minimum of zero', () => {
  const nowhere = round(b32(0x77));
  assert.throws(() => censusMinimumFor(nowhere), /no genesis for/);
  assert.throws(() => meetsCensusMinimum(census(1), nowhere, 'game'), /no genesis for/);
  assert.throws(() => selectCommittee({ entries: census(1), contract: nowhere, role: 'game', committeeSeed: SEED }),
    /no genesis for/, 'an unknown network was treated as needing nobody');

  const nameless = { committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', gameVerifySlots: 2, bondMinSats: 100000n };
  assert.throws(() => selectCommittee({ entries: census(1), contract: nameless, role: 'game', committeeSeed: SEED }),
    /names no network/);
});

test('exactly the minimum is enough, and one fewer is not', () => {
  // The boundary, both sides of it, on both networks: `<` and `<=` are one
  // character apart and the difference is whether a round of exactly the
  // minimum can be held at all.
  for (const [networkId, name] of [[NETWORK_ID_REGTEST, 'regtest'], [NETWORK_ID_TESTNET4, 'testnet4']]) {
    const need = genesisFor(name).censusMinNodes;
    const c = round(networkId, { gameVerifySlots: need, settlementSlots: need });
    assert.equal(meetsCensusMinimum(census(need), c, 'game').ok, true,
      `${name} refused a census of exactly its minimum`);
    assert.equal(meetsCensusMinimum(census(need - 1), c, 'game').ok, false,
      `${name} held a round one node short`);
    assert.equal(selectCommittee({ entries: census(need), contract: c, role: 'game', committeeSeed: SEED }).length, need);
  }
});

test('a short census yields no committee at all, where it used to yield a short one', () => {
  // The before/after of this slice, as one number. The contract names two
  // slots; the census carries one node. `slice(0, slots)` gave back a
  // committee of ONE - a quorum of itself - and now there is no committee.
  const c = round(NETWORK_ID_REGTEST, { gameVerifySlots: 2 });
  const one = census(1);

  const scored = one.filter((e) => e.roles.includes('game'));
  assert.equal(scored.slice(0, c.gameVerifySlots).length, 1,
    'the old arithmetic did not give one seat, so this is not the case it fixed');

  assert.throws(() => selectCommittee({ entries: one, contract: c, role: 'game', committeeSeed: SEED }),
    /carries 1 game node where regtest was born needing 2/);
});
