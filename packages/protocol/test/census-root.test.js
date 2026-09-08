// 5A.4: A CONTRACT'S CENSUS ROOT MUST BE THE ONE ITS CENSUS DERIVES TO.
//
// "The Round Contract names `census_height` and both roots. Any participant
// recomputes them; A CONTRACT WHOSE ROOTS DO NOT MATCH THE CHAIN IS INVALID
// and no honest node will issue receipts against it."
//
// Measured before this file existed: `censusRoot` was named by every Round
// Contract and read by NO CODE AT ALL - `grep` found it only in
// `contracts.js`. A round could name any thirty-two bytes and be played, which
// makes the committee whatever the round's author said it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  commitCensus, censusInputsId, censusRootMatchesRound, merkleRoot, leafHash,
} from '../src/census.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entryAt = (n, vout = 0, over = {}) => ({
  txid: b32(n), vout, pubkey: b32(n + 0x40), advertId: b32(n + 0x60), bondSats: 60000n,
  height: 900000, roles: ['game'], spent: false, ...over,
});
const entries = [entryAt(0x11), entryAt(0x12, 1), entryAt(0x13)];
const HEIGHT = 900000;
const depth = { minConfirmations: 6, tipHeight: 900010 };

const built = () => commitCensus(entries, { censusHeight: HEIGHT, ...depth });
const bound = () => censusInputsId({ censusHeight: HEIGHT, ...depth, entries });
const roundWith = (censusRoot, over = {}) => ({ censusHeight: HEIGHT, censusRoot, ...over });
const ask = (over = {}) => censusRootMatchesRound(
  roundWith(built().root), { entries, ...depth, boundTo: bound(), ...over },
);

/**
 * THE SAME ENTRIES AND HEIGHT GIVE THE SAME ROOT, which is what "any
 * participant recomputes them" rests on. Two machines cannot agree on a
 * committee if they cannot agree on this.
 */
test('the same entries at the same height derive the same root', () => {
  const a = commitCensus(entries, { censusHeight: HEIGHT, ...depth });
  const b = commitCensus([...entries].reverse(), { censusHeight: HEIGHT, ...depth });
  assert.equal(toHex(a.root), toHex(b.root),
    'the order a node happened to receive entries in must not move the root');
  assert.equal(a.entries.length, 3);

  // and it is the merkle root of the leaves, not a second arithmetic
  assert.equal(toHex(a.root), toHex(merkleRoot(a.entries.map(leafHash))));
});

test('a round that names the root its census derives to is playable', () => {
  const seen = ask();
  assert.equal(seen.ok, true, seen.why);
  assert.equal(toHex(seen.root), toHex(built().root));
  assert.equal(seen.entries, 3);
  assert.match(seen.why, /the censusRoot is the one those entries derive to/);
});

/**
 * AND ANY OTHER ROOT IS REFUSED BY NAME. A flipped bit, thirty-two zeroes, or
 * the root of a different set are all "not the one its entries derive to".
 */
test('a round naming any other root is refused, and the refusal names censusRoot', () => {
  const flipped = new Uint8Array(built().root);
  flipped[0] ^= 1;
  for (const root of [flipped, b32(0), b32(0x99),
                      commitCensus([entryAt(0x21)], { censusHeight: HEIGHT, ...depth }).root]) {
    const no = censusRootMatchesRound(roundWith(root), { entries, ...depth, boundTo: bound() });
    assert.equal(no.ok, false, toHex(root).slice(0, 8));
    assert.match(no.why, /censusRoot/, 'the refusal must name the field');
    assert.match(no.why, /is not the one its entries derive to at height 900000/);
    assert.equal(toHex(no.root), toHex(built().root), 'and it says what the root should have been');
  }
});

/**
 * THE HEIGHT IS THE CONTRACT'S. Recomputing at another height is recomputing a
 * different census, so a caller who could choose it could make an honest
 * contract look wrong.
 */
