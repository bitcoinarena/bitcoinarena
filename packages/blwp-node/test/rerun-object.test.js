// ONE COMMITTEE SEAT'S RE-RUN OF A SUSPENDED RESULT, AND THE COUNT THAT MAKES IT AUTHORITATIVE (§13A).
//
// The object and the count are protocol (`protocol/src/rerun.js`); exercised
// here on real BIP-340 keys, because the protocol package carries no curve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import {
  encodeRerunResult, decodeRerunResult, rerunResultId, joinSignedRerun, splitSignedRerun, rerunIsAgreed, runOf,
  RERUN_BYTES, SIGNED_RERUN_BYTES,
} from '../../protocol/src/rerun.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const keys = Array.from({ length: 7 }, () => new Uint8Array(randomBytes(32)));
const seats = keys.map((k) => schnorr.getPublicKey(k));
const verify = (s, m, k) => schnorr.verify(s, m, k);
const ROUND = b32(0x31);
const PLAYER = b32(0x32);
const CONTRADICTED = b32(0x33);
const result = (over = {}) => ({
  roundId: ROUND, playerPubkey: PLAYER, outcome: 'FAILED', score: 7,
  transcriptHash: b32(0x34), simCoreHash: b32(0x35), nodePubkey: b32(0), ...over,
});
const signed = (secret, over = {}, contradictedRunId = CONTRADICTED) => {
  const x = { contradictedRunId, result: result({ ...over, nodePubkey: schnorr.getPublicKey(secret) }) };
  return { bytes: joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), secret)) };
};
const count = (records, slots = 7, onSeats = seats) => rerunIsAgreed({
  roundId: ROUND, playerPubkey: PLAYER, contradictedRunId: CONTRADICTED, records, seats: onSeats, slots, verify,
});

test('a re-run result survives the wire at a fixed size, and every field is in its id', () => {
  const x = { contradictedRunId: CONTRADICTED, result: result({ nodePubkey: seats[0] }) };
  const body = encodeRerunResult(x);
  assert.equal(body.length, RERUN_BYTES);
  assert.deepEqual(decodeRerunResult(body), x);
  for (const over of [{ contradictedRunId: b32(9) }, { result: result({ nodePubkey: seats[0], score: 8 }) },
    { result: result({ nodePubkey: seats[1] }) }])
    assert.notEqual(toHex(rerunResultId({ ...x, ...over })), toHex(rerunResultId(x)), JSON.stringify(Object.keys(over)));
  const whole = signed(keys[0]).bytes;
  assert.equal(whole.length, SIGNED_RERUN_BYTES);
  assert.throws(() => splitSignedRerun(whole.subarray(1)), /signed re-run result is/);
});

test('five seats of seven on one outcome are authoritative, four are not, and two of two is enough on a two-seat round', () => {
  const four = count(keys.slice(0, 4).map((k) => signed(k)));
  assert.equal(four.ok, false);
  assert.match(four.why, /4 of 5 committee seats have re-run/);
  const five = count(keys.slice(0, 5).map((k) => signed(k)));
  assert.equal(five.ok, true, five.why);
  assert.equal(five.agreed, 5);
  assert.equal(toHex(five.runId), toHex(runOf(result())), 'the authoritative run is the one they re-ran to');
  assert.equal(count(keys.slice(0, 2).map((k) => signed(k)), 2, seats.slice(0, 2)).ok, true);
});

test('a re-run counts once per seated seat, about this round, player and contradicted run, on one outcome, under its seat\'s signature', () => {
  const good = keys.slice(0, 4).map((k) => signed(k));
  const forged = signed(keys[4]); forged.bytes[SIGNED_RERUN_BYTES - 1] ^= 1;
  for (const [name, extra] of [
    ['a stranger', signed(new Uint8Array(randomBytes(32)))],
    ['a second re-run from a counted seat', signed(keys[0])],
    ['another contradicted run', signed(keys[4], {}, b32(0x66))],
    ['another outcome', signed(keys[4], { score: 9 })],
    ['another player', signed(keys[4], { playerPubkey: b32(0x67) })],
    ['another round', signed(keys[4], { roundId: b32(0x68) })],
    ['a signature that does not verify', forged],
    ['bytes that are no re-run', { bytes: new Uint8Array(SIGNED_RERUN_BYTES) }],
  ]) {
    const said = count([...good, extra]);
    assert.equal(said.ok, false, `${name} made the fifth re-run`);
    assert.equal(said.agreed, 4, name);
  }
  assert.equal(count([...good, signed(keys[4])]).ok, true);
});
