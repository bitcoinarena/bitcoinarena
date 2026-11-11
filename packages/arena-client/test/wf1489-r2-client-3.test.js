// kanban #1489 round 2: GET /stake-lock is asked of every seat by findLock (lookOwed, refundStake, redeemStake). One seat answering
// thousands of made-up locks (distinct outpoints/entry ids under the player's refund key) is kept whole: every one is then asked a
// forfeit of every seat in turn (redeemStake) or a lockStatus of the federation (heldByGuardians) - the collect stalls for hours.
// Safe: what one seat can add to the list is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLock } from '../src/page-lock.js';

test('one seat listing 5000 made-up locks does not hand 5000 locks to the collect', async () => {
  const roundId = new Uint8Array(32).fill(3);
  const fake = (i) => ({ outpoint: `${i.toString(16).padStart(64, '0')}:0`, entryId: i.toString(16).padStart(64, '0'),
    fields: { paymentImage: { kind: 'hash', bytes: '11'.repeat(32) }, amountMsat: '1000', claimPk: '02' + '22'.repeat(32), refundPk: '02' + '33'.repeat(32), expiration: 100 } });
  const flood = Array.from({ length: 5000 }, (_, i) => fake(i + 1));
  const fetcher = async (url) => {
    const evil = url.startsWith('http://evil');
    return { ok: true, status: 200, json: async () => (evil ? flood : []), text: async () => '' };
  };
  const got = await findLock({ roundId, playerPubkey: new Uint8Array(33).fill(2), nodes: ['http://a', 'http://b', 'http://evil'], fetcher });
  assert.ok(got.length <= 64, `one seat put ${got.length} locks on the player's collect list`);
});
