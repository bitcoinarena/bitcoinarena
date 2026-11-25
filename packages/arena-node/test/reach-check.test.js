// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CAN THE INTERNET REACH A NEW NODE (ruling 7, reach-check.js): the seat connects back to the asker only, to a public
// address only, says only whether the nonce came back, and at most 6 times a minute per address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPublicAddress, askerAddress, createReachCheck, httpConnectBack, REACH_PER_MINUTE } from '../src/reach-check.js';

const reqFrom = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });

test('only public addresses; the asker is the peer, or the last forwarded hop behind this machine\'s own proxy', () => {
  for (const ip of ['8.8.8.8', '2a01:4f8::1', '::ffff:1.1.1.1', '100.63.0.1', '172.32.0.1']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', ['192', '168.0.5'].join('.'), '172.16.0.1', ['100', '64.0.1'].join('.'), '169.254.1.1', '0.0.0.0', '::1', 'fd7a:115c::1', 'fe80::1', '224.0.0.1', 'x'])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(askerAddress(reqFrom('203.0.113.9', '1.2.3.4')), '203.0.113.9', 'a forwarded header from a remote peer is ignored');
  // kanban #3055: only the hop our own proxy appended (the right-most; our loopback hops at the right end skipped); the client's first hop is its own text
  assert.equal(askerAddress(reqFrom('127.0.0.1', '9.9.9.9, 5.6.7.8')), '5.6.7.8', 'behind the local proxy: the hop it appended, not the client\'s first');
  assert.equal(askerAddress(reqFrom('127.0.0.1', '9.9.9.9, 5.6.7.8, 127.0.0.1')), '5.6.7.8', 'cloudflared -> the tn4 local proxy: the edge\'s hop, our loopback hop skipped');
  assert.equal(askerAddress(reqFrom('127.0.0.1', '127.0.0.1')), '127.0.0.1', 'only loopback hops: the peer');
  // kanban #3055: cf-connecting-ip only on a seat that says only Cloudflare reaches it
  const cfReq = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '7.7.7.7', 'x-forwarded-for': '9.9.9.9' } };
  assert.equal(askerAddress(cfReq, { env: {} }), '9.9.9.9', 'a client-sent cf-connecting-ip is not believed');
  assert.equal(askerAddress(cfReq, { env: { ARENA_TRUST_CF_CONNECTING_IP: '1' } }), '7.7.7.7', 'Cloudflare\'s first where the seat trusts it');
  assert.equal(askerAddress(reqFrom('::ffff:5.6.7.8')), '5.6.7.8');
});

test('the door refuses private askers, bad ports and nonces, a seventh check in a minute, and says nothing of a port it did not reach', async () => {
  let t = 0, calls = 0;
  const check = createReachCheck({ nowMs: () => t, connectBack: async () => { calls += 1; return { reached: true, ms: 1 }; } });
  assert.equal((await check(reqFrom(['192', '168.0.2'].join('.')), { port: 8470, nonce: 'a'.repeat(20) })).status, 400);
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

// kanban #3700 (report #464): every spelling of a loopback/private address is refused, not only the one '::ffff:' prefix; the
// seat dials and rate-limits the canonical address, so a respelling is neither a way in nor a fresh bucket.
test('#3700 v4-mapped, v4-compatible and other embedded-v4 spellings are checked as the v4 address they name', async () => {
  const { canonicalAddress } = await import('../src/reach-check.js');
  for (const ip of ['0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:a9fe:a9fe', '::ffff:7f00:1', '::FFFF:7F00:1', '::ffff:127.0.0.1',
    '0:0:0:0:0:FFFF:127.0.0.1', '::ffff:a00:1', '::ffff:c0a8:1', '::7f00:1', '::127.0.0.1', '0:0:0:0:0:0:0:1', '0000::0001', '::',
    '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '2002:7f00:1::1', '2002:c0a8:1::1', 'fec0::1', 'FE80::1', 'fe80::1%eth0',
    'FD00::1', 'FF02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '[::1]', '127.1', '0x7f.0.0.1', '2130706433', '127.000.000.001', '', null])
    assert.equal(isPublicAddress(ip), false, String(ip));
  for (const ip of ['0:0:0:0:0:ffff:808:808', '::ffff:8.8.8.8', '2002:808:808::1', '2A01:4F8::1', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(canonicalAddress('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
  assert.equal(canonicalAddress('0000:0000:0000:0000:0000:ffff:0808:0808'), '8.8.8.8');
  assert.equal(canonicalAddress('2A01:04F8:0:0::1'), '2a01:4f8::1');
  let dialed = [];
  const check = createReachCheck({ nowMs: () => 0, connectBack: async (ip) => { dialed.push(ip); return { reached: true, ms: 1 }; } });
  const r = await check(reqFrom('127.0.0.1', '0:0:0:0:0:ffff:7f00:1'), { port: 9999, nonce: 'a'.repeat(20) });
  assert.equal(r.status, 400, 'the report\'s request: refused'); assert.deepEqual(dialed, []);
  const spellings = ['8.8.8.8', '::ffff:808:808', '0:0:0:0:0:ffff:808:808', '0000:0000:0000:0000:0000:ffff:0808:0808', '::FFFF:8.8.8.8', '::ffff:0808:0808', '0::ffff:808:808'];
  const codes = [];
  for (const s of spellings) codes.push((await check(reqFrom('127.0.0.1', s), { port: 1, nonce: 'a'.repeat(20) })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429], 'one bucket for every spelling of 8.8.8.8');
  assert.deepEqual([...new Set(dialed)], ['8.8.8.8'], 'the canonical address is what is dialed');
});
