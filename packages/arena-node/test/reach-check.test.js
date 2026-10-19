// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CAN THE INTERNET REACH A NEW NODE (kanban #471 ruling 7, reach-check.js): the seat connects back to the asker only, to a public
// address only, says only whether the nonce came back, and at most 6 times a minute per address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPublicAddress, askerAddress, createReachCheck, httpConnectBack, REACH_PER_MINUTE } from '../src/reach-check.js';

const reqFrom = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });

test('only public addresses; the asker is the peer, or the last forwarded hop behind this machine\'s own proxy', () => {
  for (const ip of ['8.8.8.8', '2a01:4f8::1', '::ffff:1.1.1.1', '100.63.0.1', '172.32.0.1']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.0.2.5', '172.16.0.1', '198.51.100.7', '169.254.1.1', '0.0.0.0', '::1', 'fd7a:115c::1', 'fe80::1', '224.0.0.1', 'x'])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(askerAddress(reqFrom('203.0.113.9', '1.2.3.4')), '203.0.113.9', 'a forwarded header from a remote peer is ignored');
  assert.equal(askerAddress(reqFrom('127.0.0.1', '9.9.9.9, 5.6.7.8')), '9.9.9.9', 'behind the local proxies: the address the first one saw');
  assert.equal(askerAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '7.7.7.7', 'x-forwarded-for': '9.9.9.9' } }), '7.7.7.7', 'Cloudflare\'s first');
  assert.equal(askerAddress(reqFrom('::ffff:5.6.7.8')), '5.6.7.8');
});

test('the door refuses private askers, bad ports and nonces, a seventh check in a minute, and says nothing of a port it did not reach', async () => {
  let t = 0, calls = 0;
  const check = createReachCheck({ nowMs: () => t, connectBack: async () => { calls += 1; return { reached: true, ms: 1 }; } });
  assert.equal((await check(reqFrom('192.0.2.2'), { port: 8470, nonce: 'a'.repeat(20) })).status, 400);
  assert.equal((await check(reqFrom('8.8.8.8'), { port: 70000, nonce: 'a'.repeat(20) })).status, 400);
  assert.equal((await check(reqFrom('8.8.8.8'), { port: 8470, nonce: 'short' })).status, 400);
  for (let i = 0; i < REACH_PER_MINUTE; i++) {
    const r = await check(reqFrom('8.8.8.8'), { port: 8470, nonce: 'a'.repeat(20) });
    assert.deepEqual([r.status, r.body.reached, r.body.address], [200, true, '8.8.8.8']);
  }
  assert.equal((await check(reqFrom('8.8.8.8'), { port: 8470, nonce: 'a'.repeat(20) })).status, 429);
  t = 61000;
  assert.equal((await check(reqFrom('8.8.8.8'), { port: 8470, nonce: 'a'.repeat(20) })).status, 200, 'a minute later again');
  assert.equal(calls, REACH_PER_MINUTE + 1, 'refused checks never connect');
  const quiet = createReachCheck({ connectBack: async () => ({ reached: false, ms: 5000, why: '1.2.3.4 refused port 22' }) });
  const r = await quiet(reqFrom('1.2.3.4'), { port: 22, nonce: 'a'.repeat(20) });
  assert.deepEqual(r.body, { ok: true, reached: false, address: '1.2.3.4', port: 22, ms: undefined }, 'no refused / timed out: no port scanner');
  const { REACH_ALL_PER_MINUTE } = await import('../src/reach-check.js');
  const busy = createReachCheck({ nowMs: () => 0, connectBack: async () => ({ reached: true, ms: 1 }) });
  for (let i = 0; i < REACH_ALL_PER_MINUTE; i++) assert.equal((await busy(reqFrom(`8.8.${i >> 8}.${i & 255}`), { port: 1, nonce: 'a'.repeat(20) })).status, 200);
  assert.equal((await busy(reqFrom('9.9.9.9'), { port: 1, nonce: 'a'.repeat(20) })).status, 429, 'at most 60 in all');
});

test('connecting back: the nonce matches, something else answers, nothing listens', async () => {
  const nonce = 'n0nce-' + 'x'.repeat(16);
  const srv = http.createServer((q, s) => { s.end(q.url === '/reach-nonce' ? nonce : 'other'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  try {
    assert.equal((await httpConnectBack('127.0.0.1', port, nonce)).reached, true);
    const wrong = await httpConnectBack('127.0.0.1', port, 'y'.repeat(20));
    assert.equal(wrong.reached, false); assert.match(wrong.why, /not with the nonce/);
  } finally { srv.closeAllConnections(); await new Promise((ok) => srv.close(ok)); }
  const closed = await httpConnectBack('127.0.0.1', port, nonce);
  assert.equal(closed.reached, false); assert.match(closed.why, /refused/);
});
