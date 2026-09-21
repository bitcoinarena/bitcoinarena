// THE COMMITTEE SEED IS THE BEACON'S, NOT THE AUTHOR'S BYTES.
//
// 5A.5: `committee_seed = H(census_root_gv || census_root_settle || round_id
// || round_randomness)`, and the randomness "does not exist yet when round_id
// is published". Measured before this slice: `selectCommittee` read
// `contract.committeeSeed` - thirty-two bytes the round's AUTHOR wrote - so
// the lottery was a pure function of a value the creator chose. On a fixed
// census of eight bonded nodes with two slots, 34 offline candidate seeds were
// enough to assign a chosen pair. Since letter 26 made the assigned set the only
// trusted list, that is the whole committee, and 5A.11's "committee cannot be
// overwritten" passes - nothing was overwritten, it was computed.
//
// AND A CONTRACT CANNOT NAME THE SEED EITHER, which is why the field had to
// stop being an input rather than start being checked: `round_id` hashes the
// contract, so a contract carrying the seed derived from its own id has no
// fixed point. Measured below. The spec's Round Contract (§6, v4.6.2) carries
// `randomness_rule`, `committee_time` and `entry_open_time` - and no committee
// seed at all.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { selectCommittee } from '../../protocol/src/sortition.js';
import { committeeSeedFrom, committeeSeedFromBeacon } from '../../protocol/src/beacon.js';
import { roundId, encodeRoundContract, decodeRoundContract } from '../../protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { taggedHash, toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const CENSUS_HEIGHT = 900000;
// 5A.5 ties the randomness to `committee_time`, so the fixture owns one and a
// beacon is a block with a TIME - the first one after it.
const COMMITTEE_TIME = 500n;
const AFTER = 900n;
const census = (n) => Array.from({ length: n }, (_, i) => ({
  txid: b32(i + 1), vout: 0, pubkey: b32(0x40 + i), bondSats: 100000n,
  height: CENSUS_HEIGHT, roles: ['game'], spent: false,
}));
const contract = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: CENSUS_HEIGHT, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: BLOCK_TICKS, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)], ...over,
});

test('a chosen seed can no longer choose the committee', () => {
  // THE GRIND, RUN. Eight bonded nodes, two slots, and an attacker who wants
  // two named signer nodes. The search is over the value the OLD code assigned with.
  const field = census(8);
  const wanted = [toHex(b32(0x40)), toHex(b32(0x41))];
  const signerNodes = (seed) => selectCommittee({
    entries: field, contract: contract(), role: 'game', committeeSeed: seed,
  }).map((e) => toHex(e.pubkey)).sort();

  let tries = 0;
  let ground = null;
  for (let i = 0; i < 100000 && !ground; i++) {
    tries++;
    const seed = taggedHash('grind', new Uint8Array([i & 255, (i >> 8) & 255, (i >> 16) & 255]));
    const picked = signerNodes(seed);
    if (picked.length === 2 && picked[0] === wanted[0] && picked[1] === wanted[1]) ground = seed;
  }
  assert.ok(ground, 'the search found no seed at all, so this measures nothing');
  assert.ok(tries < 1000, `grinding a seed took ${tries} tries, which is still cheap`);

  // That seed still signer nodes the pair when it IS the seed - the lottery is a
  // function of its input, and that is not the defect.
  assert.deepEqual(signerNodes(ground), wanted);

  // THE DEFECT IS GONE: putting those bytes on the contract signer nodes nothing,
  // because the selection does not read the field. This is the before/after -
  // the same bytes that used to decide the committee now decide nothing.
  const withGround = contract({ committeeSeed: ground });
  const beaconSeed = committeeSeedFrom({
    censusRootGameVerify: withGround.censusRoot, censusRootSettlement: withGround.censusRoot,
    roundId: roundId(withGround), roundRandomness: b32(0xbe),
  });
  const assignedNow = selectCommittee({
    entries: field, contract: withGround, role: 'game', committeeSeed: beaconSeed,
  }).map((e) => toHex(e.pubkey)).sort();
  assert.notDeepEqual(assignedNow, wanted,
    'the ground seed still joined the pair, so grinding the contract still works');

  // and the lottery refuses to run at all on no seed rather than reaching for
  // the field
  assert.throws(() => selectCommittee({ entries: field, contract: withGround, role: 'game' }),
    /drawn on the seed its beacon produced/);
});

