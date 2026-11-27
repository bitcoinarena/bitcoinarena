// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3886: a new address is checked from outside - other seats' GET /reach-probe - before an advertisement update names it. Dead, a
// broken certificate, http only or another node: not posted, and why. A seat that holds no announcement of it yet is not a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsideCheck, checkSeats } from '../src/address-check.js';
import { createReachProbe } from '../src/reach-probe.js';

const NODE = 'ab'.repeat(32), NEW = 'https://arena.example.org', OLD = 'https://old.example.org';
const seatFetch = (bySeat) => async (u) => {
  const seat = u.slice(0, u.indexOf('/reach-probe'));
  const b = bySeat[seat];
  if (b === 'down') throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
  return new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
};
const ok = (url) => ({ ok: true, node: NODE, results: [{ url: OLD, from: ['census'], reached: false, kind: 'dns' }, { url, from: ['announced'], reached: true, ms: 120 }] });

test('two seats reach the key at the new address: ok; a dead old census address does not count against it', async () => {
  const c = await outsideCheck({ url: NEW, node: NODE, seats: ['https://s1', 'https://s2'], fetchFn: seatFetch({ 'https://s1': ok(NEW), 'https://s2': ok(`${NEW}/`) }) });
  assert.equal(c.ok, true, c.why); assert.equal(c.reached, 2); assert.equal(c.failed, 0);
});

test('dead, a broken certificate or another node at the new address: not ok, the reason said', async () => {
  const bad = (kind, status) => ({ ok: true, node: NODE, results: [{ url: NEW, from: ['announced'], reached: false, kind, ...(status ? { status } : {}) }] });
  for (const [k, says] of [['dns', /does not resolve/], ['tls', /certificate is not valid/], ['other-node', /another node/], ['timeout', /nothing answered/]]) {
    const c = await outsideCheck({ url: NEW, node: NODE, seats: ['https://s1', 'https://s2'], fetchFn: seatFetch({ 'https://s1': ok(NEW), 'https://s2': bad(k) }) });
    assert.equal(c.ok, false, k); assert.match(c.why, /1 of 2 seats could not reach/); assert.match(c.why, says);
  }
  const h = await outsideCheck({ url: 'http://203.0.113.9:8470', node: NODE, seats: ['https://s1'], fetchFn: async () => { throw new Error('never asked'); } });
  assert.equal(h.ok, false); assert.match(h.why, /not https.*mixed content/);
});

test('seats that hold no announcement of the address yet, or do not answer: unknown, not ok until two reached it', async () => {
  const c = await outsideCheck({ url: NEW, node: NODE, seats: ['https://s1', 'https://s2', 'https://s3'],
    fetchFn: seatFetch({ 'https://s1': ok(NEW), 'https://s2': { ok: true, node: NODE, results: [{ url: OLD, from: ['census'], reached: true }] }, 'https://s3': 'down' }) });
  assert.equal(c.ok, false); assert.equal(c.unknown, 2); assert.match(c.why, /1 of 3 seats reached .*checked again in 10 min/);
  assert.equal((await outsideCheck({ url: NEW, node: NODE, seats: [] })).ok, false);
});

test('checkSeats: other nodes\' https census endpoints, never this node, each once, at most 3, rotated by the seed', () => {
  const e = (k, endpoint) => ({ pubkey: k.repeat(32), advert: { endpoint } });
  const entries = [e('ab', NEW), e('01', 'https://a.example'), e('02', 'https://a.example/'), e('03', 'http://b.example:8470'), e('04', 'https://c.example'), e('05', 'https://d.example'), e('06', 'https://e.example')];
  assert.deepEqual(checkSeats({ entries, ownKey: NODE, most: 3 }), ['https://a.example', 'https://c.example', 'https://d.example']);
  assert.deepEqual(checkSeats({ entries, ownKey: NODE, most: 3, seed: 1 }), ['https://c.example', 'https://d.example', 'https://e.example']);
  assert.equal(checkSeats({ entries, ownKey: NODE }).length, 4, 'all four other https seats (at most 5 since #3890)');
});

test('against the real door: a seat holding the announcement of the new address answers it, the check reads that', async () => {
  const door = createReachProbe({ targetsOf: () => ({ census: [OLD], announced: NEW }),
    probe: async (u) => (u === NEW ? { reached: true, ms: 50 } : { reached: false, ms: 9, kind: 'dns' }) });
  const fetchFn = async (u) => { const r = await door({ headers: {}, socket: { remoteAddress: '198.51.100.7' } }, new URL(u).searchParams.get('node')); return new Response(JSON.stringify(r.body), { status: r.status }); };
  const c = await outsideCheck({ url: NEW, node: NODE, seats: ['https://s1', 'https://s2'], fetchFn });
  assert.equal(c.ok, true, c.why);
});
