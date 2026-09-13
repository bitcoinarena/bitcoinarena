// The protocol package, tested against the properties a second implementation
// would have to reproduce.

import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { Writer, Reader } from '../src/encode.js';
import { taggedHash, toHex, fromHex } from '../src/hash.js';
import { TAG, CUSTODY, SLASH_REMAINDERS, STAKE_EXPIRY_BLOCKS } from '../src/constants.js';
import { commitCensus, merkleRoot, compareEntries, leafHash } from '../src/census.js';
import { chainOf as minedChain } from '../tools/chainview.js';
import { selectCommittee, weightOf, ticketFor } from '../src/sortition.js';
import { computePayoutTable, rankWeights, payingRanks, DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import {
  encodeRoundContract, decodeRoundContract, roundId, contractWarnings, custodyFieldsAreValid,
  publicationRelaysAreValid,
  encodeEntryContract, decodeEntryContract, entryId, stakePointIsTheHandouts, STAKE_POINT_BYTES,
} from '../src/contracts.js';
import { COMMITMENT_BYTES } from '../src/handout.js';

/**
 * A view spanning the census height: from it to `tip`. A view that begins
 * after `census_height` carries no block the census is about and is refused,
 * so a fixture cannot start at the tip and call itself a chain.
 */
const spanning = (from, tip) =>
  minedChain(Array.from({ length: tip - from + 1 }, () => ({ transactions: [] })), from);


const b32 = (n) => new Uint8Array(32).fill(n);
// What a beacon would have produced. A contract names no seed - section 6 has
// no such field - so the lottery's input is stated where it is used.
const SEED = b32(11);
const pk = (n) => b32(n);

/* ---------------------------------------------------------------- encoding */

test('u64 refuses a Number, however small', () => {
  assert.throws(() => new Writer().u64(5), /BigInt/);
  assert.doesNotThrow(() => new Writer().u64(5n));
});

test('unpaired surrogates are rejected rather than replaced', () => {
  assert.throws(() => new Writer().str('\uD800'), /surrogate/);
  assert.throws(() => new Writer().str('\uDC00x'), /surrogate/);
  assert.doesNotThrow(() => new Writer().str('🚀 rocket'));
});

test('a vec declared sorted is asserted, not sorted', () => {
  const cmp = (a, b) => a - b;
  assert.throws(() => new Writer().vec([3, 1], (v, w) => w.u8(v), { sortedBy: cmp }),
    /not sorted/);
  assert.doesNotThrow(() => new Writer().vec([1, 3], (v, w) => w.u8(v), { sortedBy: cmp }));
});

test('trailing bytes are a different message', () => {
  const w = new Writer(); w.u32(7);
  const b = new Uint8Array(5); b.set(w.finish());
  const r = new Reader(b); r.u32();
  assert.throws(() => r.end(), /trailing/);
});

test('tags keep types apart even when the bodies match', () => {
  const body = new Uint8Array([1, 2, 3]);
  assert.notEqual(toHex(taggedHash(TAG.roundContract, body)),
                  toHex(taggedHash(TAG.entryContract, body)));
});

/* ------------------------------------------------------------------ census */

test('entries sort by outpoint, not by key hash', () => {
  const a = { txid: b32(1), vout: 5 }, b = { txid: b32(1), vout: 2 }, c = { txid: b32(0), vout: 9 };
  const sorted = [a, b, c].sort(compareEntries);
  assert.deepEqual(sorted.map((e) => [e.txid[0], e.vout]), [[0, 9], [1, 2], [1, 5]]);
});

test('an odd merkle level promotes rather than duplicates', () => {
  // Duplicating the last leaf is what makes two leaf sets share a root
  // (CVE-2012-2459). Three leaves and four-with-a-repeat must differ.
  const l = [b32(1), b32(2), b32(3)];
  const withRepeat = [b32(1), b32(2), b32(3), b32(3)];
  assert.notEqual(toHex(merkleRoot(l)), toHex(merkleRoot(withRepeat)));
});

test('the census is immutable for a height', () => {
  const mk = (n) => ({ txid: b32(n), vout: 0, pubkey: pk(n), advertId: b32(n + 90),
                       bondSats: 100000n,
                       height: 800000 + n, roles: ['game'], spent: false });
  const args = {
    contract: { censusHeight: 900000, censusConfirmations: 6 },
    view: spanning(900000, 900100),
  };
  const a = commitCensus([mk(3), mk(1), mk(2)], args);
  const b = commitCensus([mk(2), mk(3), mk(1)], args);
  assert.equal(toHex(a.root), toHex(b.root), 'input order changed the root');
});

test('immature and spent bonds are excluded', () => {
  const mk = (n, h, spent) => ({ txid: b32(n), vout: 0, pubkey: pk(n), advertId: b32(n + 90),
                                 bondSats: 100000n,
                                 height: h, roles: ['game'], spent });
  const c = commitCensus(
    [mk(1, 800000, false), mk(2, 900099, false), mk(3, 800000, true)],
    { contract: { censusHeight: 900000, censusConfirmations: 6 },
      view: spanning(900000, 900100) });
  assert.deepEqual(c.entries.map((e) => e.txid[0]), [1]);
});

/* --------------------------------------------------------------- sortition */

test('weight is linear, so splitting a bond never helps', () => {
  // Under sqrt weighting, four nodes at 1x total 4 against one at 4x with 2 -
  // splitting DOUBLES the chances. Linear makes them equal, which is the point.
  const whole = weightOf(400000n, 100000n);
  const split = 4n * weightOf(100000n, 100000n);
  assert.equal(whole, split);
});

test('a bond below the minimum still counts once, never zero', () => {
  assert.equal(weightOf(1n, 100000n), 1n);
});

test('selection never divides, and heavier bonds win more often', () => {
  const mk = (n, bond) => ({ txid: b32(n), vout: 0, pubkey: pk(n), bondSats: bond,
                             height: 1, roles: ['game'], spent: false });
  const entries = [];
  for (let i = 1; i <= 20; i++) entries.push(mk(i, i === 1 ? 5000000n : 100000n));

  let heavyWins = 0;
  for (let s = 0; s < 200; s++) {
    const pick = selectCommittee({
      entries, role: 'game',
      contract: { gameVerifySlots: 3, bondMinSats: 100000n, networkId: NETWORK_ID_REGTEST },
      // A DIFFERENT SEED EVERY ROUND, which is what a beacon gives: the point
      // of the run is that weight decides across many draws, not one.
      committeeSeed: b32(s % 256),
    });
    if (pick.some((e) => e.txid[0] === 1)) heavyWins++;
  }
  // fifty times the bond in a field of twenty, three slots: it should appear
  // far more often than the 15% a uniform draw would give
  assert.ok(heavyWins > 60, `the heavy bond appeared in only ${heavyWins} of 200`);
});

test('the same seed picks the same committee', () => {
  const mk = (n) => ({ txid: b32(n), vout: 0, pubkey: pk(n), bondSats: 100000n,
                       height: 1, roles: ['game'], spent: false });
  const entries = [1, 2, 3, 4, 5].map(mk);
  // A ROUND NAMES ITS NETWORK, because the census minimum is a genesis fact
  // and the network id is what says which genesis. A bare contract without one
  // is refused now, the same way the census refuses one.
  const round = {
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', gameVerifySlots: 2, bondMinSats: 100000n,
    networkId: NETWORK_ID_REGTEST,
  };
  const a = selectCommittee({ entries, contract: round, role: 'game', committeeSeed: SEED });
  const b = selectCommittee({ entries, contract: round, role: 'game', committeeSeed: SEED });
  assert.deepEqual(a.map((e) => e.txid[0]), b.map((e) => e.txid[0]));

  // AND THE SIZE IS THE ROUND'S. It was a caller number: nobody had to forge a
  // census to shrink a committee, they could pass a smaller `slots`. Section 6
  // is explicit that the counts are "echoed for readability; MUST equal
  // genesis_parameters... A contract disagreeing with the network it names is
  // invalid, NOT A SMALLER COMMITTEE."
  assert.equal(selectCommittee({ entries, contract: round, role: 'game', committeeSeed: SEED }).length, 2);
  assert.equal(selectCommittee({ entries, contract: { ...round, gameVerifySlots: 5 }, role: 'game', committeeSeed: SEED }).length, 5);

  // a settlement seat count is a different number, and a role with no pool has
  // no committee at all rather than a silent zero
  assert.equal(selectCommittee({
    entries: entries.map((e) => ({ ...e, roles: ['settlement'] })),
    contract: { ...round, settlementSlots: 4 }, role: 'settlement',
    committeeSeed: SEED }).length, 4);
  assert.throws(() => selectCommittee({ entries, contract: round, role: 'relay', committeeSeed: SEED }),
    /names no committee size for relay/);
  // THE SEED IS NOT A CONTRACT FIELD ANY MORE. A caller that brings none is
  // refused for that, and the refusal says where a seed comes from - the
  // beacon - rather than pointing at a field the spec's contract does not have.
  assert.throws(() => selectCommittee({ entries, contract: { gameVerifySlots: 2, bondMinSats: 1n }, role: 'game' }),
    /drawn on the seed its beacon produced/);
  assert.throws(() => selectCommittee({
    entries, contract: { gameVerifySlots: 2 }, role: 'game', committeeSeed: b32(11) }),
  /names no positive bond floor/);

  // A FLOOR OF ZERO IS NOT A SMALL FLOOR. The weight is bond/floor, so zero
  // is a division by zero - `weightOf` threw from underneath this rather than
  // this answering - and 5A.3 says what it means besides: a floor of nothing
  // makes identity free, "the flaw that made v4.4 unsafe".
  for (const floor of [0n, -1n])
    assert.throws(() => selectCommittee({
      entries, contract: { ...round, bondMinSats: floor }, role: 'game',
      committeeSeed: SEED }),
    /names no positive bond floor/, `a floor of ${floor} was accepted`);

  // AND A CALLER CANNOT REACH ANY OF THE THREE. Held fixed, the old arguments
  // are inert: there is no parameter left to pass one through.
  //
  // The bonds are UNEQUAL on purpose: `bondMin` normalises the weights, so a
  // field of identical bonds would weigh the same under any floor and the
  // caller's number would look inert when it was not.
  const uneven = [1, 2, 3, 4, 5].map((n) => ({
    txid: b32(n), vout: 0, pubkey: pk(n), bondSats: BigInt(n) * 400000n,
    height: 1, roles: ['game'], spent: false,
  }));
  const fair = selectCommittee({
    entries: uneven, contract: round, role: 'game', committeeSeed: SEED });
  // The values chosen here are the ones proven below to MOVE the answer when
  // the round moves them - `bondMin: 1n` looked inert and was not a test:
  // weightOf floors bond/bondMin, so scaling the floor scales every weight
  // alike and cannot reorder anybody.
  for (const extra of [{ slots: 5 }, { slots: 1 }, { bondMin: 2000000n }]) {
    const tried = selectCommittee({
      entries: uneven, contract: round, role: 'game', committeeSeed: SEED, ...extra });
    assert.equal(tried.length, 2, `a caller passing ${Object.keys(extra)[0]} resized the committee`);
    assert.deepEqual(tried.map((e) => e.txid[0]), fair.map((e) => e.txid[0]),
      `a caller passing ${Object.keys(extra)[0]} changed who sits`);
  }

  // AND THE SEED IS NO LONGER ONE OF THEM. It used to be a contract field, so
  // "a caller cannot pass one" was the protection; the field was the hole -
  // 34 offline tries picked a committee out of an eight-node census. The seed
  // is an argument now, fixed by the beacon, and the contract's own bytes are
  // NOT READ: moving them changes nobody.
  assert.deepEqual(
    selectCommittee({
      entries: uneven, contract: { ...round, committeeSeed: b32(99) }, role: 'game',
      committeeSeed: SEED }).map((e) => e.txid[0]),
    fair.map((e) => e.txid[0]),
    'the lottery still reads the contract\'s committeeSeed');

  // while the seed the BEACON produced does decide it, or the argument would
  // be inert and this test would prove nothing
  assert.notDeepEqual(
    selectCommittee({ entries: uneven, contract: round, role: 'game', committeeSeed: b32(99) })
      .map((e) => e.txid[0]), fair.map((e) => e.txid[0]));

  // and the other two, moved on the ROUND, still change the answer
  assert.notDeepEqual(
    selectCommittee({ entries: uneven, contract: { ...round, bondMinSats: 2000000n }, role: 'game',
      committeeSeed: SEED })
      .map((e) => e.txid[0]), fair.map((e) => e.txid[0]));
});

/* ------------------------------------------------------------------ payout */

test('rank weights are exact integers, not a float curve', () => {
  assert.deepEqual(rankWeights(4), [64n, 48n, 36n, 27n]);   // 4^3, 3*4^2, 9*4, 27
  assert.equal(payingRanks(75), 19);
  assert.equal(payingRanks(1), 1);
  assert.equal(payingRanks(0), 0);
});

// INCLUSIVE, AS 22A AND THE PAYOUT VECTOR SAY (M3.2 6e): each player commits
// 100 sat, the 2 sat fee comes out of it, 98 is staked. Before, this test wrote
// the fee as 0 and asserted the on-top pool of 2,500 sat - the reading a zero
// fee brings back - while test-vectors/protocol/payout.json already said 2,450.
test("the worked example from 18A.6 comes out at the spec's numbers", () => {
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push({ pubkey: pk(i), stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, outcome: DELIVERED, score: 50 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(100 + i), stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, outcome: DELIVERED, score: 900 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(200 + i), stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, outcome: FAILED, score: 0 });

  const r = computePayoutTable({ roundId: b32(9), entries, minScore: 1 });
  assert.equal(r.pool, 2450000n);
  assert.equal(r.qualifiers, 75);
  assert.equal(r.payingRanks, 19);

  const paid = r.table.reduce((s, t) => s + t.amountMsat, 0n);
  assert.equal(paid, 9800000n, 'money was created or destroyed');
});

test('nothing is created or destroyed, remainders included', () => {
  // A pool that does not divide evenly by the weights is the case where a
  // careless implementation drops millisatoshi on the floor.
  const entries = [];
  for (let i = 0; i < 7; i++) entries.push({ pubkey: pk(i), stakeMsat: 33333n, feeMsat: 0n, donationMsat: 0n, outcome: DELIVERED, score: 100 + i });
  for (let i = 0; i < 3; i++) entries.push({ pubkey: pk(50 + i), stakeMsat: 33333n, feeMsat: 0n, donationMsat: 0n, outcome: FAILED, score: 0 });

  const r = computePayoutTable({ roundId: b32(4), entries, minScore: 1 });
  const paid = r.table.reduce((s, t) => s + t.amountMsat, 0n);
  assert.equal(paid, 10n * 33333n);
});

test('VOID entries neither contribute nor draw', () => {
  const entries = [
    { pubkey: pk(1), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: DELIVERED, score: 500 },
    { pubkey: pk(2), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: FAILED, score: 0 },
    { pubkey: pk(3), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: VOID, score: 0 },
  ];
  const r = computePayoutTable({ roundId: b32(1), entries, minScore: 1 });
  assert.equal(r.table.length, 2, 'a VOID entry appeared in the table');
  assert.equal(r.table.reduce((s, t) => s + t.amountMsat, 0n), 200000n);
});

test('with no qualifiers everyone keeps nothing and the pool is untouched', () => {
  const entries = [
    { pubkey: pk(1), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: FAILED, score: 0 },
    { pubkey: pk(2), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: FORFEIT, score: 0 },
  ];
  const r = computePayoutTable({ roundId: b32(1), entries, minScore: 1 });
  assert.equal(r.qualifiers, 0);
  assert.equal(r.pool, 200000n);
});

test('a float stake is refused outright', () => {
  assert.throws(() => computePayoutTable({
    roundId: b32(1),
    entries: [{ pubkey: pk(1), stakeMsat: 100000, outcome: DELIVERED, score: 1 }],
  }), /BigInt/);
});

/* --------------------------------------------------------------- contracts */

test('a contract round-trips byte for byte', () => {
  const c = sampleContract();
  const enc = encodeRoundContract(c);
  assert.equal(toHex(encodeRoundContract(decodeRoundContract(enc))), toHex(enc));
});

test('a contract from a future version is refused, not mis-parsed', () => {
  const enc = encodeRoundContract(sampleContract());
  enc[2] = 9;                                    // bump the version word
  assert.throws(() => decodeRoundContract(enc), /protocol version/);
});

test('the round id changes if any field does', () => {
  const a = sampleContract();
  const b = { ...a, minScore: a.minScore + 1 };
  assert.notEqual(toHex(roundId(a)), toHex(roundId(b)));
});

test('a flat rank curve is flagged before anyone stakes', () => {
  const c = sampleContract();
  assert.deepEqual(contractWarnings(c), []);
  assert.ok(contractWarnings({ ...c, rankNumerator: 99, rankDenominator: 100 })
    .includes('flat_rank_curve'));
  assert.ok(contractWarnings({ ...c, exposureReference: 0 }).includes('exposure_ignored'));
});

function sampleContract() {
  return {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
    censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
    exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
    timeFloor: 16384, timeCeil: 98304, minScore: 1,
    rankNumerator: 3, rankDenominator: 4,
    nodes: [b32(4), b32(7), b32(9)],
  };
}

/**
 * 23.6 (spec v4.6.2): "The Round Contract names which construction it uses."
 * Two exist - a threshold-signed Lightning node, which the spec calls emerging
 * and measured-not-used, and the Fedimint-class federation with the stake lock
 * inside it, which is V1 - with different residual layers. A player is entitled
 * to know which one they staked into, and a round settled under one cannot be
 * replayed as if it were the other. Naming it is not implementing it.
 */
test('a round names which custody construction it uses, and it is in the id', () => {
  const c = sampleContract();
  const back = decodeRoundContract(encodeRoundContract(c));
  assert.equal(back.custody, c.custody);
  assert.ok(CUSTODY.includes(back.custody));
  assert.deepEqual(CUSTODY, ['THRESHOLD_LN', 'FEDERATION']);

  // the other construction is a different round
  const other = { ...c, custody: c.custody === 'FEDERATION' ? 'THRESHOLD_LN' : 'FEDERATION' };
  assert.notDeepEqual(roundId(other), roundId(c));
  assert.equal(decodeRoundContract(encodeRoundContract(other)).custody, other.custody);

  // and a construction nobody named is refused rather than encoded as zero
  assert.throws(() => encodeRoundContract({ ...c, custody: 'CUSTODIAN' }),
    /CUSTODIAN is not one of THRESHOLD_LN, FEDERATION/);
  assert.throws(() => encodeRoundContract({ ...c, custody: undefined }), /is not one of/);
});

/**
 * A THRESHOLD THE OPERATOR PICKS IS NOT A THRESHOLD.
 *
 * 22A: "A selected node earns its share only if it performed the
 * CONTRACT-DEFINED minimum service". It was an argument to the slashing check
 * until this field existed, and a minimum a caller chooses is one an operator
 * chooses - the same fault the objection window was moved in here to fix, and
 * worse, because this number decides whether a bond is taken. The player and
 * every node sign up to it with the rest of the round.
 */
test('the minimum service a fee is earned by is in the round, and in its id', () => {
  const c = sampleContract();
  const back = decodeRoundContract(encodeRoundContract(c));
  assert.equal(back.slashMinimumServed, c.slashMinimumServed);

  const higher = { ...c, slashMinimumServed: c.slashMinimumServed + 1 };
  assert.notDeepEqual(roundId(higher), roundId(c),
    'a different bar is a different round, or an operator could raise it after entry');
});

/**
 * AND WHERE A SLASHED BOND'S OTHER HALF GOES, 5A.3: "half to the affected
 * players of that round, half burned or to the remaining honest committee
 * members of the round, AS FIXED BY THE ROUND CONTRACT."
 *
 * The alternative is the field. The HALVES are not: the spec states them as
 * numbers, and a contract that could move them would let an operator write
 * itself the whole bond - the fault a contract field exists to prevent rather
 * than one to import.
 */
test('a round fixes where a slashed bond\'s other half goes, and it is in the id', () => {
  const c = sampleContract();
  const back = decodeRoundContract(encodeRoundContract(c));
  assert.equal(back.slashRemainder, c.slashRemainder);
  assert.deepEqual(SLASH_REMAINDERS, ['BURN', 'COMMITTEE']);

  const other = { ...c, slashRemainder: c.slashRemainder === 'BURN' ? 'COMMITTEE' : 'BURN' };
  assert.notDeepEqual(roundId(other), roundId(c));
  assert.equal(decodeRoundContract(encodeRoundContract(other)).slashRemainder, other.slashRemainder);

  assert.throws(() => encodeRoundContract({ ...c, slashRemainder: 'THE OPERATOR' }),
    /is not one of BURN, COMMITTEE/);
  assert.throws(() => encodeRoundContract({ ...c, slashRemainder: undefined }), /is not one of/);
});

/**
 * THE v4.6.2 CUSTODY FIELDS (section 6): `federation_id`, `stake_expiry_blocks`
 * and `publication_relays[]`. Each is signed with the round, so each is in the
 * id: a custodian, an expiry or a relay list changed after entry would be one
 * the creator picked after seeing who entered.
 */
test('the federation, the lock expiry and the relays are in the round, and in its id', () => {
  const c = {
    ...sampleContract(), federationId: b32(0xfe),
    publicationRelays: ['wss://relay.example/blwp', 'https://mirror.example/rounds'],
  };
  const back = decodeRoundContract(encodeRoundContract(c));
  assert.deepEqual(back.federationId, c.federationId);
  assert.equal(back.stakeExpiryBlocks, STAKE_EXPIRY_BLOCKS);
  assert.deepEqual(back.publicationRelays, c.publicationRelays);
  assert.equal(toHex(encodeRoundContract(back)), toHex(encodeRoundContract(c)));

  for (const moved of [
    { federationId: b32(0xfd) },
    { stakeExpiryBlocks: 143 },
    { publicationRelays: [...c.publicationRelays].reverse() },
    { publicationRelays: [] },
  ]) assert.notDeepEqual(roundId({ ...c, ...moved }), roundId(c), JSON.stringify(moved));

  // a contract with no field is refused rather than encoded as a default
  assert.throws(() => encodeRoundContract({ ...c, federationId: undefined }));
  assert.throws(() => encodeRoundContract({ ...c, stakeExpiryBlocks: undefined }));
  assert.throws(() => encodeRoundContract({ ...c, publicationRelays: undefined }),
    /publicationRelays is a list of URLs/);

  // and publication_txid is not one of them: it names a transaction carrying
  // H(RoundContract), so a contract holding it would have no fixed point
  assert.equal(toHex(roundId({ ...c, publicationTxid: b32(0x77) })), toHex(roundId(c)));
});

test('the custody fields say what v4.6.2 rules, or the round is refused by name', () => {
  const c = { ...sampleContract(), federationId: b32(0xfe), publicationRelays: ['wss://r.example'] };
  assert.deepEqual(custodyFieldsAreValid(c), { ok: true });
  assert.equal(STAKE_EXPIRY_BLOCKS, 144);

  assert.match(custodyFieldsAreValid({ ...c, stakeExpiryBlocks: 12 }).why,
    /stake_expiry_blocks 12 where §23\.1 rules 144/);
  assert.match(custodyFieldsAreValid({ ...c, federationId: new Uint8Array(32) }).why,
    /takes a stake into a FEDERATION and names no federation_id/);
  // a round that takes no stake needs no custodian
  assert.equal(custodyFieldsAreValid({ ...c, federationId: new Uint8Array(32), stakeMsat: 0n }).ok, true);
  assert.match(custodyFieldsAreValid({ ...c, publicationRelays: ['ftp://r.example'] }).why,
    /is not an http\(s\) or ws\(s\) URL/);
  assert.match(custodyFieldsAreValid({ ...c, publicationRelays: ['not a url'] }).why,
    /is not an http\(s\) or ws\(s\) URL/);
  assert.match(custodyFieldsAreValid({ ...c, publicationRelays: ['wss://r.example', 'wss://r.example'] }).why,
    /named twice/);
});

// SINCE P2 NO RESULT IS FINAL UNTIL ITS TRANSCRIPT IS POSTED TO THE ROUND'S
// RELAYS (§13A), so a round that takes a stake and names none could never
// settle it. A free round moves no money and may name none.
test('a round that takes a stake names at least one publication relay; a free round may name none', () => {
  const c = { ...sampleContract(), federationId: b32(0xfe), publicationRelays: ['wss://r.example'] };
  assert.ok(c.stakeMsat > 0n, 'the sample round takes a stake');
  assert.deepEqual(publicationRelaysAreValid(c), { ok: true });
  assert.match(publicationRelaysAreValid({ ...c, publicationRelays: [] }).why,
    /takes a stake and names no publication relay/);
  assert.match(custodyFieldsAreValid({ ...c, publicationRelays: [] }).why,
    /takes a stake and names no publication relay/);
  assert.deepEqual(publicationRelaysAreValid({ ...c, publicationRelays: [], stakeMsat: 0n }), { ok: true });
  assert.match(publicationRelaysAreValid({ ...c, publicationRelays: ['not a url'] }).why,
    /is not an http\(s\) or ws\(s\) URL/);
});

/**
 * THE ENTRY'S STAKE-LOCK FIELDS (section 7, v4.6.2): stake_point, fee_preimage,
 * the two lock outpoints and the claim-key attestation. All signed by the
 * player, so all in the entry id - a lock outpoint swapped after signing would
 * point the seats at a lock the player did not commit to.
 */
const lockedEntry = () => ({
  roundId: b32(0x01), playerPubkey: b32(0x02), sessionPubkey: b32(0x03), stakeCommitment: b32(0x04),
  stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x05),
  vssSharesRef: b32(0x06), stakePoint: new Uint8Array(33).fill(0x02),
  feePreimage: b32(0x07), stakeLockOutpoint: { txid: b32(0x08), outIdx: 0n },
  feeLockOutpoint: { txid: b32(0x08), outIdx: 1n }, claimKeyAttestationRef: b32(0x09),
});

