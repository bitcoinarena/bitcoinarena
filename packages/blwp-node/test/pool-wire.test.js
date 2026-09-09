// THE TWO SHAPES A SIGNING ROUND PUTS ON A WIRE, READ BY A NODE THAT TRUSTS
// NOTHING ABOUT THE SENDER.
//
// Both are fixed-width, which is the whole reason a stranger can read them:
// there is no length field to lie about and no framing to disagree over. What
// is checked here is that a body which is not one of these two shapes is
// REFUSED rather than half-read - a commitment list a byte short is a list
// whose last entry is somebody else's bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeUtxo, decodeUtxo, encodeCommitments, decodeCommitments,
  encodeShare, decodeShare, encodeShareRequest,
  UTXO_BYTES, COMMITMENT_BYTES, SHARE_BYTES,
} from '../src/pool-wire.js';

const b = (n, v) => new Uint8Array(n).fill(v);
const utxo = { txid: b(32, 0xab), vout: 3, value: 123456n, script: b(34, 0x51) };
const commitments = [
  { id: 1, hiding: b(33, 2), binding: b(33, 3) },
  { id: 7, hiding: b(33, 4), binding: b(33, 5) },
];

test('an output goes out and comes back the same output', () => {
  const bytes = encodeUtxo(utxo);
  assert.equal(bytes.length, UTXO_BYTES);
  assert.deepEqual(decodeUtxo(bytes), utxo);
});

test('a commitment list keeps its ids, its points and its length', () => {
  const bytes = encodeCommitments(commitments);
  assert.equal(bytes.length, commitments.length * COMMITMENT_BYTES);
  assert.deepEqual(decodeCommitments(bytes), commitments);
});

test('a list that is not a whole number of commitments is refused, not half-read', () => {
  const bytes = encodeCommitments(commitments);
  assert.throws(() => decodeCommitments(bytes.subarray(0, bytes.length - 1)),
    new RegExp(`a commitment list is a multiple of ${COMMITMENT_BYTES} bytes`));
  assert.throws(() => decodeCommitments(new Uint8Array(0)),
    new RegExp(`a commitment list is a multiple of ${COMMITMENT_BYTES} bytes`));
  // AND ONE BYTE TOO MANY IS THE SAME ANSWER. A reader that stopped at the
  // last whole commitment would sign under a list the sender did not send.
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes, 0);
  assert.throws(() => decodeCommitments(longer),
    new RegExp(`a commitment list is a multiple of ${COMMITMENT_BYTES} bytes`));
});

test('a participant id off the wire has to be one a committee could have', () => {
  const bytes = encodeCommitments([commitments[0]]);
  const zero = bytes.slice();
  zero.fill(0, 0, 32);
  assert.throws(() => decodeCommitments(zero), /not a participant this committee could have/);
  const huge = bytes.slice();
  huge.fill(0xff, 0, 32);
  assert.throws(() => decodeCommitments(huge), /not a participant this committee could have/);
});

test('a signature share is 32 bytes and nothing else is one', () => {
  assert.equal(encodeShare(99n).length, SHARE_BYTES);
  assert.equal(decodeShare(encodeShare(99n)), 99n);
  assert.throws(() => decodeShare(b(31, 0)), /a signature share is 32 bytes/);
  assert.throws(() => decodeShare('99'), /a signature share is 32 bytes/);
});

test('round two carries the output again, then the list', () => {
  const body = encodeShareRequest(utxo, commitments);
  assert.equal(body.length, UTXO_BYTES + commitments.length * COMMITMENT_BYTES);
  assert.deepEqual(decodeUtxo(body.subarray(0, UTXO_BYTES)), utxo);
  assert.deepEqual(decodeCommitments(body.subarray(UTXO_BYTES)), commitments);
});
