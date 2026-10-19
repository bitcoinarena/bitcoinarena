// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FIRST SOCKET IS TRIED UNTIL IT OPENS (PRIORITIES 2026-10-02 12:13, the owner's playtest: "Not joined PAID · 100 sats
// round 3fe0d7d1: socket error" - the entry held by all 7 signer nodes, the stake locked, and one failed socket ended the
// join; no first mark came and the door signed FORFEIT). A server that drops the first two upgrades and takes the third:
// connectFirst opens on the third try. One that never takes one: it gives up at its deadline and says how many it tried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Client } from '../src/client.js';

function flaky(dropFirst) {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  http.on('upgrade', (req, sock, head) => {
    upgrades++;
    if (upgrades <= dropFirst) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
  });
  return new Promise((r) => http.listen(0, '127.0.0.1', () => r({ port: http.address().port, upgrades: () => upgrades,
    close: () => { for (const c of wss.clients) c.terminate(); return new Promise((d) => http.close(d)); } })));
}
const fresh = (port) => {
  const c = new Client({ base: `http://127.0.0.1:${port}`, core: {}, sign: () => null, verify: () => true });
  c.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50)));    // the backoff, quick
  return c;
};

test('two dropped upgrades, then one taken: connectFirst opens on the third try where connect alone failed', async () => {
  const s = await flaky(2);
  try {
    const once = fresh(s.port);
    const alone = await once.connect().then(() => 'open', (e) => 'failed: ' + e.message);
    const c = fresh(s.port);
    await c.connectFirst({ untilMs: Date.now() + 30000 });
    console.log('  FACTS:', JSON.stringify({ alone, tries: c.firstTries, state: c.state, upgrades: s.upgrades() }));
    assert.match(alone, /^failed: /);
    assert.equal(c.firstTries, 2, 'the second client met one dropped upgrade, then the open');
    assert.equal(c.state, 'ready');
    c.ended = true; c.sock.close();
  } finally { await s.close(); }
});

test('a server that never takes one: connectFirst gives up at its deadline, and says how many it tried', async () => {
  const s = await flaky(Infinity);
  try {
    const c = fresh(s.port);
    const t0 = Date.now();
    const why = await c.connectFirst({ untilMs: Date.now() + 1500 }).then(() => 'open', (e) => e.message);
    console.log('  FACTS:', JSON.stringify({ why, tries: c.firstTries, ms: Date.now() - t0 }));
    assert.match(why, /\(\d+ tries\)$/);
    assert.ok(c.firstTries >= 2, 'it tried once');
    assert.ok(Date.now() - t0 < 5000, 'it went past its deadline');
  } finally { await s.close(); }
});