test('an entry carries its stake point, fee preimage, lock outpoints and claim-key attestation, in its id', () => {
  assert.equal(STAKE_POINT_BYTES, COMMITMENT_BYTES, 'a stake point is not the shape of Feldman\'s A0');
  const e = lockedEntry();
  const back = decodeEntryContract(encodeEntryContract(e));
  for (const k of ['stakePoint', 'feePreimage', 'stakeLockOutpoint', 'feeLockOutpoint', 'claimKeyAttestationRef'])
    assert.deepEqual(back[k], e[k], k);
  assert.equal(toHex(encodeEntryContract(back)), toHex(encodeEntryContract(e)));

  for (const moved of [
    { stakePoint: new Uint8Array(33).fill(0x03) },
    { feePreimage: b32(0x70) },
    { stakeLockOutpoint: { txid: b32(0x08), outIdx: 2n } },
    { feeLockOutpoint: { txid: b32(0x80), outIdx: 1n } },
    { claimKeyAttestationRef: b32(0x90) },
  ]) assert.notDeepEqual(entryId({ ...e, ...moved }), entryId(e), Object.keys(moved)[0]);

  // absent is refused, never defaulted
  assert.throws(() => encodeEntryContract({ ...e, stakePoint: b32(0x02) }));
  assert.throws(() => encodeEntryContract({ ...e, stakeLockOutpoint: undefined }), /federation outpoint/);
  assert.throws(() => encodeEntryContract({ ...e, feeLockOutpoint: { txid: b32(1), outIdx: 1 } }), /BigInt/);
  assert.throws(() => encodeEntryContract({ ...e, claimKeyAttestationRef: undefined }));
});

test('a seat takes shares only if their A0 is the entry\'s stake point (F1)', () => {
  const e = lockedEntry();
  const handout = { commitments: [new Uint8Array(e.stakePoint), new Uint8Array(33).fill(0x03)] };
  assert.deepEqual(stakePointIsTheHandouts(e, handout), { ok: true });

  const other = new Uint8Array(e.stakePoint); other[32] ^= 1;
  assert.match(stakePointIsTheHandouts(e, { commitments: [other] }).why,
    /A0 is not the entry's stake point/);
  assert.match(stakePointIsTheHandouts({ ...e, stakePoint: new Uint8Array(33) }, handout).why,
    /names no stake point/);
  assert.match(stakePointIsTheHandouts(e, { commitments: [] }).why, /no constant commitment A0/);
  assert.match(stakePointIsTheHandouts({ ...e, stakePoint: undefined }, handout).why, /no 33-byte stake point/);
});
