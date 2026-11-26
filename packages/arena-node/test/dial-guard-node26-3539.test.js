// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3539: the dial guard installs as the dispatcher Node's own fetch and WebSocket read, on Node 24 (undici 7, '.1') and on
// Node 26 (undici 8, '.2' with a wrapper under '.1'). No public DNS: dns.lookup answers evil.test with loopback before the guard loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (hostname !== 'evil.test') return realLookup(hostname, options, callback);
  if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};
syncBuiltinESMExports();

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); realError(...a); };
const { dialGuardInstalled, nativeGlobalAgent } = await import('../src/dial-guard.js');
const { keepAliveDispatcher } = await import('../src/fetch-routes.js');
console.error = realError;

const causeCode = (e) => { for (let c = e; c; c = c.cause) if (c.code) return c.code; return null; };

test('the guard installs on this Node, as the dispatcher its fetch reads', () => {
  assert.deepEqual(errors.filter((m) => m.includes('[dial-guard]')), []);
  assert.ok(dialGuardInstalled(), `guarded on ${process.version}`);
  assert.ok(nativeGlobalAgent() && typeof nativeGlobalAgent().dispatch === 'function');
});

test('fetch, WebSocket and the keep-alive dispatcher do not connect to a name resolving to loopback', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.end('ok'); });
  srv.on('upgrade', (req, sock) => { hits.push(`ws ${req.url}`); sock.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const e1 = await fetch(`http://evil.test:${port}/fetch`).then(() => null, (e) => e);
    assert.ok(e1, 'refused');
    assert.equal(causeCode(e1), 'EARENA_INTERNAL_ADDRESS');

    const ws = new WebSocket(`ws://evil.test:${port}/ws`);
    await new Promise((r) => { ws.onerror = r; ws.onclose = r; ws.onopen = r; });

    const make = keepAliveDispatcher(fetch, 30000);
    const kept = await make();
    assert.ok(kept && typeof kept.dispatch === 'function', 'a keep-alive Agent is made on this Node');
    const e2 = await fetch(`http://evil.test:${port}/kept`, { dispatcher: kept }).then(() => null, (e) => e);
    assert.equal(causeCode(e2), 'EARENA_INTERNAL_ADDRESS');

    assert.deepEqual(hits, []);
    assert.equal((await fetch(`http://localhost:${port}/ok`)).status, 200, 'a local name is the name rule\'s');
    assert.equal((await fetch(`http://localhost:${port}/ok2`, { dispatcher: kept })).status, 200);
    await kept.close();
  } finally { srv.close(); srv.closeAllConnections?.(); }
});
