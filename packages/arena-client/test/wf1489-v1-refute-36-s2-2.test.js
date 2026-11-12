// kanban #1489 / #1531 skeptic 2: one operator behind one reverse proxy names 64 path-prefixed "seats" (https://evil.example/s0 ..
// /s63 - distinct sources by joinQuery's own sourceKey rule) ahead of the honest seats in a shared join link. Round-robin gives each
// "seat" a slot in round 0 and LOCKS_FOUND_MAX stops at 64: only the operator's made-up locks reach refundStake / redeemStake, and the
// player's real lock, named by every honest seat, is never collected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLock } from '../src/page-lock.js';

const fields = (b) => ({ paymentImage: { kind: 'hash', bytes: '11'.repeat(32) }, amountMsat: '1000', claimPk: '02' + b.repeat(32), refundPk: '02' + '33'.repeat(32), expiration: 100 });
const real = { outpoint: `${'ab'.repeat(32)}:0`, entryId: 'cd'.repeat(32), fields: fields('22') };

test('64 path-prefixed seats of one operator do not push the honest lock off the list', async () => {
  const roundId = new Uint8Array(32).fill(3);
  const fetcher = async (url) => {
    const m = /^https:\/\/evil\.example\/s(\d+)\//.exec(url);
    const body = m ? [{ outpoint: `${(Number(m[1]) + 1).toString(16).padStart(64, '0')}:0`, entryId: 'ee'.repeat(32), fields: fields('44') }] : [real];
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  const evil = Array.from({ length: 64 }, (_, i) => `https://evil.example/s${i}`);
  const honest = Array.from({ length: 14 }, (_, i) => `https://seat${i}.example`);
  const got = await findLock({ roundId, playerPubkey: new Uint8Array(33).fill(2), nodes: [...evil, ...honest], fetcher });
  const has = got.some((l) => Buffer.from(l.outpoint.txid).toString('hex') === 'ab'.repeat(32));
  assert.ok(has, `14 honest seats name the real lock and it is dropped; ${got.length} locks kept`);
});
