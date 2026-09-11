// ONE SEAT'S WORD THAT IT POSTED A RUN'S TRANSCRIPT, AND THE COUNT THAT MAKES A RESULT REPLAYABLE (P2).
//
// v4.6.2 §13A: FINAL needs the round's threshold of settlement seats to have
// retrieved the canonical transcript and posted it to `publication_relays[]`.
// The object and the count are protocol (`protocol/src/posting.js`); they are
// exercised here, on real BIP-340 keys, because the protocol package carries no
// curve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import {
  encodeTranscriptPosting, decodeTranscriptPosting, transcriptPostingId, joinSignedPosting, splitSignedPosting,
  transcriptIsPublished, transcriptBytesHash, relayPath, POSTING_BYTES, SIGNED_POSTING_BYTES,
} from '../../protocol/src/posting.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const keys = Array.from({ length: 7 }, () => new Uint8Array(randomBytes(32)));
const seats = keys.map((k) => schnorr.getPublicKey(k));
const verify = (s, m, k) => schnorr.verify(s, m, k);
const ROUND = b32(0x21);
const PLAYER = b32(0x22);
const HASH = b32(0x23);

const signed = (secret, over = {}) => {
  const p = { roundId: ROUND, playerPubkey: PLAYER, transcriptHash: HASH, seatPubkey: schnorr.getPublicKey(secret), ...over };
  return joinSignedPosting(encodeTranscriptPosting(p), schnorr.sign(transcriptPostingId(p), secret));
};
const count = (postings, settlementSlots = 7, onSeats = seats) => transcriptIsPublished({
  roundId: ROUND, playerPubkey: PLAYER, transcriptHash: HASH, postings, seats: onSeats, settlementSlots, verify,
});
const at = (bytes, seenMs) => ({ bytes, seenMs });

test('a posting survives the wire at a fixed size, and every field is in its id', () => {
  const p = { roundId: ROUND, playerPubkey: PLAYER, transcriptHash: HASH, seatPubkey: seats[0] };
  const bytes = encodeTranscriptPosting(p);
  assert.equal(bytes.length, POSTING_BYTES);
  assert.deepEqual(decodeTranscriptPosting(bytes), p);
  for (const over of [{ roundId: b32(9) }, { playerPubkey: b32(9) }, { transcriptHash: b32(9) }, { seatPubkey: seats[1] }])
    assert.notEqual(toHex(transcriptPostingId({ ...p, ...over })), toHex(transcriptPostingId(p)), JSON.stringify(Object.keys(over)));
  const whole = signed(keys[0]);
  assert.equal(whole.length, SIGNED_POSTING_BYTES);
  assert.deepEqual(decodeTranscriptPosting(splitSignedPosting(whole).body), p);
  assert.throws(() => splitSignedPosting(whole.subarray(1)), /signed posting is/);
  assert.equal(relayPath(HASH), `/transcript/${toHex(HASH)}`);
  assert.equal(transcriptBytesHash(new Uint8Array([1, 2, 3])).length, 32);
});

test('five seats of seven make it published, four do not, and the fifth\'s arrival is where the window opens', () => {
  const four = count(keys.slice(0, 4).map((k, i) => at(signed(k), 1000 + i)));
  assert.equal(four.ok, false);
  assert.equal(four.posted, 4);
  assert.match(four.why, /4 of 5 settlement seats have posted/);
  const five = count(keys.slice(0, 5).map((k, i) => at(signed(k), [5000, 1000, 4000, 2000, 3000][i])));
  assert.equal(five.ok, true, five.why);
  assert.equal(five.atMs, 5000, 'the window opens when the fifth posting arrived, not the first');
  const two = count(keys.slice(0, 2).map((k) => at(signed(k), 7)), 2, seats.slice(0, 2));
  assert.equal(two.ok, true, 'a two-seat round is published at 2 of 2');
});

test('a posting counts once per seated seat, about this run and this transcript, and only with its seat\'s signature', () => {
  const stranger = new Uint8Array(randomBytes(32));
  const good = keys.slice(0, 4).map((k) => at(signed(k), 1));
  const forged = signed(keys[4]); forged[SIGNED_POSTING_BYTES - 1] ^= 1;
  for (const [name, extra] of [
    ['a stranger', at(signed(stranger), 1)],
    ['a second posting from a counted seat', at(signed(keys[0]), 1)],
    ['another transcript', at(signed(keys[4], { transcriptHash: b32(0x99) }), 1)],
    ['another player', at(signed(keys[4], { playerPubkey: b32(0x98) }), 1)],
    ['another round', at(signed(keys[4], { roundId: b32(0x97) }), 1)],
    ['a signature that does not verify', at(forged, 1)],
    ['bytes that are no posting', at(new Uint8Array(SIGNED_POSTING_BYTES), 1)],
  ]) {
    const said = count([...good, extra]);
    assert.equal(said.ok, false, `${name} made the fifth posting`);
    assert.equal(said.posted, 4, name);
  }
  assert.equal(count([...good, at(signed(keys[4]), 1)]).ok, true);
  assert.match(transcriptIsPublished({ roundId: ROUND, playerPubkey: PLAYER, transcriptHash: HASH, postings: [], seats, settlementSlots: 7 }).why,
    /needs a verifier/);
});
