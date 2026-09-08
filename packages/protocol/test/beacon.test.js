// THE COMMITTEE SEED COMES FROM RANDOMNESS THE ROUND'S CREATOR COULD NOT HAVE
// HAD, AND EVERY NODE GIVEN THE SAME VALUE REACHES THE SAME SEAT LIST.
//
// Section 5A.5 makes the seed H(census roots || round_id || round_randomness)
// with round_randomness "a public randomness beacon value that DOES NOT EXIST
// YET when round_id is published". The threat table says why in one line: in
// v4.4 the creator chose round_id while the randomness was already known, so
// "grinding round_ids offline until both committees consisted of his own nodes
// was trivial and undetectable".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import {
  committeeSeedFrom, beaconIsAfterRound, committeeSeedFromBeacon,
} from '../src/beacon.js';
import { roundId } from '../src/contracts.js';
import { selectCommittee } from '../src/sortition.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xc0 + n)),
};
const RID = roundId(contract);
const PUBLISHED = b32(0x9b);            // the block hash, once it exists

/**
 * TWO NODES, ONE PUBLISHED HASH, ONE SEED - and the four inputs in 5A.5's own
 * order, because two nodes concatenating differently would select different
 * committees from identical facts.
 */
test('two nodes given the same published hash reach the same seed', () => {
  const inputs = {
    censusRootGameVerify: contract.censusRoot,
    censusRootSettlement: contract.censusRoot,
    roundId: RID,
    roundRandomness: PUBLISHED,
  };
  const a = committeeSeedFrom(inputs);
  const b = committeeSeedFrom({ ...inputs });
  assert.deepEqual(a, b, 'one set of facts produced two seeds');
  assert.equal(a.length, 32);

  // EVERY INPUT MOVES IT. A seed that ignored one of the four would let that
  // one be chosen freely afterwards.
  const moved = (patch) => toHex(committeeSeedFrom({ ...inputs, ...patch }));
  assert.notEqual(moved({ roundRandomness: b32(0x9c) }), toHex(a), 'the beacon does not reach the seed');
  assert.notEqual(moved({ roundId: b32(0x11) }), toHex(a), 'the round does not reach the seed');
  assert.notEqual(moved({ censusRootGameVerify: b32(0x22) }), toHex(a));
  assert.notEqual(moved({ censusRootSettlement: b32(0x22) }), toHex(a));

  // AND THE ORDER IS PART OF IT: the two roots are not interchangeable.
  assert.notEqual(
    moved({ censusRootGameVerify: b32(4), censusRootSettlement: b32(5) }),
    moved({ censusRootGameVerify: b32(5), censusRootSettlement: b32(4) }),
    'the roots were hashed as a set rather than in order');

  // THE VALUE ITSELF, PINNED. Every assertion above compares the seed with
  // another seed, so a change that moved every seed alike - the two roots
  // swapped, a tag renamed, the parts joined differently - would pass all of
  // them. This is the byte-level fact: four known inputs, one known answer.
  // If it ever changes, every committee ever selected changes with it, and
  // that must be a decision rather than a diff nobody noticed.
  assert.equal(
    toHex(committeeSeedFrom({
      censusRootGameVerify: b32(4), censusRootSettlement: b32(5),
      roundId: b32(6), roundRandomness: b32(7),
    })),
    '9c28512a7b662b84f5b49848bcb9bede9cb6fcacda35892687a3c996288ed336',
    'the committee seed changed, so every committee this protocol would select changed');

  // and a caller cannot hand it something that is not 32 bytes
  assert.throws(() => committeeSeedFrom({ ...inputs, roundRandomness: b32(1).subarray(0, 16) }),
    /randomness is not 32 bytes/);
  assert.throws(() => committeeSeedFrom({ ...inputs, roundId: undefined }), /round id is not 32 bytes/);
});

/**
 * AND THE SAME SEED SELECTS THE SAME COMMITTEE. The seed is only worth
 * anything because the seat list follows from it.
 */
test('one seed selects one committee, and a different beacon selects another', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
    txid: b32(n), vout: 0, pubkey: b32(0xa0 + n), bondSats: 100000n,
    height: 1, roles: ['game'], spent: false,
  }));
  const seedOf = (randomness) => committeeSeedFrom({
    censusRootGameVerify: contract.censusRoot, censusRootSettlement: contract.censusRoot,
    roundId: RID, roundRandomness: randomness,
  });

  const pick = (randomness) => selectCommittee({
    entries, role: 'game',
    contract: { ...contract, committeeSeed: seedOf(randomness) },
  }).map((e) => toHex(e.pubkey));

  const one = pick(PUBLISHED);
  assert.deepEqual(one, pick(PUBLISHED), 'one seed selected two committees');
  assert.equal(one.length, contract.gameVerifySlots);
  assert.notDeepEqual(one, pick(b32(0x9c)),
    'the beacon does not decide the committee, so grinding the round would still work');
});

/**
 * A HASH THE CREATOR COULD HAVE HAD IS REFUSED.
 *
 * The contract commits to `census_height`, so chain state at or below it was
 * demonstrably in the creator's hands when the round was made. A beacon from
 * there is the v4.4 attack with extra steps.
 */
test('randomness from a height the round already knew is rejected', () => {
  const at = (height) => beaconIsAfterRound(contract, { height });

  assert.equal(at(contract.censusHeight).ok, false, 'the census height itself was accepted');
  assert.equal(at(contract.censusHeight - 1).ok, false);
  assert.equal(at(0).ok, false);
  assert.match(at(contract.censusHeight).why, /at or below the round's own census height/);
  assert.match(at(contract.censusHeight).why, /held that chain state when the round was made/);

  assert.equal(at(contract.censusHeight + 1).ok, true, 'a later block was refused');
  assert.equal(at(contract.censusHeight + 1).provenAfter, contract.censusHeight);

  // NO HEIGHT IS NOT A LATE HEIGHT. "I do not know when this was published"
  // and "it was published late enough" must never be the same answer.
  assert.equal(beaconIsAfterRound(contract, {}).ok, false);
  assert.match(beaconIsAfterRound(contract, {}).why, /names no height/);
  assert.equal(beaconIsAfterRound(contract, { height: 900000.5 }).ok, false);
  assert.match(beaconIsAfterRound({}, { height: 1 }).why, /no census height/);
});

/**
 * THE TWO HALVES ARE ONE RULE: no seed without the ordering.
 */
test('a seed is not produced from randomness that has not shown it came later', () => {
  const early = committeeSeedFromBeacon(contract,
    { roundId: RID, randomness: PUBLISHED, height: contract.censusHeight });
  assert.equal(early.ok, false);
  assert.equal(early.seed, undefined, 'a seed came back from randomness the creator already had');

  const late = committeeSeedFromBeacon(contract,
    { roundId: RID, randomness: PUBLISHED, height: contract.censusHeight + 1 });
  assert.equal(late.ok, true, late.why);
  assert.deepEqual(late.seed, committeeSeedFrom({
    censusRootGameVerify: contract.censusRoot, censusRootSettlement: contract.censusRoot,
    roundId: RID, roundRandomness: PUBLISHED,
  }));

  // The contract carries ONE census root where 5A.5 names two, and the answer
  // says so rather than quietly hashing one of them twice in silence.
  assert.equal(late.rootsAreOne, true);
});
