// kanban #1531 refute: the page ships dist/arena-client.js (tools/bundle.js), not src. One seat's 5000 made-up locks through the bundle's findLock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const ARENACLIENT = createRequire(import.meta.url)('../dist/arena-client.js');

test('the shipped bundle: one seat listing 5000 made-up locks does not hand 5000 locks to the collect', async () => {
  const roundId = new Uint8Array(32).fill(3);
  const fake = (i) => ({ outpoint: `${i.toString(16).padStart(64, '0')}:0`, entryId: i.toString(16).padStart(64, '0'),
    fields: { paymentImage: { kind: 'hash', bytes: '11'.repeat(32) }, amountMsat: '1000', claimPk: '02' + '22'.repeat(32), refundPk: '02' + '33'.repeat(32), expiration: 100 } });
  const flood = Array.from({ length: 5000 }, (_, i) => fake(i + 1));
  const fetcher = async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith('http://evil') ? flood : []), text: async () => '' });
  const got = await ARENACLIENT.findLock({ roundId, playerPubkey: new Uint8Array(33).fill(2), nodes: ['http://a', 'http://b', 'http://evil'], fetcher });
  assert.ok(got.length <= 64, `the shipped bundle put ${got.length} locks on the player's collect list`);
});