test('the census height comes off the contract, not off the asker', () => {
  const later = entries.map((e) => ({ ...e, height: HEIGHT + 5 }));
  const atLater = commitCensus(later, { censusHeight: HEIGHT + 5, ...depth, tipHeight: 900020 });

  // the same entries, a contract naming the later height and the later root
  const seen = censusRootMatchesRound(
    roundWith(atLater.root, { censusHeight: HEIGHT + 5 }),
    { entries: later, minConfirmations: 6, tipHeight: 900020,
      boundTo: censusInputsId({ censusHeight: HEIGHT + 5, minConfirmations: 6, tipHeight: 900020, entries: later }) },
  );
  assert.equal(seen.ok, true, seen.why);

  // and that same set against the ORIGINAL height's contract is refused
  const no = censusRootMatchesRound(roundWith(built().root, { censusHeight: HEIGHT }),
    { entries: later, ...depth,
      boundTo: censusInputsId({ censusHeight: HEIGHT, ...depth, entries: later }) });
  assert.equal(no.ok, false);
});

/**
 * AND THE ENTRIES CANNOT BE SWAPPED UNDER THE ROOT. A root is a function of a
 * SET and a height, so a caller free to choose the set can make any honest
 * contract look wrong by handing in a different list - the free variable row 3
 * of 5A.3 had before its inputs were bound.
 */
test('an accuser cannot swap the entries under the root', () => {
  const swapped = [...entries.slice(0, 2), entryAt(0x14)];
  const no = ask({ entries: swapped });
  assert.equal(no.slashed, undefined);
  assert.equal(no.ok, false, 'a different set was accepted under the published commitment');
  assert.match(no.why, /not the census entries that were published/);

  // dropping one is the same answer
  assert.equal(ask({ entries: entries.slice(0, 2) }).ok, false);

  // and so is changing the depth rule the set was published under
  assert.equal(ask({ minConfirmations: 1 }).ok, false);
  assert.equal(ask({ tipHeight: 900011 }).ok, false);

  for (const bad of [undefined, b32(0).slice(0, 31), 'not bytes'])
    assert.match(censusRootMatchesRound(roundWith(built().root),
      { entries, ...depth, boundTo: bad }).why, /no committed census inputs/);
});

test('the committed inputs cover the set, the height and the depth rule', () => {
  const was = toHex(bound());
  assert.notEqual(toHex(censusInputsId({ censusHeight: HEIGHT + 1, ...depth, entries })), was, 'the height');
  assert.notEqual(toHex(censusInputsId({ censusHeight: HEIGHT, ...depth, minConfirmations: 7, entries })), was, 'the depth');
  assert.notEqual(toHex(censusInputsId({ censusHeight: HEIGHT, ...depth, tipHeight: 900011, entries })), was, 'the tip');
  assert.notEqual(toHex(censusInputsId({ censusHeight: HEIGHT, ...depth, entries: [...entries, entryAt(0x14)] })), was, 'the set');
  assert.notEqual(toHex(censusInputsId({ censusHeight: HEIGHT, ...depth,
    entries: entries.map((e, i) => (i === 0 ? { ...e, spent: true } : e)) })), was, 'a spend');

  // the order the caller lists them in is NOT one of them: 5A.4 sorts by
  // outpoint, and a set is the same set however it arrived
  assert.equal(toHex(censusInputsId({ censusHeight: HEIGHT, ...depth, entries: [...entries].reverse() })), was);
});

test('a round that names no root or no height is answered, not crashed at', () => {
  for (const bad of [undefined, {}, { censusRoot: 'not bytes', censusHeight: HEIGHT },
                     { censusRoot: b32(0).slice(0, 31), censusHeight: HEIGHT }])
    assert.match(censusRootMatchesRound(bad, { entries, ...depth, boundTo: bound() }).why,
      /names no census root/);
  assert.match(censusRootMatchesRound({ censusRoot: b32(1) }, { entries, ...depth, boundTo: bound() }).why,
    /names no census height/);
  assert.match(ask({ entries: undefined }).why, /no census entries/);
});

/**
 * A CENSUS THAT CANNOT BE BUILT IS A REFUSAL, NOT AN EXCEPTION handed to
 * whoever asked whether a round may be played. `commitCensus` throws on a
 * duplicate outpoint, which is exactly what a hostile publication would carry.
 */
test('a census that cannot be built is refused with its reason', () => {
  const twice = [entryAt(0x11), entryAt(0x11)];
  const seen = censusRootMatchesRound(roundWith(b32(0x99)), {
    entries: twice, ...depth,
    boundTo: censusInputsId({ censusHeight: HEIGHT, ...depth, entries: twice }),
  });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /that census cannot be built: duplicate outpoint/);
});
