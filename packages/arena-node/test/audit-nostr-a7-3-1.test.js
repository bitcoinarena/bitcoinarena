// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a7-3 #1 (gap in #2839): THE SUBSCRIPTION BUDGET COUNTS VALUES, NOT BYTES. #2839 charges each kept subscription the number
// of values its compiled filters hold (SUB_VALUES_PER_SOCKET 4000 per socket, SUB_VALUES_TOTAL 400,000 relay-wide). A #<letter> tag value
// is any string, with no length bound but the 128 KB frame: one REQ of one filter {"#d": [<~128 KB string>]} is charged 2 values and keeps
// ~128 KB in the relay's heap. 20 of them per socket keep ~2.6 MB for a charge of 40; the relay-wide total of 400,000 values is reached
// only after ~10,000 such sockets (~26 GB). Sockets are free and uncounted, so the #2839 OOM is back with a few dozen idle sockets.
// Safe (the bound of the #2839 test): 40 idle sockets x 20 REQs keep the relay's heap growth under 48 MB.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import v8 from 'node:v8';
import vm from 'node:vm';
import { startRelay } from '../src/nostr-relay.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const settle = async () => { for (let i = 0; i < 3; i++) { gc(); await new Promise((r) => setTimeout(r, 100)); } };

const SOCKETS = 40, SUBS = 20, LONG = 128 * 1024 - 200;
const reqOf = (sid, salt) => JSON.stringify(['REQ', sid, { '#d': [`${salt}-`.padEnd(LONG, String.fromCharCode(97 + (salt % 26)))] }]);

test('audit nostr a7-3 #1: long tag values keep megabytes per idle socket while the #2839 value budget counts two values a REQ', async () => {
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  const socks = [];
  try {
    await settle();
    const before = process.memoryUsage().heapUsed;
    let closed = 0, eose = 0, size = 0;
    for (let s = 0; s < SOCKETS; s++) {
      const ws = new WebSocket(url);
      await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
      ws.on('message', (m) => { const a = JSON.parse(String(m)); if (a[0] === 'EOSE') eose++; if (a[0] === 'CLOSED') closed++; });
      socks.push(ws);
      for (let i = 0; i < SUBS; i++) { const q = reqOf(`s${i}`, s * SUBS + i); size = q.length; ws.send(q); }
    }
    for (let t = 0; t < 400 && eose + closed < SOCKETS * SUBS; t++) await new Promise((r) => setTimeout(r, 50));
    await settle();
    const grew = (process.memoryUsage().heapUsed - before) / 1048576;
    console.log(`  FACTS: one REQ ${size} bytes; ${eose} subscriptions open, ${closed} refused; relay heap grew ${grew.toFixed(1)} MB for ${SOCKETS} idle sockets (${(grew / SOCKETS).toFixed(2)} MB a socket, charged ${SUBS * 2} values each of the ${4000} allowed)`);
    assert.ok(grew < 48, `the relay keeps ${grew.toFixed(1)} MB for ${SOCKETS} idle sockets' subscriptions (${eose} accepted): the value budget does not see the bytes`);
  } finally {
    for (const w of socks) w.terminate();
    await relay.close();
  }
});

test('audit nostr a7-3 #1: honest filters keep working - short tag values cost one each, a long one is refused per its length', async () => {
  const relay = await startRelay({ port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
  try {
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const got = [];
    ws.on('message', (m) => got.push(JSON.parse(String(m))));
    const reply = async (sid) => { for (let t = 0; t < 200 && !got.some((a) => (a[0] === 'EOSE' || a[0] === 'CLOSED') && a[1] === sid); t++) await new Promise((r) => setTimeout(r, 10)); return got.find((a) => (a[0] === 'EOSE' || a[0] === 'CLOSED') && a[1] === sid); };
    // a seat-sized query: 500 d values of ~100 characters (charged 501), 7 of them on one socket (3507 of 4000)
    for (let i = 0; i < 7; i++) {
      ws.send(JSON.stringify(['REQ', `h${i}`, { kinds: [30762], '#d': Array.from({ length: 500 }, (_, j) => `arena:result:${i}-${j}-`.padEnd(100, 'x')) }]));
      assert.equal((await reply(`h${i}`))[0], 'EOSE', `honest query h${i} is answered`);
    }
    // one value of 64 KB is charged 512: past the 4000 this socket may hold
    ws.send(JSON.stringify(['REQ', 'long', { '#d': ['y'.repeat(64 * 1024)] }]));
    const ans = await reply('long');
    assert.equal(ans[0], 'CLOSED');
    assert.match(ans[2], /too many subscription values/);
  } finally { ws.terminate(); await relay.close(); }
});
