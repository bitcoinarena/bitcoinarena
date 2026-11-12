// kanban #1700 (#1531 refute, #1489): the page runs findLock from dist/arena-client.js, not from src. The same flood through the
// bundle and through the module must keep the same locks, or a fix merged into src never reached the player's collect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { findLock, LOCKS_FOUND_MAX } from '../src/page-lock.js';
const BUNDLE = createRequire(import.meta.url)('../dist/arena-client.js');
const TEMPLATE = createRequire(import.meta.url)('../../../src/arena-ui/arena-client.js');

const roundId = new Uint8Array(32).fill(3);
const playerPubkey = new Uint8Array(33).fill(2);
const fake = (i, tag = '11') => ({ outpoint: `${i.toString(16).padStart(64, '0')}:0`, entryId: i.toString(16).padStart(64, '0'),
  fields: { paymentImage: { kind: 'hash', bytes: tag.repeat(32) }, amountMsat: '1000', claimPk: '02' + '22'.repeat(32), refundPk: '02' + '33'.repeat(32), expiration: 100 } });
const real = fake(0xabc, '44');
const flood = Array.from({ length: 5000 }, (_, i) => fake(i + 1));
const fetcher = async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith('http://evil') ? flood : [real]), text: async () => '' });
const nodes = ['http://evil', 'http://a', 'http://b', 'http://evil2'];

test('findLock on a 5000-lock flood: the bundle, the WebGL template copy and the src module keep the same locks', async () => {
  const want = await findLock({ roundId, playerPubkey, nodes, fetcher });
  assert.ok(want.length <= LOCKS_FOUND_MAX, `src kept ${want.length}`);
  for (const [name, client] of [['dist/arena-client.js', BUNDLE], ['src/arena-ui/arena-client.js', TEMPLATE]]) {
    const got = await client.findLock({ roundId, playerPubkey, nodes, fetcher });
    assert.equal(got.length, want.length, `${name} kept ${got.length} locks, src ${want.length}: the bundle is not the build of src`);
    assert.deepEqual(got.map((l) => l.entryId), want.map((l) => l.entryId), `${name} keeps other locks than src`);
    assert.ok(got.some((l) => l.entryId === real.entryId), `${name}: the honest seat's lock was pushed out`);
  }
});
