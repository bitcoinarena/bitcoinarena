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
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
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
  settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
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

  // THE SEED IS THE BEACON'S, handed to the lottery. It is no longer read off
  // the contract at all - a contract cannot name it, since `round_id` hashes
  // the contract that would carry it.
  const pick = (randomness) => selectCommittee({
    entries, role: 'game', contract, committeeSeed: seedOf(randomness),
  }).map((e) => toHex(e.pubkey));

  const one = pick(PUBLISHED);
  assert.deepEqual(one, pick(PUBLISHED), 'one seed selected two committees');
  assert.equal(one.length, contract.gameVerifySlots);
  assert.notDeepEqual(one, pick(b32(0x9c)),
    'the beacon does not decide the committee, so grinding the round would still work');
});

/**
 * A HASH THE CREATOR COULD HAVE HAD IS REFUSED, AND THE LINE IS COMMITTEE_TIME.
 *
 * It used to be `census_height`, because that was the only ordering the
 * contract could prove: 5A.5 ties the randomness to `committee_time` and the
 * field did not exist. It does now - "committee_time: beacon value appears ->
 * committees selected & verified" - so the rule is the one the spec states
 * rather than the one the fields allowed.
 */
test('randomness from at or before committee_time is rejected', () => {
  const at = (timeMs) => beaconIsAfterRound(contract, { height: contract.censusHeight + 1, timeMs });

  assert.equal(at(contract.committeeTimeMs).ok, false, 'the committee time itself was accepted');
  assert.equal(at(contract.committeeTimeMs - 1n).ok, false);
  assert.equal(at(0n).ok, false);
  assert.match(at(contract.committeeTimeMs).why, /at or before this round's committee time/);
  assert.match(at(contract.committeeTimeMs).why, /could have held it when the round was made/);

  assert.equal(at(contract.committeeTimeMs + 1n).ok, true, 'a later block was refused');
  assert.equal(at(contract.committeeTimeMs + 1n).provenAfter, contract.committeeTimeMs);

  // NO TIME IS NOT A LATE TIME. "I do not know when this was published" and
  // "it was published late enough" must never be the same answer.
  assert.equal(beaconIsAfterRound(contract, { height: 1 }).ok, false);
  assert.match(beaconIsAfterRound(contract, { height: 1 }).why, /names no time/);

  // AND THE ROUND HAS TO SAY WHICH BEACON, AND WHEN.
  assert.match(beaconIsAfterRound({ ...contract, committeeTimeMs: undefined }, { timeMs: 900n }).why,
    /names no committee time/);
  assert.match(beaconIsAfterRound({ ...contract, randomnessRule: undefined }, { timeMs: 900n }).why,
    /names no randomness rule/);
  assert.match(beaconIsAfterRound({ ...contract, randomnessRule: 'drand' }, { timeMs: 900n }).why,
    /names randomness rule "drand" where regtest was born reading "bitcoin-block-hash"/);
});

/**
 * THE TWO HALVES ARE ONE RULE: no seed without the ordering.
 */
test('a seed is not produced from randomness that has not shown it came later', () => {
  const early = committeeSeedFromBeacon(contract,
    { roundId: RID, randomness: PUBLISHED, height: contract.censusHeight + 1,
      timeMs: contract.committeeTimeMs });
  assert.equal(early.ok, false);
  assert.equal(early.seed, undefined, 'a seed came back from randomness the creator already had');

  const late = committeeSeedFromBeacon(contract,
    { roundId: RID, randomness: PUBLISHED, height: contract.censusHeight + 1,
      timeMs: contract.committeeTimeMs + 1n });
  assert.equal(late.ok, true, late.why);
  assert.deepEqual(late.seed, committeeSeedFrom({
    censusRootGameVerify: contract.censusRoot, censusRootSettlement: contract.censusRoot,
    roundId: RID, roundRandomness: PUBLISHED,
  }));

  // The contract carries ONE census root where 5A.5 names two, and the answer
  // says so rather than quietly hashing one of them twice in silence.
  assert.equal(late.rootsAreOne, true);
});