test('a contract carries no committee seed at all, so stray bytes change nothing', () => {
  // WHY THE FIELD WENT RATHER THAN GETTING A CHECK. While it existed, a
  // contract could not name the seed its own beacon derives either: `round_id`
  // hashes the contract, so the value it would have to carry depends on
  // itself. Measured while it was still there - six iterations, never a fixed
  // point - which is why the field stopped being an input instead of starting
  // to be compared. Section 6's contract has no such field, and now neither
  // does this one.
  const clean = contract();
  const withStray = contract({ committeeSeed: b32(0x5e) });

  assert.deepEqual(toHex(encodeRoundContract(withStray)), toHex(encodeRoundContract(clean)),
    'a stray committeeSeed reached the encoding');
  assert.deepEqual(toHex(roundId(withStray)), toHex(roundId(clean)),
    'a stray committeeSeed moved the round id, so it is still part of the round');
  assert.equal(decodeRoundContract(encodeRoundContract(withStray)).committeeSeed, undefined,
    'a decoded contract still hands back a committee seed');

  // and what the contract DOES carry is which beacon and when
  const back = decodeRoundContract(encodeRoundContract(clean));
  assert.equal(back.committeeTimeMs, COMMITTEE_TIME);
  assert.equal(back.randomnessRule, 'bitcoin-block-hash');
});

test('the seed is the beacon\'s, and a beacon the creator already had is refused', () => {
  const c = contract();
  const rid = roundId(c);

  const later = committeeSeedFromBeacon(c, {
    roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5, timeMs: AFTER,
  });
  assert.equal(later.ok, true, later.why);
  assert.deepEqual(later.seed, committeeSeedFrom({
    censusRootGameVerify: c.censusRoot, censusRootSettlement: c.censusRoot,
    roundId: rid, roundRandomness: b32(0xbe),
  }), 'the seed is not 5A.5\'s hash of the roots, the round id and the randomness');

  // A DIFFERENT BEACON IS A DIFFERENT COMMITTEE, or the randomness would be
  // decoration.
  const other = committeeSeedFromBeacon(c, {
    roundId: rid, randomness: b32(0x9c), height: CENSUS_HEIGHT + 5, timeMs: AFTER,
  });
  assert.notDeepEqual(toHex(other.seed), toHex(later.seed));

  // AND RANDOMNESS FROM AT OR BEFORE COMMITTEE_TIME IS REFUSED: the creator
  // could have held it when the round was made, which is the whole of what
  // 5A.5's ordering buys. The rule is the round's own `committee_time` now,
  // not a census height standing in for it.
  for (const timeMs of [COMMITTEE_TIME, COMMITTEE_TIME - 1n, 0n]) {
    const early = committeeSeedFromBeacon(c, {
      roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5, timeMs,
    });
    assert.equal(early.ok, false, `a beacon at ${timeMs} seeded a round it predates`);
    assert.match(early.why, /at or before this round's committee time/);
  }

  // and no time at all is not "late enough"
  const undated = committeeSeedFromBeacon(c, {
    roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5,
  });
  assert.equal(undated.ok, false);
  assert.match(undated.why, /names no time/);
});

test('a seed that is not thirty-two bytes is not a seed', () => {
  const field = census(4);
  for (const bad of [new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), 'seed', 7])
    assert.throws(() => selectCommittee({
      entries: field, contract: contract(), role: 'game', committeeSeed: bad,
    }), /drawn on the seed its beacon produced/, `${bad && bad.length} bytes passed as a seed`);
});

test('a round that names no committee time, or the wrong beacon, seeds nothing', () => {
  const rid = roundId(contract());

  // WHICH BEACON AND WHEN are the round's to say - section 6 lists both, and
  // this contract carried neither until now.
  const noTime = committeeSeedFromBeacon({ ...contract(), committeeTimeMs: undefined },
    { roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5, timeMs: AFTER });
  assert.equal(noTime.ok, false, 'a round with no committee time was seeded anyway');
  assert.match(noTime.why, /names no committee time/);

  const noRule = committeeSeedFromBeacon({ ...contract(), randomnessRule: undefined },
    { roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5, timeMs: AFTER });
  assert.equal(noRule.ok, false);
  assert.match(noRule.why, /names no randomness rule/);

  // AND THE RULE IS THE NETWORK'S. `randomness_source` is a genesis parameter
  // (27A.6): a round cannot name a beacon its network was not born reading.
  const wrong = committeeSeedFromBeacon({ ...contract(), randomnessRule: 'drand' },
    { roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5, timeMs: AFTER });
  assert.equal(wrong.ok, false, 'a round chose its own beacon');
  assert.match(wrong.why, /names randomness rule "drand" where regtest was born reading "bitcoin-block-hash"/);
});

