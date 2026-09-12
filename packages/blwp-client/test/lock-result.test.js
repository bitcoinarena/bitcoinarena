// THE LOCK CLIENT'S ANSWER, READ INTO AN ENTRY'S OUTPOINT AND A SEAT'S CONTRACT (W1a glue).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockFromClient } from '../src/lock-result.js';
import { toHex } from '../../protocol/src/hash.js';

const b = (n, len) => new Uint8Array(len).fill(n);
const KEYS = { point: b(2, 33), claimPk: b(3, 33), refundPk: b(2, 33) };
const answer = (over = {}) => ({
  txid: 'ab'.repeat(32), out_idx: 0, block_count_at_lock: 306, expiry_delta: 150,
  computed_contract_id: 'cd'.repeat(32), computed_expiration: 456, stored_contract_id: 'cd'.repeat(32),
  stored_blocks_left: 150, block_count_at_read: 306, stored_expiration: 456, ids_match: true, amount_msat: 980000, ...over,
});

test('an answer whose stored contract is the one built gives the entry its outpoint and the seat its contract', () => {
  const got = lockFromClient(JSON.stringify(answer()), KEYS);
  assert.equal(toHex(got.outpoint.txid), 'ab'.repeat(32));
  assert.equal(got.outpoint.outIdx, 0n);
  assert.deepEqual({ ...got.fields, paymentImage: { kind: got.fields.paymentImage.kind, bytes: toHex(got.fields.paymentImage.bytes) } },
    { paymentImage: { kind: 'point', bytes: '02'.repeat(33) }, amountMsat: 980000n, claimPk: KEYS.claimPk, refundPk: KEYS.refundPk, expiration: 456 });
  assert.equal(got.contractId, 'cd'.repeat(32));
});

test('an answer whose guardians hold another contract, or another expiry, or that names no outpoint, is refused', () => {
  assert.throws(() => lockFromClient(answer({ ids_match: false, stored_contract_id: 'ee'.repeat(32) }), KEYS), /another contract at that outpoint/);
  assert.throws(() => lockFromClient(answer({ stored_expiration: 455 }), KEYS), /hold expiration 455, and the lock client built 456/);
  assert.throws(() => lockFromClient(answer({ txid: 'nope' }), KEYS), /named no transaction/);
  assert.throws(() => lockFromClient(answer({ out_idx: -1 }), KEYS), /named no output/);
});
