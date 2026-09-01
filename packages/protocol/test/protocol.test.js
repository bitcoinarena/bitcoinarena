// The protocol package, tested against the properties a second implementation
// would have to reproduce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader } from '../src/encode.js';
import { taggedHash, toHex, fromHex } from '../src/hash.js';
import { TAG } from '../src/constants.js';
import { buildCensus, merkleRoot, compareEntries, leafHash } from '../src/census.js';
import { selectCommittee, weightOf, ticketFor } from '../src/sortition.js';
import { computePayoutTable, rankWeights, payingRanks, DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { encodeRoundContract, decodeRoundContract, roundId, contractWarnings } from '../src/contracts.js';

const b32 = (n) => new Uint8Array(32).fill(n);
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
  const mk = (n) => ({ txid: b32(n), vout: 0, pubkey: pk(n), bondSats: 100000n,
                       height: 800000 + n, roles: ['game'], spent: false });
  const args = { censusHeight: 900000, minConfirmations: 6, tipHeight: 900100 };
  const a = buildCensus([mk(3), mk(1), mk(2)], args);
  const b = buildCensus([mk(2), mk(3), mk(1)], args);
  assert.equal(toHex(a.root), toHex(b.root), 'input order changed the root');
});

test('immature and spent bonds are excluded', () => {
  const mk = (n, h, spent) => ({ txid: b32(n), vout: 0, pubkey: pk(n), bondSats: 100000n,
                                 height: h, roles: ['game'], spent });
  const c = buildCensus(
    [mk(1, 800000, false), mk(2, 900099, false), mk(3, 800000, true)],
    { censusHeight: 900000, minConfirmations: 6, tipHeight: 900100 });
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
      entries, committeeSeed: b32(s % 256), role: 'game', slots: 3, bondMin: 100000n });
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
  const a = selectCommittee({ entries, committeeSeed: b32(11), role: 'game', slots: 2, bondMin: 100000n });
  const b = selectCommittee({ entries, committeeSeed: b32(11), role: 'game', slots: 2, bondMin: 100000n });
  assert.deepEqual(a.map((e) => e.txid[0]), b.map((e) => e.txid[0]));
});

/* ------------------------------------------------------------------ payout */

test('rank weights are exact integers, not a float curve', () => {
  assert.deepEqual(rankWeights(4), [64n, 48n, 36n, 27n]);   // 4^3, 3*4^2, 9*4, 27
  assert.equal(payingRanks(75), 19);
  assert.equal(payingRanks(1), 1);
  assert.equal(payingRanks(0), 0);
});

test("the worked example from 18A.6 comes out at the spec's numbers", () => {
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push({ pubkey: pk(i), stakeMsat: 100000n, outcome: DELIVERED, score: 50 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(100 + i), stakeMsat: 100000n, outcome: DELIVERED, score: 900 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(200 + i), stakeMsat: 100000n, outcome: FAILED, score: 0 });

  const r = computePayoutTable({ roundId: b32(9), entries, minScore: 1 });
  assert.equal(r.pool, 2500000n);
  assert.equal(r.qualifiers, 75);
  assert.equal(r.payingRanks, 19);

  const paid = r.table.reduce((s, t) => s + t.amountMsat, 0n);
  assert.equal(paid, 10000000n, 'money was created or destroyed');
});

test('nothing is created or destroyed, remainders included', () => {
  // A pool that does not divide evenly by the weights is the case where a
  // careless implementation drops millisatoshi on the floor.
  const entries = [];
  for (let i = 0; i < 7; i++) entries.push({ pubkey: pk(i), stakeMsat: 33333n, outcome: DELIVERED, score: 100 + i });
  for (let i = 0; i < 3; i++) entries.push({ pubkey: pk(50 + i), stakeMsat: 33333n, outcome: FAILED, score: 0 });

  const r = computePayoutTable({ roundId: b32(4), entries, minScore: 1 });
  const paid = r.table.reduce((s, t) => s + t.amountMsat, 0n);
  assert.equal(paid, 10n * 33333n);
});

test('VOID entries neither contribute nor draw', () => {
  const entries = [
    { pubkey: pk(1), stakeMsat: 100000n, outcome: DELIVERED, score: 500 },
    { pubkey: pk(2), stakeMsat: 100000n, outcome: FAILED, score: 0 },
    { pubkey: pk(3), stakeMsat: 100000n, outcome: VOID, score: 0 },
  ];
  const r = computePayoutTable({ roundId: b32(1), entries, minScore: 1 });
  assert.equal(r.table.length, 2, 'a VOID entry appeared in the table');
  assert.equal(r.table.reduce((s, t) => s + t.amountMsat, 0n), 200000n);
});

test('with no qualifiers everyone keeps nothing and the pool is untouched', () => {
  const entries = [
    { pubkey: pk(1), stakeMsat: 100000n, outcome: FAILED, score: 0 },
    { pubkey: pk(2), stakeMsat: 100000n, outcome: FORFEIT, score: 0 },
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
    simCoreHash: b32(1), startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n,
    censusHeight: 964900, censusRoot: b32(2), committeeSeed: b32(3),
    stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
    exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
    timeFloor: 16384, timeCeil: 98304, minScore: 1,
    rankNumerator: 3, rankDenominator: 4,
    nodes: [b32(4), b32(7), b32(9)],
  };
}
