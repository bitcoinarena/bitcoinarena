// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3133: a name is judged by where it resolves when the connection is made, not only by the name list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolvedRefusal, operatorHosts } from '../src/dial-guard.js';

const none = new Set();
test('a public name resolving to an internal address is refused; the rest is the name rule\'s or the operator\'s', () => {
  assert.ok(resolvedRefusal('x.lacolhost.com', [{ address: '127.0.0.1' }], { operator: none }));
  assert.ok(resolvedRefusal('evil.example', [{ address: '93.184.216.34' }, { address: '192.168.1.1' }], { operator: none }), 'any one internal address');
  assert.ok(resolvedRefusal('evil.example', [{ address: '::ffff:127.0.0.1' }], { operator: none }));
  assert.equal(resolvedRefusal('example.com', [{ address: '93.184.216.34' }], { operator: none }), null);
  assert.equal(resolvedRefusal('x.lacolhost.com', [{ address: '127.0.0.1' }], { localOk: true, operator: none }), null, 'a local-seat node');
  assert.equal(resolvedRefusal('localhost', [{ address: '127.0.0.1' }], { operator: none }), null, 'a local name: the name rule decides');
  assert.equal(resolvedRefusal('seat-a.tail1234.ts.net', [{ address: '100.101.102.103' }], { operator: none }), null, 'a tailnet name on its tailnet address');
  assert.ok(resolvedRefusal('seat-a.tail1234.ts.net', [{ address: '127.0.0.1' }], { operator: none }));
  assert.ok(resolvedRefusal('evil.example', [{ address: '100.101.102.103' }], { operator: none }), 'CGNAT under another name');
  const op = operatorHosts({ ARENA_ROUTE_MAP: 'https://seat.example.com/g=http://box.example.net:31231', FM_WS_API_CONNECT_OVERRIDES: 'wss://a/b=ws://fed.example.org:7000', ARENA_DIAL_INTERNAL_OK: 'db.example.io' });
  assert.deepEqual([...op].sort(), ['box.example.net', 'db.example.io', 'fed.example.org']);
  for (const h of op) assert.equal(resolvedRefusal(h, [{ address: '10.0.0.2' }], { operator: op }), null, 'the operator\'s own target');
});

test('the process fetch does not connect to a name that resolves to loopback (localh.st, x.lacolhost.com)', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.headers.host); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    for (const h of ['localh.st', 'x.lacolhost.com']) { try { await fetch(`http://${h}:${port}/x`, { signal: AbortSignal.timeout(5000) }); } catch { /* refused */ } }
    assert.deepEqual(hits, []);
    assert.equal((await fetch(`http://127.0.0.1:${port}/x`)).status, 200, 'an IP literal is the name rule\'s (and works for a local caller)');
    assert.equal((await fetch(`http://localhost:${port}/x`)).status, 200);
  } finally { srv.close(); }
});
