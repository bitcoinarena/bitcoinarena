// kanban #1489 / #1531 skeptic 3: seatBaseOf (kanban #1876) folds trailing slashes, but a node-list spelling with a fragment
// ("http://evil#1", "http://evil#2", ...) is not taken as a URL base: it falls back to its own raw string, so each spelling is its own
// "origin". fetch drops the fragment - all 64 hit the one seat http://evil/ - yet each takes its own LOCKS_PER_SEAT budget, and the
// made-up locks each named by 8 such "origins" outrank the real lock two honest seats name: LOCKS_FOUND_MAX cuts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLock } from '../src/page-lock.js';

const fields = (b) => ({ paymentImage: { kind: 'hash', bytes: '11'.repeat(32) }, amountMsat: '1000', claimPk: '02' + b.repeat(32), refundPk: '02' + '33'.repeat(32), expiration: 100 });
const real = { outpoint: `${'ab'.repeat(32)}:0`, entryId: 'cd'.repeat(32), fields: fields('22') };
const fake = (n) => ({ outpoint: `${(n + 1).toString(16).padStart(64, '0')}:0`, entryId: (n + 1).toString(16).padStart(64, '0'), fields: fields('44') });

test('one seat under 64 fragment spellings of its URL does not push the honest seats\' lock off the list', async () => {
  const roundId = new Uint8Array(32).fill(3);
  const hosts = new Set();
  const fetcher = async (url) => {
    const m = /^http:\/\/evil#(\d+)\//.exec(url);
    if (m) hosts.add(new URL(url).host);
    const i = m ? Number(m[1]) : -1;
    const body = m ? Array.from({ length: 8 }, (_, k) => fake((i % 8) * 8 + k)) : [real];
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  const spellings = Array.from({ length: 64 }, (_, i) => `http://evil#${i}`);
  const got = await findLock({ roundId, playerPubkey: new Uint8Array(33).fill(2), nodes: [...spellings, 'http://a', 'http://b'], fetcher });
  assert.deepEqual([...hosts], ['evil'], 'all 64 spellings are one seat');
  const has = got.some((l) => Buffer.from(l.outpoint.txid).toString('hex') === 'ab'.repeat(32));
  assert.ok(has, `the real lock both honest seats name is gone; ${got.length} locks kept, all one seat's`);
});
