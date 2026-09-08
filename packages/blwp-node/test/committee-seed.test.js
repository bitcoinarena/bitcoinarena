// THE COMMITTEE SEED IS THE BEACON'S, NOT THE AUTHOR'S BYTES.
//
// 5A.5: `committee_seed = H(census_root_gv || census_root_settle || round_id
// || round_randomness)`, and the randomness "does not exist yet when round_id
// is published". Measured before this slice: `selectCommittee` read
// `contract.committeeSeed` - thirty-two bytes the round's AUTHOR wrote - so
// the lottery was a pure function of a value the creator chose. On a fixed
// census of eight bonded nodes with two slots, 34 offline candidate seeds were
// enough to seat a chosen pair. Since letter 26 made the seated set the only
// trusted list, that is the whole committee, and 5A.11's "committee cannot be
// overwritten" passes - nothing was overwritten, it was computed.
//
// AND A CONTRACT CANNOT NAME THE SEED EITHER, which is why the field had to
// stop being an input rather than start being checked: `round_id` hashes the
// contract, so a contract carrying the seed derived from its own id has no
// fixed point. Measured below. The spec's Round Contract (§6) carries
// `randomness_rule`, `randomness_fallback`, `committee_time` and
// `entry_open_time` - and no committee seed at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCommittee } from '../../protocol/src/sortition.js';
import { committeeSeedFrom, committeeSeedFromBeacon } from '../../protocol/src/beacon.js';
import { roundId } from '../../protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { taggedHash, toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const CENSUS_HEIGHT = 900000;
const census = (n) => Array.from({ length: n }, (_, i) => ({
  txid: b32(i + 1), vout: 0, pubkey: b32(0x40 + i), bondSats: 100000n,
  height: CENSUS_HEIGHT, roles: ['game'], spent: false,
}));
const contract = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 1000n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: b32(0xd0),
  censusHeight: CENSUS_HEIGHT, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)], ...over,
});

test('a chosen seed can no longer choose the committee', () => {
  // THE GRIND, RUN. Eight bonded nodes, two slots, and an attacker who wants
  // two named seats. The search is over the value the OLD code seated with.
  const field = census(8);
  const wanted = [toHex(b32(0x40)), toHex(b32(0x41))];
  const seats = (seed) => selectCommittee({
    entries: field, contract: contract(), role: 'game', committeeSeed: seed,
  }).map((e) => toHex(e.pubkey)).sort();

  let tries = 0;
  let ground = null;
  for (let i = 0; i < 100000 && !ground; i++) {
    tries++;
    const seed = taggedHash('grind', new Uint8Array([i & 255, (i >> 8) & 255, (i >> 16) & 255]));
    const picked = seats(seed);
    if (picked.length === 2 && picked[0] === wanted[0] && picked[1] === wanted[1]) ground = seed;
  }
  assert.ok(ground, 'the search found no seed at all, so this measures nothing');
  assert.ok(tries < 1000, `grinding a seed took ${tries} tries, which is still cheap`);

  // That seed still seats the pair when it IS the seed - the lottery is a
  // function of its input, and that is not the defect.
  assert.deepEqual(seats(ground), wanted);

  // THE DEFECT IS GONE: putting those bytes on the contract seats nothing,
  // because the selection does not read the field. This is the before/after -
  // the same bytes that used to decide the committee now decide nothing.
  const withGround = contract({ committeeSeed: ground });
  const beaconSeed = committeeSeedFrom({
    censusRootGameVerify: withGround.censusRoot, censusRootSettlement: withGround.censusRoot,
    roundId: roundId(withGround), roundRandomness: b32(0xbe),
  });
  const seatedNow = selectCommittee({
    entries: field, contract: withGround, role: 'game', committeeSeed: beaconSeed,
  }).map((e) => toHex(e.pubkey)).sort();
  assert.notDeepEqual(seatedNow, wanted,
    'the ground seed still seated the pair, so grinding the contract still works');

  // and the lottery refuses to run at all on no seed rather than reaching for
  // the field
  assert.throws(() => selectCommittee({ entries: field, contract: withGround, role: 'game' }),
    /drawn on the seed its beacon produced/);
});

test('no contract can name the seed its own beacon derives', () => {
  // Why the field could not simply be CHECKED: the seed depends on round_id,
  // and round_id hashes the contract the field sits on. Six steps, and the
  // value never settles - a fixed point would be a 2^256 search, not a
  // construction.
  let seed = b32(0);
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const c = contract({ committeeSeed: seed });
    const derived = committeeSeedFrom({
      censusRootGameVerify: c.censusRoot, censusRootSettlement: c.censusRoot,
      roundId: roundId(c), roundRandomness: b32(0xbe),
    });
    assert.notDeepEqual(toHex(derived), toHex(seed),
      `a contract named its own derived seed at step ${i}`);
    assert.equal(seen.has(toHex(derived)), false, 'the derivation cycled');
    seen.add(toHex(derived));
    seed = derived;
  }
});

test('the seed is the beacon\'s, and a beacon the creator already had is refused', () => {
  const c = contract();
  const rid = roundId(c);

  const later = committeeSeedFromBeacon(c, {
    roundId: rid, randomness: b32(0xbe), height: CENSUS_HEIGHT + 5,
  });
  assert.equal(later.ok, true, later.why);
  assert.deepEqual(later.seed, committeeSeedFrom({
    censusRootGameVerify: c.censusRoot, censusRootSettlement: c.censusRoot,
    roundId: rid, roundRandomness: b32(0xbe),
  }), 'the seed is not 5A.5\'s hash of the roots, the round id and the randomness');

  // A DIFFERENT BEACON IS A DIFFERENT COMMITTEE, or the randomness would be
  // decoration.
  const other = committeeSeedFromBeacon(c, {
    roundId: rid, randomness: b32(0x9c), height: CENSUS_HEIGHT + 5,
  });
  assert.notDeepEqual(toHex(other.seed), toHex(later.seed));

  // AND RANDOMNESS THE CREATOR ALREADY HELD IS REFUSED: at or below the
  // round's own census height, that chain state was in hand when the round was
  // made.
  for (const height of [CENSUS_HEIGHT, CENSUS_HEIGHT - 1, 0]) {
    const early = committeeSeedFromBeacon(c, { roundId: rid, randomness: b32(0xbe), height });
    assert.equal(early.ok, false, `a beacon at height ${height} seeded a round it predates`);
    assert.match(early.why, /the creator held that chain state when the round was made/);
  }

  // and no height at all is not "late enough"
  assert.equal(committeeSeedFromBeacon(c, { roundId: rid, randomness: b32(0xbe) }).ok, false);
});

test('a seed that is not thirty-two bytes is not a seed', () => {
  const field = census(4);
  for (const bad of [new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), 'seed', 7])
    assert.throws(() => selectCommittee({
      entries: field, contract: contract(), role: 'game', committeeSeed: bad,
    }), /drawn on the seed its beacon produced/, `${bad && bad.length} bytes passed as a seed`);
});
