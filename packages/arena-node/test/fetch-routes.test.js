// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//: the seat's own fetches routed to the direct address and capped per origin (measured: 770-910 HTTPS connections per
// seat to its own host's Tailscale address, 4,589 to the test host through the fed2 forwarder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { parseRoutes, routed, cappedFetch, keepAliveDispatcher } from '../src/fetch-routes.js';

test('a public URL is fetched at its direct address, the longest prefix first, at a path boundary only', () => {
  const r = parseRoutes('https://b.ts.net/guardian-1=http://127.0.0.1:31221, https://b.ts.net/fed2-1=http://198.51.100.106:6221/,https://b.ts.net/guardian-1x=http://x');
  assert.equal(routed('https://b.ts.net/guardian-1/rounds?next=2', r), 'http://127.0.0.1:31221/rounds?next=2');
  assert.equal(routed('https://b.ts.net/fed2-1/identity', r), 'http://198.51.100.106:6221/identity');
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

// ONE LANE PER SEAT, AND A WAITING CALL KEEPS ITS DEADLINE (measured 2026-10-13 ~20:45Z: seven seats behind one host shared
// 8 slots, and a 5 s call queued behind 30 s ones without bound - a second-host seat's seating agent stopped signing PRESENTs)
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

// kanban #742 (measured on test host seat 3, 2026-10-28): every seat fetch to a stopped test node's quick tunnel failed at DNS and left a
// TLSSocket behind, ~3.6 a second per host - 112,473 alive after an hour. A host that answered ENOTFOUND is not dialed again until the
// request timeout has passed; another host, and the same host after the timeout, are dialed as before.
test('a host that does not resolve is not dialed again until the timeout has passed', async () => {
  const dialed = [];
  const notFound = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND gone.example'), { code: 'ENOTFOUND' }) });
  const inner = async (u) => { dialed.push(String(u)); if (String(u).includes('gone.example')) throw notFound(); return new Response('ok'); };
  const f = cappedFetch(inner, { timeoutMs: 200 });
  await assert.rejects(f('https://gone.example/presence'), (e) => e.cause && e.cause.code === 'ENOTFOUND');
  for (let i = 0; i < 50; i++) await assert.rejects(f('https://gone.example/identity'), (e) => e.message === 'fetch failed' && e.cause.code === 'ENOTFOUND');
  assert.equal(dialed.filter((u) => u.includes('gone.example')).length, 1, 'dialed once, then answered without a socket');
  assert.deepEqual(Object.keys(f.unresolved()), ['gone.example']);
  assert.equal(await (await f('https://other.example/x')).text(), 'ok');
  await new Promise((r) => setTimeout(r, 250));
  await assert.rejects(f('https://gone.example/identity'));
  assert.equal(dialed.filter((u) => u.includes('gone.example')).length, 2, 'dialed again once the timeout has passed');
});

test('a failure other than ENOTFOUND does not hold the host back', async () => {
  let n = 0;
  const inner = async () => { n++; throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); };
  const f = cappedFetch(inner, { timeoutMs: 10000 });
  for (let i = 0; i < 3; i++) await assert.rejects(f('http://127.0.0.1:9/x'));
  assert.equal(n, 3);
  assert.deepEqual(f.unresolved(), {});
});

// kanban #1122: an installer node opened ~90 TLS connections a minute to the seats behind one Tailscale serve host (Node's fetch drops
// an idle connection after 4 s when the server names no keep-alive time, as a proxy does not) and its doors went unanswered for 5-15 s
test('an idle connection to a server that names no keep-alive time is kept past 4 s for the next request', async () => {
  // an HTTP/1.1 server that, like a proxy, sends no Keep-Alive header and keeps the connection open
  let connections = 0;
  const srv = netServer((sock) => {
    connections++;
    let buf = '';
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n\r\n')) >= 0) { buf = buf.slice(i + 4); sock.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'); } });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/x`;
  const native = globalThis.fetch.bind(globalThis);
  const twice = async (f) => { const before = connections; await (await f(url)).text(); await new Promise((r) => setTimeout(r, 4600)); await (await f(url)).text(); return connections - before; };
  try {
    const dispatcher = keepAliveDispatcher(native, 30000);
    const kept = cappedFetch(native, { dispatcher });
    const plain = await twice(native);
    const ours = await twice(kept);
    assert.equal(plain, 2, 'Node\'s own fetch dialed again after 4.6 s idle');
    assert.equal(ours, 1, 'the kept connection served both');
    assert.equal(keepAliveDispatcher(native, 0), null, '0 leaves Node\'s own');
    (await dispatcher()).destroy();
  } finally { srv.close(); }
});
