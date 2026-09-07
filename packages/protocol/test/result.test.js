// A PLAYER RESULT, SECTION 13.
//
// "Each committee node independently replays the player's canonical transcript
// and signs: PlayerResult { round_id, player_pubkey, result, score,
// transcript_hash, sim_wasm_hash, node_pubkey, signature }. Once 5-of-7 nodes
// sign the identical result, the result becomes PROVISIONALLY_FINAL."
//
// The object, its id, its signature and the arithmetic. NOT the replay that
// produces it, not the objection window, not a live committee - the same shape
// CheckpointReceipt was built in, and stated as such rather than passed off as
// finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey,
} from 'node:crypto';

import {
  encodePlayerResult, decodePlayerResult, resultId, joinSignedResult,
  splitSignedResult, provisionallyFinal, OUTCOMES, RESULTS_FOR_FINAL,
  RESULT_BYTES, SIGNED_RESULT_BYTES,
} from '../src/result.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);

// NODE'S OWN Ed25519, not a vendored curve and not a new dependency: this
// package declares almost none on purpose, and a test that added one to check
// a signature would have put a curve in the money path's own package.
const b64url = (u8) => Buffer.from(u8).toString('base64url');
const keypair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, pubkey: new Uint8Array(raw) };
};
const signWith = (key, msg) => new Uint8Array(nodeSign(null, Buffer.from(msg), key));
const verifyWith = (pubkey, msg, sig) => nodeVerify(null, Buffer.from(msg),
  createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(pubkey) }, format: 'jwk' }),
  Buffer.from(sig));

const node = keypair();
const nodeKey = node.pubkey;

const result = (over = {}) => ({
  roundId: b32(1), playerPubkey: b32(2), outcome: DELIVERED, score: 1200,
  transcriptHash: b32(3), simCoreHash: b32(4), nodePubkey: nodeKey, ...over,
});

test('a result survives the wire unchanged, and its id is the tagged hash', () => {
  const r = result();
  assert.deepEqual(decodePlayerResult(encodePlayerResult(r)), r);
  assert.equal(resultId(r).length, 32);

  // the size is fixed and checked against a real encoding, not against a
  // number written down beside it - the first one written down was wrong
  assert.equal(encodePlayerResult(r).length, RESULT_BYTES);
  assert.equal(SIGNED_RESULT_BYTES, RESULT_BYTES + 64);

  // every field is covered: change any one and the id moves
  const moved = [
    { roundId: b32(9) }, { playerPubkey: b32(9) }, { outcome: FAILED },
    { score: 1201 }, { transcriptHash: b32(9) }, { simCoreHash: b32(9) },
    { nodePubkey: b32(9) },
  ];
  for (const over of moved) {
    assert.notEqual(toHex(resultId(result(over))), toHex(resultId(r)), JSON.stringify(over));
  }
  assert.throws(() => decodePlayerResult(encodePlayerResult(r).slice(0, 20)));
});

/**
 * THE FOUR WORDS ARE THE PAYOUT TABLE'S. No fifth is added: a synonym would be
 * a second word for one fate and a second place to get it wrong.
 */
test('the outcome is one of the four the payout table already reads', () => {
  assert.deepEqual(OUTCOMES, [DELIVERED, FAILED, FORFEIT, VOID]);
  for (const outcome of OUTCOMES) {
    assert.equal(decodePlayerResult(encodePlayerResult(result({ outcome }))).outcome, outcome);
  }
  assert.throws(() => encodePlayerResult(result({ outcome: 'PLAYER_LOST' })),
    /PLAYER_LOST is not one of DELIVERED, FAILED, FORFEIT, VOID/);
  assert.throws(() => encodePlayerResult(result({ outcome: 'WON' })), /is not one of/);
});

/**
 * A STRANGER CAN CHECK IT, which is the whole point of signing the tagged id
 * rather than the encoding: a signature here can never be replayed as one over
 * another object that happens to encode the same way.
 */
test('one node signs it and anybody can verify, and a tampered result cannot', () => {
  const r = result();
  const signed = joinSignedResult(encodePlayerResult(r), signWith(node.privateKey, resultId(r)));
  assert.equal(signed.length, SIGNED_RESULT_BYTES);

  const { body, signature } = splitSignedResult(signed);
  const back = decodePlayerResult(body);
  assert.deepEqual(back, r);
  assert.equal(verifyWith(back.nodePubkey, resultId(back), signature), true);

  // the score raised after signing
  const raised = { ...back, score: 9999 };
  assert.equal(verifyWith(raised.nodePubkey, resultId(raised), signature), false);

  // the outcome turned into a win
  const won = { ...back, outcome: DELIVERED, transcriptHash: b32(9) };
  assert.equal(verifyWith(won.nodePubkey, resultId(won), signature), false);

  // somebody else's signature on an honest result
  const stranger = keypair();
  const forged = joinSignedResult(encodePlayerResult(r), signWith(stranger.privateKey, resultId(r)));
  const split = splitSignedResult(forged);
  assert.equal(verifyWith(r.nodePubkey, resultId(r), split.signature), false);
});

/**
 * FIVE OF SEVEN ON THE IDENTICAL RESULT. Not five signatures about a player -
 * five distinct nodes on ONE id. Two nodes signing different results are a
 * disagreement, and adding them together would turn that into finality.
 */
test('five distinct nodes on the same result, and not five on different ones', () => {
  assert.equal(RESULTS_FOR_FINAL, 5);
  const agreed = resultId(result());
  const other = resultId(result({ score: 7 }));
  const key = (n) => b32(n);

  const four = [1, 2, 3, 4].map((n) => ({ resultId: agreed, nodePubkey: key(n) }));
  assert.equal(provisionallyFinal(four).final, false);
  assert.match(provisionallyFinal(four).why, /4 of 5 on the strongest result/);

  const five = [...four, { resultId: agreed, nodePubkey: key(5) }];
  assert.equal(provisionallyFinal(five).final, true);
  assert.equal(provisionallyFinal(five).signers, 5);
  assert.match(provisionallyFinal(five).why, /PROVISIONALLY_FINAL/);

  // one node saying it five times is one node
  const shouting = [1, 1, 1, 1, 1].map(() => ({ resultId: agreed, nodePubkey: key(1) }));
  assert.equal(provisionallyFinal(shouting).final, false);
  assert.equal(provisionallyFinal(shouting).signers, 1);

  // a committee split three and four ways is not final at seven signatures
  const split = [
    ...[1, 2, 3].map((n) => ({ resultId: agreed, nodePubkey: key(n) })),
    ...[4, 5, 6, 7].map((n) => ({ resultId: other, nodePubkey: key(n) })),
  ];
  const seen = provisionallyFinal(split);
  assert.equal(seen.final, false, 'a split committee was called final');
  assert.equal(seen.signers, 4, 'the strongest side is four, not seven');

  assert.equal(provisionallyFinal([]).final, false);
  assert.match(provisionallyFinal([]).why, /nobody has signed a result/);
});
