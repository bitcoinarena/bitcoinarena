// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r24-nostr-2: THE SUBSCRIPTIONS A STRANGER HOLDS OPEN ARE NOBODY'S BOUND. nostr-relay.js keeps each accepted REQ's filters,
// compiled into Sets (compileFilter), for the socket's life: 20 subscriptions x 10 filters x (ids, authors, kinds + 8 #<letter> keys) x 500
// values each - only the 128 KB message size bounds one REQ - and sockets are free and uncounted ("no cap on sockets per address").
// A socket that sends 20 such REQs (well inside 60 messages / 10 s) and never sends anything again holds that memory in the relay for good;
// N such sockets hold N times it, until the relay process (NIP-46 logins, NWC payments, the seats' results) runs out of heap.
// Safe: what all open subscriptions together retain is bounded - a stranger's sockets cannot grow the relay's heap without limit
// (here: 8 sockets x 20 full REQs keep the relay's heap growth under 48 MB).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';
import v8 from 'node:v8';
import vm from 'node:vm';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const settle = async () => { for (let i = 0; i < 3; i++) { gc(); await new Promise((r) => setTimeout(r, 100)); } };

const SOCKETS = 8, SUBS = 20;
// one REQ under 128 KB: 10 filters, each 8 #<letter> keys of distinct 4-char values (as many as fit), + kinds
const reqOf = (sid, salt) => {
  let n = salt * 1e6;
  const vals = (k) => Array.from({ length: k }, () => (n++).toString(36).slice(-4));
  const letters = 'abcdefgh'.split('');
  const filters = Array.from({ length: 10 }, () => Object.fromEntries(letters.map((l) => [`#${l}`, vals(205)])));
  return JSON.stringify(['REQ', sid, ...filters]);
};

test('#1489 r24-nostr-2: open subscriptions of free sockets do not grow the relay heap without bound', async () => {
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
    for (let t = 0; t < 200 && eose + closed < SOCKETS * SUBS; t++) await new Promise((r) => setTimeout(r, 50));
    await settle();
    const grew = (process.memoryUsage().heapUsed - before) / 1048576;
    for (const w of socks) w.terminate();
    await new Promise((r) => setTimeout(r, 300)); await settle();
    const after = (process.memoryUsage().heapUsed - before) / 1048576;
    console.log(`  FACTS: after the sockets closed the growth is ${after.toFixed(1)} MB (what the open subscriptions held: ${(grew - after).toFixed(1)} MB)`);
    console.log(`  FACTS: one REQ ${size} bytes; ${eose} subscriptions open, ${closed} refused; relay heap grew ${grew.toFixed(1)} MB for ${SOCKETS} idle sockets (${(grew / SOCKETS).toFixed(1)} MB a socket)`);
    assert.ok(grew < 48, `the relay keeps ${grew.toFixed(1)} MB for ${SOCKETS} idle sockets' subscriptions - sockets are free, so N sockets keep N x ${(grew / SOCKETS).toFixed(1)} MB`);
  } finally {
    for (const w of socks) w.terminate();
    await relay.close();
  }
});
