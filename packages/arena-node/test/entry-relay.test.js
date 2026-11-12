// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SEAT HANDS ON, AND TO WHOM (kanban #1068).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntryRelay, RELAY_HEADER, lookAtMembers, seatView } from '../src/entry-relay.js';

const stub = (doors) => {
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url), key = `${init.method || 'GET'} ${u.origin}${u.pathname}`;
    asked.push({ key, relayed: init.headers && init.headers[RELAY_HEADER] });
    const a = doors(key);
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status ?? a });   // a real body: handLocks reads it capped (kanban #2327)
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

// WHO IS IN THE ROUND (kanban #1071, §17): seven seats, this one and six peers, 5 of 7
const E = 'e1'.repeat(32), F = 'f2'.repeat(32);
const look = (views, { held = [], take = async () => ({ ok: true }), players = 2 } = {}) => {
  const voided = [], asked = [];
  return lookAtMembers({ roundId: new Uint8Array(32), roundHex: '00'.repeat(32), peers: views.map((_, i) => `http://p${i}`), slots: 7, needed: 5, players, held: new Set(held),
    viewOf: async (base) => { const v = views[Number(base.slice(8))]; if (!v) throw new Error('down'); return new Set(v); },
    take: async (r, e, from) => { asked.push({ e, from }); return take(r, e, from); }, voidEntry: async (r, e) => { voided.push(e); } }).then((got) => ({ ...got, voidedHere: voided, asked }));
};

test('a seat short of an entry asks only the peers that hold it, and waits until it is taken', async () => {
  const got = await look([[E, F], [E, F], [E, F], [E, F], [E, F], null], { held: [E], take: async () => ({ ok: false, why: '4 of 5 seats signed a result naming it' }) });
  assert.match(got.wait, /4 of 5/);
  assert.deepEqual(got.asked, [{ e: F, from: ['http://p0', 'http://p1', 'http://p2', 'http://p3', 'http://p4'] }]);
  assert.deepEqual(got.voidedHere, []);
  assert.equal((await look([[E, F], [E, F], [E, F], [E, F], [E, F], null], { held: [E] })).wait, null);
});

test('an entry three seats lack can never reach five: void where held, not taken where lacked, and silent seats do not count as lacking', async () => {
  const lacks = await look([[E, F], [E, F], [E, F], [E], [E], [E]], { held: [E, F] });
  assert.deepEqual(lacks.voidedHere, [F]);
  assert.equal(lacks.wait, null);
  const short = await look([[E, F], [E, F], [E, F], [E, F], [E], [E]], { held: [E] });
  assert.deepEqual(short.asked, []);
  assert.equal(short.wait, null);
  const silent = await look([[E, F], [E, F], [E], null, null, null], { held: [E, F] });
  assert.deepEqual(silent.voidedHere, []);
});

test('a seat alone with an entry signs nothing while too few seats answered to rule another out; three answers rule it out', async () => {
  assert.match((await look([[E], null, null, null, null, null], { held: [E] })).wait, /2 of 7 seats answered/);
  assert.equal((await look([[E], [E], null, null, null, null], { held: [E] })).wait, null);
  assert.equal((await look([null, null, null, null, null, null], { held: [] })).wait, null, 'a seat holding nothing has nothing to wait for');
});

test('a peer\'s view is a list of entries; a peer that holds no such round holds none of it, and one that fails did not answer', async () => {
  const fetcher = async (url) => (url.includes('//gone') ? { status: 404, ok: false } : url.includes('//bad') ? { status: 503, ok: false } : new Response(JSON.stringify({ players: [{ entry: E }] }), { status: 200 }));
  const view = seatView(fetcher);
  assert.deepEqual([...(await view('http://here', 'ab'))], [E]);
  assert.equal((await view('http://gone', 'ab')).size, 0);
  await assert.rejects(view('http://bad', 'ab'));
});
