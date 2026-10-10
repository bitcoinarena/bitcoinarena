// §11 / kanban #311: the committee's signed price sample - its bytes, its id, and when an attestation stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodePriceSample, decodePriceSample, priceSampleId, priceTapeId, attestationStands, sampleTick, PRICE_TAPE_LENGTH } from '../../arena-protocol/src/price-sample.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 10); return { sk, pk: schnorr.getPublicKey(sk) }; });
const committee = seats.map((s) => s.pk);
const verify = (sig, msg, pk) => schnorr.verify(sig, msg, pk);
const sample = { roundId: b32(9), tick: 300, priceCents: 8297193 };

test('a price sample is its round, tick and price in cents; the bytes read back, and any change is another id', () => {
  assert.deepEqual(decodePriceSample(encodePriceSample(sample)), sample);
  const id = toHex(priceSampleId(sample));
  for (const other of [{ ...sample, tick: 301 }, { ...sample, priceCents: 8297194 }, { ...sample, roundId: b32(8) }])
    assert.notEqual(toHex(priceSampleId(other)), id);
  assert.throws(() => encodePriceSample({ ...sample, priceCents: 0 }), /positive number of cents/);
  assert.throws(() => encodePriceSample({ ...sample, priceCents: 1.5 }), /whole/);
  const tape = { roundId: b32(9), tick: 0, prices: Array.from({ length: PRICE_TAPE_LENGTH }, (_, i) => 8290000 + i) };
  assert.notEqual(toHex(priceTapeId(tape)), toHex(priceTapeId({ ...tape, prices: [...tape.prices.slice(1), 1] })));
  assert.throws(() => priceTapeId({ ...tape, prices: tape.prices.slice(1) }), /64 prices/);
});

test('an attestation stands at the threshold of distinct committee keys; outsiders, repeats and bad signatures count nothing', () => {
  const id = priceSampleId(sample);
  const sign = (s) => ({ key: s.pk, signature: schnorr.sign(id, s.sk) });
  assert.equal(attestationStands({ id, sigs: seats.slice(0, 5).map(sign), committee, threshold: 5, verify }).ok, true);
  const four = attestationStands({ id, sigs: seats.slice(0, 4).map(sign), committee, threshold: 5, verify });
  assert.equal(four.ok, false); assert.match(four.why, /4 of the committee signed it, 5 are needed/);
  const outsider = { sk: b32(99), pk: schnorr.getPublicKey(b32(99)) };
  assert.equal(attestationStands({ id, sigs: [...seats.slice(0, 4).map(sign), sign(outsider)], committee, threshold: 5, verify }).ok, false, 'an outsider counts nothing');
  assert.equal(attestationStands({ id, sigs: [...seats.slice(0, 4).map(sign), sign(seats[0])], committee, threshold: 5, verify }).ok, false, 'one key twice counts once');
  const wrong = { key: seats[4].pk, signature: schnorr.sign(priceSampleId({ ...sample, priceCents: 1 }), seats[4].sk) };
  assert.equal(attestationStands({ id, sigs: [...seats.slice(0, 4).map(sign), wrong], committee, threshold: 5, verify }).ok, false, 'a signature over another price counts nothing');
  const hex = seats.slice(0, 5).map(sign).map((s) => ({ key: toHex(s.key), signature: toHex(s.signature) }));
  assert.equal(attestationStands({ id, sigs: hex, committee: committee.map(toHex), threshold: 5, verify }).ok, true, 'hex works the same');
});

test('one sample every 5 s of round time: sample k at the tick 5 k seconds into the run, at the network\'s tick rate', () => {
  assert.equal(sampleTick(0), 0);
  assert.equal(sampleTick(1), 300, '5 s at 60.0147 ticks a second');
  assert.equal(sampleTick(12), 3600);
});