test('beacons after committee_time decide the committee: one beacon one pair, and 256 beacons every pair', () => {
  // The randomness has to DECIDE something, or binding it to committee_time
  // would be ceremony. Eight bonded nodes and two slots, so the draw has room
  // to differ - 28 possible pairs.
  //
  // THE CLAIM IS NOT ABOUT TWO CHOSEN BEACONS. It used to be 0xbe against
  // 0x9c, and those differed only by the luck of the round id: when this
  // fixture took the real signed donation set (M3.2 6e) the round id moved and
  // both joined the same pair - a 1-in-28 coincidence, measured, while all 28
  // pairs stayed reachable. So the draw is swept instead, which is stronger
  // than any two beacons differing and holds for whatever the round id is.
  const field = census(8);
  const c = contract();
  const rid = roundId(c);
  const signerNodesBy = (randomness) => {
    const seeded = committeeSeedFromBeacon(c, {
      roundId: rid, randomness, height: CENSUS_HEIGHT + 5, timeMs: AFTER,
    });
    assert.equal(seeded.ok, true, seeded.why);
    return selectCommittee({ entries: field, contract: c, role: 'game', committeeSeed: seeded.seed })
      .map((e) => toHex(e.pubkey)).sort();
  };

  const one = signerNodesBy(b32(0xbe));
  assert.deepEqual(one, signerNodesBy(b32(0xbe)), 'one beacon assigned two committees');
  const pairs = new Set();
  for (let k = 0; k < 256; k++) pairs.add(signerNodesBy(b32(k)).join('+'));
  assert.equal(pairs.size, 28,
    `256 beacons assigned ${pairs.size} of the 28 pairs, so the randomness does not decide the committee`);
});

test('a fallback is the same beacon or it is nothing', () => {
  // Spec v4.6.2 has no fallback beacon (§6 dropped `randomness_fallback`); the
  // beacon is the first Bitcoin block after committee_time. On a network born
  // reading `bitcoin-block-hash` that IS the rule, so the only honest values
  // are absent, empty, or the born rule
  // itself. Anything else is a SECOND randomness source - and a second source
  // is a second committee, since a creator free to fall back would fall back
  // to the beacon that signer nodes their own nodes.
  const rid = roundId(contract());
  const seeded = (randomnessFallback) => committeeSeedFromBeacon(
    { ...contract(), randomnessFallback },
    { roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5, timeMs: AFTER });

  for (const allowed of [undefined, null, '', 'bitcoin-block-hash']) {
    const out = seeded(allowed);
    assert.equal(out.ok, true, `a fallback of ${JSON.stringify(allowed)} was refused: ${out.why}`);
  }

  // AND THE SEED IS THE SAME ONE, so an allowed fallback changes nothing about
  // which committee sits - it is the same beacon by construction.
  assert.deepEqual(seeded('bitcoin-block-hash').seed, seeded(undefined).seed);

  for (const foreign of ['drand', 'mock:7', 'bitcoin-block-height', 'BITCOIN-BLOCK-HASH']) {
    const out = seeded(foreign);
    assert.equal(out.ok, false, `a fallback of "${foreign}" was accepted`);
    assert.match(out.why, /a fallback is the same beacon or it is nothing/);
    assert.match(out.why, new RegExp(`names randomness fallback "${foreign}"`));
    assert.equal(out.seed, undefined, 'a seed came back from a round with a second beacon');
  }

  // AND IT CANNOT ARRIVE OVER THE WIRE AT ALL: the field does not encode, so a
  // decoded contract carries none whatever the sender wrote.
  const wire = decodeRoundContract(encodeRoundContract({ ...contract(), randomnessFallback: 'drand' }));
  assert.equal(wire.randomnessFallback, undefined,
    'a foreign fallback survived the encoding, so the wire can carry a second beacon');
  assert.equal(committeeSeedFromBeacon(wire,
    { roundId: roundId(wire), randomness: b32(0xbe), height: CENSUS_HEIGHT + 5, timeMs: AFTER }).ok,
  true);
});
