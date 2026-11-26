// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3749 (gap in #3690): relayMarks dials each relay's /play with the /play cap (ws-dial.js PLAY_ANSWER_MOST). An honest answer (a
// receipt, a few hundred bytes) still counts; an answer just past the cap fails that relay; the dial guard (#3133) refuses a relay name
// that resolves to loopback. No public DNS: dns.lookup answers evil.test with loopback before the guard loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { WebSocketServer } from 'ws';

const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (hostname !== 'evil.test') return realLookup(hostname, options, callback);
  if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};
syncBuiltinESMExports();

const { relayMarks } = await import('../src/relay.js');
const { PLAY_ANSWER_MOST } = await import('../src/ws-dial.js');

async function playDoor(answerBytes) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/play' });
  const seen = { upgrades: 0, marks: 0 };
  http.on('upgrade', () => { seen.upgrades += 1; });
  wss.on('connection', (sock) => { sock.on('error', () => {}); sock.on('message', () => { seen.marks += 1; sock.send(Buffer.alloc(answerBytes, 0x61)); }); });
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  return {
    port: http.address().port, seen,
    close: async () => { for (const c of wss.clients) c.terminate(); wss.close(); http.closeAllConnections?.(); await new Promise((ok) => http.close(ok)); },
  };
}
const marks = [Uint8Array.from([0xaa]), Uint8Array.from([0xbb])];

test('the /play cap is #3690\'s 64 KiB', () => assert.equal(PLAY_ANSWER_MOST, 64 * 1024));

test('relayMarks: an honest receipt-sized answer counts; one just past the cap fails that relay', async () => {
  const honest = await playDoor(300), fat = await playDoor(PLAY_ANSWER_MOST + 1);
  try {
    const r = await relayMarks([`http://127.0.0.1:${honest.port}`, `http://127.0.0.1:${fat.port}`], marks, { timeoutMs: 5000 });
    assert.equal(r.sent, 1);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0], new RegExp(`127\\.0\\.0\\.1:${fat.port}: .*(payload|1009)`, 'i'));
    assert.equal(honest.seen.marks, 2);
  } finally { await honest.close(); await fat.close(); }
});

test('relayMarks: the dial guard still refuses a relay name resolving to loopback', async () => {
  const door = await playDoor(300);
  try {
    const r = await relayMarks([`http://evil.test:${door.port}`], marks, { timeoutMs: 5000 });
    assert.equal(r.sent, 0);
    assert.match(r.failed[0], /kanban #3133/);
    assert.equal(door.seen.upgrades, 0, 'no connection reached the loopback service');
    const ok = await relayMarks([`http://localhost:${door.port}`], marks, { timeoutMs: 5000 });
    assert.equal(ok.sent, 1, 'a local name is the name rule\'s');
  } finally { await door.close(); }
});
