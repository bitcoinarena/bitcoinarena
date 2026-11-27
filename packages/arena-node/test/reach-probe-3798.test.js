// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3798: GET /reach-probe?node=<key> - a seat visits the addresses IT holds for that key (census, announcement) and says per address
// whether that node answered, how fast, and if not why; the asker names a key, never an address; bounded and rate-limited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeTargets, probeOne, createReachProbe, failureKind, PROBE_PER_MINUTE } from '../src/reach-probe.js';
import { peerEndpointRefusal } from '../src/address-book.js';

const NODE = 'ab'.repeat(32), OTHER = 'cd'.repeat(32);
const req = (ip) => ({ socket: { remoteAddress: ip }, headers: {} });

test('the targets: the census endpoints and the newest announcement, each once, a loopback or private one never', () => {
  const refusal = (u) => peerEndpointRefusal(u);
  const t = probeTargets({ census: ['https://old.trycloudflare.com', 'http://127.0.0.1:18777/lnurlp'], announced: 'https://node.example.ts.net/', refusal });
  assert.deepEqual(t, [{ url: 'https://old.trycloudflare.com', from: ['census'] }, { url: 'https://node.example.ts.net', from: ['announced'] }]);
  const same = probeTargets({ census: ['https://n.example.com'], announced: 'https://n.example.com/', refusal });
  assert.deepEqual(same, [{ url: 'https://n.example.com', from: ['census', 'announced'] }], 'the same address once, from both');
  assert.equal(probeTargets({ census: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'], announced: 'https://e.example' }).length, 3);
});

test('one probe: the right key answers; another key, an HTTP error, a redirect, a dead name and silence each say what they are', async () => {
  const srv = http.createServer((q, s) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname !== '/identity') { s.writeHead(404); return s.end(); }
    const host = u.searchParams.get('as') || '';
    if (/^right/.test(host)) { s.writeHead(200); return s.end(Buffer.from(NODE, 'hex')); }
    if (/^other/.test(host)) { s.writeHead(200); return s.end(Buffer.from(OTHER, 'hex')); }
    if (/^gone/.test(host)) { s.writeHead(530); return s.end('tunnel gone'); }
    if (/^moved/.test(host)) { s.writeHead(302, { location: 'http://127.0.0.1:1/identity' }); return s.end(); }
    /* silent: never answers */
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  const via = (name) => async (url, o) => { assert.match(url, /^https?:\/\/[a-z]+\.example\/identity$/); return fetch(`http://127.0.0.1:${port}/identity?as=${name}`, o); };
  try {
    const ok = await probeOne('wss://right.example', NODE, { fetchFn: via('right') });
    assert.equal(ok.reached, true); assert.ok(Number.isFinite(ok.ms));
    assert.deepEqual((({ reached, kind }) => ({ reached, kind }))(await probeOne('https://other.example', NODE, { fetchFn: via('other') })), { reached: false, kind: 'other-node' });
    const gone = await probeOne('https://gone.example', NODE, { fetchFn: via('gone') });
    assert.equal(gone.kind, 'http'); assert.equal(gone.status, 530);
    const moved = await probeOne('https://moved.example', NODE, { fetchFn: via('moved') });
    assert.equal(moved.reached, false); assert.equal(moved.status, 302, 'a redirect is not followed');
    const silent = await probeOne('https://silent.example', NODE, { fetchFn: via('silent'), timeoutMs: 300 });
    assert.equal(silent.kind, 'timeout');
  } finally { srv.closeAllConnections(); srv.close(); }
  assert.equal((await probeOne('https://no-such-name.invalid', NODE, { timeoutMs: 5000 })).kind, 'dns');
  assert.equal(failureKind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })), 'tls');
  assert.equal(failureKind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'refused');
  assert.equal(failureKind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EARENA_INTERNAL_ADDRESS' } })), 'blocked', 'a name resolving to a private address (dial-guard.js)');
});

test('the door: a key only, 404 for a node this seat holds no address for, one answer shared, at most 6 fresh checks a minute per asker', async () => {
  let t = 0, dials = 0;
  const probe = async () => { dials += 1; return { reached: true, ms: 12 }; };
  const book = { [NODE]: { census: ['https://old.trycloudflare.com'], announced: 'https://new.example.ts.net' } };
  const door = createReachProbe({ targetsOf: (n) => book[n] || {}, probe, nowMs: () => t, env: {} });
  assert.equal((await door(req('8.8.8.8'), 'https://evil.example')).status, 400, 'an address is no key');
  assert.equal((await door(req('8.8.8.8'), OTHER)).status, 404);
  const a = await door(req('8.8.8.8'), NODE);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.census, ['https://old.trycloudflare.com']);
  assert.deepEqual(a.body.results.map((r) => [r.url, r.from, r.reached]), [['https://old.trycloudflare.com', ['census'], true], ['https://new.example.ts.net', ['announced'], true]]);
  assert.equal(dials, 2);
  const kept = await door(req('9.9.9.9'), NODE);
  assert.equal(dials, 2, 'within 30 s the kept answer, no new dial'); assert.ok(kept.body.keptMs >= 0);
  t += 61000;
  const keys = Array.from({ length: PROBE_PER_MINUTE + 1 }, (_, i) => (i + 16).toString(16).repeat(32));
  for (const k of keys) book[k] = { census: [`https://n${k.slice(0, 4)}.example`] };
  const answers = [];
  for (const k of keys) answers.push((await door(req('8.8.8.8'), k)).status);
  assert.deepEqual(answers, [...Array(PROBE_PER_MINUTE).fill(200), 429], 'a seventh fresh check in a minute from one address is refused');
  assert.equal((await door(req('1.1.1.1'), keys.at(-1))).status, 200, 'another asker is not held up by it');
});
