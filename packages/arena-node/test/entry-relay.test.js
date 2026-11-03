// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SEAT HANDS ON, AND TO WHOM (kanban #1068).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntryRelay, RELAY_HEADER } from '../src/entry-relay.js';

const stub = (doors) => {
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url), key = `${init.method || 'GET'} ${u.origin}${u.pathname}`;
    asked.push({ key, relayed: init.headers && init.headers[RELAY_HEADER] });
    const a = doors(key);
    return { status: a.status ?? a, json: async () => a.body };
  };
  return { asked, fetcher };
};
const settle = () => new Promise((r) => setTimeout(r, 60));
const relay = (fetcher, more = {}) => createEntryRelay({ peersOf: () => ['http://a/', 'http://b'], entryOf: () => new Uint8Array([1]), handoutOf: () => new Uint8Array([2]),
  locksOf: () => ({ stake: { s: 1 }, fee: { f: 1 } }), fetcher, log: () => {}, afterMs: 0, spreadMs: 0, lockAfterMs: 0, againMs: 5, ...more });

test('the handout then the entry go only to the seat that does not hold the entry, marked as a seat\'s copy', async () => {
  const { asked, fetcher } = stub((k) => (k === 'GET http://a/entry' ? 200 : k === 'GET http://b/entry' ? 404 : 201));
  relay(fetcher).entryTaken(new Uint8Array(32), 'ab'.repeat(32), Date.now() + 60000);
  await settle();
  assert.deepEqual(asked.filter((x) => x.key.startsWith('POST')).map((x) => [x.key, x.relayed]), [['POST http://b/handout', '1'], ['POST http://b/entry', '1']]);
  assert.ok(!asked.some((x) => x.key.startsWith('POST http://a')));
});

test('an entry is handed on once, and at once when entry close is near: the seats\' doors shut there', async () => {
  const { asked, fetcher } = stub((k) => (k.endsWith('/entry') && k.startsWith('GET') ? 404 : 201));
  const r = relay(fetcher, { afterMs: 10000 });
  r.entryTaken(new Uint8Array(32), 'cd'.repeat(32), Date.now() + 100);
  r.entryTaken(new Uint8Array(32), 'cd'.repeat(32), Date.now() + 100);
  await settle();
  assert.equal(asked.filter((x) => x.key === 'POST http://b/entry').length, 1);
});

test('only the lock a seat lacks is handed on, and a seat still without the entry is asked again', async () => {
  let tries = 0;
  const { asked, fetcher } = stub((k) => {
    if (k === 'GET http://a/order-locks') return { status: 200, body: { stake: { s: 1 }, fee: null } };
    if (k === 'GET http://b/order-locks') return 404;
    if (k === 'POST http://b/lock') return ++tries === 1 ? 404 : 201;
    return 201;
  });
  relay(fetcher).lockTaken(new Uint8Array(32), 'ef'.repeat(32));
  await settle();
  const posts = asked.filter((x) => x.key.startsWith('POST')).map((x) => x.key);
  assert.deepEqual(posts.filter((x) => x.includes('//a/')), ['POST http://a/fee-lock']);
  assert.equal(posts.filter((x) => x === 'POST http://b/lock').length, 2);
});

test('a seat that does not answer costs nothing: no throw, the other seat is still handed it', async () => {
  const { asked, fetcher } = stub((k) => { if (k.includes('//a/')) throw new Error('fetch failed'); return k.startsWith('GET') ? 404 : 201; });
  relay(fetcher).entryTaken(new Uint8Array(32), '12'.repeat(32), Date.now() + 60000);
  await settle();
  assert.ok(asked.some((x) => x.key === 'POST http://b/entry'));
});
