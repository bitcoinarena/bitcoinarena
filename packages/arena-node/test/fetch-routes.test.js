// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #348: the seat's own fetches routed to the direct address and capped per origin (measured: 770-910 HTTPS connections per
// seat to its own host's Tailscale address, 4,589 to the test host through the fed2 forwarder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutes, routed, cappedFetch } from '../src/fetch-routes.js';

test('a public URL is fetched at its direct address, the longest prefix first, at a path boundary only', () => {
  const r = parseRoutes('https://b.ts.net/guardian-1=http://127.0.0.1:31221, https://b.ts.net/fed2-1=http://198.51.100.7:6221/,https://b.ts.net/guardian-1x=http://x');
  assert.equal(routed('https://b.ts.net/guardian-1/rounds?next=2', r), 'http://127.0.0.1:31221/rounds?next=2');
  assert.equal(routed('https://b.ts.net/fed2-1/identity', r), 'http://198.51.100.7:6221/identity');
  assert.equal(routed('https://b.ts.net/guardian-1x/a', r), 'http://x/a', 'the longest prefix');
  assert.equal(routed('https://b.ts.net/guardian-12/a', r), 'https://b.ts.net/guardian-12/a', 'not a path boundary: unrouted');
  assert.equal(routed('https://other.example/a', r), 'https://other.example/a');
});

test('at most N requests in flight per origin; the rest wait; another origin is not held up; no signal gets a timeout', async () => {
  let live = 0, most = 0; const seen = [];
  const inner = async (url, opts) => { seen.push([url, !!opts.signal]); live++; most = Math.max(most, live); await new Promise((r) => setTimeout(r, 20)); live--; return { ok: true, url }; };
  const f = cappedFetch(inner, { routes: parseRoutes('https://b.ts.net/fed2-1=http://mac:6221'), maxPerOrigin: 3, timeoutMs: 1000 });
  const t0 = Date.now();
  const got = await Promise.all(Array.from({ length: 12 }, (_, i) => f(`https://b.ts.net/fed2-1/r${i}`)));
  const ms = Date.now() - t0;
  console.log('  CAP:', JSON.stringify({ requests: 12, maxInFlight: most, ms, first: got[0].url }));
  assert.equal(most, 3, 'never more than 3 at once to one origin');
  assert.ok(ms >= 80, '12 requests at 3 at a time take at least 4 rounds of 20 ms');
  assert.ok(seen.every(([u, sig]) => u.startsWith('http://mac:6221/') && sig), 'routed, and each with a timeout signal');
  most = 0;
  await Promise.all([...Array.from({ length: 3 }, () => f('http://a/x')), ...Array.from({ length: 3 }, () => f('http://b/x'))]);
  assert.equal(most, 6, 'two origins, 3 each at once');
});

// ONE LANE PER SEAT, AND A WAITING CALL KEEPS ITS DEADLINE (kanban #348, measured 2026-10-13 ~20:45Z: seven seats behind one host shared
// 8 slots, and a 5 s call queued behind 30 s ones without bound - a test host seat's seating agent stopped signing PRESENTs)
test('seats behind one host have a lane each; a queued call is aborted by its own signal while it waits', async () => {
  const pending = [];
  const inner = (url, opts) => new Promise((ok, no) => { pending.push({ url, ok }); if (opts && opts.signal) opts.signal.addEventListener('abort', () => no(new Error('aborted in flight')), { once: true }); });
  const f = cappedFetch(inner, { maxPerOrigin: 1, timeoutMs: 60000 });
  f('https://h.example/guardian-1/a'); f('https://h.example/guardian-2/a');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pending.length, 2, 'two seats behind one host each got their lane');
  const ctl = new AbortController();
  const queued = f('https://h.example/guardian-1/b', { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pending.length, 2, 'the third waits for guardian-1\'s lane');
  assert.deepEqual(f.inFlight()['https://h.example/guardian-1'], { busy: 1, waiting: 1 });
  ctl.abort(new Error('gave up'));
  await assert.rejects(queued, /gave up/);
  assert.deepEqual(f.inFlight()['https://h.example/guardian-1'], { busy: 1, waiting: 0 }, 'the aborted call left the queue');
  pending[0].ok({ ok: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pending.length, 2, 'nothing waited behind it any more');
});
